const Koa = require('koa')

import bodyParser from 'koa-bodyparser'
import Router from '@koa/router'
import type http from 'http'
import { go2rtc } from './go2rtc.js'
import { auth, PORT, proxy } from './state.js'
import { mediaRoutes } from './routes_media.js'
import { apiRoutes } from './routes_api.js'

// the UI loads its icon font from the Fluent CDN; everything else is ours. Video is MSE (blob:) or HLS.
const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data: https://spoppe-b.azureedge.net https://static2.sharepointonline.com",
    "connect-src 'self' ws: wss:",
    "worker-src 'self' blob:",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'"
].join('; ')

let warnedProxy = false

// http server: login check, api, media and the app itself
export function startWeb() {
    const api = apiRoutes()
    const assets = mediaRoutes()

    const nav = new Router()
        .get('/network', async (ctx, _next) => {
            ctx.redirect(`http://${ctx.headers.host? ctx.headers.host.split(":")[0] : 'localhost'}:3998`)
        })
        .get('/metrics', async (ctx, _next) => {
            ctx.redirect(`http://${ctx.headers.host? ctx.headers.host.split(":")[0] : 'localhost'}:3000/d/T3OrKihMk/our-house?orgId=1`)
        })

    const app = new Koa()
    // honour X-Forwarded-* (https detection for secure cookies) only behind a reverse proxy you control
    app.proxy = process.env['TRUST_PROXY'] === '1'

    app.use(async (ctx, next) => {
        ctx.set('X-Content-Type-Options', 'nosniff')
        ctx.set('X-Frame-Options', 'SAMEORIGIN')
        ctx.set('Referrer-Policy', 'same-origin')
        ctx.set('Content-Security-Policy', CSP)
        if (process.env['HSTS'] === '1') ctx.set('Strict-Transport-Security', 'max-age=31536000')
        if (!app.proxy && ctx.headers['x-forwarded-for'] && !warnedProxy) {
            warnedProxy = true
            console.warn('requests carry X-Forwarded-For but TRUST_PROXY is not set: every user looks like the proxy, so the login lockout is shared and cookies are not marked Secure. Set TRUST_PROXY=1 behind your reverse proxy.')
        }
        const protectedPath = /^\/(api|image|video|mp4|go2rtc|network|metrics)(\/|$)/.test(ctx.path)
        if (!protectedPath || ctx.path === '/api/login' || ctx.path === '/api/me') return next()
        if (!auth.enabled) {
            ctx.state['session'] = { user: 'anonymous', role: 'admin', expires: 0 }
            return next()
        }
        if (auth.isInternal(ctx.req)) {
            ctx.state['session'] = { user: 'internal', role: 'viewer', expires: 0 }
            return next()
        }
        const session = await auth.fromRequest(ctx.req)
        if (!session) {
            ctx.status = 401
            ctx.body = { error: 'unauthorized' }
            return
        }
        ctx.state['session'] = session
        const selfService = ctx.path === '/api/logout' || ctx.path === '/api/password'
        const readOnly = ctx.method === 'GET' || ctx.method === 'HEAD'
        const adminOnly = ctx.path.startsWith('/api/users') || (!readOnly && !selfService)
        if (adminOnly && session.role !== 'admin') {
            ctx.status = 403
            ctx.body = { error: 'admin only' }
            return
        }
        return next()
    })
    app.use(bodyParser())
    app.use(api.routes())
    app.use(nav.routes())
    app.use(assets.routes())

    console.log(`Starting on ${PORT}..`)
    const server = app.listen(PORT)

    // live view websocket: only /go2rtc/api/ws?src=<one of our streams>, for authenticated users
    server.on('upgrade', async (req: http.IncomingMessage, socket, head) => {
        const deny = (code: string) => { socket.write(`HTTP/1.1 ${code}\r\nConnection: close\r\n\r\n`); socket.destroy() }
        try {
            const u = new URL(req.url || '', 'http://x')
            const src = u.searchParams.get('src')
            if (u.pathname !== '/go2rtc/api/ws' || !src || [...u.searchParams.keys()].length !== 1 || !go2rtc.has(src)) return deny('404 Not Found')
            if (auth.enabled && !(await auth.fromRequest(req))) return deny('401 Unauthorized')
            req.url = `/api/ws?src=${encodeURIComponent(src)}`
            proxy.ws(req, socket, head, { target: go2rtc.apiTarget }, () => socket.destroy())
        } catch (e) {
            deny('400 Bad Request')
        }
    })

    return server
}
