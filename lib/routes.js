/**
 * 设置卡片的后端路由：/ustc-iwan/api/*。
 * GET 读状态，POST 做动作；响应统一 { ok: true, value } 或 { ok: false, error }。
 *
 * 注册走宿主自己的 Web 服务服务位 `ctx.webServer`（@deepseek-ai/dsh-host-webserver）：
 *   register({ kind: 'prefix', path, handler(req, res) })  ->  disposer
 * 这里必须用 `handler` 而不是 `resource`：`resource` 形式只放行 GET 与 HEAD，
 * 其它方法在匹配路由之前就被 405 挡掉、请求体也不会被读取，而保存配置、
 * 下载客户端、启停 iWAN 全靠 POST。
 * 旧版的 `connection.fetch.register` 在当前宿主里已经不存在，因此绝不能只试那条路。
 */
import { readSettingsUpdate } from './settings-store.js'
import { BINARY_NAME } from './binary.js'
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

async function readBody(request) {
  const text = await request.text()
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw Object.assign(new Error('请求体过大'), { status: 413 })
  let body
  try { body = JSON.parse(text || '{}') }
  catch { throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }) }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('请求体必须是 JSON 对象'), { status: 400 })
  return body
}

/**
 * @param {object} rt  createRuntime 的返回值
 * @param {object} deps { log(msg) }
 */
export function createRouteHandler(rt, { log = () => {} } = {}) {
  return async function handle(request) {
    const url = new URL(request.url ?? '/', 'http://dsh.local')
    if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/')) return fail('not found', 404)
    if (rt.runtime?.disposed) return fail('插件已停止', 503)
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
        const body = await readBody(request)
        const { patch, error } = readSettingsUpdate(body)
        if (error) return fail(error)
        await rt.applySettings(patch)
        return ok(rt.status())
      }
      if (action === '/download') {
        const body = await readBody(request)
        const mode = body.mode ?? 'download'
        if (!['download', 'update', 'reinstall'].includes(mode)) return fail('不支持的客户端安装操作')
        const result = await rt.installClient({ mode })
        return ok({ ...result, url: 'GitHub Releases', name: BINARY_NAME })
      }
      if (action === '/download/cancel') return ok(await rt.cancelClientInstall())
      if (action === '/update/check') return ok(await rt.inspectUpdates())
      if (action === '/connect') {
        const handle = await rt.connect()
        return ok({ connected: true, managed: handle.managed })
      }
      if (action === '/disconnect') {
        return ok({ disconnected: await rt.disconnect() })
      }
      if (action === '/auth/start') {
        const session = await rt.beginAuth()
        return ok({ ...session, state: 'awaiting' })
      }
      if (action === '/auth/complete') {
        const body = await readBody(request)
        const result = rt.completeAuth(body.id, body.redirectUrl)
        if (result.error) return fail(result.error)
        return ok({ ...result, state: 'submitting' })
      }
      if (action === '/auth/cancel') {
        const body = await readBody(request)
        const result = rt.abandonAuth(body.id)
        return result.error ? fail(result.error) : ok(result)
      }
      if (action === '/test') {
        const body = await readBody(request)
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
      const status = [400, 413].includes(error?.status) ? error.status : 500
      return fail(error instanceof Error ? error.message : String(error), status)
    }
  }
}

/**
 * 把 Fetch 风格的处理器接到 node:http 的 req/res 上。
 *
 * 宿主的 `resource` 形式只放行 GET/HEAD，写动作必须在匹配路由之前就能进来，
 * 所以这里用 `handler` 形式自建这一层：先读完请求体（带上限，超限直接 413），
 * 再用读到的字节构造 Fetch `Request`，最后把 `Response` 写回 socket。
 */
async function toFetchRequest(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      const error = new Error('请求体过大')
      error.status = 413
      throw error
    }
    chunks.push(chunk)
  }
  const body = size > 0 ? Buffer.concat(chunks) : undefined
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    headers.set(key, Array.isArray(value) ? value.join(', ') : value)
  }
  return new Request(new URL(req.url ?? '/', 'http://ustc-iwan.local'), {
    method: req.method ?? 'GET',
    headers,
    body,
  })
}

async function writeFetchResponse(res, response) {
  const headers = {}
  response.headers.forEach((value, key) => {
    headers[key] = value
  })
  res.writeHead(response.status, headers)
  if (response.body === null) {
    res.end()
    return
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  res.end(buffer)
}

/** 用 HTML 请求处理器包装 routeHandler；返回 (req, res) => Promise<void>。 */
function nodeHandler(routeHandler) {
  return async function handle(req, res) {
    try {
      const request = await toFetchRequest(req)
      const response = await routeHandler(request)
      await writeFetchResponse(res, response)
    } catch (error) {
      const status = error && error.status === 413 ? 413 : 500
      const payload = JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
      try {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(payload)
      } catch {}
    }
  }
}


/**
 * 把路由挂到宿主的 Web 服务；返回注销函数。
 *
 * 走 `handler` 形式而不是 `resource`：只有 handler 能收到 GET/HEAD 以外的方法，
 * 而设置卡片要靠 POST 执行保存、下载、启动等动作。
 */
export function registerRoutes(ctx, routeHandler) {
  const disposers = new Set()
  let disposed = false
  const unmountAll = () => {
    disposed = true
    for (const unmount of [...disposers]) unmount()
  }
  ctx.on?.('dispose', unmountAll)
  const mount = (scope) => {
    if (disposed) return
    const webServer = scope.webServer
    if (webServer === undefined || typeof webServer.register !== 'function') {
      ctx.logger?.warn?.('[ustc-iwan] 宿主未提供 webServer 服务，设置卡片的后端接口未挂载')
      return
    }
    try {
      const dispose = webServer.register({ kind: 'prefix', path: PREFIX, handler: nodeHandler(routeHandler) })
      const unmount = () => {
        if (!disposers.delete(unmount)) return
        try { dispose?.() } catch {}
      }
      disposers.add(unmount)
      scope.on?.('dispose', unmount)
      return unmount
    } catch (error) {
      ctx.logger?.warn?.('[ustc-iwan] 路由注册失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }
  ctx.inject(['webServer'], mount)
  return unmountAll
}
