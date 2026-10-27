import { spawn } from 'child_process'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import { EventEmitter } from 'events'
import path from 'path'
import { backoffMs } from './backoff.js'

export interface Detection {
    label: string;
    score: number;
    // normalised [x1, y1, x2, y2]
    box: [number, number, number, number];
}

export interface DetectorConfig {
    // none = disabled
    type: 'none' | 'edgetpu' | 'cpu' | 'mock';
    // edgetpu device: '' (first), 'usb', 'usb:0', 'pci', 'pci:0'. Several, comma separated, use one worker per device.
    device?: string;
    model?: string;
    labels?: string;
    python?: string;
    min_score?: number;
}

export interface WorkerStatus {
    device: string;
    state: 'stopped' | 'starting' | 'running' | 'error';
    error?: string;
    inferenceMs?: number;
    detections: number;
}

export interface DetectorStatus {
    type: string;
    state: 'stopped' | 'starting' | 'running' | 'error';
    backend?: string;
    error?: string;
    inputSize?: [number, number];
    inferenceMs?: number;
    detections: number;
    // frames replaced by a newer one from the same camera before they ran
    dropped: number;
    workers: WorkerStatus[];
}

interface Pending {
    owner: string;
    frame: Buffer;
    resolve: (d: Detection[] | null) => void;
}

interface InFlight {
    id: number;
    pending: Pending;
}

const REQUEST_TIMEOUT_MS = 5000
// a detector that ran this long before dying is not a crash loop
const STABLE_MS = 60000

export function deviceList(cfg: DetectorConfig): string[] {
    if (cfg.type !== 'edgetpu') return ['']
    const devices = (cfg.device || '').split(',').map(d => d.trim()).filter((d, i, all) => d && all.indexOf(d) === i)
    return devices.length > 0 ? devices : ['']
}

// One python detector process (detector/detector.py), one frame in flight at a time
class Worker {
    status: WorkerStatus
    backend?: string
    inputSize?: [number, number]
    private proc: ChildProcessWithoutNullStreams | null = null
    private inflight: InFlight | null = null
    private timer: NodeJS.Timeout | null = null
    private restartTimer: NodeJS.Timeout | null = null
    private lineBuf = ''
    private generation = 0
    private failures = 0
    private readyAt = 0
    private emaMs = 0
    private nextId = 1

    constructor(private cfg: DetectorConfig, private device: string, private onChange: () => void, private onResult: (r: Detection[] | null, p: Pending) => void) {
        this.status = { device, state: 'stopped', detections: 0 }
    }

    get idle(): boolean {
        return this.status.state === 'running' && !this.inflight
    }

    start() {
        this.generation++
        this.spawnProc()
    }

    stop() {
        this.generation++
        if (this.restartTimer) clearTimeout(this.restartTimer)
        this.restartTimer = null
        this.killProc()
        this.proc = null
        this.failInflight()
        this.set({ state: 'stopped' })
    }

    submit(p: Pending) {
        const id = this.nextId++
        const size = this.inputSize as [number, number]
        const head = Buffer.alloc(12)
        head.write('NVRD', 0, 'ascii')
        head.writeUInt32LE(id, 4)
        head.writeUInt16LE(size[0], 8)
        head.writeUInt16LE(size[1], 10)
        this.inflight = { id, pending: p }
        this.timer = setTimeout(() => {
            console.warn(`detector ${this.device || 'auto'}: request timed out, restarting`)
            this.killProc()
        }, REQUEST_TIMEOUT_MS)
        ;(this.proc as ChildProcessWithoutNullStreams).stdin.write(Buffer.concat([head, p.frame]))
    }

    private set(s: Partial<WorkerStatus>) {
        this.status = { ...this.status, ...s }
        this.onChange()
    }

    private args(): string[] {
        const c = this.cfg
        return [
            process.env['DETECTOR_PY'] || path.join(__dirname, '..', 'detector', 'detector.py'),
            '--backend', c.type,
            ...(c.model ? ['--model', c.model] : []),
            ...(c.labels ? ['--labels', c.labels] : []),
            ...(this.device ? ['--device', this.device] : []),
            ...(c.min_score ? ['--min-score', String(Math.min(c.min_score, 0.4))] : [])
        ]
    }

    private spawnProc() {
        const gen = this.generation
        this.set({ state: 'starting', error: undefined })
        const python = this.cfg.python || process.env['DETECTOR_PYTHON'] || 'python3'
        console.log(`detector: starting ${python} ${this.args().join(' ')}`)
        const proc = spawn(python, this.args())
        this.proc = proc
        this.lineBuf = ''

        proc.stdout.on('data', (d: Buffer) => this.onData(gen, d))
        proc.stderr.on('data', (d: Buffer) => console.warn(`detector ${this.device || 'auto'} stderr: ${d.toString().trim()}`))
        proc.on('error', (e: Error) => this.onExit(gen, `${e.name}: ${e.message}`))
        proc.on('close', (code: number) => this.onExit(gen, `exited with code ${code}`))
        // stdin errors (EPIPE after a crash) are handled by the close event
        proc.stdin.on('error', () => { /* ignored */ })
    }

    private onData(gen: number, d: Buffer) {
        if (gen !== this.generation) return
        this.lineBuf += d.toString()
        let nl: number
        while ((nl = this.lineBuf.indexOf('\n')) >= 0) {
            const line = this.lineBuf.slice(0, nl)
            this.lineBuf = this.lineBuf.slice(nl + 1)
            if (line.trim()) this.onMessage(line)
        }
    }

    private onMessage(line: string) {
        let m: any
        try {
            m = JSON.parse(line)
        } catch (e) {
            console.warn(`detector: unparseable output: ${line.slice(0, 200)}`)
            return
        }
        if (m.type === 'ready') {
            this.backend = m.backend
            this.inputSize = m.input
            this.readyAt = Date.now()
            console.log(`detector ${this.device || 'auto'}: ready backend=${m.backend} input=${m.input}`)
            this.set({ state: 'running', error: undefined })
        } else if (m.type === 'result') {
            const f = this.inflight
            if (f && f.id === m.id) {
                this.clearTimer()
                this.inflight = null
                this.emaMs = this.emaMs ? this.emaMs * 0.9 + m.ms * 0.1 : m.ms
                this.status = { ...this.status, inferenceMs: Math.round(this.emaMs * 10) / 10, detections: this.status.detections + 1 }
                this.onResult(m.detections, f.pending)
            }
        } else if (m.type === 'error') {
            console.warn(`detector ${this.device || 'auto'} error: ${m.msg}`)
            if (m.id === null || m.id === undefined) {
                // fatal (startup) error, the process exits right after
                this.set({ state: 'error', error: m.msg })
            } else if (this.inflight?.id === m.id) {
                this.clearTimer()
                const f = this.inflight
                this.inflight = null
                this.status = { ...this.status, error: m.msg }
                this.onResult(null, f.pending)
            }
        }
    }

    private onExit(gen: number, why: string) {
        if (gen !== this.generation) return
        this.proc = null
        this.clearTimer()
        this.failInflight()
        // a crash loop (no Coral, bad model) backs off to a minute instead of retrying every few seconds
        this.failures = this.readyAt && Date.now() - this.readyAt > STABLE_MS ? 1 : this.failures + 1
        this.readyAt = 0
        const delay = backoffMs(this.failures, 5000, 60000)
        console.warn(`detector ${this.device || 'auto'}: ${why}, restarting in ${Math.round(delay / 1000)}s`)
        this.set({ state: 'error', error: this.status.error || why })
        this.restartTimer = setTimeout(() => {
            this.restartTimer = null
            if (gen === this.generation) this.spawnProc()
        }, delay)
    }

    private failInflight() {
        this.clearTimer()
        const f = this.inflight
        this.inflight = null
        if (f) this.onResult(null, f.pending)
    }

    private clearTimer() {
        if (this.timer) clearTimeout(this.timer)
        this.timer = null
    }

    private killProc() {
        this.clearTimer()
        this.proc?.kill()
    }
}

// Runs one detector process per device and shares them between all cameras:
// each camera has at most one waiting frame (its newest), served round-robin to whichever worker is free.
export class DetectorClient extends EventEmitter {

    private cfg: DetectorConfig = { type: 'none' }
    private workers: Worker[] = []
    private waiting = new Map<string, Pending>()
    private dropped = 0
    private wasReady = false
    status: DetectorStatus = { type: 'none', state: 'stopped', detections: 0, dropped: 0, workers: [] }

    constructor() {
        super()
        // every camera pipeline listens for ready/down
        this.setMaxListeners(100)
    }

    get ready(): boolean {
        return this.status.state === 'running'
    }

    start(cfg: DetectorConfig) {
        this.stop()
        this.cfg = cfg
        this.dropped = 0
        if (cfg.type === 'none') {
            this.refresh()
            return
        }
        this.workers = deviceList(cfg).map(d => new Worker(cfg, d, () => this.refresh(), (r, p) => this.onResult(r, p)))
        this.refresh()
        this.workers.forEach(w => w.start())
    }

    stop() {
        this.workers.forEach(w => w.stop())
        this.workers = []
        for (const p of this.waiting.values()) p.resolve(null)
        this.waiting.clear()
        this.refresh()
    }

    // Resolves null when the frame was replaced by a newer one from the same owner, or the detector is unavailable.
    // Callers use the camera name as owner.
    detect(frame: Buffer, owner = 'default'): Promise<Detection[] | null> {
        if (!this.ready) {
            this.dropped++
            return Promise.resolve(null)
        }
        return new Promise(resolve => {
            const old = this.waiting.get(owner)
            if (old) {
                this.dropped++
                old.resolve(null)
                // newest frame goes to the back of the line too, so one chatty camera cannot hold the front
                this.waiting.delete(owner)
            }
            this.waiting.set(owner, { owner, frame, resolve })
            this.pump()
        })
    }

    // Map keeps insertion order: oldest waiting owner first
    private pump() {
        for (const w of this.workers) {
            if (this.waiting.size === 0) return
            if (!w.idle) continue
            const [owner, p] = this.waiting.entries().next().value as [string, Pending]
            this.waiting.delete(owner)
            w.submit(p)
        }
    }

    private onResult(r: Detection[] | null, p: Pending) {
        p.resolve(r)
        // refresh publishes the new timings and hands waiting frames to free workers
        this.refresh()
    }

    private refresh() {
        const ws = this.workers.map(w => w.status)
        const running = this.workers.filter(w => w.status.state === 'running')
        const first = running[0]
        const ms = running.map(w => w.status.inferenceMs).filter((x): x is number => x !== undefined)
        const states = ws.map(w => w.state)
        const state: DetectorStatus['state'] = running.length > 0 ? 'running' : states.includes('starting') ? 'starting' : states.includes('error') ? 'error' : 'stopped'
        this.status = {
            type: this.cfg.type,
            state,
            backend: first?.backend,
            error: running.length === 0 ? ws.find(w => w.error)?.error : undefined,
            inputSize: first?.inputSize,
            inferenceMs: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length * 10) / 10 : undefined,
            detections: ws.reduce((n, w) => n + w.detections, 0),
            dropped: this.dropped,
            workers: ws
        }
        const ready = state === 'running'
        if (ready !== this.wasReady) {
            this.wasReady = ready
            this.emit(ready ? 'ready' : 'down', this.status)
            if (ready) this.pump()
        } else if (ready) {
            this.pump()
        }
    }
}

export const detector = new DetectorClient()
