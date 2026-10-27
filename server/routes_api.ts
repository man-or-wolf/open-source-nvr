import fs from 'fs/promises'
import { spawn } from 'child_process'
import Router from '@koa/router'
import { COOKIE, parseCookies, validUsername, validPassword } from './auth.js'
import type { Role, Session } from './auth.js'
import { auth, cameradb, cameraCache, db, shared } from './state.js'
import { applySettings, clientConfig, detectUrl, SECRET_PLACEHOLDER, systemStatus } from './detection.js'
import { catalogVideo } from './diskcheck.js'
import { clearDownDisk } from './events.js'
import { ensureDir, maskSecrets, maskUrl, re, sanitizeCamera } from './util.js'
import { go2rtc } from './go2rtc.js'
import { movementdb, pipelines } from './state.js'
import type { CameraCacheEntry, CameraEntry, CameraEntryClient, MovementEntry, MovementToClient, Settings } from './types.js'

const snapshotsInFlight: { [cameraKey: string]: Promise<Buffer> } = {}

export function apiRoutes() {
    const api = new Router({ prefix: '/api' })
        .get('/me', async (ctx, _next) => {
            const session: Session | null = auth.enabled ? await auth.fromRequest(ctx.req) : { user: 'anonymous', role: 'admin', expires: 0 }
            ctx.body = { authEnabled: auth.enabled, user: session ? { name: session.user, role: session.role } : null }
        })
        .post('/login', async (ctx, _next) => {
            const { username, password } = ctx.request.body || {}
            if (auth.throttled(ctx.ip)) ctx.throw(429, 'too many failed attempts, try again in a minute')
            const token = await auth.login(username, password, ctx.ip)
            if (!token) ctx.throw(401, 'invalid username or password')
            ctx.cookies.set(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: ctx.secure, maxAge: 7 * 24 * 3600 * 1000, overwrite: true })
            ctx.status = 200
            ctx.body = { ok: true }
        })
        .post('/logout', async (ctx, _next) => {
            const token = parseCookies(ctx.headers.cookie)[COOKIE]
            if (token) await auth.logout(token)
            ctx.cookies.set(COOKIE, null)
            ctx.status = 200
            ctx.body = { ok: true }
        })
        // change own password
        .post('/password', async (ctx, _next) => {
            const { current, password } = ctx.request.body || {}
            const session: Session = ctx.state['session']
            if (!validPassword(password)) ctx.throw(400, 'password must be 8-200 characters')
            if (!await auth.login(session.user, current, ctx.ip).then(t => { t && auth.logout(t); return t })) ctx.throw(403, 'current password is wrong')
            await auth.setUser(session.user, password, session.role)
            // a changed password ends every other login (a stolen session cookie stops working), this one stays
            await auth.revokeSessions(session.user, parseCookies(ctx.headers.cookie)[COOKIE])
            ctx.status = 200
            ctx.body = { ok: true }
        })
        .get('/users', async (ctx, _next) => {
            ctx.body = await auth.listUsers()
        })
        .post('/users', async (ctx, _next) => {
            const { username, password, role } = ctx.request.body || {}
            if (!validUsername(username)) ctx.throw(400, 'username: letters, numbers, . _ - (max 32)')
            if (!validPassword(password)) ctx.throw(400, 'password must be 8-200 characters')
            if (role !== 'admin' && role !== 'viewer') ctx.throw(400, 'role must be admin or viewer')
            await auth.setUser(username, password, role as Role)
            await auth.revokeSessions(username)
            ctx.status = 201
        })
        .delete('/users/:name', async (ctx, _next) => {
            const name = ctx.params['name'].toLowerCase()
            const users = await auth.listUsers()
            if (name === ctx.state['session'].user) ctx.throw(400, 'cannot delete yourself')
            if (!users.some(u => u.name === name && u.role === 'admin') || users.filter(u => u.role === 'admin').length > 1) {
                await auth.deleteUser(name)
                ctx.status = 200
            } else {
                ctx.throw(400, 'cannot delete the last admin')
            }
        })
        // one frame of a camera, used by the zone/mask editor
        .get('/snapshot/:cameraKey', async (ctx, _next) => {
            const cameraKey = ctx.params['cameraKey']
            const cc = cameraCache[cameraKey]
            if (!cc || cc.ce.delete) ctx.throw(404, 'unknown camera')
            const ce = cc.ce
            let input: string[] | undefined
            const live = `${ce.disk}/${ce.folder}/stream.m3u8`
            const url = detectUrl(cameraKey, ce)
            if (url) {
                input = [...(url.startsWith('rtsp') ? ['-rtsp_transport', 'tcp'] : []), '-i', url]
            } else {
                // reolink cameras: newest recorded segment
                const hls = await fs.readFile(live).then(b => b.toString(), () => '')
                const seg = [...hls.matchAll(re)].map(m => m[1]).pop()
                if (seg) input = ['-i', `${ce.disk}/${ce.folder}/stream${seg}.ts`]
            }
            if (!input) ctx.throw(404, 'no stream available yet')
            // requests for the same camera share one ffmpeg
            const frame = snapshotsInFlight[cameraKey] = snapshotsInFlight[cameraKey] || new Promise<Buffer>((res, rej) => {
                const ff = spawn('/usr/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', ...(input as string[]), '-frames:v', '1', '-q:v', '3', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'], { timeout: 15000 })
                const out: Buffer[] = []
                let err = ''
                ff.stdout.on('data', (d: Buffer) => out.push(d))
                ff.stderr.on('data', (d: Buffer) => { err += d })
                ff.on('error', rej)
                ff.on('close', (code: number) => code === 0 && out.length ? res(Buffer.concat(out)) : rej(new Error(maskSecrets(`snapshot failed: ${err.slice(-200)}`))))
            }).finally(() => { delete snapshotsInFlight[cameraKey] })
            ctx.body = await frame.catch(e => ctx.throw(502, e.message))
            ctx.set('content-type', 'image/jpeg')
            ctx.set('cache-control', 'no-store')
        })
        .post('/settings', async (ctx, _next) => {
            console.log (`settings save by ${ctx.state['session']?.user}`)
            if (ctx.request.body) {
                const body: Settings = ctx.request.body
                // the password is never sent to the browser, the placeholder means unchanged
                const new_settings: Settings = { ...body, mqtt_password: body.mqtt_password === SECRET_PLACEHOLDER ? shared.settingsCache.settings.mqtt_password : body.mqtt_password }
                try {
                    const dirchk = await fs.stat(new_settings.disk_base_dir)
                    if (!dirchk.isDirectory())  throw new Error(`${new_settings.disk_base_dir} is not a directory`)
                    if (new_settings.detector_type && !['none', 'edgetpu', 'cpu', 'mock'].includes(new_settings.detector_type)) throw new Error(`unknown detector type ${new_settings.detector_type}`)
                    if (new_settings.detector_type === 'edgetpu' || new_settings.detector_type === 'cpu') {
                        if (!new_settings.detector_model) throw new Error('detector model (.tflite) is required')
                        await fs.stat(new_settings.detector_model).catch(() => { throw new Error(`detector model not found: ${new_settings.detector_model}`) })
                    }
                    if (new_settings.go2rtc_path) {
                        await fs.stat(new_settings.go2rtc_path).catch(() => { throw new Error(`go2rtc binary not found: ${new_settings.go2rtc_path}`) })
                    }
                    if (new_settings.mqtt_url && !/^(mqtt|mqtts|ws|wss|tcp):\/\/[^\s]+$/i.test(new_settings.mqtt_url)) throw new Error('mqtt url must be like mqtt://host:1883')
                    await db.put('settings', new_settings)
                    const previous = shared.settingsCache.settings
                    shared.settingsCache = {...shared.settingsCache, settings: new_settings, status: {...shared.settingsCache.status, nextCheckInMinutes: new_settings.enable_cleanup ?  new_settings.cleanup_interval : 0}}
                    applySettings(new_settings, previous)
                    ctx.status = 201
                } catch (err) {
                    ctx.body = (err as Error).message
                    ctx.status = 400
                }
            } else {
                ctx.body = 'no body'
                ctx.status = 500
            }
        })
        .post('/camera/:id', async (ctx, _next) => {
            
            const cameraKey = ctx.params['id']
            const deleteOption = ctx.request.query['delopt']

            console.log (`camera save ${cameraKey} by ${ctx.state['session']?.user}`)
            if (ctx.request.body) {
                let new_ce: CameraEntry
                try {
                    new_ce = sanitizeCamera(ctx.request.body)
                } catch (e) {
                    ctx.throw(400, (e as Error).message)
                }
                const folder = `${new_ce.disk}/${new_ce.folder}`
                if (cameraKey === 'new') {
                    // creating new entry
                    try {
                        await ensureDir(folder)
                        const new_key = "C" + ((Date.now() / 1000 | 0) - 1600000000)
                        if (new_ce.detect_url === '') delete new_ce.detect_url
                        await cameradb.put(new_key, {delete: false, ...new_ce} as CameraEntry)
                        cameraCache[new_key] = {ce: new_ce }
                        ctx.status = 201
                    } catch (e) {
                        ctx.throw(400, e)
                    }
                    
                } else {

                    // updating existing camera
                    try {
                        const old_cc: CameraCacheEntry = cameraCache[cameraKey] 
                        if (!old_cc) throw new Error(`camera ${cameraKey} not found`)

                        if (!deleteOption) {
                            await ensureDir(folder)
                        }

                        // stop old camera definition movements and ffmpeg
                        if (old_cc.ffmpeg_process?.running) {
                            cameraCache[cameraKey] = {
                                ce: {...old_cc.ce, enable_streaming: false},
                                ffmpeg_process: null,
                                movementStatus: null
                            }
                            old_cc.ffmpeg_process.taskid?.kill();
                        }

                        if (!deleteOption) {
                            const new_vals: CameraEntry = {...old_cc.ce, ...new_ce}
                            // an empty detect_url clears the sub stream
                            if (new_vals.detect_url === '') delete new_vals.detect_url
                            await cameradb.put(cameraKey, new_vals) 
                            cameraCache[cameraKey] = { ce: new_vals }
                            ctx.status = 201
                        } else {
                            if (deleteOption === 'delall') {
                                //delete all camera files
                                const diskres = await clearDownDisk(shared.settingsCache.settings.disk_base_dir, [cameraKey], -1)
                            }
                            if (deleteOption === 'del' || deleteOption === 'delall') {
                                //delete camera entry
                                const new_vals: CameraEntry = {...old_cc.ce, delete: true}

                                await cameradb.put(cameraKey, new_vals) 
                                cameraCache[cameraKey] = { ce: new_vals }
                                ctx.status = 200
                            }
                        }
   
                    } catch (e) {
                        console.warn (e)
                        ctx.throw(400, e)
                    }

                }
            } else {
                ctx.status = 500
            }
            /*
        }).post('/movements/:id', async (ctx, _next) => {
            const cid = ctx.params['camera']
            if (ctx.request.body && ctx.request.body.length > 0) {
                const confirmed: any = ctx.request.body
                const cmd = confirmed.map((m: any) => { return { type: 'del', key: m.movement_key } })
                const succ = await movementdb.batch(cmd as any)
                ctx.status = 201
            }
            */
        }).get('/movements', async (ctx, _next) => {
            const mode = ctx.query['mode'] 
            const cameras: CameraEntryClient[] = Object.keys(cameraCache).filter(c => !cameraCache[c].ce.delete).map((key) => {

                const c = cameraCache[key]
                const {ce, ffmpeg_process, movementStatus} = c
                // filer out data not for the client
                const {ip, passwd, rtsp_url, detect_url, ...cameraEntry} = ce
                //const {current_movement, ...movement} = c.movement || {}
                const {taskid, ...ffmpeg_process_wo_task} = ffmpeg_process || {}
                return maskSecrets({
                    key, ...cameraEntry,
                    rtsp_url_masked: maskUrl(rtsp_url), detect_url_masked: maskUrl(detect_url),
                    live_stream: go2rtc.has(key) ? key : go2rtc.has(key + '_detect') ? key + '_detect' : undefined,
                    ffmpeg_process: ffmpeg_process_wo_task, movementStatus,
                    detect: pipelines[key] ? pipelines[key].pipe.state : undefined
                }) as CameraEntryClient
            })

            ctx.response.set("content-type", "application/json");
            ctx.body = await new Promise(async (res, _rej) => {

                let movements: MovementToClient[] = []

                if (mode === "Time") {

                    for (let c of cameras) {
                        const listfiles = await catalogVideo(`${c.disk}/${c.folder}`)
                        for (let i = listfiles.length - 1; i >= 0; i--) {
                            const segs = listfiles[i]
                            movements.push({
                                key: parseInt(c.key.slice(1) + segs.segmentStart),
                                startDate_en_GB: segs.startDate_en_GB,
                                movement: {
                                    cameraKey: c.key,
                                    startDate: segs.ctimeMs,
                                    startSegment: segs.segmentStart,
                                    seconds: segs.seconds,
                                    consecutivesecondswithout: 0
                                }
                            })
                        }
                    }
                    res({ config: clientConfig(), system: systemStatus(), cameras, movements })
                } else {
                    

                    // Everything in movementdb, with key time (movement start date) greater than the creation date of the oldest sequence file on disk
                    const feed = movementdb.createReadStream({ reverse: true /*, gt: oldestctimeMs > 0 ? (oldestctimeMs / 1000 | 0) - 1600000000 : 0 */})
                        .on('data', (data) => {
                            const { key, value } = data as {key: number, value: MovementEntry}
                            const { ml, cameraKey } = value

                            let tags = ml?.success ? ml.tags : null
                            if (mode === 'Filtered') {
                                if (tags && Array.isArray(tags) && tags.length > 0) {
                                    const { ignore_tags } = cameraCache[cameraKey]?.ce || {}
                                    if (ignore_tags && Array.isArray(ignore_tags) && ignore_tags.length > 0) {
                                        tags = tags.reduce((a, c) => ignore_tags.includes(c.tag) ? a : a.concat(c), [])
                                    } 
                                }
                            }
                            if (mode === 'Movement' || (mode === 'Filtered' && tags?.length >0)) {
                                const startDate = new Date(value.startDate)
                                movements.push({
                                    key,
                                    startDate_en_GB: new Intl.DateTimeFormat('en-GB', { ...(startDate.toDateString() !== (new Date()).toDateString() && {weekday: "short"}), minute: "2-digit", hour: "2-digit",  hour12: true }).format(startDate),
                                    movement: {...value, ...(tags &&  { ml: { ...value.ml, tags}})}
                                })
                            }
                        }).on('end', () => {
                            res({ config: clientConfig(), system: systemStatus(), cameras, movements })
                        })
                }
            })

        })

    return api
}
