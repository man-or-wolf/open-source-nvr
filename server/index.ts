import { detector } from './detector_client.js'
import { JobManager } from './jobmanager.js'
import { mqttPublisher } from './mqtt.js'
import { go2rtc } from './go2rtc.js'
import { auth, cameradb, cameraCache, db, pipelines, shared } from './state.js'
import { applySettings, stopPipeline, syncDetection, syncGo2rtc } from './detection.js'
import { jobWorker, processMovement, StreamingController } from './camera.js'
import { clearDownDisk, recoverEvents } from './events.js'
import { startWeb } from './web.js'
import type { CameraEntry, Settings } from './types.js'

async function main() {

    const jobman = new JobManager(db, 1, jobWorker)
    jobman.start(false)

    // Populate cameraCache
    await new Promise((res, _rej) => {
        cameradb.createReadStream()
            .on('data', (data) => {
                const { key, value } = data as {key: number, value: CameraEntry}
                cameraCache[key] = {ce: value}
            })
            .on('end', () => {
                res(0)
            })
    })

    // Populate settingsCache
    shared.settingsCache = {settings: { disk_base_dir: '',  enable_cleanup: false, mlDir:'', mlCmd:'', enable_ml: false, cleanup_interval: 120, cleanup_capacity: 99}, status: { fail: false, nextCheckInMinutes: 0}}
    try {
        shared.settingsCache = {...shared.settingsCache, settings : await db.get('settings') as Settings}
    } catch (e) {
        console.warn ('no settings defined yet')
    }

    await auth.bootstrap()
    setInterval(() => auth.purge().catch(e => console.warn(`auth purge failed: ${e}`)), 3600 * 1000)
    applySettings(shared.settingsCache.settings)
    await recoverEvents(jobman)

    // Detector + camera stats over MQTT
    setInterval(() => {
        mqttPublisher.stats({
            detector: detector.status,
            cameras: Object.fromEntries(Object.entries(pipelines).map(([k, p]) => [cameraCache[k]?.ce.name, { fps: p.pipe.state.fps, motion: p.pipe.state.motion, running: p.pipe.state.running }]))
        })
    }, 30000)

    // Start the Camera controll loop (ensuring ffmpeg is running, and checking movement) ()
    setInterval(async () => {
        syncDetection()
        await syncGo2rtc()
        for (let cKey of Object.keys(cameraCache)) {
            if (!cameraCache[cKey].ce.delete) {
                const pi = await StreamingController(cKey)
                if (pi?.running) {
                    await processMovement(cKey, jobman)
                }
            }
        }
    }, 1000)

    // Start the Disk controll loop, checking space and cleaning up disk and movements db
    setInterval(async () => {
        const { settings, status} = shared.settingsCache

        if (status.nextCheckInMinutes === 0) {
            shared.settingsCache = {...shared.settingsCache, status: {...status, nextCheckInMinutes: settings.cleanup_interval}}
            if (settings.enable_cleanup && settings.disk_base_dir) {
                try {
                    const diskres = await clearDownDisk(settings.disk_base_dir, Object.keys(cameraCache).filter(c => (!cameraCache[c].ce.delete) && cameraCache[c].ce.enable_streaming), settings.cleanup_capacity )
                    shared.settingsCache = {...shared.settingsCache, status: {...status, fail:false, error: '',  ...diskres, lastChecked: new Date()}}
                } catch(e) {
                    console.log(`disk cleanup error`, e)
                    console.warn(e)
                    shared.settingsCache = {...shared.settingsCache, status: {...status, fail: true, error: e?.message, lastChecked: new Date()}}
                }
            }
        } else {
            shared.settingsCache = {...shared.settingsCache, status: {...status,  nextCheckInMinutes: status.nextCheckInMinutes - 1}}
        }
    }, 60000)

    startWeb()

    // stop child processes (recording ffmpeg, detection, detector, go2rtc) so they don't outlive the server
    const shutdown = () => {
        for (const key of Object.keys(cameraCache)) cameraCache[key].ffmpeg_process?.taskid?.kill()
        for (const key of Object.keys(pipelines)) stopPipeline(key)
        detector.stop()
        go2rtc.stop()
        mqttPublisher.close()
        process.exit(0)
    }
    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)

    //db.close()
}

main()
