// End-to-end test: fake HTTP cameras + the mock detector (no Coral, no real camera needed).
// Needs: ffmpeg, python3 with numpy. Run `npm run test:e2e` (builds the server first).
const { spawn } = require('child_process')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')

const PORT = 20000 + Math.floor(Math.random() * 20000)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nvr-e2e-'))
const root = path.join(__dirname, '..', '..')
const children = []
let serverLog = ''
let server

function run(cmd, args, env) {
    const p = spawn(cmd, args, { env: { ...process.env, ...env }, cwd: root })
    children.push(p)
    return p
}

function startServer() {
    server = run('node', ['lib/index.js'], { DBPATH: path.join(dir, 'db'), PORT: String(PORT), NVR_ADMIN_PASSWORD: 'e2e-password-1', DETECTOR_PYTHON: process.env.DETECTOR_PYTHON || 'python3' })
    server.stdout.on('data', d => { serverLog += d })
    server.stderr.on('data', d => { serverLog += d })
    return server
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function until(what, fn, timeoutMs = 120000, every = 1000) {
    const end = Date.now() + timeoutMs
    for (;;) {
        try { const v = await fn(); if (v) return v } catch (e) { /* retry */ }
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
        await sleep(every)
    }
}

async function req(method, p, { body, cookie, raw } = {}) {
    const res = await fetch(`http://127.0.0.1:${PORT}${p}`, {
        method, redirect: 'manual',
        headers: { ...(body && { 'content-type': 'application/json' }), ...(cookie && { cookie }) },
        ...(body && { body: JSON.stringify(body) })
    })
    const buf = Buffer.from(await res.arrayBuffer())
    return { status: res.status, headers: res.headers, buf, json: () => JSON.parse(buf.toString()), text: () => buf.toString() }
}

async function login(user, password) {
    const r = await req('POST', '/api/login', { body: { username: user, password } })
    return r.status === 200 ? r.headers.get('set-cookie').split(';')[0] : null
}

let n = 0
const ok = (msg) => console.log(`ok ${++n} - ${msg}`)

async function main() {
    run('python3', [path.join(__dirname, 'fakecam.py'), String(PORT + 1)])
    run('python3', [path.join(__dirname, 'fakecam.py'), String(PORT + 2)])
    startServer()
    await until('server', async () => (await req('GET', '/api/me')).status === 200, 30000)

    // --- auth
    assert.strictEqual((await req('GET', '/api/movements?mode=Movement')).status, 401); ok('api needs a login')
    assert.strictEqual((await req('GET', '/image/1')).status, 401); ok('media needs a login')
    assert.strictEqual(await login('admin', 'wrong'), null); ok('wrong password refused')
    const admin = await login('admin', 'e2e-password-1')
    assert.ok(admin); ok('admin login')

    // --- settings and camera
    const settings = { disk_base_dir: path.join(dir, 'video'), enable_cleanup: false, cleanup_interval: 120, cleanup_capacity: 99, enable_ml: false, mlDir: '', mlCmd: '', detector_type: 'mock' }
    fs.mkdirSync(settings.disk_base_dir)
    assert.strictEqual((await req('POST', '/api/settings', { cookie: admin, body: { ...settings, detector_type: 'bogus' } })).status, 400)
    assert.strictEqual((await req('POST', '/api/settings', { cookie: admin, body: settings })).status, 201); ok('settings saved, bad detector refused')

    const cam = { name: 'fake', folder: 'fake', disk: settings.disk_base_dir, camera_type: 'rtsp', rtsp_url: `http://u:secretpw@127.0.0.1:${PORT + 1}/live`, detect_url: `http://127.0.0.1:${PORT + 2}/live`, enable_streaming: true, enable_movement: true, detect_enabled: true, secWithoutMovement: 4, secMaxSingleMovement: 600, mSPollFrequency: 1000, segments_prior_to_movement: 2, segments_post_movement: 2, ignore_tags: [], detect_fps: 5 }
    assert.strictEqual((await req('POST', '/api/camera/new', { cookie: admin, body: { ...cam, rtsp_url: 'file:///etc/passwd' } })).status, 400)
    assert.strictEqual((await req('POST', '/api/camera/new', { cookie: admin, body: { ...cam, name: '../x' } })).status, 400)
    assert.strictEqual((await req('POST', '/api/camera/new', { cookie: admin, body: { ...cam, zones: [{ name: 'z', points: [[0, 0], [2, 2], [0, 1]] }] } })).status, 400); ok('bad urls, names and zones refused')
    assert.strictEqual((await req('POST', '/api/camera/new', { cookie: admin, body: cam })).status, 201); ok('camera saved')

    // --- detection through the whole pipeline
    const ev = await until('a person event', async () => {
        const d = (await req('GET', '/api/movements?mode=Filtered', { cookie: admin })).json()
        return d.movements.find(m => m.movement.ml && m.movement.ml.tags.some(t => t.tag === 'person') && m.movement.ffmpeg && m.movement.ffmpeg.success)
    }, 150000, 2000)
    const tag = ev.movement.ml.tags.find(t => t.tag === 'person')
    const want = [0.3125, 0.25, 0.5625, 0.75] // the white rectangle in the fake camera
    tag.box.forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 0.03, `box ${tag.box} should be near ${want}`))
    ok(`event with a person, box ${tag.box} matches the object`)

    const all = (await req('GET', '/api/movements?mode=Movement', { cookie: admin })).text()
    assert.ok(!all.includes('secretpw'), 'no camera password in the api')
    assert.ok(all.includes('http://****@127.0.0.1'), 'urls are shown masked')
    ok('api does not leak camera urls')

    const camState = (await req('GET', '/api/movements?mode=Movement', { cookie: admin })).json()
    assert.strictEqual(camState.system.detector.state, 'running')
    assert.ok(camState.cameras[0].detect.running)
    ok('detector and camera pipeline report running')

    // --- media
    const img = await req('GET', `/image/${ev.key}`, { cookie: admin })
    assert.strictEqual(img.status, 200); assert.strictEqual(img.headers.get('content-type'), 'image/jpeg'); ok('event snapshot')
    const { startSegment, seconds, cameraKey } = ev.movement
    const clip = await req('GET', `/mp4/${startSegment}/${seconds}/${cameraKey}?preseq=1&postseq=1`, { cookie: admin })
    assert.strictEqual(clip.status, 200); assert.ok(clip.buf.length > 1000); ok('mp4 clip')
    await sleep(500)
    assert.deepStrictEqual(fs.readdirSync(path.join(settings.disk_base_dir, 'fake')).filter(f => f.startsWith('save-')), []); ok('clip temp files removed')
    assert.strictEqual((await req('GET', `/mp4/${startSegment}/999999/${cameraKey}`, { cookie: admin })).status, 400)
    assert.strictEqual((await req('GET', `/video/${startSegment}/${seconds}/${cameraKey}/stream.m3u8?preseq=-1`, { cookie: admin })).status, 400)
    assert.strictEqual((await req('GET', `/video/live/${cameraKey}/..%2F..%2F..%2Fetc%2Fpasswd`, { cookie: admin })).status, 400); ok('clip limits and path traversal refused')
    const burst = await Promise.all([1, 2, 3, 4, 5, 6].map(() => req('GET', `/mp4/${startSegment}/${seconds}/${cameraKey}`, { cookie: admin })))
    assert.ok(burst.some(r => r.status === 503) && burst.some(r => r.status === 200), `limited clip concurrency: ${burst.map(r => r.status)}`); ok('only a few clips at once')
    assert.strictEqual((await req('GET', `/api/snapshot/${cameraKey}`, { cookie: admin })).status, 200); ok('camera snapshot')

    // --- users
    assert.strictEqual((await req('POST', '/api/users', { cookie: admin, body: { username: 'view', password: 'viewer-pass-1', role: 'viewer' } })).status, 201)
    const viewer = await login('view', 'viewer-pass-1')
    assert.strictEqual((await req('GET', '/api/movements?mode=Movement', { cookie: viewer })).status, 200)
    assert.strictEqual((await req('POST', '/api/settings', { cookie: viewer, body: settings })).status, 403)
    assert.strictEqual((await req('GET', '/api/users', { cookie: viewer })).status, 403); ok('viewer can watch, not change')
    const other = await login('admin', 'e2e-password-1')
    assert.strictEqual((await req('POST', '/api/password', { cookie: admin, body: { current: 'e2e-password-1', password: 'e2e-password-2' } })).status, 200)
    assert.strictEqual((await req('GET', '/api/users', { cookie: admin })).status, 200)
    assert.strictEqual((await req('GET', '/api/users', { cookie: other })).status, 401); ok('password change ends other sessions')

    // --- crash recovery: kill the server while an event runs
    const admin2 = await login('admin', 'e2e-password-2')
    const running = await until('a running event', async () => {
        const d = (await req('GET', '/api/movements?mode=Movement', { cookie: admin2 })).json()
        return d.movements.find(m => m.movement.ongoing)
    }, 90000, 500)
    server.kill('SIGKILL')
    await sleep(1000)
    serverLog = ''
    startServer()
    await until('server restart', async () => (await req('GET', '/api/me')).status === 200, 30000)
    const admin3 = await login('admin', 'e2e-password-2')
    const after = await until('recovered event', async () => {
        const d = (await req('GET', '/api/movements?mode=Movement', { cookie: admin3 })).json()
        const m = d.movements.find(x => x.key === running.key)
        return m && !m.movement.ongoing && m.movement.ffmpeg && m
    }, 30000)
    assert.ok(after); ok(`event running at a crash is closed and gets a snapshot attempt (snapshot ${after.movement.ffmpeg.success ? 'taken' : 'failed: segment was not finished'})`)
}

main().then(() => { console.log(`\nall ${n} checks passed`); cleanup(0) }, (e) => {
    console.error(`\nFAILED after ${n} checks: ${e.stack || e}`)
    console.error('--- server log tail\n' + serverLog.split('\n').slice(-40).join('\n'))
    cleanup(1)
})

function cleanup(code) {
    for (const c of children) { try { c.kill('SIGKILL') } catch (e) { /* gone */ } }
    // ffmpeg started by the fake cameras / server
    setTimeout(() => { fs.rmSync(dir, { recursive: true, force: true }); process.exit(code) }, 300)
}
