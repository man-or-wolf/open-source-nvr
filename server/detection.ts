import { detector } from './detector_client.js'
import type { DetectorConfig } from './detector_client.js'
import { DetectPipeline } from './detect.js'
import type { DetectSettings } from './detect.js'
import { mqttPublisher } from './mqtt.js'
import { go2rtc } from './go2rtc.js'
import { auth, cameraCache, pipelines, shared } from './state.js'
import type { CameraEntry, Settings } from './types.js'

export const SECRET_PLACEHOLDER = '********'

export function detectorConfig(s: Settings): DetectorConfig {
    return {
        type: s.detector_type || 'none',
        device: s.detector_device,
        model: s.detector_model,
        labels: s.detector_labels,
        python: s.detector_python
    }
}

// Stream used to record: rtsp cameras use their rtsp_url (via go2rtc when running)
export function recordUrl(key: string, ce: CameraEntry): string | undefined {
    return ce.rtsp_url ? go2rtc.url(key, ce.rtsp_url) : undefined
}

// Stream used for detection: detect_url (sub stream) if given, else the recording stream
export function detectUrl(key: string, ce: CameraEntry): string | undefined {
    if (ce.detect_url) return go2rtc.url(key + '_detect', ce.detect_url)
    return recordUrl(key, ce)
}

export function stopPipeline(key: string) {
    pipelines[key]?.pipe.stop()
    delete pipelines[key]
}

// Called every second: starts/stops/restarts detection pipelines to match camera and detector config
export function syncDetection() {
    const dc = detectorConfig(shared.settingsCache.settings)
    for (const key of Object.keys(cameraCache)) {
        const ce = cameraCache[key].ce
        const url = detectUrl(key, ce)
        const wanted = !ce.delete && ce.enable_streaming && ce.enable_movement && ce.detect_enabled && dc.type !== 'none' && url
        if (!wanted) {
            if (pipelines[key]) stopPipeline(key)
            continue
        }
        const { ip, passwd, rtsp_url, detect_url, ...rest } = ce
        const sig = JSON.stringify([url, pickDetect(rest)])
        if (pipelines[key]?.sig === sig) continue
        stopPipeline(key)
        const pipe = new DetectPipeline(ce.name, url as string, pickDetect(ce))
        pipe.on('motion', (on: boolean) => mqttPublisher.motion(ce.name, on))
        pipe.on('objects', (changed: any, all: any) => mqttPublisher.objects(ce.name, changed, all))
        pipelines[key] = { pipe, sig }
        mqttPublisher.registerCamera(ce.name)
        pipe.start()
    }
    for (const key of Object.keys(pipelines)) {
        if (!cameraCache[key]) stopPipeline(key)
    }
}

export function pickDetect(ce: DetectSettings): DetectSettings {
    const { detect_enabled, detect_fps, detect_width, track_objects, min_score, require_object, motion_threshold, motion_area, motion_mask, object_mask, zones } = ce
    return { detect_enabled, detect_fps, detect_width, track_objects, min_score, require_object, motion_threshold, motion_area, motion_mask, object_mask, zones }
}

// go2rtc streams for every rtsp source we know about
export async function syncGo2rtc() {
    const streams: { [name: string]: string[] } = {}
    for (const key of Object.keys(cameraCache)) {
        const ce = cameraCache[key].ce
        if (ce.delete) continue
        if (ce.rtsp_url) streams[key] = [ce.rtsp_url]
        if (ce.detect_url) streams[key + '_detect'] = [ce.detect_url]
    }
    try {
        await go2rtc.sync(shared.settingsCache.settings.go2rtc_path, process.env['DBPATH'] || './mydb', streams)
    } catch (e) {
        console.warn(`go2rtc sync failed: ${e}`)
    }
}

export function clientConfig() {
    const { settings, status } = shared.settingsCache
    return { settings: { ...settings, mqtt_password: settings.mqtt_password ? SECRET_PLACEHOLDER : '' }, status }
}

export function systemStatus() {
    return {
        detector: detector.status,
        go2rtc: { enabled: !!shared.settingsCache.settings.go2rtc_path, running: go2rtc.running, error: go2rtc.error },
        mqtt: { enabled: !!shared.settingsCache.settings.mqtt_url, connected: mqttPublisher.connected, error: mqttPublisher.error },
        auth: { enabled: auth.enabled }
    }
}

// start/stop the things that depend on settings
export function applySettings(s: Settings, previous?: Settings) {
    const before = previous ? JSON.stringify(detectorConfig(previous)) : ''
    const now = JSON.stringify(detectorConfig(s))
    if (before !== now) {
        detector.start(detectorConfig(s))
        // pipelines are rebuilt by syncDetection with the new model input size
        for (const key of Object.keys(pipelines)) stopPipeline(key)
    }
    mqttPublisher.configure(s)
    syncGo2rtc()
}
