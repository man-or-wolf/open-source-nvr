# syntax=docker/dockerfile:1

# ---- build: server (tsc) and UI (react-scripts)
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY server ./server
COPY public ./public
COPY src ./src
RUN npx tsc && CI=false npm run build && npm prune --omit=dev

# ---- run
FROM node:20-bookworm-slim

# go2rtc gives low latency live view and one connection per camera (amd64 and arm64 only).
# Build with --build-arg INSTALL_GO2RTC=false to leave it out.
ARG INSTALL_GO2RTC=true
ARG GO2RTC_VERSION=1.9.4

ENV DEBIAN_FRONTEND=noninteractive

# ffmpeg: recording and detection streams; python3: detector; libedgetpu1-std: Coral runtime (USB and PCIe);
# tini: reaps the child processes. The Coral apt repository is Google's.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv curl ca-certificates gnupg tini \
 && curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/coral.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/coral.gpg] https://packages.cloud.google.com/apt coral-edgetpu-stable main" > /etc/apt/sources.list.d/coral-edgetpu.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends libedgetpu1-std \
 && rm -rf /var/lib/apt/lists/*

# python environment for the detector
COPY detector/requirements.txt /tmp/requirements.txt
RUN python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt \
 && rm /tmp/requirements.txt

# SSD MobileNet v2 (COCO, 300x300) for the Coral and for the CPU, and the labels
RUN mkdir -p /opt/models && cd /opt/models \
 && for f in ssd_mobilenet_v2_coco_quant_postprocess_edgetpu.tflite ssd_mobilenet_v2_coco_quant_postprocess.tflite coco_labels.txt; do \
      curl -fsSL -o "$f" "https://github.com/google-coral/test_data/raw/master/$f"; \
    done

RUN if [ "$INSTALL_GO2RTC" = "true" ]; then \
      arch="$(dpkg --print-architecture)" \
      && curl -fsSL -o /usr/local/bin/go2rtc "https://github.com/AlexxIT/go2rtc/releases/download/v${GO2RTC_VERSION}/go2rtc_linux_${arch}" \
      && chmod +x /usr/local/bin/go2rtc; \
    fi

WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/lib ./lib
COPY --from=build /app/build ./build
COPY detector ./detector

# database in /data, recordings in /video (set "Disk Mount Folder" to /video in the settings)
RUN mkdir -p /data /video && chown node:node /data /video
VOLUME ["/data", "/video"]

ENV NODE_ENV=production \
    PORT=8080 \
    DBPATH=/data/db \
    WEBPATH=/app/build \
    DETECTOR_PYTHON=/opt/venv/bin/python

EXPOSE 8080
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/me" > /dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "lib/index.js"]
