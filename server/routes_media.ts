const send = require('koa-send')

import fs from 'fs/promises'
import { createReadStream } from 'fs'
import crypto from 'crypto'
import { spawn } from 'child_process'
import Router from '@koa/router'
import { go2rtc } from './go2rtc.js'
import { auth, cameradb, cameraCache, movementdb, PORT, proxy } from './state.js'
import { safeName } from './util.js'
import type { CameraEntry, MovementEntry } from './types.js'

// limits for the clip routes, so one request cannot use unbounded memory, disk or ffmpeg processes
const MAX_CLIP_SECONDS = 7200
const MAX_PAD_SEGMENTS = 600
const MAX_MP4_JOBS = 2
let mp4Active = 0

export function mediaRoutes() {
    const assets = new Router()
        .get('/image/:moment', async (ctx, _next) => {
            const moment = parseInt(ctx.params['moment'])

            try {
                const m: MovementEntry = await movementdb.get(moment)
                const c: CameraEntry = await cameradb.get(m.cameraKey)
                // darknet writes an annotated mlimage, built-in detection only has the plain snapshot
                const ml = `${c.disk}/${c.folder}/mlimage${moment}.jpg`
                const serve = m.ml && m.ml.success && await fs.stat(ml).then(() => true, () => false) ? ml : `${c.disk}/${c.folder}/image${moment}.jpg`
                const { size } = await fs.stat(serve)
                ctx.set('content-type', 'image/jpeg')
                ctx.body = createReadStream(serve, { encoding: undefined }).on('error', ctx.onerror)
            } catch (e) {
                const err : Error = e as Error
                ctx.throw(400, err.message)
            }

        })
        .get('/video/live/:cameraKey/:file', async (ctx, _next) => {
            const cameraKey = ctx.params['cameraKey'],
                  file = ctx.params['file']

            try {
                if (!safeName(file)) throw new Error(`invalid file=${file}`)
                const c = await cameradb.get(cameraKey)
                const serve = `${c.disk}/${c.folder}/${file}`
                const { size } = await fs.stat(serve)
                //console.log(`serving : ${serve}`)
                ctx.body = createReadStream(serve, { encoding: undefined }).on('error', ctx.onerror)
            } catch (e) {
                const err : Error = e as Error
                ctx.throw(400, err.message)
            }

        })
        .get('/video/:startSegment/:seconds/:cameraKey/:file', async (ctx, _next) => {
            const 
                startSegment = ctx.params['startSegment'],
                seconds = ctx.params['seconds'],
                cameraKey = ctx.params['cameraKey'],
                file = ctx.params['file']

            if (!safeName(file)) ctx.throw(400, `invalid file=${file}`)
            if (!cameraCache[cameraKey]) ctx.throw(404, `unknown camera`)
            const ce: CameraEntry = cameraCache[cameraKey].ce
            
            if (file.endsWith('.m3u8')) {
                const segmentInt = parseInt(startSegment)//.getTime()
                const secondsInt = parseInt(seconds)//.getTime()
                const preseq: number = ctx.query['preseq'] ? parseInt(ctx.query['preseq'] as any) : 0
                const postseq: number = ctx.query['postseq'] ? parseInt(ctx.query['postseq'] as any) : 0
                if (isNaN(segmentInt) || isNaN(secondsInt) || isNaN(preseq) || isNaN(postseq)) {
                    ctx.throw(400, `message=${startSegment} or ${seconds} not valid values`)
                } else if (secondsInt < 0 || preseq < 0 || postseq < 0 || secondsInt > MAX_CLIP_SECONDS || preseq > MAX_PAD_SEGMENTS || postseq > MAX_PAD_SEGMENTS) {
                    ctx.throw(400, `clip too long (max ${MAX_CLIP_SECONDS}s, padding max ${MAX_PAD_SEGMENTS} segments)`)
                } else {
                    //const startSegment = segment // (d / 1000 | 0) - 1600000000

                    const body = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
` + [...Array(Math.round(secondsInt / 2) + preseq + postseq).keys()].map(n => `#EXTINF:2.000000,
stream${n + segmentInt - preseq}.ts`).join("\n") + "\n" + "#EXT-X-ENDLIST\n"
    
                    ctx.body = body
                }
            } else if (file.endsWith('.ts')) {
                const serve = `${ce.disk}/${ce.folder}/${file}`
                //console.log(`serving : ${serve}`)
                try {
                    const { size } = await fs.stat(serve)
                    ctx.body = createReadStream(serve, { encoding: undefined }).on('error', ctx.onerror)
                } catch (e) {
                    const err : Error = e as Error
                    ctx.throw(400, `message=${err.message}`)
                }
            } else {
                ctx.throw(400, `unknown file=${file}`)
            }
        })
        /*
        .get('/video/:mid/:file', async (ctx, _next) => {
            const movement = ctx.params['mid'],
                  file = ctx.params['file']

            //need to cache this in memory!!
            const m: MovementEntry = await movementdb.get(parseInt(movement))
            const ce: CameraEntry = cameraCache[m.cameraKey].ce

            if (file.endsWith('.m3u8')) {

                const preseq: number = ctx.query['preseq'] ? parseInt(ctx.query['preseq'] as any) : 1
                const postseq: number = ctx.query['postseq'] ? parseInt(ctx.query['postseq'] as any) : 1
                // need to return a segement file for the movement
                try {
                    

                    const body = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:${m.lhs_seg_duration_seq}
` + [...Array(Math.round(m.seconds / 2) + preseq + postseq).keys()].map(n => `#EXTINF:2.000000,
${ce.name}.${n + m.startSegment - preseq}.ts`).join("\n") + "\n" + "#EXT-X-ENDLIST\n"

                    ctx.body = body
                } catch (e) {
                    const err : Error = e as Error
                    ctx.throw(400, `unknown movement name=${movement} message=${err.message}`)
                }
            } else if (file.endsWith('.ts')) {
                const [camera, index, suffix] = file.split('.')
                const serve = `${ce.disk}/${ce.folder}/stream${index}.${suffix}`
                //console.log(`serving : ${serve}`)
                try {
                    const { size } = await fs.stat(serve)
                    ctx.body = createReadStream(serve, { encoding: undefined }).on('error', ctx.onerror)
                } catch (e) {
                    const err : Error = e as Error
                    ctx.throw(400, `message=${err.message}`)
                }
            } else {
                ctx.throw(400, `unknown file=${file}`)
            }

        })
        */
        .get('/mp4/:startSegment/:seconds/:cameraKey', async (ctx, _next) => {
            // numbers only, these end up in ffmpeg arguments
            const startSegment = parseInt(ctx.params['startSegment']),
                seconds = parseInt(ctx.params['seconds']),
                cameraKey = ctx.params['cameraKey'],
                preseq = ctx.query['preseq'] ? parseInt(ctx.query['preseq'] as any) : 0,
                postseq = ctx.query['postseq'] ? parseInt(ctx.query['postseq'] as any) : 0
            if ([startSegment, seconds, preseq, postseq].some(isNaN) || seconds < 0 || preseq < 0 || postseq < 0) ctx.throw(400, 'invalid segment, seconds or padding')
            if (seconds > MAX_CLIP_SECONDS || preseq > MAX_PAD_SEGMENTS || postseq > MAX_PAD_SEGMENTS) ctx.throw(400, `clip too long (max ${MAX_CLIP_SECONDS}s)`)
            const ce: CameraEntry | undefined = cameraCache[cameraKey]?.ce
            if (!ce || ce.delete) ctx.throw(404, 'unknown camera')

            // each clip is a temporary file, bounded concurrency
            if (mp4Active >= MAX_MP4_JOBS) {
                ctx.set('Retry-After', '10')
                ctx.throw(503, 'too many clips being prepared, try again shortly')
            }
            const serve = `${(ce as CameraEntry).disk}/${(ce as CameraEntry).folder}/save-${crypto.randomBytes(6).toString('hex')}.mp4`
            mp4Active++
            try {
                await new Promise((res, rej) => {
                    const mv_task = spawn('/usr/bin/ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-headers', `x-nvr-internal: ${auth.internalToken}\r\n`, '-i', `http://127.0.0.1:${PORT}/video/${startSegment}/${seconds}/${cameraKey}/stream.m3u8${preseq > 0 || postseq > 0 ? `?preseq=${preseq}&postseq=${postseq}` : ''}`, '-c', 'copy', serve], { timeout: 120000 })
                    let stderr = '', myerror = ''
                    mv_task.stderr.on('data', (data: string) => { stderr += data })
                    mv_task.on('error', async (error: Error) => { myerror = `${error.name}: ${error.message}` })
                    mv_task.on('close', async (code: number) => code === 0 ? res(0) : rej(new Error(`ffmpeg stderr=${stderr.slice(-300)} error=${myerror}`)))
                })
            } catch (e) {
                await fs.unlink(serve).catch(() => undefined)
                console.warn(`mp4 failed: ${e}`)
                ctx.throw(500, 'could not create the clip')
            } finally {
                mp4Active--
            }

            ctx.set('Content-Type', 'video/mp4')
            ctx.set('Content-Disposition', `attachment; filename="${cameraKey}-${startSegment}.mp4"`)
            // the file is only needed for this download
            ctx.body = createReadStream(serve, { encoding: undefined }).on('error', ctx.onerror).on('close', () => { fs.unlink(serve).catch(() => undefined) })
        })
        /*
        .get('/mp4/:movement', async (ctx, _next) => {
            const movement = ctx.params['movement']

            const preseq: number = ctx.query['preseq'] ? parseInt(ctx.query['preseq'] as any) : -1
            const postseq: number = ctx.query['postseq'] ? parseInt(ctx.query['postseq'] as any) : -1

            try {
                const m: MovementEntry = await movementdb.get(parseInt(movement))
                const ce: CameraEntry = await cameraCache[m.cameraKey].ce

                const serve = `${ce.disk}/${ce.folder}/save${movement}.mp4`

                await new Promise(async (res, rej) => {
                    const mv_task = spawn('/usr/bin/ffmpeg', ['-y', '-i', `http://localhost:${PORT}/video/${movement}/stream.m3u8${preseq > 0 && postseq > 0 ? `?preseq=${preseq}&postseq=${postseq}` : ''}`, '-c', 'copy', serve], { timeout: 5000 })
                    let stdout = '', stderr = '', myerror = ''
                    mv_task.stdout.on('data', (data: string) => { stdout += data })
                    mv_task.stderr.on('data', (data: string) => { stderr += data })
                    mv_task.on('error', async (error: Error) => { myerror = `${error.name}: ${error.message}` })

                    mv_task.on('close', async (code: number) => {
                        if (code === 0) {
                            res(0)
                        } else {
                            rej(new Error(`ffmpeg stderr=${stderr} error=${myerror}`))
                        }
                    })
                })

                ctx.set('Content-Type', 'video/mp4')
                ctx.body = createReadStream(serve, { encoding: undefined }).on('error', ctx.onerror)

            } catch (e) {
                ctx.throw(`error mp4 gen error=${e}`)
            }

        })
        */
        /*
        .get('/mp4old/:movement', async (ctx, _next) => {
            console.log(`serving video: ${ctx.params[0]}`)
            const filepath = `./test_video/${ctx.params[0]}`
            let streamoptions: any = { encoding: null }
            if (ctx.headers.range) {

                const { size } = await fs.stat(filepath)

                const [range_start, range_end] = ctx.headers.range.replace(/bytes=/, "").split("-"),
                    start = parseInt(range_start, 10),
                    chunklength = range_end ? parseInt(range_end, 10) - start + 1 : Math.min(1024 * 1024 * 32 / * 32KB default * /, size - start / * whats left in the file  * /),
                    end = start + chunklength - 1

                console.log(`serving video request range: ${range_start} -> ${range_end},  providing ${start} -> ${end} / ${size}`)

                ctx.set('Accept-Ranges', 'bytes');
                ctx.set('Content-Length', chunklength.toString()) // 38245154
                ctx.set('Content-Range', `bytes ${start}-${end}/${size}`) // bytes 29556736-67801889/67801890

                streamoptions = { ...streamoptions, start, end }
                ctx.status = 206;
            }
            ctx.body = createReadStream(filepath, streamoptions).on('error', ctx.onerror)

        })
        */
        // go2rtc web components used by the live view (the rest of go2rtc's API is NOT exposed)
        .get(['/go2rtc/video-stream.js', '/go2rtc/video-rtc.js'], async (ctx, _next) => {
            if (!go2rtc.running) ctx.throw(503, 'go2rtc not running')
            ctx.respond = false
            ctx.req.url = ctx.path.replace('/go2rtc', '')
            proxy.web(ctx.req, ctx.res, { target: go2rtc.apiTarget }, () => { ctx.res.statusCode = 502; ctx.res.end() })
        })
        .get(['/(.*)'], async (ctx, _next) => {
            const path = ctx.params[0]
            console.log(`serving static: ${path}`)
            await send(ctx, !path || path === "video_only" ? '/index.html' : path, { root: process.env['WEBPATH'] || './build' })
        })

    return assets
}
