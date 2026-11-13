/**
 * 设置卡片的后端路由：/ustc-iwan/api/*。
 * GET 读状态，POST 做动作；响应统一 { ok: true, value } 或 { ok: false, error }。
 * 注册方式与 dsh-rewind 一致：connection.fetch.register 挂到宿主 Web 服务。
 */
import { readSettingsUpdate } from './settings-store.js'
import { startDownload, BINARY_NAME } from './binary.js'
import { isPortOpen } from './iwan-client.js'

const PREFIX = '/ustc-iwan/api'
const MAX_BODY_BYTES = 256 * 1024

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

function ok(value) {
  return json({ ok: true, value })
}

function fail(message, status = 400) {
  return json({ ok: false, error: String(message) }, status)
}

/**
 * @param {object} rt  createRuntime 的返回值
 * @param {object} deps { log(msg) }
 */
export function createRouteHandler(rt, { log = () => {} } = {}) {
  return async function handle(request) {
    const url = new URL(request.url ?? '/', 'http://dsh.local')
    if (!url.pathname.startsWith(PREFIX)) return fail('not found', 404)
    const action = url.pathname.slice(PREFIX.length) || '/'
    try {
      if (request.method === 'GET' && (action === '/status' || action === '/')) {
        const status = rt.status()
        status.iwan.socksAlive = await isPortOpen(
          status.settings.iwanSocksPort,
          status.settings.iwanSocksHost,
          600,
        )
        return ok(status)
      }
      if (request.method !== 'POST') return fail('method not allowed', 405)
      if (action === '/settings') {
        let body
        try {
          const text = await request.text()
          if (text.length > MAX_BODY_BYTES) return fail('请求体过大')
          body = JSON.parse(text || '{}')
        } catch {
          return fail('请求体不是合法 JSON')
        }
        const { patch, error } = readSettingsUpdate(body)
        if (error) return fail(error)
        await rt.applySettings(patch)
        return ok(rt.status())
      }
      if (action === '/download') {
        const result = await startDownload(log)
        return ok({ ...result, url: 'GitHub Releases', name: BINARY_NAME })
      }
      if (action === '/connect') {
        const handle = await rt.connect()
        return ok({ connected: true, managed: handle.managed })
      }
      if (action === '/disconnect') {
        return ok({ disconnected: rt.disconnect() })
      }
      if (action === '/test') {
        let body = {}
        try {
          body = JSON.parse((await request.text()) || '{}')
        } catch {}
        const host = typeof body.host === 'string' && body.host.trim() ? body.host.trim() : 'llm.ustc.edu.cn'
        rt.refreshDerived()
        const decision = await rt.decide(host)
        let resolvedIps = []
        try {
          const { createResolver } = await import('./resolver.js')
          const resolver = createResolver({ dnsServer: rt.runtime.settings.dnsServer || undefined })
          resolvedIps = (await resolver(host)).ips
        } catch {}
        return ok({ host, decision, resolvedIps })
      }
      return fail('unknown action: ' + action, 404)
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), 500)
    }
  }
}

/** 把路由挂到宿主 connection 服务；返回注销函数。 */
export function registerRoutes(ctx, routeHandler) {
  let disposeRoutes = () => {}
  const mount = (scope) => {
    const connection = scope.connection
    if (connection === undefined || typeof connection.fetch?.register !== 'function') return
    try {
      const disposer = connection.fetch.register(
        {
          path: PREFIX + '/status',
          methods: ['GET'],
          requestBody: 'none',
          fetch: routeHandler,
        },
        'ustc-iwan status route',
      )
      const disposer2 = connection.fetch.register(
        {
          path: PREFIX + '/settings',
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: routeHandler,
        },
        'ustc-iwan settings route',
      )
      const disposer3 = connection.fetch.register(
        {
          path: PREFIX + '/download',
          methods: ['POST'],
          requestBody: 'none',
          fetch: routeHandler,
        },
        'ustc-iwan download route',
      )
      const disposer4 = connection.fetch.register(
        {
          path: PREFIX + '/connect',
          methods: ['POST'],
          requestBody: 'none',
          fetch: routeHandler,
        },
        'ustc-iwan connect route',
      )
      const disposer5 = connection.fetch.register(
        {
          path: PREFIX + '/disconnect',
          methods: ['POST'],
          requestBody: 'none',
          fetch: routeHandler,
        },
        'ustc-iwan disconnect route',
      )
      const disposer6 = connection.fetch.register(
        {
          path: PREFIX + '/test',
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: routeHandler,
        },
        'ustc-iwan test route',
      )
      disposeRoutes = () => {
        for (const d of [disposer, disposer2, disposer3, disposer4, disposer5, disposer6]) {
          try {
            d?.()
          } catch {}
        }
      }
    } catch (error) {
      ctx.logger?.warn?.('[ustc-iwan] 路由注册失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }
  ctx.inject(['connection'], mount)
  return () => disposeRoutes()
}
