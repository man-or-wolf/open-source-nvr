import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import fs from 'fs/promises'
import path from 'path'

const API_PORT = 1984
const RTSP_PORT = 8554

// Manages an optional go2rtc process (https://github.com/AlexxIT/go2rtc): cameras are restreamed over local RTSP so each
// camera only has one connection (recording + detection share it), and it serves low-latency MSE live view.
export class Go2Rtc {

    private proc: ChildProcess | null = null
    private streams: { [name: string]: string[] } = {}
    private bin = ''
    private signature = ''
    private restartTimer: NodeJS.Timeout | null = null
    error?: string

    get running(): boolean {
        return this.proc !== null
    }

    get apiTarget(): string {
        return `http://127.0.0.1:${API_PORT}`
    }

    // Stream names that may be requested by the browser
    has(name: string): boolean {
        return this.running && Object.prototype.hasOwnProperty.call(this.streams, name)
    }

    // Local restream URL for a stream, or the original if go2rtc is not serving it
    url(name: string, original: string): string {
        return this.has(name) ? `rtsp://127.0.0.1:${RTSP_PORT}/${name}` : original
    }

    // Starts/restarts go2rtc when the binary or stream set changed; stops it when bin is empty.
    async sync(bin: string | undefined, dir: string, streams: { [name: string]: string[] }) {
        const sig = JSON.stringify([bin, streams])
        if (sig === this.signature) return
        this.signature = sig
        this.stop()
        if (!bin || Object.keys(streams).length === 0) return
        this.bin = bin
        this.streams = streams
        const file = path.join(dir, 'go2rtc.yaml')
        // JSON is valid YAML; avoids quoting problems in urls/passwords. Holds camera credentials.
        await fs.writeFile(file, JSON.stringify({
            api: { listen: `127.0.0.1:${API_PORT}` },
            rtsp: { listen: `127.0.0.1:${RTSP_PORT}` },
            webrtc: { listen: '127.0.0.1:8555' },
            streams
        }), { mode: 0o600 })
        this.start(file)
    }

    private start(file: string) {
        console.log(`go2rtc: starting ${this.bin} with ${Object.keys(this.streams).length} streams`)
        const proc = spawn(this.bin, ['-config', file])
        this.proc = proc
        this.error = undefined
        proc.stdout.on('data', (d: Buffer) => console.log(`go2rtc: ${d.toString().trim()}`))
        proc.stderr.on('data', (d: Buffer) => console.warn(`go2rtc: ${d.toString().trim()}`))
        proc.on('error', (e: Error) => { this.error = `${e.name}: ${e.message}` })
        proc.on('close', (code: number) => {
            if (this.proc !== proc) return
            this.proc = null
            this.error = this.error || `exited with code ${code}`
            console.warn(`go2rtc: ${this.error}, restarting in 10s`)
            this.restartTimer = setTimeout(() => this.proc === null && this.start(file), 10000)
        })
    }

    stop() {
        if (this.restartTimer) clearTimeout(this.restartTimer)
        this.restartTimer = null
        const p = this.proc
        this.proc = null
        this.streams = {}
        p?.kill()
    }
}

export const go2rtc = new Go2Rtc()
