/**
 * 设置卡片的后端路由：/ustc-iwan/api/*。
 * GET 读状态，POST 做动作；响应统一 { ok: true, value } 或 { ok: false, error }。
 *
 * 注册走宿主自己的 Web 服务服务位 `ctx.webServer`（@deepseek-ai/dsh-host-webserver）：
 *   register({ kind: 'prefix', path, resource(request) })  ->  disposer
 * 这里用 `resource` 而不是 `handler`：前者拿到的是 Fetch `Request`、交回 Fetch
 * `Response`，请求体由插件自己读，GET/HEAD 与 POST 都能处理。
 * 旧版的 `connection.fetch.register` 在当前宿主里已经不存在，因此绝不能只试那条路。
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

/**
 * 把路由挂到宿主的 Web 服务；返回注销函数。
 *
 * 优先用 `ctx.webServer`（现代宿主唯一在用的是这一条）。前缀注册一次即可覆盖
 * 整个 /ustc-iwan/api 子树，不必为每个动作写一条 route。
 */
export function registerRoutes(ctx, routeHandler) {
  const disposers = []
  const mount = (scope) => {
    const webServer = scope.webServer
    if (webServer === undefined || typeof webServer.register !== 'function') {
      ctx.logger?.warn?.('[ustc-iwan] 宿主未提供 webServer 服务，设置卡片的后端接口未挂载')
      return
    }
    try {
      disposers.push(
        webServer.register({
          kind: 'prefix',
          path: PREFIX,
          resource: (request) => routeHandler(request),
        }),
      )
    } catch (error) {
      ctx.logger?.warn?.('[ustc-iwan] 路由注册失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }
  ctx.inject(['webServer'], mount)
  return () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose?.()
      } catch {}
    }
  }
}
