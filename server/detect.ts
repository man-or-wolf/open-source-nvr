import { spawn } from 'child_process'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import { EventEmitter } from 'events'
import { detector } from './detector_client.js'
import type { Detection } from './detector_client.js'
import { rasterise, zonesFor } from './zones.js'
import type { Polygon, Zone } from './zones.js'
import { backoffMs } from './backoff.js'

// Per-camera detection settings (subset of CameraEntry)
export interface DetectSettings {
    detect_enabled?: boolean;
    detect_fps?: number;
    // width of the decoded detection frames, crops for the detector are taken from these
    detect_width?: number;
    track_objects?: string[];
    min_score?: number;
    // false = any motion starts an event, true = only tracked objects do
    require_object?: boolean;
    // pixel luma change (0-255) that counts as motion
    motion_threshold?: number;
    // % of the frame that must change to count as motion
    motion_area?: number;
    motion_mask?: Polygon[];
    object_mask?: Polygon[];
    zones?: Zone[];
}

export interface TrackedObject extends Detection {
    zones: string[];
}

export interface DetectTag {
    tag: string;
    probability: number;
    box: number[];
    zones: string[];
}

export interface DetectState {
    running: boolean;
    error?: string;
    fps: number;
    size?: [number, number];
    motion: boolean;
    // an event is in progress (object in zone, or motion when require_object is off)
    active: boolean;
    objects: TrackedObject[];
    // detector inferences run on the last frame
    regions: number;
    lastFrame: number;
}

export type Box = [number, number, number, number]
// square crop of the frame, in pixels
export interface Region { x0: number; y0: number; side: number }

export const DEFAULT_TRACK = ['person', 'car', 'dog', 'cat']
const STALL_MS = 15000
const KEEPALIVE_MS = 10000
// the stream must run this long before earlier failures are forgotten
const STABLE_MS = 30000
// more than this fraction of the frame changing is a light change, not motion
const LIGHT_CHANGE = 0.8
const BG_ALPHA = 0.1
// motion is measured on every STRIDE-th pixel in each direction, in cells of CELL x CELL samples
const STRIDE = 4
const CELL = 8
const CELL_MIN_CHANGED = 4
const MAX_REGIONS = 3
// smallest crop, as a fraction of the frame height (small crops are upscaled, which helps distant objects)
const MIN_SIDE = 0.3
const NMS_IOU = 0.5
// objects that are not moving are looked at this often, not at every frame
const STATIONARY_MS = 1000

// ---- pure helpers (exported for tests)

// Square crop around a normalised box, 1.4x the box, at least MIN_SIDE of the frame height, inside the frame.
export function regionFor(box: Box, w: number, h: number): Region {
    const bw = (box[2] - box[0]) * w, bh = (box[3] - box[1]) * h
    const side = Math.round(Math.min(Math.min(w, h), Math.max(Math.max(bw, bh) * 1.4, MIN_SIDE * h)))
    const cx = (box[0] + box[2]) / 2 * w, cy = (box[1] + box[3]) / 2 * h
    return {
        x0: Math.round(Math.min(Math.max(cx - side / 2, 0), w - side)),
        y0: Math.round(Math.min(Math.max(cy - side / 2, 0), h - side)),
        side
    }
}

// Bilinear resize of a square region of an RGB frame to ow x oh.
export function cropResize(src: Buffer, w: number, h: number, r: Region, ow: number, oh: number): Buffer {
    const out = Buffer.allocUnsafe(ow * oh * 3)
    const sx = r.side / ow, sy = r.side / oh
    const x0i = new Int32Array(ow), x1i = new Int32Array(ow), xf = new Float32Array(ow)
    for (let x = 0; x < ow; x++) {
        const fx = Math.min(Math.max((x + 0.5) * sx - 0.5, 0), r.side - 1) + r.x0
        const xi = Math.floor(fx)
        x0i[x] = xi * 3
        x1i[x] = Math.min(xi + 1, w - 1) * 3
        xf[x] = fx - xi
    }
    let o = 0
    for (let y = 0; y < oh; y++) {
        const fy = Math.min(Math.max((y + 0.5) * sy - 0.5, 0), r.side - 1) + r.y0
        const yi = Math.floor(fy), yf = fy - yi
        const row0 = yi * w * 3, row1 = Math.min(yi + 1, h - 1) * w * 3
        for (let x = 0; x < ow; x++) {
            const a = x0i[x] as number, b = x1i[x] as number, f = xf[x] as number
            for (let c = 0; c < 3; c++) {
                const top = (src[row0 + a + c] as number) * (1 - f) + (src[row0 + b + c] as number) * f
                const bot = (src[row1 + a + c] as number) * (1 - f) + (src[row1 + b + c] as number) * f
                out[o++] = top * (1 - yf) + bot * yf
            }
        }
    }
    return out
}

// Box in crop coordinates (0-1) -> box in frame coordinates (0-1)
export function mapBox(b: number[], r: Region, w: number, h: number): Box {
    return [(r.x0 + (b[0] as number) * r.side) / w, (r.y0 + (b[1] as number) * r.side) / h, (r.x0 + (b[2] as number) * r.side) / w, (r.y0 + (b[3] as number) * r.side) / h]
}

function iou(a: number[], b: number[]): number {
    const iw = Math.min(a[2] as number, b[2] as number) - Math.max(a[0] as number, b[0] as number)
    const ih = Math.min(a[3] as number, b[3] as number) - Math.max(a[1] as number, b[1] as number)
    if (iw <= 0 || ih <= 0) return 0
    const inter = iw * ih
    return inter / (((a[2] as number) - (a[0] as number)) * ((a[3] as number) - (a[1] as number)) + ((b[2] as number) - (b[0] as number)) * ((b[3] as number) - (b[1] as number)) - inter)
}

// Overlapping crops see the same object twice, keep the best per label.
export function nms(dets: Detection[], threshold = NMS_IOU): Detection[] {
    const keep: Detection[] = []
    for (const d of [...dets].sort((a, b) => b.score - a.score)) {
        if (!keep.some(k => k.label === d.label && iou(k.box, d.box) > threshold)) keep.push(d)
    }
    return keep
}

// Detect on this frame? Always when there is motion, otherwise (only watching tracked objects) at most once per STATIONARY_MS
export function shouldDetect(hasMotionBoxes: boolean, lastDetectAt: number, now: number): boolean {
    return hasMotionBoxes || now - lastDetectAt >= STATIONARY_MS
}

// Connected groups of active cells -> normalised boxes (one cell of margin), largest first
export function cellBoxes(active: Uint8Array, cw: number, ch: number): Box[] {
    const seen = new Uint8Array(active.length)
    const boxes: { box: Box; n: number }[] = []
    for (let start = 0; start < active.length; start++) {
        if (!active[start] || seen[start]) continue
        let minx = cw, miny = ch, maxx = 0, maxy = 0, n = 0
        const stack = [start]
        seen[start] = 1
        while (stack.length) {
            const i = stack.pop() as number
            const x = i % cw, y = (i / cw) | 0
            n++
            minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y)
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx, ny = y + dy
                if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue
                const j = ny * cw + nx
                if (active[j] && !seen[j]) { seen[j] = 1; stack.push(j) }
            }
        }
        boxes.push({ n, box: [Math.max(0, minx - 1) / cw, Math.max(0, miny - 1) / ch, Math.min(cw, maxx + 2) / cw, Math.min(ch, maxy + 2) / ch] })
    }
    return boxes.sort((a, b) => b.n - a.n).map(b => b.box)
}

// ffprobe the stream size, so the decoded frames keep the camera's aspect ratio
function probeSize(url: string): Promise<[number, number]> {
    return new Promise((res, rej) => {
        const p = spawn('/usr/bin/ffprobe', [
            '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0',
            ...(url.startsWith('rtsp') ? ['-rtsp_transport', 'tcp'] : []), url
        ])
        let out = '', err = ''
        const t = setTimeout(() => p.kill(), 20000)
        p.stdout.on('data', (d: Buffer) => { out += d })
        p.stderr.on('data', (d: Buffer) => { err += d })
        p.on('error', (e: Error) => { clearTimeout(t); rej(e) })
        p.on('close', () => {
            clearTimeout(t)
            // some streams list the video stream more than once, the first line is enough
            const [w, h] = (out.trim().split('\n')[0] || '').split(',').map(Number)
            w && h ? res([w, h]) : rej(new Error(`ffprobe failed: ${err.trim().slice(-200) || 'no video stream'}`))
        })
    })
}

// Runs one ffmpeg that outputs raw RGB frames, does frame-difference motion detection on them, and runs the
// object detector (Coral/CPU) on square crops around the motion (or around objects already being tracked).
// Emits 'motion' (boolean), 'objects' (counts by label) and 'active' (boolean).
// ffmpeg only runs while the detector is up, and restarts with backoff.
export class DetectPipeline extends EventEmitter {

    private proc: ChildProcessWithoutNullStreams | null = null
    private chunks: Buffer[] = []
    private have = 0
    private w = 0
    private h = 0
    private size = 0
    private wanted = false
    private starting = false
    private busy = false
    private failures = 0
    private startedAt = 0
    private lastFrameAt = 0
    private restartTimer: NodeJS.Timeout | null = null
    private stallTimer: NodeJS.Timeout | null = null

    // motion grid: every STRIDE-th pixel
    private mw = 0
    private mh = 0
    private cur = new Float32Array(0)
    private bg: Float32Array | null = null
    private ignore: Uint8Array = new Uint8Array(0)
    private objectMask: Uint8Array = new Uint8Array(0)
    private cells = new Uint8Array(0)
    private cellCounts = new Uint16Array(0)
    private validSamples = 0

    private lastValid = 0
    private lastDetectAt = 0
    private frames = 0
    private fpsSince = Date.now()
    private tags: { [label: string]: DetectTag } = {}
    private prevCounts: { [label: string]: number } = {}
    private onReady = () => this.evaluate()
    private onDown = () => this.halt('waiting for detector')

    state: DetectState = { running: false, fps: 0, motion: false, active: false, objects: [], regions: 0, lastFrame: 0 }

    constructor(private name: string, private url: string, private settings: DetectSettings) {
        super()
    }

    start() {
        this.wanted = true
        detector.on('ready', this.onReady)
        detector.on('down', this.onDown)
        this.evaluate()
    }

    stop() {
        this.wanted = false
        detector.off('ready', this.onReady)
        detector.off('down', this.onDown)
        this.halt()
    }

    // Tags accumulated since the last take (best score per label), stored with the event.
    takeTags(): DetectTag[] {
        const t = this.peekTags()
        this.tags = {}
        return t
    }

    peekTags(): DetectTag[] {
        return Object.values(this.tags)
    }

    // Allocates the motion grid and rasterises masks for frames of w x h
    configure(w: number, h: number) {
        this.w = w
        this.h = h
        this.size = w * h * 3
        this.mw = Math.floor(w / STRIDE)
        this.mh = Math.floor(h / STRIDE)
        this.cur = new Float32Array(this.mw * this.mh)
        this.bg = null
        this.ignore = rasterise(this.settings.motion_mask, this.mw, this.mh)
        this.objectMask = rasterise(this.settings.object_mask, this.mw, this.mh)
        this.validSamples = this.ignore.reduce((n, v) => n + (v ? 0 : 1), 0)
        this.cells = new Uint8Array(Math.ceil(this.mw / CELL) * Math.ceil(this.mh / CELL))
        this.cellCounts = new Uint16Array(this.cells.length)
    }

    private setState(s: Partial<DetectState>) {
        const prev = this.state
        this.state = { ...prev, ...s }
        if (prev.motion !== this.state.motion) this.emit('motion', this.state.motion)
        if (prev.active !== this.state.active) this.emit('active', this.state.active)
    }

    // start ffmpeg if it should be running and is not
    private evaluate() {
        if (!this.wanted || this.proc || this.starting || this.restartTimer) return
        if (!detector.ready) {
            this.setState({ running: false, error: 'waiting for detector' })
            return
        }
        this.starting = true
        const width = Math.min(Math.max(this.settings.detect_width || 640, 160), 1920)
        probeSize(this.url).then(([sw, sh]) => {
            this.starting = false
            if (!this.wanted || !detector.ready) return
            const w = width - (width % 2)
            const h = Math.max(2, Math.round(w * sh / sw / 2) * 2)
            this.configure(w, h)
            this.spawnFfmpeg()
        }, (e: Error) => {
            this.starting = false
            this.failed(e.message)
        })
    }

    private failed(why: string) {
        this.failures++
        const delay = backoffMs(this.failures, 5000, 60000)
        console.warn(`detect [${this.name}]: ${why.slice(0, 200)}, retrying in ${Math.round(delay / 1000)}s`)
        this.setState({ running: false, motion: false, active: false, objects: [], error: why.slice(0, 300) })
        if (this.restartTimer) clearTimeout(this.restartTimer)
        this.restartTimer = setTimeout(() => { this.restartTimer = null; this.evaluate() }, delay)
    }

    // stop ffmpeg without scheduling a restart
    private halt(why?: string) {
        if (this.restartTimer) clearTimeout(this.restartTimer)
        if (this.stallTimer) clearInterval(this.stallTimer)
        this.restartTimer = this.stallTimer = null
        const p = this.proc
        this.proc = null
        p?.kill()
        this.setState({ running: false, motion: false, active: false, objects: [], error: why })
    }

    private spawnFfmpeg() {
        const fps = Math.min(Math.max(this.settings.detect_fps || 5, 1), 30)
        const args = [
            '-hide_banner', '-loglevel', 'error',
            ...(this.url.startsWith('rtsp') ? ['-rtsp_transport', 'tcp'] : []),
            '-i', this.url, '-an',
            '-vf', `fps=${fps},scale=${this.w}:${this.h}`,
            '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'
        ]
        const proc = spawn('/usr/bin/ffmpeg', args)
        this.proc = proc
        this.chunks = []
        this.have = 0
        this.bg = null
        this.startedAt = this.lastFrameAt = Date.now()
        let err = ''
        this.setState({ running: true, error: undefined, size: [this.w, this.h] })

        proc.stdout.on('data', (d: Buffer) => this.onData(d))
        proc.stderr.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-300) })
        proc.on('error', (e: Error) => { err = `${e.name}: ${e.message}` })
        proc.on('close', (code: number) => {
            if (this.proc !== proc) return
            this.proc = null
            if (this.stallTimer) clearInterval(this.stallTimer)
            this.stallTimer = null
            if (!this.wanted) return
            this.failed(err.trim() || `ffmpeg exited with code ${code}`)
        })
        if (this.stallTimer) clearInterval(this.stallTimer)
        this.stallTimer = setInterval(() => {
            if (Date.now() - this.lastFrameAt > STALL_MS) {
                console.warn(`detect [${this.name}]: no frames for ${STALL_MS / 1000}s, restarting ffmpeg`)
                err = 'no frames'
                proc.kill()
            }
        }, 5000)
    }

    private onData(d: Buffer) {
        this.chunks.push(d)
        this.have += d.length
        while (this.have >= this.size) {
            const all = this.chunks.length === 1 ? (this.chunks[0] as Buffer) : Buffer.concat(this.chunks)
            const frame = all.subarray(0, this.size)
            const rest = all.subarray(this.size)
            this.chunks = rest.length ? [rest] : []
            this.have = rest.length
            this.onFrame(frame)
        }
    }

    private async onFrame(frame: Buffer) {
        const now = Date.now()
        this.lastFrameAt = now
        if (this.failures > 0 && now - this.startedAt > STABLE_MS) this.failures = 0
        this.frames++
        if (now - this.fpsSince >= 5000) {
            this.state = { ...this.state, fps: Math.round(this.frames * 1000 / (now - this.fpsSince) * 10) / 10 }
            this.frames = 0
            this.fpsSince = now
        }
        // one frame processed at a time, skip frames while the detector is busy
        if (this.busy) return
        this.busy = true
        try {
            const { motion, boxes } = this.detectMotion(frame)
            const recentlyActive = now - this.lastValid < KEEPALIVE_MS
            let objects: TrackedObject[] = this.state.objects
            let regions = 0
            // look at: where there is motion, and where objects already are (they may have stopped moving)
            const looks = motion ? boxes.slice() : []
            if (recentlyActive) looks.push(...this.state.objects.map(o => o.box))
            if (looks.length > 0 && detector.ready && shouldDetect(motion && boxes.length > 0, this.lastDetectAt, now)) {
                this.lastDetectAt = now
                const [iw, ih] = detector.status.inputSize as [number, number]
                const crops = this.pickRegions(looks)
                const found: Detection[] = []
                let any = false
                for (const r of crops) {
                    const dets = await detector.detect(cropResize(frame, this.w, this.h, r, iw, ih), this.name)
                    if (!this.proc) return
                    if (dets) {
                        any = true
                        regions++
                        for (const d of dets) found.push({ ...d, box: mapBox(d.box, r, this.w, this.h) })
                    }
                }
                if (any) {
                    objects = this.filter(nms(found))
                    if (objects.length > 0) {
                        this.lastValid = Date.now()
                        this.addTags(objects)
                    }
                }
            } else if (!motion && !recentlyActive) {
                objects = []
            }
            const requireObject = this.settings.require_object !== false
            const active = objects.length > 0 || (!requireObject && motion)
            this.setState({ motion, active, objects, regions, lastFrame: now })
            this.emitCounts(objects)
        } catch (e) {
            console.warn(`detect [${this.name}]: frame error ${e}`)
        } finally {
            this.busy = false
        }
    }

    // up to MAX_REGIONS crops, skipping boxes whose centre is already inside a chosen crop
    private pickRegions(boxes: Box[]): Region[] {
        const out: Region[] = []
        for (const b of boxes) {
            const cx = (b[0] + b[2]) / 2 * this.w, cy = (b[1] + b[3]) / 2 * this.h
            if (out.some(r => cx >= r.x0 && cx <= r.x0 + r.side && cy >= r.y0 && cy <= r.y0 + r.side)) continue
            out.push(regionFor(b, this.w, this.h))
            if (out.length >= MAX_REGIONS) break
        }
        return out
    }

    // Running-average background subtraction on luma samples, ignoring masked ones.
    // Returns whether there is motion and boxes around the moving areas.
    detectMotion(rgb: Buffer): { motion: boolean; boxes: Box[] } {
        const { mw, mh, w, cur } = this
        for (let gy = 0; gy < mh; gy++) {
            let j = gy * STRIDE * w * 3
            for (let gx = 0, i = gy * mw; gx < mw; gx++, j += STRIDE * 3) {
                cur[i + gx] = ((rgb[j] as number) * 77 + (rgb[j + 1] as number) * 150 + (rgb[j + 2] as number) * 29) / 256
            }
        }
        const bg = this.bg
        if (!bg) {
            this.bg = Float32Array.from(cur)
            return { motion: false, boxes: [] }
        }

        const thr = this.settings.motion_threshold || 25
        const cw = Math.ceil(mw / CELL)
        this.cellCounts.fill(0)
        let changed = 0
        for (let gy = 0; gy < mh; gy++) {
            for (let gx = 0; gx < mw; gx++) {
                const i = gy * mw + gx
                const diff = (cur[i] as number) - (bg[i] as number)
                bg[i] = (bg[i] as number) + BG_ALPHA * diff
                if (!this.ignore[i] && (diff > thr || diff < -thr)) {
                    changed++
                    this.cellCounts[((gy / CELL) | 0) * cw + ((gx / CELL) | 0)]++
                }
            }
        }
        if (this.validSamples === 0) return { motion: false, boxes: [] }
        const frac = changed / this.validSamples
        if (frac > LIGHT_CHANGE) {
            // exposure/IR switch: relearn background instead of reporting motion
            bg.set(cur)
            return { motion: false, boxes: [] }
        }
        const motion = frac * 100 >= (this.settings.motion_area ?? 1)
        if (!motion) return { motion, boxes: [] }
        for (let c = 0; c < this.cells.length; c++) this.cells[c] = (this.cellCounts[c] as number) >= CELL_MIN_CHANGED ? 1 : 0
        return { motion, boxes: cellBoxes(this.cells, cw, Math.ceil(mh / CELL)) }
    }

    private filter(dets: Detection[]): TrackedObject[] {
        const track = this.settings.track_objects && this.settings.track_objects.length ? this.settings.track_objects : DEFAULT_TRACK
        const minScore = this.settings.min_score || 0.6
        const zones = this.settings.zones
        const out: TrackedObject[] = []
        for (const d of dets) {
            if (!track.includes(d.label) || d.score < minScore) continue
            const cx = (d.box[0] + d.box[2]) / 2, cy = (d.box[1] + d.box[3]) / 2
            const px = Math.min(this.mw - 1, Math.max(0, Math.floor(cx * this.mw))), py = Math.min(this.mh - 1, Math.max(0, Math.floor(cy * this.mh)))
            if (this.objectMask[py * this.mw + px]) continue
            const z = zonesFor(d.label, d.box, zones)
            // with zones defined, an object only counts inside a zone that allows its label
            if (zones && zones.length > 0 && z.length === 0) continue
            out.push({ ...d, zones: z })
        }
        return out
    }

    private addTags(objects: TrackedObject[]) {
        for (const o of objects) {
            const cur = this.tags[o.label]
            if (!cur || o.score * 100 > cur.probability) {
                this.tags[o.label] = { tag: o.label, probability: Math.round(o.score * 100), box: o.box, zones: o.zones }
            }
        }
    }

    private emitCounts(objects: TrackedObject[]) {
        const counts: { [label: string]: number } = {}
        for (const o of objects) counts[o.label] = (counts[o.label] || 0) + 1
        const labels = new Set([...Object.keys(counts), ...Object.keys(this.prevCounts)])
        const changed: { [label: string]: number } = {}
        for (const l of labels) {
            if ((counts[l] || 0) !== (this.prevCounts[l] || 0)) changed[l] = counts[l] || 0
        }
        this.prevCounts = counts
        if (Object.keys(changed).length > 0) this.emit('objects', changed, counts)
    }
}
