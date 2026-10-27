"""Protocol tests for detector/detector.py using the mock backend. Run: python3 test/test_detector.py"""
import json
import os
import struct
import subprocess
import sys
import unittest

import numpy as np

DETECTOR = os.path.join(os.path.dirname(__file__), '..', 'detector', 'detector.py')
sys.path.insert(0, os.path.dirname(DETECTOR))
import detector  # noqa: E402


def frame(fid, w, h, img):
    return struct.pack('<4sIHH', b'NVRD', fid, w, h) + img.tobytes()


class MockProtocol(unittest.TestCase):
    def setUp(self):
        self.p = subprocess.Popen([sys.executable, DETECTOR, '--backend', 'mock', '--mock-size', '64'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        self.ready = json.loads(self.p.stdout.readline())

    def tearDown(self):
        self.p.stdin.close()
        self.p.wait(5)

    def ask(self, data):
        self.p.stdin.write(data)
        self.p.stdin.flush()
        return json.loads(self.p.stdout.readline())

    def test_ready(self):
        self.assertEqual(self.ready, {'type': 'ready', 'backend': 'mock', 'input': [64, 64]})

    def test_detects_box(self):
        img = np.zeros((64, 64, 3), np.uint8)
        img[10:30, 20:40] = 255
        r = self.ask(frame(7, 64, 64, img))
        self.assertEqual((r['type'], r['id']), ('result', 7))
        self.assertEqual(r['detections'][0]['label'], 'person')
        self.assertEqual(r['detections'][0]['box'], [0.3125, 0.1562, 0.625, 0.4688])

    def test_empty_frame_and_wrong_size(self):
        self.assertEqual(self.ask(frame(1, 64, 64, np.zeros((64, 64, 3), np.uint8)))['detections'], [])
        r = self.ask(frame(2, 32, 32, np.zeros((32, 32, 3), np.uint8)))
        self.assertEqual((r['type'], r['id']), ('error', 2))


class CoralErrors(unittest.TestCase):
    def test_missing_edgetpu_gives_actionable_error(self):
        out = subprocess.run([sys.executable, DETECTOR, '--backend', 'edgetpu', '--model', '/nonexistent.tflite'], stdin=subprocess.DEVNULL, capture_output=True, timeout=30)
        msg = json.loads(out.stdout.splitlines()[0])
        self.assertEqual(msg['type'], 'error')
        self.assertNotEqual(out.returncode, 0)


class Outputs(unittest.TestCase):
    def test_ssd_postprocess_parsing(self):
        class Interp:
            def set_tensor(self, *a): pass
            def invoke(self): pass
            def get_tensor(self, i):
                return [np.array([[[.1, .2, .5, .6], [0, 0, 1, 1]]], np.float32), np.array([[0, 2]], np.float32),
                        np.array([[.9, .3]], np.float32), np.array([2], np.float32)][i]
        b = detector.TfliteBackend.__new__(detector.TfliteBackend)
        b.labels, b.min_score, b.h, b.w, b.in_dtype, b.in_index = detector.DEFAULT_LABELS, 0.5, 300, 300, np.uint8, 0
        b.interp, b.outs = Interp(), [{'index': i} for i in range(4)]
        self.assertEqual(b.detect(np.zeros(300 * 300 * 3, np.uint8)), [{'label': 'person', 'score': 0.9, 'box': [0.2, 0.1, 0.6, 0.5]}])

    def _backend(self, dtype, quant):
        seen = {}

        class Interp:
            def set_tensor(self, i, data): seen['data'] = data
            def invoke(self): pass
            def get_tensor(self, i):
                return [np.zeros((1, 1, 4), np.float32), np.zeros((1, 1), np.float32), np.zeros((1, 1), np.float32), np.array([0], np.float32)][i]
        b = detector.TfliteBackend.__new__(detector.TfliteBackend)
        b.labels, b.min_score, b.h, b.w, b.in_dtype, b.in_index, b.in_quant = detector.DEFAULT_LABELS, 0.5, 2, 2, dtype, 0, quant
        b.interp, b.outs = Interp(), [{'index': i} for i in range(4)]
        return b, seen

    def test_input_types(self):
        px = np.array([0, 127, 128, 255] * 3, np.uint8)
        b, seen = self._backend(np.uint8, (0.0078125, 128))
        b.detect(px)
        self.assertEqual(seen['data'].dtype, np.uint8)
        self.assertEqual(seen['data'].reshape(-1)[:4].tolist(), [0, 127, 128, 255])
        b, seen = self._backend(np.int8, (0.0078125, -1))
        b.detect(px)
        self.assertEqual(seen['data'].dtype, np.int8)
        self.assertEqual(seen['data'].reshape(-1)[:4].tolist(), [-128, -2, 0, 127])
        b, seen = self._backend(np.float32, (0.0, 0))
        b.detect(px)
        self.assertEqual(seen['data'].dtype, np.float32)
        self.assertAlmostEqual(float(seen['data'].reshape(-1)[0]), -1.0)

    def test_labels_file_formats(self):
        import tempfile
        with tempfile.NamedTemporaryFile('w', suffix='.txt', delete=False) as f:
            f.write('0  person\n2  car\n')
        self.assertEqual(detector.load_labels(f.name), {0: 'person', 2: 'car'})
        with tempfile.NamedTemporaryFile('w', suffix='.txt', delete=False) as f:
            f.write('person\nbicycle\n')
        self.assertEqual(detector.load_labels(f.name), {0: 'person', 1: 'bicycle'})
        self.assertEqual(detector.DEFAULT_LABELS[0], 'person')
        self.assertEqual(detector.DEFAULT_LABELS[2], 'car')


if __name__ == '__main__':
    unittest.main()
