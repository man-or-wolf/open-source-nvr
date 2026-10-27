#!/bin/bash
# Downloads the Coral SSD MobileNet v2 (COCO, 300x300) models and labels into ./models
set -e
cd "$(dirname "$0")"
mkdir -p models
BASE=https://github.com/google-coral/test_data/raw/master
for f in ssd_mobilenet_v2_coco_quant_postprocess_edgetpu.tflite ssd_mobilenet_v2_coco_quant_postprocess.tflite coco_labels.txt; do
    [ -f "models/$f" ] || curl -fL -o "models/$f" "$BASE/$f"
done
ls -l models
