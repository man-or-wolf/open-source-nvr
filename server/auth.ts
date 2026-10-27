import crypto from 'crypto'
import type http from 'http'

export type Role = 'admin' | 'viewer'

export interface User {
    name: string;
    role: Role;
    salt: string;
    hash: string;
}

export interface Session {
    user: string;
    role: Role;
    expires: number;
}

// Minimal key/value store (a leveldb sublevel in practice)
export interface Store<T> {
    get(key: string): Promise<T>;
    put(key: string, value: T): Promise<void>;
    del(key: string): Promise<void>;
    keys(): Promise<string[]>;
}

export const COOKIE = 'nvr_session'
const SESSION_MS = 7 * 24 * 3600 * 1000
const MAX_FAILS = 5
const FAIL_WINDOW_MS = 60 * 1000

// sessions are stored by token hash, so a copy of the db cannot be replayed
function tokenKey(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex')
}

function scrypt(password: string, salt: string): Promise<string> {
    return new Promise((res, rej) => crypto.scrypt(password, salt, 64, (err, key) => err ? rej(err) : res(key.toString('hex'))))
}

export function validUsername(n: any): boolean {
    return typeof n === 'string' && /^[a-z0-9][a-z0-9_.-]{0,31}$/i.test(n)
}

export function validPassword(p: any): boolean {
    return typeof p === 'string' && p.length >= 8 && p.length <= 200
}

export class Auth {

    enabled: boolean
    // secret for our own ffmpeg calling back into this server on loopback
    readonly internalToken = crypto.randomBytes(24).toString('hex')
    private fails: { [ip: string]: number[] } = {}
    private cache: { [token: string]: Session } = {}

    constructor(private users: Store<User>, private sessions: Store<Session>, enabled: boolean) {
        this.enabled = enabled
    }

    // Creates the first admin if there are no users: password from NVR_ADMIN_PASSWORD, otherwise random and logged once.
    async bootstrap() {
        if (!this.enabled) {
            console.warn('auth: DISABLED (NVR_AUTH=off), anyone who can reach this server has full access')
            return
        }
        if ((await this.users.keys()).length > 0) return
        const name = process.env['NVR_ADMIN_USER'] || 'admin'
        const given = process.env['NVR_ADMIN_PASSWORD']
        const password = given && validPassword(given) ? given : crypto.randomBytes(9).toString('base64url')
        await this.setUser(name, password, 'admin')
        if (given && validPassword(given)) {
            console.log(`auth: created admin user "${name}"`)
        } else {
            console.log(`auth: created admin user "${name}" with generated password: ${password}  (change it in the app)`)
        }
    }

    async setUser(name: string, password: string, role: Role) {
        const salt = crypto.randomBytes(16).toString('hex')
        await this.users.put(name.toLowerCase(), { name: name.toLowerCase(), role, salt, hash: await scrypt(password, salt) })
    }

    async listUsers(): Promise<{ name: string; role: Role }[]> {
        const out = []
        for (const k of await this.users.keys()) {
            const { name, role } = await this.users.get(k)
            out.push({ name, role })
        }
        return out
    }

    async deleteUser(name: string) {
        name = name.toLowerCase()
        await this.users.del(name)
        // drop their sessions
        for (const k of await this.sessions.keys()) {
            if ((await this.sessions.get(k)).user === name) await this.sessions.del(k)
        }
        for (const t of Object.keys(this.cache)) {
            if ((this.cache[t] as Session).user === name) delete this.cache[t]
        }
    }

    throttled(ip: string): boolean {
        const now = Date.now()
        const recent = (this.fails[ip] || []).filter(t => now - t < FAIL_WINDOW_MS)
        if (recent.length > 0) this.fails[ip] = recent
        else delete this.fails[ip]
        return recent.length >= MAX_FAILS
    }

    // Drops old failure records, expired sessions and their cache entries. Run now and then.
    async purge() {
        const now = Date.now()
        for (const ip of Object.keys(this.fails)) this.throttled(ip)
        for (const k of await this.sessions.keys()) {
            try {
                if ((await this.sessions.get(k)).expires < now) await this.sessions.del(k)
            } catch (e) { /* removed meanwhile */ }
        }
        for (const t of Object.keys(this.cache)) {
            if ((this.cache[t] as Session).expires < now) delete this.cache[t]
        }
    }

    // Ends all sessions of a user, except the one with token `keep` (used when the password changes)
    async revokeSessions(name: string, keep?: string) {
        name = name.toLowerCase()
        const keepKey = keep ? tokenKey(keep) : ''
        for (const k of await this.sessions.keys()) {
            if (k !== keepKey && (await this.sessions.get(k)).user === name) await this.sessions.del(k)
        }
        for (const t of Object.keys(this.cache)) {
            if (t !== keep && (this.cache[t] as Session).user === name) delete this.cache[t]
        }
    }

    // returns a session token, or null for bad credentials
    async login(name: string, password: string, ip: string): Promise<string | null> {
        if (typeof name !== 'string' || typeof password !== 'string') return null
        let user: User | null = null
        try {
            user = await this.users.get(name.toLowerCase())
        } catch (e) { /* unknown user */ }
        // always hash, so unknown users cost the same as wrong passwords
        const salt = user ? user.salt : 'x'.repeat(32)
        const hash = await scrypt(password, salt)
        if (!user || !crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'))) {
            (this.fails[ip] = this.fails[ip] || []).push(Date.now())
            return null
        }
        const token = crypto.randomBytes(32).toString('base64url')
        const s: Session = { user: user.name, role: user.role, expires: Date.now() + SESSION_MS }
        this.cache[token] = s
        await this.sessions.put(tokenKey(token), s)
        return token
    }

    async logout(token: string) {
        delete this.cache[token]
        try { await this.sessions.del(tokenKey(token)) } catch (e) { /* already gone */ }
    }

    async session(token: string | undefined): Promise<Session | null> {
        if (!token) return null
        let s: Session | undefined = this.cache[token]
        if (!s) {
            try { s = await this.sessions.get(tokenKey(token)) } catch (e) { return null }
            this.cache[token] = s
        }
        if (s.expires < Date.now()) {
            await this.logout(token)
            return null
        }
        return s
    }

    // Session for an incoming request (cookie), or an HTTP basic auth header for API clients.
    async fromRequest(req: http.IncomingMessage): Promise<Session | null> {
        const cookies = parseCookies(req.headers.cookie)
        const s = await this.session(cookies[COOKIE])
        if (s) return s
        const basic = /^Basic (.+)$/i.exec(req.headers.authorization || '')
        if (basic) {
            const [name, ...rest] = Buffer.from(basic[1] as string, 'base64').toString().split(':')
            const ip = req.socket.remoteAddress || ''
            if (this.throttled(ip)) return null
            const token = await this.login(name as string, rest.join(':'), ip)
            if (token) {
                const s2 = await this.session(token)
                await this.logout(token)
                return s2
            }
        }
        return null
    }

    isInternal(req: http.IncomingMessage): boolean {
        const ra = req.socket.remoteAddress || ''
        return req.headers['x-nvr-internal'] === this.internalToken && (ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1')
    }
}

export function parseCookies(header: string | undefined): { [k: string]: string } {
    const out: { [k: string]: string } = {}
    for (const part of (header || '').split(';')) {
        const i = part.indexOf('=')
        if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
    }
    return out
}
