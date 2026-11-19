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
import { BINARY_NAME } from './binary.js'
import { createClashTunManager } from './clash-tun.js'
import { isPortOpen } from './iwan-client.js'

const PREFIX = '/ustc-iwan/api'
const MAX_BODY_BYTES = 256 * 1024

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
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

// 修改其它应用的配置须来自 loopback 上的同源设置卡片或已认证的桌面网关。
function allowClashTun(request, transport) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(transport?.remoteAddress)) return false
  const { headers } = request
  if (headers.get('x-ustc-iwan-tun') !== '1') return false
  const host = headers.get('host') ?? ''
  if (!/^(?:localhost|127[.]0[.]0[.]1|\[::1\])(?::[1-9][0-9]{0,4})?$/i.test(host)) return false
  const protocol = transport.secure ? 'https:' : 'http:'
  try {
    const authority = new URL(protocol + '//' + host)
    const port = Number(authority.port) || (transport.secure ? 443 : 80)
    if (port !== transport.localPort) return false
    const site = headers.get('sec-fetch-site'), origin = headers.get('origin'), referer = headers.get('referer')
    if (site === 'same-origin') {
      return request.method === 'POST' ? origin === authority.origin : new URL(referer ?? '').origin === authority.origin
    }
    // Electron 的 dsh-app 网关移除 Origin/Sec-Fetch-Site，代为发送宿主签发的会话。
    // 自定义头只标识传输方式，不是凭据；交给宿主原有 admission 校验，不自行读密钥。
    if (site !== null || origin !== null || headers.get('x-ustc-iwan-desktop') !== '1') return false
    if (referer !== null && !/^dsh-app:\/\/app(?:\/|$)/.test(referer)) return false
    return transport.verifyHostSession?.(request) === true
  } catch { return false }
}

async function clashTunAction(request, action, clashTun, transport) {
  if (!allowClashTun(request, transport)) return fail('请在本机同源设置卡片或已认证的词元工坊桌面端操作 Clash TUN', 403)
  try {
    if (action === '/clash-tun') return request.method === 'GET' ? ok(await clashTun.inspect()) : fail('method not allowed', 405)
    if (request.method !== 'POST') return fail('method not allowed', 405)
    if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return fail('请提交 JSON 配置确认', 415)
    const body = await readBody(request)
    const { mode, revision } = body
    if (typeof revision !== 'string' || !revision || revision.length > 256) return fail('请重新检测再确认配置')
    if (action === '/clash-tun/apply') {
      if (!['relay', 'campus'].includes(mode) || Object.keys(body).length !== 2) return fail('无效的排除范围')
      return ok(await clashTun.apply({ mode, revision }))
    }
    if (Object.keys(body).length !== 1) return fail('无效的回退参数')
    return ok(await clashTun.rollback({ revision }))
  } catch (error) {
    if ([400, 409, 413, 423, 501].includes(error?.status)) return fail(error.message, error.status)
    return fail('无法处理 Clash TUN 配置。请重新检测确认当前状态；不要重复提交未确认的写入。', 500)
  }
}

/**
 * @param {object} rt  createRuntime 的返回值
 * @param {object} deps { log(msg) }
 */
export function createRouteHandler(rt, { log = () => {}, clashTun = createClashTunManager() } = {}) {
  return async function handle(request, transport) {
    const url = new URL(request.url ?? '/', 'http://dsh.local')
    if (url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/')) return fail('not found', 404)
    if (rt.runtime?.disposed) return fail('插件已停止', 503)
    const action = url.pathname.slice(PREFIX.length) || '/'
    if (['/clash-tun', '/clash-tun/apply', '/clash-tun/rollback'].includes(action)) {
      return clashTunAction(request, action, clashTun, transport)
    }
    try {
      if (request.method === 'GET' && (action === '/status' || action === '/')) {
        const endpoint = ({ settings, iwan }) => ({
          host: iwan.socksHost ?? settings.iwanSocksHost, port: iwan.socksPort ?? settings.iwanSocksPort,
          probe: !iwan.nativeReconnect && (!settings.manageClient || iwan.managed),
        })
        const before = endpoint(rt.status())
        const alive = before.probe && await isPortOpen(before.port, before.host, 600)
        if (rt.runtime?.disposed) return fail('插件已停止', 503)
        // 探测期间可能已完成唤醒重连，返回最新进程/认证状态，而不是休眠前的快照。
        const status = rt.status()
        const current = endpoint(status)
        status.iwan.socksAlive = Boolean(current.probe && (before.probe && current.port === before.port &&
          current.host === before.host ? alive : await isPortOpen(current.port, current.host, 600)))
        if (rt.runtime?.disposed) return fail('插件已停止', 503)
        return ok(status)
      }
      if (request.method !== 'POST') return fail('method not allowed', 405)
      if (action === '/settings') {
        await rt.applySettings(await readBody(request))
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
      if (action === '/reconnect') {
        const handle = await rt.reconnect()
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
        return ok(await rt.testRoute(host))
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
function nodeHandler(routeHandler, getConnection) {
  return async function handle(req, res) {
    try {
      const request = await toFetchRequest(req)
      const response = await routeHandler(request, {
        remoteAddress: req.socket?.remoteAddress, localPort: req.socket?.localPort, secure: req.socket?.encrypted === true,
        verifyHostSession: () => {
          // 查询当前服务而不把 connection 设成硬依赖；旧宿主没有它时桌面分支应拒绝。
          const admission = getConnection()?.admit?.(req)
          return Boolean(admission?.peer && !Object.hasOwn(admission, 'rejection'))
        },
      })
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
  const mount = (scope) => {
    if (disposed) return
    const webServer = scope.webServer
    if (webServer === undefined || typeof webServer.register !== 'function') {
      ctx.logger?.warn?.('[ustc-iwan] 宿主未提供 webServer 服务，设置卡片的后端接口未挂载')
      return
    }
    try {
      const dispose = webServer.register({ kind: 'prefix', path: PREFIX, handler: nodeHandler(routeHandler, () => scope.get?.('connection')) })
      const unmount = () => {
        if (!disposers.delete(unmount)) return
        try { dispose?.() } catch {}
      }
      disposers.add(unmount)
      return unmount
    } catch (error) {
      ctx.logger?.warn?.('[ustc-iwan] 路由注册失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }
  ctx.inject(['webServer'], mount)
  return unmountAll
}
