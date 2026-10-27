import fs from 'fs/promises'
import { validPolygon } from './zones.js'
import type { Polygon, Zone } from './zones.js'
import type { CameraEntry } from './types.js'

// stream12345.ts in an HLS playlist
export const re = new RegExp(`stream([\\d]+).ts`, 'g');

// single path segment, no traversal
export function safeName(n: string): boolean {
    return /^[\w][\w.-]*$/.test(n) && !n.includes('..')
}

// credentials in urls/messages must not reach the browser
export function maskSecrets(v: any): any {
    if (typeof v === 'string') return v.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^@/\s]+@/gi, '$1****@')
    if (Array.isArray(v)) return v.map(maskSecrets)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskSecrets(x)]))
    return v
}

export function maskUrl(u?: string): string | undefined {
    return u ? u.replace(/\/\/[^@/]*@/, '//****@') : undefined
}

export async function ensureDir(folder: string): Promise<boolean> {
    try {
        const stat = await fs.stat(folder)
        if (!stat.isDirectory()) {
            throw new Error(`${folder} is not a directory`)
        }
        return true
    } catch (e) {
        if (e.code === 'ENOENT') {
            try {
                await fs.mkdir(folder)
                return true
            } catch (e) {
                throw new Error(`Cannot create ${folder}: ${e}`)
            }
        } else {
            throw new Error(`Cannot stat ${folder}: ${e}`)
        }
    }
}

// Validates/normalises a camera body from the client; unknown fields are dropped
export function sanitizeCamera(b: any): CameraEntry {
    const str = (v: any) => typeof v === 'string' ? v : undefined
    const num = (v: any, min: number, max: number) => typeof v === 'number' && v >= min && v <= max ? v : undefined
    const bool = (v: any) => typeof v === 'boolean' ? v : undefined
    const strs = (v: any) => Array.isArray(v) && v.every(x => typeof x === 'string') ? v.slice(0, 100) : undefined
    const polys = (v: any): Polygon[] | undefined => {
        if (v === undefined) return undefined
        if (!Array.isArray(v) || v.length > 50 || !v.every(validPolygon)) throw new Error('invalid mask polygon (points must be [x,y] between 0 and 1)')
        return v
    }
    const zones = (v: any): Zone[] | undefined => {
        if (v === undefined) return undefined
        if (!Array.isArray(v) || v.length > 50) throw new Error('invalid zones')
        return v.map(z => {
            if (!z || typeof z.name !== 'string' || !z.name || !validPolygon(z.points) || (z.objects !== undefined && !strs(z.objects))) throw new Error('invalid zone')
            return { name: z.name.slice(0, 40), points: z.points, ...(z.objects && { objects: z.objects }) }
        })
    }
    const url = (v: any, what: string) => {
        if (v === undefined) return undefined
        if (v === '') return ''
        if (typeof v !== 'string' || !/^(rtsp|rtsps|rtmp|http|https):\/\/[^\s]+$/i.test(v)) throw new Error(`${what} must be an rtsp://, rtmp:// or http(s):// url`)
        return v
    }
    const ct = b.camera_type === 'rtsp' ? 'rtsp' : b.camera_type === 'reolink' ? 'reolink' : undefined
    const out: any = {
        delete: false,
        name: str(b.name), folder: str(b.folder), disk: str(b.disk),
        camera_type: ct,
        ip: str(b.ip), passwd: str(b.passwd),
        rtsp_url: url(b.rtsp_url, 'rtsp_url'), detect_url: url(b.detect_url, 'detect_url'),
        record_audio: bool(b.record_audio),
        enable_streaming: bool(b.enable_streaming), enable_movement: bool(b.enable_movement),
        secWithoutMovement: num(b.secWithoutMovement, 0, 3600), secMaxSingleMovement: num(b.secMaxSingleMovement, 1, 86400),
        mSPollFrequency: num(b.mSPollFrequency, 100, 60000),
        segments_prior_to_movement: num(b.segments_prior_to_movement, 0, 600), segments_post_movement: num(b.segments_post_movement, 0, 600),
        ignore_tags: strs(b.ignore_tags),
        detect_enabled: bool(b.detect_enabled), detect_fps: num(b.detect_fps, 1, 30), detect_width: num(b.detect_width, 160, 1920),
        track_objects: strs(b.track_objects), min_score: num(b.min_score, 0.1, 1),
        require_object: bool(b.require_object), motion_threshold: num(b.motion_threshold, 1, 255), motion_area: num(b.motion_area, 0, 100),
        motion_mask: polys(b.motion_mask), object_mask: polys(b.object_mask), zones: zones(b.zones)
    }
    // drop unset fields so saving a partial form keeps the stored values; blank secrets/urls mean "keep"
    for (const k of Object.keys(out)) {
        if (out[k] === undefined || ((k === 'ip' || k === 'passwd' || k === 'rtsp_url') && out[k] === '')) delete out[k]
    }
    if (out.name !== undefined && !/^[a-z0-9][_\-a-z0-9]+[a-z0-9]$/i.test(out.name)) throw new Error('invalid camera name')
    if (out.folder !== undefined && (out.folder.startsWith('/') || out.folder.split('/').includes('..'))) throw new Error('invalid folder')
    return out as CameraEntry
}

// ffmpeg args for recording an rtsp camera into HLS segments
export function rtspRecordArgs(url: string, ce: CameraEntry, streamFile: string): string[] {
    return [
        '-hide_banner', '-loglevel', 'error',
        ...(url.startsWith('rtsp') ? ['-rtsp_transport', 'tcp'] : []),
        '-i', url,
        '-c:v', 'copy', ...(ce.record_audio ? ['-c:a', 'aac', '-b:a', '64k'] : ['-an']),
        '-hls_time', '2',
        '-start_number', ((Date.now() / 1000 | 0) - 1600000000).toString(),
        streamFile
    ]
}
