const lexint = require('lexicographic-integer')

import fs from 'fs'
import level from 'level'
import sub from 'subleveldown'
import httpProxy from 'http-proxy'
import { Auth } from './auth.js'
import type { Session, User, Store } from './auth.js'
import type { DetectPipeline } from './detect.js'
import type { CameraCache, SettingsCache } from './types.js'

// Shared mutable state. Modules read and change it through these objects (never reassign the exports).

export const PORT = process.env['PORT'] || 8080

// level creates the database folder but not its parents
fs.mkdirSync(process.env['DBPATH'] || './mydb', { recursive: true })

export const db = level(process.env['DBPATH'] || './mydb',  { valueEncoding : 'json' })

export const cameradb = sub(db, 'cameras', { valueEncoding : 'json' })

export const movementdb = sub(db, 'movements', {
    valueEncoding : 'json',
    keyEncoding: {
        type: 'lexicographic-integer',
        encode: (n) => lexint.pack(n, 'hex'),
        decode: lexint.unpack,
        buffer: false
    }
})

export const cameraCache: CameraCache = {}

// settingsCache is replaced as a whole, so it lives in an object
export const shared: { settingsCache: SettingsCache } = { settingsCache: undefined as any }

export interface PipelineEntry {
    pipe: DetectPipeline;
    sig: string;
}
// built-in detection pipelines, one per camera
export const pipelines: { [cameraKey: string]: PipelineEntry } = {}

// consecutive quick recording ffmpeg failures per camera
export const recordFailures: { [cameraKey: string]: number } = {}

// leveldb sublevel as a promise based Store
export function storeOf<T>(sublevel: any): Store<T> {
    return {
        get: (k) => sublevel.get(k),
        put: (k, v) => sublevel.put(k, v),
        del: (k) => sublevel.del(k),
        keys: () => new Promise((res, rej) => {
            const keys: string[] = []
            sublevel.createKeyStream().on('data', (k: string) => keys.push(k)).on('end', () => res(keys)).on('error', rej)
        })
    }
}

export const authEnabled = (process.env['NVR_AUTH'] || 'on').toLowerCase() !== 'off'

export const auth = new Auth(storeOf<User>(sub(db, 'users', { valueEncoding: 'json' })), storeOf<Session>(sub(db, 'sessions', { valueEncoding: 'json' })), authEnabled)

export const proxy = httpProxy.createProxyServer({ xfwd: false })
proxy.on('error', (e) => console.warn(`go2rtc proxy: ${e.message}`))
