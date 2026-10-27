import { spawn } from 'child_process'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import fs from 'fs/promises'
import server_fetch from './server_fetch.js'
import { backoffMs } from './backoff.js'
import { JobStatus, JobTask } from './jobmanager.js'
import type { JobManager, JobReturn, JobData } from './jobmanager.js'
import { mqttPublisher } from './mqtt.js'
import { cameraCache, movementdb, pipelines, recordFailures, shared } from './state.js'
import { re, maskSecrets, rtspRecordArgs } from './util.js'
import { recordUrl } from './detection.js'
import type { MLData, MovementEntry, ProcessInfo } from './types.js'

export async function jobWorker(seq: number, d: JobData): Promise<JobReturn> {

    let newJob: JobData | null = null
    if (d.task === JobTask.ML) {

        const m: MovementEntry = await movementdb.get(d.movement_key)
        let new_movement: MovementEntry = {...m}
        const c = cameraCache[m.cameraKey].ce
        const input = `${c.disk}/${c.folder}/image${d.movement_key}.jpg`
        const outpic = `${c.disk}/${c.folder}/mlimage${d.movement_key}.jpg`
        await new Promise((acc, _rej) => {
            let ml_stdout = '', ml_stderr = '', ml_error = ''
            // './darknet', ['detect', 'cfg/yolov3.cfg', 'cfg/yolov3.weights', input]
            let [cmd, ...rest] = shared.settingsCache.settings.mlCmd.split(' ')
            const ml_task = spawn(cmd, rest.map(a => a === '{in}' ? input : a === '{out}' ? outpic : a), { cwd: shared.settingsCache.settings.mlDir, timeout: 120000 });

            ml_task.stdout.on('data', (data: string) => { ml_stdout += data })
            ml_task.stderr.on('data', (data: string) => { ml_stderr += data })
            ml_task.on('error', async (error: Error) => { ml_error = `${error.name}: ${error.message}` })

            // The 'close' event will always emit after 'exit' was already emitted, or 'error' if the child failed to spawn.
            ml_task.on('close', async (ml_code: number) => {
                const ml_succcess = ml_code === 0
                const ml: MLData = { success: ml_succcess, code: ml_code, ...(!ml_succcess && {stderr: ml_stderr}), stdout: ml_stdout, error: ml_error, tags: [] }
                new_movement = {...new_movement, ml}

                if (ml_succcess) {
                    let mltags = ml_stdout.match(/([\w]+): ([\d]+)%/g)
                    const tags = mltags? mltags.map(d => { const i = d.indexOf(': '); return { tag: d.substr(0, i), probability: parseInt(d.substr(i + 2, d.length - i - 3)) } }) : []
                    new_movement = {...new_movement, ml: {...ml, tags}}
                    await movementdb.put(d.movement_key, new_movement)

                    //let mv_stdout = '', mv_stderr = '', mv_error = ''
                    //const mv_task = spawn('/usr/bin/mv', [`${shared.settingsCache.settings.mlDir}/predictions.jpg`, outpic], { timeout: 5000 })

                    //mv_task.stdout.on('data', (data: string) => { mv_stdout += data })
                    //mv_task.stderr.on('data', (data: string) => { mv_stderr += data })
                    //mv_task.on('error', async (error: Error) => { mv_error = `${error.name}: ${error.message}` })

                    //mv_task.on('close', async (mv_code: number) => {
                    //    const mv_succcess = mv_code === 0
                    //    await movementdb.put(d.movement_key, { ...new_movement, ml_movejpg: { success: mv_succcess, ...(!mv_succcess && {stderr: mv_stderr, stdout: mv_stdout, error: mv_error }) }})
                        acc(0)
                    //})

                } else {
                    await movementdb.put(d.movement_key, new_movement)
                    acc(ml_code)
                }

            });

        })

    } else if (d.task === JobTask.Snapshot) {
        // Take a single frame snapshot to corispond to the start of the movement segment recorded in startSegment.
        // -ss seek to the first frame in the segment file

        const m: MovementEntry = await movementdb.get(d.movement_key)
        const c = cameraCache[m.cameraKey].ce

        // the segment after the start is the first one that has the movement; if it was never finished
        // (crash, camera dropped) use the one that was being written, then the one before
        let segment = m.startSegment + 1
        for (const candidate of [m.startSegment + 1, m.startSegment, m.startSegment - 1]) {
            if (await fs.access(`${c.disk}/${c.folder}/stream${candidate}.ts`).then(() => true, () => false)) { segment = candidate; break }
        }

        const code = await new Promise((acc, _rej) => {

            var ffmpeg = spawn('/usr/bin/ffmpeg', ['-y', '-ss', '0', '-i', `${c.disk}/${c.folder}/stream${segment}.ts`, '-hide_banner', '-loglevel', 'error', '-frames:v', '1', '-q:v', '2', `${c.disk}/${c.folder}/image${d.movement_key}.jpg`], { timeout: 120000 });
            let ff_stdout = '', ff_stderr = '', ff_error = ''

            ffmpeg.stdout.on('data', (data: string) => { ff_stdout += data })
            ffmpeg.stderr.on('data', (data: string) => { ff_stderr += data })
            ffmpeg.on('error', async (error: Error) => { ff_error = `${error.name}: ${error.message}` })

            ffmpeg.on('close', async (ff_code: number) => {
                const ff_succcess = ff_code === 0
                await movementdb.put(d.movement_key, { ...m, ffmpeg: { success: ff_succcess, ...(!ff_succcess && {stderr: ff_stderr, stdout: ff_stdout, error: ff_error })} })
                if (ff_succcess && shared.settingsCache.settings.enable_ml && !m.ml) {
                    newJob = { task: JobTask.ML, movement_key: d.movement_key }
                }
                acc(ff_code)
            });
        })
    }
    return { seq, status: JobStatus.Success, ...(newJob ? { newJob } : {}) }
}

// running events are saved this often (seconds), see processMovement
export const PROGRESS_SAVE_SECONDS = 10

 // Called every seond for each camera, to process movement
export async function processMovement(cameraKey: string, jobManager: JobManager) : Promise<void> {

    const { movementStatus, ce } = cameraCache[cameraKey]
    // curcuit breaker, if movement error recorded from API, dont try again, until after check_after!
    if (movementStatus?.in_progress || (movementStatus?.fail && ( (!movementStatus.check_after) || movementStatus.check_after > Date.now())) ) {
            return
    }

    // prevent multiple movement processes from running at the same time (needed with setInterval)
    cameraCache[cameraKey] = {...cameraCache[cameraKey],  movementStatus: {...cameraCache[cameraKey].movementStatus, in_progress: true}}

    const {ip, passwd, disk, folder, secWithoutMovement, secMaxSingleMovement} = ce
    try {

        const current_movement = movementStatus?.current_movement

        // Motion source: built-in detection (motion + objects) when enabled, otherwise the camera's own motion API
        const pipe = pipelines[cameraKey]?.pipe
        let moving: boolean
        if (pipe) {
            moving = pipe.state.active
        } else if (ce.camera_type === 'rtsp') {
            cameraCache[cameraKey] = {...cameraCache[cameraKey], movementStatus: {...movementStatus, in_progress: false, fail: false, status: 'no motion source, enable built-in detection and set a detector in settings'}}
            return
        } else {
            const body_json = await server_fetch(`http://${ip}/api.cgi?cmd=GetMdState&user=admin&password=${passwd}`, {timeout: 2000})

            // camera content type response is "text/html" even though its json :)
            const body = JSON.parse(body_json)
            //console.log(body[0].value)
            if (body[0].error) {
                cameraCache[cameraKey] = {...cameraCache[cameraKey],  movementStatus: {fail: true, in_progress: false, status: `fetch movement error: ${JSON.stringify(body)}`, check_after: Date.now() + (30 * 1000)}}
                return
            }
            moving = body[0].value.state === 1
        }

        if (moving) {
            // Got movement (state ===1)
            if (!current_movement) {
                // got NEW movement
                console.log(`processMovement: Got NEW movement (${cameraCache[cameraKey].ce.name})`)
                const startDate = Date.now()
                mqttPublisher.event({ type: 'new', camera: ce.name, key: (startDate / 1000 | 0) - 1600000000, start_time: startDate, labels: pipe ? pipe.state.objects.map(o => o.label) : [] })

                // Need to determine the segment that corrisponds to the movement
                // Read the curren live stream.m3u8, and get a array of all the stream23059991.ts files
                // set startSegment to the LAST segment file index in the array (most recent) + 1 (+1 due to ffmpeg lag!)
                const filepath = `${disk}/${folder}/stream.m3u8`
                const hls = (await fs.readFile(filepath)).toString()
                const hls_segments = [...hls.matchAll(re)].map(m => m[1])
                const targetduration = hls.match(/#EXT-X-TARGETDURATION:([\d])/)
                const lhs_seg_duration_seq = parseInt(targetduration && targetduration.length>1? targetduration[1]: "2")

                const started: MovementEntry = {
                    cameraKey,
                    startDate,
                    startSegment: parseInt(hls_segments[hls_segments.length - 1]) + 1,
                    lhs_seg_duration_seq,
                    seconds: 1,
                    consecutivesecondswithout: 0
                }
                // stored right away (and refreshed below), a crash then keeps the event
                await movementdb.put((startDate / 1000 | 0) - 1600000000, { ...started, ongoing: true })

                cameraCache[cameraKey] = {...cameraCache[cameraKey], movementStatus: {
                    in_progress: false, fail: false, status: "new movement detected",
                    current_movement: started
                }}
            } else {
                // continuatation of same movment event
                console.log(`processMovement: continuatation movement (${cameraCache[cameraKey].ce.name}) (${current_movement.seconds + 1 + current_movement.consecutivesecondswithout}s)`)

                const continued: MovementEntry = {
                    ...current_movement,
                    seconds: current_movement.seconds + 1 + current_movement.consecutivesecondswithout,
                    consecutivesecondswithout: 0
                }
                if (continued.seconds % PROGRESS_SAVE_SECONDS < current_movement.seconds % PROGRESS_SAVE_SECONDS || current_movement.seconds === 1) {
                    const tags = pipe ? pipe.peekTags() : []
                    await movementdb.put((current_movement.startDate / 1000 | 0) - 1600000000, { ...continued, ongoing: true, ...(tags.length > 0 && { ml: { success: true, code: 0, stdout: '', stderr: '', error: '', tags } }) })
                }

                cameraCache[cameraKey] = {...cameraCache[cameraKey], movementStatus: {
                    ...movementStatus,
                    in_progress: false, fail: false, status: "continuatation of same movment event",
                    current_movement: continued
                }}
            }
        } else {
            // no movement from camera
            if (current_movement) {
                // got current movement
                if (current_movement.consecutivesecondswithout > secWithoutMovement || current_movement.seconds > (secMaxSingleMovement || 600)) {

                    console.log(`processMovement:  movement complete (${cameraCache[cameraKey].ce.name}) (${current_movement.seconds}s)`)

                    // no movement for too long, end movement and queue Job for Image processing
                    const movement_key = (current_movement.startDate / 1000 | 0) - 1600000000
                    const tags = pipe ? pipe.takeTags() : []
                    const entry: MovementEntry = tags.length > 0 ? { ...current_movement, ml: { success: true, code: 0, stdout: '', stderr: '', error: '', tags } } : current_movement
                    await movementdb.put(movement_key, entry)
                    mqttPublisher.event({ type: 'end', camera: ce.name, key: movement_key, start_time: current_movement.startDate, end_time: Date.now(), labels: tags.map(t => t.tag), tags })

                    await jobManager.submit({ task: JobTask.Snapshot, movement_key })

                    cameraCache[cameraKey] = {...cameraCache[cameraKey],  movementStatus: {
                        in_progress: false, fail: false, status: "movement ended, recorded to database key=${movement_key}",
                    }}

                } else {
                    // still same movement, incremenet consecutive seconds without movement
                    cameraCache[cameraKey] = {...cameraCache[cameraKey],  movementStatus: {
                        ...movementStatus,
                        in_progress: false, fail: false, status: "continuatation of same movment event (within consecutivesecondswithout)",
                        current_movement: {
                            ...movementStatus.current_movement,
                            consecutivesecondswithout: current_movement.consecutivesecondswithout + 1
                    }}}
                }
            } else {
                cameraCache[cameraKey] = {...cameraCache[cameraKey],  movementStatus: {
                    ...movementStatus,
                    in_progress: false, fail: false, status: "no current movement"
                }}
            }
        }
    } catch (e) {
        const filtersensitive = e?.message ? [passwd, ip].filter(x => x).reduce((m: string, secret) => m.replaceAll(secret as string, "****"), e.message) : e
        console.warn (`${new Date()}: processMovement failed error: cameraKey=${cameraKey}, name=${cameraCache[cameraKey]?.ce?.name}  message=${filtersensitive}`)
        cameraCache[cameraKey] = { ...cameraCache[cameraKey],  movementStatus: {
            ...movementStatus, 
            fail: true, in_progress: false,
            check_after: Date.now() + (30 * 1000),
            status: filtersensitive}}
        //console.error(e)
    }
}

// run every second to start new cameras, and ensure steaming is working for running cameras
export async function StreamingController(cameraKey: string): Promise<ProcessInfo | undefined> {
    //console.log (`StreamingController for ${cameraKey}`)
    const { ce, ffmpeg_process } = cameraCache[cameraKey]
    const streamFile = `${ce.disk}/${ce.folder}/stream.m3u8`

    // chkecFFMpeg still running from last interval, skip this check.
    // Protects duplicate running if this function takes longer than 1 second
    if (ffmpeg_process?.in_progress) {
        return ffmpeg_process
    }

    // No streaming enabled, and processes is running then kill it
    if (!ce.enable_streaming) {
        if (ffmpeg_process?.running) {
            ffmpeg_process.taskid?.kill();
        }
        return ffmpeg_process
    }

    // check if ffmpeg has stopped, or has shopped producing output
    if (ffmpeg_process) {
        // check the output from ffmpeg, if no updates in the last 10seconds, the process could of hung! so restart it.
        if (ffmpeg_process.check_after && ffmpeg_process.check_after < Date.now())   {
            
            if (ffmpeg_process.running) {
                console.log (`Checking ffmpeg for [${ce.name}] running=${ffmpeg_process.running} error=${ffmpeg_process.error}...`)
                try {
                    const {mtimeMs} = await fs.stat(streamFile),
                           last_updated_ago = Date.now() - mtimeMs
                    if (last_updated_ago > 10000 /* 10 seconds */) {
                        console.warn (`ffmpeg no output for 10secs for ${ce.name} - file ${streamFile}, kill process`)
                        // kill, should trigger ffmpeg.on('close') thus shoud trigger check_after error nexttime around
                        ffmpeg_process.taskid?.kill();
                    } else {
                        // its running fine, recheck in 30secs
                        console.log (`Checking ffmpeg for [${ce.name}], all good, last_updated_ago=${last_updated_ago}mS, check again in 1minute`)
                        cameraCache[cameraKey].ffmpeg_process = {...cameraCache[cameraKey].ffmpeg_process as ProcessInfo, check_after: Date.now() + 60000}
                    }
                } catch (e) {
                    console.warn (`cannot access ffmpeg output for ${ce.name} - file ${streamFile}, kill process`)
                    // kill, should trigger ffmpeg.on('close') thus shoud trigger check_after error nexttime around
                    ffmpeg_process.taskid?.kill();
                }

                return cameraCache[cameraKey].ffmpeg_process as ProcessInfo

            } else {
                console.warn (`Try to restart failed or stopped ffmpeg for [${ce.name}] running=${ffmpeg_process.running} error=${ffmpeg_process.error}`)
            }
        } else {
            // not time to re-check, just leave it
            return ffmpeg_process
        }
    }

    // start ffmpeg
    try {
        let ffmpegArgs: string[] | null = null
        if (ce.camera_type === 'rtsp') {
            const url = recordUrl(cameraKey, ce)
            if (!url) throw new Error('rtsp_url not set')
            ffmpegArgs = rtspRecordArgs(url, ce, streamFile)
            cameraCache[cameraKey] = {...cameraCache[cameraKey], ffmpeg_process: {taskid: null, running: false, error: false, in_progress: true, status: 'Starting'}}
        } else {
            console.log ((new Date()).toTimeString().substring(0,8) + ` Getting token for [${ce.name}]...`)
            cameraCache[cameraKey] = {...cameraCache[cameraKey], ffmpeg_process: {taskid: null, running: false, error: false, in_progress: true, status: 'Getting token'}}

            const body_json = await server_fetch(`http://${ce.ip}/cgi-bin/api.cgi?cmd=Login&token=null`, {timeout: 5000}, [{"cmd":"Login","action":0,"param":{"User":{"userName":"admin","password": ce.passwd}}}])
            const body = JSON.parse(body_json)
            if (body[0].error) {
                cameraCache[cameraKey] = {...cameraCache[cameraKey], ffmpeg_process: {taskid: null, running: false, error: true, in_progress: false, status: `Unable to retrive token: ${JSON.stringify(body[0])}`, check_after: Date.now() + 60000}}
            } else {
                const token = body[0].value.Token.name
                ffmpegArgs = ['-r', '25', '-i', `rtmp://admin:${ce.passwd}@${ce.ip}/bcs/channel0_main.bcs?token=${token}&channel=0&stream=0`, '-hide_banner', '-loglevel', 'error', '-vcodec', 'copy', '-start_number', ((Date.now() / 1000 | 0) - 1600000000).toString(), streamFile ]
            }
        }
        if (ffmpegArgs) {
            console.log ((new Date()).toTimeString().substring(0,8) + ` starting ffmpeg for [${ce.name}] : ${streamFile}...`)
            var ffmpeg : ChildProcessWithoutNullStreams = spawn('/usr/bin/ffmpeg', ffmpegArgs)
            cameraCache[cameraKey] = {...cameraCache[cameraKey], ffmpeg_process: {taskid: ffmpeg, running: true, error: false, in_progress: false, status: 'Starting...\n', check_after: Date.now() + 60000 /* check it hasn't hung every 30seconds */}}

            ffmpeg.stdout.on('data', (data: string) => {
                console.log (`ffmpeg stdout [${ce.name}]: ${data}`)
                cameraCache[cameraKey] = {...cameraCache[cameraKey], ffmpeg_process: {...cameraCache[cameraKey].ffmpeg_process, status: cameraCache[cameraKey].ffmpeg_process?.status + data.toString()} as ProcessInfo}
            })
            ffmpeg.stderr.on('data', (data: string) => {
                console.warn (`ffmpeg stderr [${ce.name}]: ${maskSecrets(data.toString())}`)
                cameraCache[cameraKey] = {...cameraCache[cameraKey], ffmpeg_process: {...cameraCache[cameraKey].ffmpeg_process, status: cameraCache[cameraKey].ffmpeg_process?.status + `StdErr: ${maskSecrets(data.toString())}`} as ProcessInfo}
            })
            ffmpeg.on('error', async (error: Error) => { 
                console.warn (`ffmpeg on-error [${ce.name}]: ${error.name}: ${error.message}`)
                cameraCache[cameraKey] = {...cameraCache[cameraKey], ffmpeg_process: {...cameraCache[cameraKey].ffmpeg_process, status: cameraCache[cameraKey].ffmpeg_process?.status + `Error: ${error.name}: ${error.message}`} as ProcessInfo}
            })

            const startedAt = Date.now()
            ffmpeg.on('close', async (code: number) => {
                // died quickly = camera down or bad url: retry after 1s, 2s, 4s ... up to a minute. Ran for a while = retry now.
                const failures = Date.now() - startedAt > 30000 ? 0 : (recordFailures[cameraKey] || 0) + 1
                recordFailures[cameraKey] = failures
                const delay = backoffMs(failures, 1000, 60000)
                console.warn ((new Date()).toTimeString().substring(0,8) + ` ffmpeg on-close [${ce.name}]: code=${code}${delay ? `, retry in ${Math.round(delay / 1000)}s` : ''}`)
                cameraCache[cameraKey] = {...cameraCache[cameraKey], ffmpeg_process: {...cameraCache[cameraKey].ffmpeg_process, taskid: null, running: false, error: code !== 0, check_after: Date.now() + delay}}
            });
        }

        
    } catch (e) {
        console.warn ((new Date()).toTimeString().substring(0,8) + ` FFMpeg catch error [${ce.name}]: ${e}, try again in 1minute`)
        cameraCache[cameraKey] = {...cameraCache[cameraKey], ffmpeg_process: {...cameraCache[cameraKey].ffmpeg_process, running: false, error: true, in_progress: false, status: e?.message, check_after: Date.now() + 60000}}
    }

    return  cameraCache[cameraKey].ffmpeg_process as ProcessInfo
}
