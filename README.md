


#  Open-Source Network Video Recorder (NVR), with Object Detection

Web application to monitor your IP Security Camera network, continuously record camera feeds to your computers harddrive, and monitor motion events through a web app. Features include:

  :heavy_check_mark:  No expensive hardware required, use your old computers & harddrives \
  :heavy_check_mark:  Supports one or multiple cameras, with single, filtered, motion list \
  :heavy_check_mark:  No cloud account required, self-contained \
  :heavy_check_mark:  Enhance your Cameras motion detection with Object Detection tagging/filtering \
  :heavy_check_mark:  Continuously monitors hardrives, deleting the oldest video segments when almost full \
  :heavy_check_mark:  Any RTSP camera, with built-in motion + real-time object detection (Google Coral TPU, or CPU) \
  :heavy_check_mark:  Zones and masks, drawn over a camera snapshot \
  :heavy_check_mark:  Login (admin / viewer users), MQTT + Home Assistant discovery, optional go2rtc restream & low latency live view



<p align="center">
  <img width="700"  src="./assets/wenui.png">
</p>

> **_NOTE:_** This repo was developed with Reolink POE cameras, that provided a RTMP endpoint, and a API for motion detection. Reolink cameras still work that way. Any other camera works as type **RTSP**, using the built-in detection below.

### Built-in detection (RTSP cameras, Coral TPU)

For cameras of type **RTSP** (or a Reolink camera given a detection stream url) the app does its own detection, so no camera motion API is needed:

1. ffmpeg decodes a (preferably low resolution) *detection stream* at `detect fps` (default 5), at the *detection resolution* (default 640 wide, keeping the camera's aspect ratio).
2. Frame-difference **motion detection** (running average, with motion masks) decides when to look, and where.
3. Square crops around the moving areas (and around objects already being tracked, which may have stopped) are resized to the model's input size and sent to the **object detector** (`detector/detector.py`, a python sidecar the server starts), with Google Coral EdgeTPU, or TFLite on the CPU. Crops find small and distant objects that a squashed full frame would lose. A higher detection resolution helps with small objects, at some CPU cost. ffmpeg only runs while the detector is up.
4. A tracked object (default person, car, dog, cat) inside a zone starts an event, which is recorded with its tags (shown in the list, filterable like before). Events end after `Continuation if no movement` seconds.

Running events are saved every 10s, and an event that was running when the server stopped (crash, power loss) is recovered at the next start. Failing cameras, ffmpeg and detector processes are retried with growing delays (up to a minute), so a dead camera or a missing Coral does not spin the CPU.

Recording is a stream copy of the main stream, so the CPU cost is only the low resolution detection stream. Use the camera's sub stream as the *Detection stream url*. HLS segments are cut on keyframes, set the camera's keyframe interval to 2s (or less) so segments are about 2s.

#### Google Coral setup

The detector needs the Edge TPU runtime and a python with a TFLite runtime. On Debian/Ubuntu:

```
# Edge TPU runtime (use libedgetpu1-max for max clock, it gets hot)
echo "deb https://packages.cloud.google.com/apt coral-edgetpu-stable main" | sudo tee /etc/apt/sources.list.d/coral-edgetpu.list
curl https://packages.cloud.google.com/apt/doc/apt-key.gpg | sudo gpg --dearmor -o /etc/apt/trusted.gpg.d/coral.gpg
sudo apt update && sudo apt install libedgetpu1-std      # USB and PCIe/M.2 (PCIe also needs the gasket driver)

# python environment for the detector (tflite-runtime supports Python 3.7-3.11)
python3 -m venv /opt/nvr-venv
/opt/nvr-venv/bin/pip install -r detector/requirements.txt

# models (SSD MobileNet v2, COCO, 300x300)
./detector/get_models.sh
```

Then in **Settings**: Detector = *Google Coral TPU*, Coral device (leave on *First available* with one Coral; `usb`, `usb:1`, `pci` ... otherwise), Model = `<repo>/detector/models/ssd_mobilenet_v2_coco_quant_postprocess_edgetpu.tflite`, Python = `/opt/nvr-venv/bin/python`. The status line under the detector shows the backend and inference time once it is running. If it shows an error, it is the message from the Edge TPU library (missing library, device not found, permissions).

* USB: the user running the server needs access to the device (the `libedgetpu1-std` package installs the udev rules; replug the Coral after installing). In Docker pass `--device /dev/bus/usb`.
* PCIe / M.2: install the `gasket-dkms` driver, the device appears as `/dev/apex_0`; in Docker pass `--device /dev/apex_0`.
* Newer python versions: `ai-edge-litert` is used if `tflite_runtime` is not installed, but the Edge TPU delegate is only known to work with `tflite-runtime`/`pycoral` builds, use Python 3.9-3.11 for the Coral.
* Several Corals: list the devices separated by commas (`usb:0,usb:1`), one detector process is started per device and cameras share them. Each camera has at most one frame waiting, always its newest, so a busy camera cannot starve the others.
* Objects that are not moving are only re-checked once a second, motion is checked at the full detection rate.
* Models with float32, uint8 or int8 inputs work.
* No Coral? Detector = *CPU* with the non-edgetpu model works, but is slow (use a lower detect fps).

Any custom SSD model with the standard 4 outputs (boxes, classes, scores, count) works, set *Labels file* if it is not COCO.

The older darknet/YOLO option below still works for Reolink cameras using their motion API.

### Zones and masks

Edit a camera, then **Zones and masks**. A snapshot of the camera is shown to draw on:

* **Zone**: when a camera has zones, an object only counts if its bottom centre is inside a zone (optionally only for the listed object types). Names are shown on the events.
* **Motion mask**: motion in this area is ignored (trees, timestamps, a busy road).
* **Object mask**: detections whose centre is in this area are ignored (a parked car).

### MQTT and Home Assistant

Set the broker url in **Settings** (e.g. `mqtt://192.168.1.5:1883`). Topics (prefix `nvr` by default):

| Topic | Payload |
|---|---|
| `nvr/available` | `online` / `offline` |
| `nvr/<camera>/motion` | `ON` / `OFF` |
| `nvr/<camera>/<label>`, `nvr/<camera>/all` | number of objects currently seen |
| `nvr/events` | JSON when an event starts (`type: new`) and ends (`type: end`, with tags and zones) |
| `nvr/stats` | JSON detector and camera stats, every 30s |

With *Home Assistant MQTT discovery* on, each camera shows up as a motion sensor plus person/car/dog/cat/all count sensors.

### Authentication

Login is required. On first start an `admin` user is created, with the password from `NVR_ADMIN_PASSWORD` if set, otherwise a random one that is printed once in the server log (`journalctl -u open-source-nvr.service | grep "auth:"`). Change it in the app (Settings menu, *Users and password*). *Viewers* can watch and download, *admins* can change settings and manage users. API clients can use HTTP basic auth.

| Variable | |
|---|---|
| `NVR_ADMIN_USER`, `NVR_ADMIN_PASSWORD` | initial admin (only used when there are no users yet) |
| `NVR_AUTH=off` | disable login, only if something in front of the app (VPN, authenticating proxy) does it |
| `TRUST_PROXY=1` | when behind a TLS terminating proxy (nginx), so the session cookie is marked `Secure` |
| `PORT` | listen port, default 8080 |

Use TLS (nginx/Caddy) if the app is reachable from outside your network, the login is otherwise sent in clear text.

Notes:
* Logins are limited to 5 failures a minute per address. Behind a reverse proxy set `TRUST_PROXY=1`, otherwise every user looks like the proxy (the server logs a warning when it sees `X-Forwarded-For` without it).
* Changing a password ends all other sessions of that user. Sessions last 7 days and expired ones are purged hourly.
* A Content-Security-Policy is sent (scripts, styles and video only from the app itself, the icon font from the Fluent CDN). Set `HSTS=1` when you serve it over HTTPS only.
* Camera passwords are stored in the database and appear in the ffmpeg command line (visible to other local users with `ps`). Mount `/proc` with `hidepid=2`, or use go2rtc below, then only `rtsp://127.0.0.1:8554/...` is on the command line.
* Admins can set programs the server runs (detector python, go2rtc binary, darknet command): only give the admin role to people you trust with the machine.

### RTSP restream and live view (go2rtc)

Optional. Download a [go2rtc](https://github.com/AlexxIT/go2rtc/releases) binary and set its path in **Settings**. Cameras with an RTSP url are then restreamed on `rtsp://127.0.0.1:8554/<camera id>`: the recording and detection read from there so the camera only has one connection, and the live view uses low latency MSE instead of HLS (lower latency than HLS). Only the live view script and websocket are exposed to the browser, behind the login.

### Object Detection (darknet)

In addition, if your cameras motion sensor triggers a detection, the app will take a still of the detection, and run a Object Detection process, to tag the still with the objects in the picture.  You can then use these tags to filter and review your motion events.  This is very useful to avoid false positives, like the sun going behind a cloud, or a rain shower.

<p align="center">
  <img width="450"  src="./assets/objectdetection.png">
</p>

### Settings

Using the settings menu, you first select the disk you will be using to stream real-time video from the cameras, and if you want to use the auto-deletion featre to prevent the disk from filling up, then if you want to use the object detection feature. Then you can add your cameras

<p align="center">
  <img width="250"  src="./assets/settings1a.png"> <img width="250"   src="./assets/settings2a.png"> 
</p>

<br clear="both"/>

## Install / Setup / Run

The benifit of this app, its, its open-source, and it can be installed on any comodity h/w running linux (a free o/s operating system), techincal savvy users should be able to get this working.


### Build & Run Web App

Ensure you have `nodejs` (recommended version >= 16 LTS) and `ffmpeg` (latest version) installed.

Clone this repo onto a Linux machine, then build the app by running these commands: 


```
# install dependencies
npm i

# build typescript server
npx tsc

# build fromend
npm run-script build
```

### To manually run the server

```
node ./lib/index.js
```

Then open a browser and navigate to `http://<hostname>:8080`.  You are free to use a proxy like nginx and add TLS/DNS, authenitcation, then expose your app to the internet so you can monitor your home when away


## Code layout

| | |
|---|---|
| `server/index.ts` | start-up: loads state, runs the camera loop every second |
| `server/camera.ts` | per camera: recording ffmpeg, events (movements), snapshot jobs |
| `server/detection.ts`, `detect.ts`, `detector_client.ts`, `zones.ts` | settings to pipelines, motion + crops, the detector processes, zones |
| `server/routes_api.ts`, `routes_media.ts`, `web.ts` | json api, video/images, http server with login and headers |
| `server/auth.ts`, `mqtt.ts`, `go2rtc.ts` | users and sessions, MQTT publishing, go2rtc process |
| `server/state.ts`, `types.ts`, `util.ts` | shared state (db, camera cache), types, helpers |
| `detector/detector.py` | Coral / TFLite process |
| `src/` | React UI |

## Tests

```
npm run test:e2e         # whole system with fake cameras and the mock detector (needs ffmpeg, python3 + numpy)
```

```
npm run test:server      # builds, then zones / motion / auth tests (node:test)
npm run test:detector    # detector protocol tests (python, no Coral needed)
```

## Darknet Real-time object detection

To enable the Object Detection feature, you will  need to install the following darknet/yolo project, information here: https://pjreddie.com/darknet/yolo/.  Then, go into the settings panel, enable object detection, and set the installation folder.
  
The install folder must include the following files

<pre>
.    
├── darknet (the executable)  
└── cfg (directory)  
     ├── yolov3.cfg  
     └── yolov3.weights  
</pre>
  

  
## To run the server each time the machine starts

Create a executable `web.sh` file containing the following (the paths need to be absolute):

```
#!/bin/bash
WEBPATH="/home/<user>/open-source-nvr/build" DBPATH="/home/<user>/open-source-nvr/mydb" node /home/<user>/open-source-nvr/lib/index.js
```

Now, create a `open-source-nvr.service` file for Linux Systemd service managers, to ensure your website starts when the machine starts & will be kept running

```
[Unit]
Description=open-source-nvr
Wants=network-online.target
After=network-online.target

[Service]
User=<user>
Group=<user>
Type=simple
ExecStart=/home/<user>/open-source-nvr/web.sh

[Install]
WantedBy=multi-user.target
```

Copy the `open-source-nvr.service` file to `/etc/systemd/system` , and replacing the `<user>`

Enable & run the service

```
sudo systemctl enable  open-source-nvr.service
sudo systemctl start  open-source-nvr.service
```


## Additional Systemd commands

### list services
```
systemctl --type=service
```
### list logs
```
sudo journalctl -u open-source-nvr.service -f
sudo journalctl -u open-source-nvr.service -n 100 --no-pager
```




## Example to create Logic Volume for the local files 

To create a logical volume from a volume group storage pool, use the ```lvcreate``` command. Specify the size of the logical volume with the -L option, specify a name with the -n option, and pass in the volume group to allocate the space from.

```
sudo lvcreate -L 40G -n video-files ubuntu-vg
```

format:
```
sudo mkfs -t ext4 /dev/mapper/ubuntu--vg-video--files
```

mount:

```
mkdir /video
sudo mount /dev/mapper/ubuntu--vg-video--files  /video
```

ensure its always mounted:
```
sudo vi /etc/fstab
/dev/mapper/ubuntu--vg-video--files /video ext4 defaults 0 0
```



## Video Format Info

The video encapsulation format used by all Reolink cameras is MP4. So the video's format we download via Reolink Client or Reolink app is MP4. But when using USB disk to backup videos directly from Reolink NVR, you could choose either H.264 or MP4 video files. - the compression type is H264


## The player

https://videojs.com/


HTTP Live Streaming (HLS) is a widely used protocol developed by Apple that will serve your stream better to a multitude of devices. HLS will take your stream, break it into chunks, and serve it via a specialized playlist


