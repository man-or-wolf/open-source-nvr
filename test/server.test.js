// Run `npx tsc` first, then `npm run test:server`
const test = require('node:test')
const assert = require('node:assert')
const z = require('../lib/zones.js')
const det = require('../lib/detect.js')
const { DetectPipeline } = det
const { backoffMs } = require('../lib/backoff.js')
const { Auth, validUsername, validPassword } = require('../lib/auth.js')

const box = [0.3133, 0.25, 0.56, 0.75] // bottom centre = (0.44, 0.75)
const mid = [[0.3, 0.5], [0.6, 0.5], [0.6, 0.9], [0.3, 0.9]]
const left = [[0, 0.8], [0.2, 0.8], [0.2, 1], [0, 1]]
const zone = (points, objects) => ({ name: 'z', points, objects })

function pipeline(settings) {
    const p = new DetectPipeline('t', 'x', settings)
    p.configure(320, 240)
    return p
}

test('zonesFor uses the bottom centre and the zone object list', () => {
    assert.deepStrictEqual(z.zonesFor('person', box, [zone(mid)]), ['z'])
    assert.deepStrictEqual(z.zonesFor('person', box, [zone(left)]), [])
    assert.deepStrictEqual(z.zonesFor('person', box, [zone(mid, ['car'])]), [])
})

test('validPolygon rejects bad shapes', () => {
    assert.ok(z.validPolygon(mid))
    assert.ok(!z.validPolygon([[0, 0], [1, 1]]))
    assert.ok(!z.validPolygon([[0, 0], [1, 1], [2, 0]]))
    assert.ok(!z.validPolygon('x'))
})

test('filter: tracked labels, score, zones, object mask', () => {
    const dets = [{ label: 'person', score: 0.9, box }, { label: 'car', score: 0.9, box: [0, 0, .1, .1] }, { label: 'person', score: 0.3, box: [0, 0, .1, .1] }, { label: 'bird', score: 0.99, box }]
    assert.deepStrictEqual(pipeline({}).filter(dets).map(o => o.label), ['person', 'car'])
    assert.deepStrictEqual(pipeline({ track_objects: ['car'] }).filter(dets).map(o => o.label), ['car'])
    assert.deepStrictEqual(pipeline({ zones: [zone(mid)] }).filter(dets).map(o => o.label), ['person'])
    assert.deepStrictEqual(pipeline({ zones: [zone(left)] }).filter(dets).map(o => o.label), [])
    assert.deepStrictEqual(pipeline({ object_mask: [mid] }).filter(dets).map(o => o.label), ['car'])
})

// 320x240 RGB frame, black with a white rectangle (pixel coordinates)
function frame(x0, x1, y0 = 160, y1 = 220) {
    const b = Buffer.alloc(320 * 240 * 3)
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * 320 + x) * 3; b[i] = b[i + 1] = b[i + 2] = 255 }
    return b
}

test('motion detection: masks and light changes', () => {
    // mid mask covers x 96-192, y 120-216 at this size
    const q = pipeline({ motion_mask: [mid] })
    q.detectMotion(frame(0, 0))
    assert.strictEqual(q.detectMotion(frame(110, 170, 130, 200)).motion, false, 'change inside the mask is ignored')
    const r = pipeline({ motion_mask: [mid] })
    r.detectMotion(frame(0, 0))
    assert.strictEqual(r.detectMotion(frame(0, 60)).motion, true, 'change outside the mask is motion')
    const l = pipeline({})
    l.detectMotion(frame(0, 0))
    assert.strictEqual(l.detectMotion(Buffer.alloc(320 * 240 * 3, 255)).motion, false, 'whole frame change is a light change')
})

test('motion detection returns a box around the moving area', () => {
    const q = pipeline({})
    q.detectMotion(frame(0, 0))
    const { motion, boxes } = q.detectMotion(frame(200, 260, 40, 120))
    assert.ok(motion)
    assert.strictEqual(boxes.length, 1)
    const [x1, y1, x2, y2] = boxes[0]
    assert.ok(x1 <= 200 / 320 && x2 >= 260 / 320 && y1 <= 40 / 240 && y2 >= 120 / 240, `box ${boxes[0]} should contain the rectangle`)
    assert.ok(x2 - x1 < 0.6 && y2 - y1< 0.8, 'and not be the whole frame')
})

test('two separate movers give two boxes', () => {
    const q = pipeline({})
    q.detectMotion(frame(0, 0))
    const b = frame(10, 50, 20, 60)
    frame(260, 300, 170, 220).forEach((v, i) => { if (v) b[i] = v })
    assert.strictEqual(q.detectMotion(b).boxes.length, 2)
})

test('regionFor: square, inside the frame, min size, centred on the box', () => {
    const r = det.regionFor([0.5, 0.5, 0.52, 0.55], 640, 360)
    assert.strictEqual(r.side, Math.round(0.3 * 360))
    assert.ok(r.x0 >= 0 && r.y0 >= 0 && r.x0 + r.side <= 640 && r.y0 + r.side <= 360)
    const edge = det.regionFor([0.95, 0.9, 1, 1], 640, 360)
    assert.strictEqual(edge.x0 + edge.side, 640)
    assert.strictEqual(edge.y0 + edge.side, 360)
    assert.strictEqual(det.regionFor([0, 0, 1, 1], 640, 360).side, 360)
})

test('cropResize + mapBox: an object found in the crop maps back to the frame', () => {
    const W = 640, H = 360
    const src = Buffer.alloc(W * H * 3)
    for (let y = 100; y < 160; y++) for (let x = 300; x < 340; x++) { const i = (y * W + x) * 3; src[i] = src[i + 1] = src[i + 2] = 255 }
    const r = det.regionFor([300 / W, 100 / H, 340 / W, 160 / H], W, H)
    const out = det.cropResize(src, W, H, r, 300, 300)
    assert.strictEqual(out.length, 300 * 300 * 3)
    // bounding box of white pixels in the crop, as the detector would report it
    let x1 = 300, y1 = 300, x2 = 0, y2 = 0
    for (let y = 0; y < 300; y++) for (let x = 0; x < 300; x++) if ((out[(y * 300 + x) * 3] || 0) > 200) { x1 = Math.min(x1, x); x2 = Math.max(x2, x + 1); y1 = Math.min(y1, y); y2 = Math.max(y2, y + 1) }
    const back = det.mapBox([x1 / 300, y1 / 300, x2 / 300, y2 / 300], r, W, H)
    const want = [300 / W, 100 / H, 340 / W, 160 / H]
    back.forEach((v, i) => assert.ok(Math.abs(v - want[i]) < 0.01, `box ${back} vs ${want}`))
})

test('nms keeps the best of overlapping same-label boxes', () => {
    const d = (label, score, box) => ({ label, score, box })
    const out = det.nms([d('person', 0.7, [0.1, 0.1, 0.5, 0.9]), d('person', 0.9, [0.12, 0.1, 0.52, 0.9]), d('car', 0.8, [0.1, 0.1, 0.5, 0.9]), d('person', 0.8, [0.7, 0.1, 0.9, 0.9])])
    assert.deepStrictEqual(out.map(o => [o.label, o.score]).sort(), [['car', 0.8], ['person', 0.8], ['person', 0.9]])
})

test('backoff grows, caps, and has jitter', () => {
    assert.strictEqual(backoffMs(0), 0)
    for (let i = 0; i < 20; i++) {
        const d1 = backoffMs(1, 1000, 60000), d4 = backoffMs(4, 1000, 60000), big = backoffMs(30, 1000, 60000)
        assert.ok(d1 >= 800 && d1 <= 1200)
        assert.ok(d4 >= 6400 && d4 <= 9600)
        assert.ok(big >= 48000 && big <= 72000)
    }
})

test('takeTags keeps the best score per label and resets', () => {
    const p = pipeline({})
    p.addTags([{ label: 'person', score: 0.7, box, zones: [] }])
    p.addTags([{ label: 'person', score: 0.9, box, zones: ['z'] }, { label: 'dog', score: 0.65, box, zones: [] }])
    const tags = p.takeTags()
    assert.deepStrictEqual(tags.map(t => [t.tag, t.probability]).sort(), [['dog', 65], ['person', 90]])
    assert.deepStrictEqual(p.takeTags(), [])
})

function memStore() {
    const m = new Map()
    return { get: async k => { if (!m.has(k)) throw new Error('nf'); return m.get(k) }, put: async (k, v) => { m.set(k, v) }, del: async k => { m.delete(k) }, keys: async () => [...m.keys()] }
}

test('auth: login, session, throttle, delete user', async () => {
    const a = new Auth(memStore(), memStore(), true)
    await a.setUser('Bob', 'password123', 'viewer')
    assert.strictEqual(await a.login('bob', 'nope', '1.1.1.1'), null)
    const token = await a.login('BOB', 'password123', '1.1.1.1')
    assert.ok(token)
    assert.deepStrictEqual((await a.session(token)).role, 'viewer')
    for (let i = 0; i < 5; i++) await a.login('bob', 'bad', '2.2.2.2')
    assert.ok(a.throttled('2.2.2.2'))
    assert.ok(!a.throttled('1.1.1.1'))
    await a.deleteUser('bob')
    assert.strictEqual(await a.session(token), null)
})

test('auth: validation helpers', () => {
    assert.ok(validUsername('a.b-c_1') && !validUsername('a b') && !validUsername(''))
    assert.ok(validPassword('12345678') && !validPassword('short'))
})

test('shouldDetect: always with motion, otherwise at most once a second', () => {
    assert.ok(det.shouldDetect(true, 1000, 1001))
    assert.ok(!det.shouldDetect(false, 1000, 1500))
    assert.ok(det.shouldDetect(false, 1000, 2000))
})

const { detector, deviceList } = require('../lib/detector_client.js')

test('deviceList: one worker per Coral, one for everything else', () => {
    assert.deepStrictEqual(deviceList({ type: 'edgetpu' }), [''])
    assert.deepStrictEqual(deviceList({ type: 'edgetpu', device: 'usb:0, usb:1,usb:0' }), ['usb:0', 'usb:1'])
    assert.deepStrictEqual(deviceList({ type: 'cpu', device: 'usb' }), [''])
})

test('detector pool: a camera only keeps its newest waiting frame', async () => {
    process.env.DETECTOR_PYTHON = process.env.DETECTOR_PYTHON || 'python3'
    detector.start({ type: 'mock' })
    await new Promise((res, rej) => { detector.once('ready', res); setTimeout(() => rej(new Error('detector did not start')), 15000) })
    const white = Buffer.alloc(300 * 300 * 3)
    for (let y = 100; y < 200; y++) for (let x = 100; x < 200; x++) white.fill(255, (y * 300 + x) * 3, (y * 300 + x) * 3 + 3)
    // the first goes straight to the worker, the second waits and is replaced by the third
    const [a, b, c, other] = await Promise.all([detector.detect(white, 'cam'), detector.detect(white, 'cam'), detector.detect(white, 'cam'), detector.detect(white, 'other')])
    assert.strictEqual(a[0].label, 'person')
    assert.strictEqual(b, null)
    assert.strictEqual(c[0].label, 'person')
    assert.strictEqual(other[0].label, 'person')
    assert.strictEqual(detector.status.dropped, 1)
    assert.strictEqual(detector.status.workers.length, 1)
    detector.stop()
    assert.strictEqual(await detector.detect(white, 'cam'), null, 'no detector, no result')
})
