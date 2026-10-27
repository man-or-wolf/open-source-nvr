#!/usr/bin/env python3
"""Object detector sidecar for open-source-nvr.

Reads raw RGB frames from stdin, writes one JSON line per frame to stdout.

Frame:    b'NVRD' | u32 id | u16 width | u16 height | width*height*3 RGB bytes  (little endian)
Startup:  {"type":"ready","backend":..,"input":[w,h]}
Result:   {"type":"result","id":n,"ms":t,"detections":[{"label","score","box":[x1,y1,x2,y2]}]}  (box normalised 0-1)
Error:    {"type":"error","id":n|null,"msg":..}

Backends: edgetpu (Coral USB/PCIe), cpu (tflite), mock (testing).
"""
import argparse
import json
import struct
import sys
import time

import numpy as np

MAGIC = b'NVRD'
HEADER = struct.Struct('<4sIHH')

# COCO ids used by the ssd_mobilenet_v2_coco_quant_postprocess models (class index = id - 1)
_COCO = {
    1: 'person', 2: 'bicycle', 3: 'car', 4: 'motorcycle', 5: 'airplane', 6: 'bus', 7: 'train', 8: 'truck',
    9: 'boat', 10: 'traffic light', 11: 'fire hydrant', 13: 'stop sign', 14: 'parking meter', 15: 'bench',
    16: 'bird', 17: 'cat', 18: 'dog', 19: 'horse', 20: 'sheep', 21: 'cow', 22: 'elephant', 23: 'bear',
    24: 'zebra', 25: 'giraffe', 27: 'backpack', 28: 'umbrella', 31: 'handbag', 32: 'tie', 33: 'suitcase',
    34: 'frisbee', 35: 'skis', 36: 'snowboard', 37: 'sports ball', 38: 'kite', 39: 'baseball bat',
    40: 'baseball glove', 41: 'skateboard', 42: 'surfboard', 43: 'tennis racket', 44: 'bottle',
    46: 'wine glass', 47: 'cup', 48: 'fork', 49: 'knife', 50: 'spoon', 51: 'bowl', 52: 'banana',
    53: 'apple', 54: 'sandwich', 55: 'orange', 56: 'broccoli', 57: 'carrot', 58: 'hot dog', 59: 'pizza',
    60: 'donut', 61: 'cake', 62: 'chair', 63: 'couch', 64: 'potted plant', 65: 'bed', 67: 'dining table',
    70: 'toilet', 72: 'tv', 73: 'laptop', 74: 'mouse', 75: 'remote', 76: 'keyboard', 77: 'cell phone',
    78: 'microwave', 79: 'oven', 80: 'toaster', 81: 'sink', 82: 'refrigerator', 84: 'book', 85: 'clock',
    86: 'vase', 87: 'scissors', 88: 'teddy bear', 89: 'hair drier', 90: 'toothbrush',
}
DEFAULT_LABELS = {i - 1: n for i, n in _COCO.items()}


def load_labels(path):
    """Accepts 'name' per line, or 'index  name' per line (coral coco_labels.txt)."""
    if not path:
        return DEFAULT_LABELS
    labels = {}
    with open(path) as f:
        for n, line in enumerate(f):
            line = line.strip()
            if not line:
                continue
            parts = line.split(maxsplit=1)
            if len(parts) == 2 and parts[0].isdigit():
                labels[int(parts[0])] = parts[1].strip()
            else:
                labels[n] = line
    return labels


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def emit(obj):
    sys.stdout.write(json.dumps(obj, separators=(',', ':')) + '\n')
    sys.stdout.flush()


def _import_tflite():
    """Returns (Interpreter, load_delegate) from whichever runtime is installed."""
    errors = []
    for mod in ('tflite_runtime.interpreter', 'ai_edge_litert.interpreter', 'tensorflow.lite.python.interpreter'):
        try:
            m = __import__(mod, fromlist=['Interpreter'])
            return m.Interpreter, m.load_delegate
        except Exception as e:  # ImportError, or a broken native lib
            errors.append(f'{mod}: {e}')
    raise RuntimeError('no tflite runtime found (pip install tflite-runtime / ai-edge-litert); ' + '; '.join(errors))


def _edgetpu_lib():
    if sys.platform == 'darwin':
        return 'libedgetpu.1.dylib'
    if sys.platform.startswith('win'):
        return 'edgetpu.dll'
    return 'libedgetpu.so.1'


class TfliteBackend:
    """SSD postprocess model (boxes, classes, scores, count). Runs on a Coral when device is given."""

    def __init__(self, model, labels, use_edgetpu, device, min_score):
        if not model:
            raise RuntimeError('model path required')
        self.labels = labels
        self.min_score = min_score
        self.name = 'edgetpu' if use_edgetpu else 'cpu'
        Interpreter, load_delegate = _import_tflite()
        if use_edgetpu:
            opts = {'device': device} if device else {}
            try:
                self.interp = Interpreter(model_path=model, experimental_delegates=[load_delegate(_edgetpu_lib(), opts)])
            except (ValueError, OSError) as e:
                raise RuntimeError(
                    f'Coral EdgeTPU not usable (device={device or "auto"}): {e}. '
                    'Check libedgetpu1-std is installed, the device is plugged in, and the user can access it '
                    '(USB: udev rules / docker --device /dev/bus/usb; PCIe/M.2: /dev/apex_0).')
        else:
            self.interp = Interpreter(model_path=model, num_threads=2)
        self.interp.allocate_tensors()
        inp = self.interp.get_input_details()[0]
        self.in_index = inp['index']
        self.in_dtype = inp['dtype']
        self.in_quant = inp.get('quantization', (0, 0))
        _, self.h, self.w, _ = inp['shape']
        self.outs = sorted(self.interp.get_output_details(), key=lambda d: d['index'])

    def input_size(self):
        return int(self.w), int(self.h)

    def detect(self, rgb):
        data = rgb.reshape(1, self.h, self.w, 3)
        if self.in_dtype == np.uint8:
            data = data.astype(np.uint8, copy=False)
        else:
            # float and int8 models expect the image scaled to [-1, 1]; int8 is then quantised with the model's parameters
            data = (data.astype(np.float32) - 127.5) / 127.5
            if self.in_dtype == np.int8:
                scale, zero = self.in_quant
                data = np.clip(np.round(data / (scale or 1.0) + zero), -128, 127).astype(np.int8)
        self.interp.set_tensor(self.in_index, data)
        self.interp.invoke()
        boxes, classes, scores, count = self._outputs()
        dets = []
        for i in range(min(int(count), len(scores))):
            s = float(scores[i])
            if s < self.min_score:
                continue
            y1, x1, y2, x2 = (min(max(float(v), 0.0), 1.0) for v in boxes[i])
            dets.append({'label': self.labels.get(int(classes[i]), str(int(classes[i]))), 'score': round(s, 4),
                         'box': [round(x1, 4), round(y1, 4), round(x2, 4), round(y2, 4)]})
        return dets

    def _outputs(self):
        vals = [self.interp.get_tensor(o['index']) for o in self.outs]
        boxes = next(v for v in vals if v.ndim == 3 and v.shape[-1] == 4)[0]
        count = next(v for v in vals if v.size == 1).flatten()[0]
        rest = [v[0] for v in vals if v.ndim == 2 and v.shape[0] == 1]  # classes, scores in output order
        return boxes, rest[0], rest[1], count


class MockBackend:
    """Reports a 'person' for the bounding box of near-white pixels; lets the pipeline be tested without a model."""

    name = 'mock'

    def __init__(self, size, min_score):
        self.size = size
        self.min_score = min_score

    def input_size(self):
        return self.size, self.size

    def detect(self, rgb):
        img = rgb.reshape(self.size, self.size, 3)
        ys, xs = np.nonzero(img.min(axis=2) > 200)
        if len(xs) < 16:
            return []
        n = float(self.size)
        return [{'label': 'person', 'score': 0.9,
                 'box': [round(xs.min() / n, 4), round(ys.min() / n, 4), round((xs.max() + 1) / n, 4), round((ys.max() + 1) / n, 4)]}]


def read_exact(stream, n):
    buf = bytearray()
    while len(buf) < n:
        chunk = stream.read(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return bytes(buf)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--backend', choices=['edgetpu', 'cpu', 'mock'], default='edgetpu')
    ap.add_argument('--model')
    ap.add_argument('--labels')
    ap.add_argument('--device', default='', help='edgetpu device: usb, usb:0, pci, pci:0 (default: first available)')
    ap.add_argument('--min-score', type=float, default=0.4)
    ap.add_argument('--mock-size', type=int, default=300)
    args = ap.parse_args()

    try:
        if args.backend == 'mock':
            backend = MockBackend(args.mock_size, args.min_score)
        else:
            backend = TfliteBackend(args.model, load_labels(args.labels), args.backend == 'edgetpu', args.device, args.min_score)
    except Exception as e:
        emit({'type': 'error', 'id': None, 'msg': str(e)})
        return 1

    w, h = backend.input_size()
    emit({'type': 'ready', 'backend': backend.name, 'input': [w, h]})
    expect = w * h * 3
    stdin = sys.stdin.buffer
    while True:
        head = read_exact(stdin, HEADER.size)
        if head is None:
            return 0
        magic, fid, fw, fh = HEADER.unpack(head)
        if magic != MAGIC:
            emit({'type': 'error', 'id': None, 'msg': 'bad frame header, desynchronised'})
            return 2
        payload = read_exact(stdin, fw * fh * 3)
        if payload is None:
            return 0
        if (fw, fh) != (w, h) or len(payload) != expect:
            emit({'type': 'error', 'id': fid, 'msg': f'frame {fw}x{fh} does not match model input {w}x{h}'})
            continue
        t = time.monotonic()
        try:
            dets = backend.detect(np.frombuffer(payload, dtype=np.uint8))
        except Exception as e:
            emit({'type': 'error', 'id': fid, 'msg': f'inference failed: {e}'})
            continue
        emit({'type': 'result', 'id': fid, 'ms': round((time.monotonic() - t) * 1000, 1), 'detections': dets})


if __name__ == '__main__':
    sys.exit(main())
