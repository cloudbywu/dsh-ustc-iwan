/**
 * 插件运行时：设置文档的唯一持有者，分流代理 / iWAN 托管 / 代理策略三件套的
 * 生命周期都在这里，宿主路由（设置卡片的后端）只调用它。
 */
import { makeCidrMatcher } from './cidr.js'
import { createResolver } from './resolver.js'
import { startSplitProxy } from './split-proxy.js'
import { ensureIwanClient, DEFAULT_IWAN_DNS } from './iwan-client.js'
import { installSplitPolicy } from './policy.js'
import { resolveBinary, downloadState, cancelDownload } from './binary.js'
import { startAuth, submitRedirect, cancelAuth, cancelAllAuth, waitForAuthCleanup, authState } from './auth.js'
import { readSettings, writeSettings } from './settings-store.js'
import { DEFAULT_CIDRS } from './defaults.js'

/** 最近日志环形缓冲，供设置卡片展示。 */
const LOG_LIMIT = 200

export function createRuntime({ log = () => {}, warn = () => {}, overrides = {} } = {}) {
  const ring = []
  const emit = (level) => (msg) => {
    ring.push({ at: Date.now(), level, msg: String(msg) })
    if (ring.length > LOG_LIMIT) ring.shift()
    try { (level === 'warn' ? warn : log)(msg) } catch {}
  }
  const info = emit('info')
  const warnLog = emit('warn')
  /** 逐请求日志开关：保守读取，设置尚未就绪时按关闭处理。 */
  const verboseLog = () => runtime.settings?.verbose === true

  const runtime = {
    settings: { ...readSettings({ cidrs: DEFAULT_CIDRS }), ...overrides },
    proxy: null,           // { close() } | null
    policyDisposer: null,  // () => void | Promise
    iwan: null,            // { managed, stop() } | null
    disposed: false,
    ring,
  }

  // 所有代理/配置变更串行；dispose 标志与客户端 abort 则立即生效。
  let lifecycle = Promise.resolve()
  const enqueue = (action) => {
    const task = lifecycle.then(action)
    lifecycle = task.catch(() => {})
    return task
  }
  let disposePromise = null
  let clientPending = null
  let clientStopping = Promise.resolve()
  let clientUnsubscribe = null
  const assertActive = () => {
    if (runtime.disposed) throw new Error('插件已停止，不能再执行此操作')
  }

  let stamp = ''
  let matchCidr = null
  let suffixes = []
  let resolve4 = null

  function refreshDerived() {
    const s = runtime.settings
    const next = [s.cidrs, s.domainSuffixes, s.dnsServer].join('|')
    if (next === stamp) return
    stamp = next
    matchCidr = makeCidrMatcher(s.cidrs ?? DEFAULT_CIDRS)
    suffixes = String(s.domainSuffixes ?? '')
      .split(/[\s,]+/).filter(Boolean)
      .map((x) => x.toLowerCase().replace(/^\*\./, '').replace(/^\./, ''))
    resolve4 = createResolver({ dnsServer: s.dnsServer || undefined })
  }

  /** 路由决策：域名后缀命中或 IPv4 命中 USTC 网段 → iWAN；否则上游代理/直连。 */
  async function decide(host) {
    refreshDerived()
    const h = String(host ?? '').toLowerCase().replace(/\.$/, '')
    if (!h) return { kind: 'direct' }
    const hitSuffix = suffixes.find((sfx) => h === sfx || h.endsWith('.' + sfx))
    if (hitSuffix !== undefined) {
      if (verboseLog()) info(h + ' 命中域名后缀 ' + hitSuffix + ' → 走 iWAN')
      return { kind: 'iwan' }
    }
    const resolved = await resolve4(h)
    const hitCidr = resolved.ips.find((ip) => matchCidr(ip) !== null)
    if (hitCidr !== undefined) {
      if (verboseLog()) info(h + ' 命中网段 ' + hitCidr + ' → 走 iWAN')
      return { kind: 'iwan' }
    }
    const upstream = runtime.settings.upstreamProxy
    if (resolved.fake) {
      // 每请求都打会把日志刷屏；只在开了逐请求日志时记录，并写清判定依据。
      if (verboseLog()) {
        info(
          h + ' 解析到 fake-ip（TUN 接管 DNS），既未命中域名后缀（' +
            (suffixes.join(' / ') || '空') + '）也未命中网段 → ' +
            (upstream ? '走上游代理' : '直连'),
        )
      }
    }
    return upstream ? { kind: 'upstream', url: upstream } : { kind: 'direct' }
  }

  async function stopProxy() {
    const restore = runtime.policyDisposer
    const proxy = runtime.proxy
    runtime.policyDisposer = null
    runtime.proxy = null
    try { if (restore) await restore() }
    catch (error) { warnLog('恢复代理策略失败：' + (error?.message ?? error)) }
    finally {
      if (proxy) {
        await proxy.close()
        info('分流代理已停止')
      }
    }
  }

  async function startProxy() {
    if (runtime.proxy || runtime.disposed || !runtime.settings.enabled) return
    const s = runtime.settings
    const proxy = await startSplitProxy({
      port: s.listenPort,
      listenHost: '127.0.0.1',
      decide,
      iwan: { proxyHost: s.iwanSocksHost, proxyPort: s.iwanSocksPort },
      log: info,
      verbose: s.verbose,
    })
    if (runtime.disposed) {
      await proxy.close()
      return
    }
    runtime.proxy = proxy
    try {
      const restore = await installSplitPolicy(s.listenPort, info)
      if (runtime.disposed) {
        try { await restore?.() } finally { await stopProxy() }
        return
      }
      runtime.policyDisposer = restore
      info('已安装分流策略：HTTP(S)_PROXY → 本地分流代理')
    } catch (error) {
      warnLog('安装代理策略失败：' + (error?.message ?? error))
      if (runtime.disposed) await stopProxy()
    }
  }

  async function restartProxy() {
    await stopProxy()
    if (runtime.settings.enabled && !runtime.disposed) await startProxy()
  }

  function connect() {
    try { assertActive() } catch (error) { return Promise.reject(error) }
    if (runtime.iwan && (runtime.iwan.isAlive?.() ?? true)) return Promise.resolve(runtime.iwan)
    if (clientPending && !clientPending.controller.signal.aborted) return clientPending.promise
    const waitingForStop = clientStopping
    const controller = new AbortController()
    const pending = { controller, promise: null }
    pending.promise = (async () => {
      await waitingForStop
      assertActive()
      controller.signal.throwIfAborted()
      const s = runtime.settings
      const resolved = resolveBinary(s.iwanClientPath || '')
      // 外部 SOCKS 已运行时不要求本机再有一份可执行文件。
      const handle = await ensureIwanClient({
        exePath: resolved.path,
        server: s.iwanServer || undefined,
        socksHost: s.iwanSocksHost,
        socksPort: s.iwanSocksPort,
        dns: s.dnsServer || DEFAULT_IWAN_DNS,
        signal: controller.signal,
        log: info,
      })
      if (runtime.disposed || controller.signal.aborted) {
        if (handle.managed) await handle.stop()
        throw new Error('iWAN 连接已取消')
      }
      if (handle.managed && (handle.isAlive?.() ?? true)) {
        runtime.iwan = handle
        clientUnsubscribe?.()
        clientUnsubscribe = handle.onExit?.(() => {
          if (runtime.iwan === handle) {
            runtime.iwan = null
            info('插件托管的 iWAN 客户端已退出')
          }
        }) ?? null
      }
      return handle
    })().finally(() => { if (clientPending === pending) clientPending = null })
    clientPending = pending
    return pending.promise
  }

  /** 当前可用于认证的可执行文件；没有就抛出可读的原因。 */
  function requireBinary() {
    const s = runtime.settings
    const resolved = resolveBinary(s.iwanClientPath || '')
    if (resolved.error) {
      throw new Error(resolved.error + '。请先在卡片里点「下载 iwan-client-oidc」，或填写「客户端路径」')
    }
    return resolved.path
  }

  /** 启动统一身份认证，返回授权地址供卡片打开。 */
  function beginAuth() {
    assertActive()
    return startAuth({ exePath: requireBinary(), log: info })
  }

  function completeAuth(id, redirectUrl) {
    return submitRedirect(id, redirectUrl)
  }

  function abandonAuth(id) {
    return cancelAuth(id)
  }

  function disconnect() {
    const pending = clientPending
    const handle = runtime.iwan
    pending?.controller.abort()
    runtime.iwan = null
    clientUnsubscribe?.()
    clientUnsubscribe = null
    const previousStop = clientStopping
    const stopping = Promise.allSettled([
      previousStop,
      Promise.resolve().then(() => handle?.stop()),
      pending?.promise.catch(() => {}),
    ]).then((results) => {
      const failed = results.find((result) => result.status === 'rejected')
      if (failed) {
        warnLog('停止 iWAN 客户端失败：' + (failed.reason?.message ?? failed.reason))
        throw failed.reason
      }
      if (handle || pending) info('已停止插件托管的 iWAN 客户端（外部启动的不受影响）')
    })
    // 对外报告本次错误，但不能让内部尾链永久 rejected，阻断后续重连。
    clientStopping = stopping.catch(() => {})
    return stopping.then(() => Boolean(handle || pending))
  }

  /** 应用一个已校验的设置补丁，必要时重启分流代理/自动连接。 */
  function applySettings(patch) {
    return enqueue(async () => {
      assertActive()
      const before = runtime.settings
      const s = { ...before, ...patch, ...overrides }
      writeSettings(s) // 写盘失败时保留原运行状态。
      runtime.settings = s
      refreshDerived()
      info('设置已保存：' + (Object.keys(patch).join(', ') || '空补丁'))
      const changed = (keys) => keys.some((key) => s[key] !== before[key])
      const proxyChanged = changed(['listenPort', 'enabled', 'iwanSocksHost', 'iwanSocksPort', 'verbose'])
      const clientChanged = changed(['iwanSocksHost', 'iwanSocksPort', 'iwanClientPath', 'iwanServer', 'dnsServer'])
      const hadManaged = Boolean(runtime.iwan || clientPending)
      const managementDisabled = before.manageClient && !s.manageClient
      if (!s.enabled || managementDisabled || clientChanged) await disconnect()
      if (proxyChanged) await restartProxy()
      const autoConnect = s.manageClient && (!before.enabled || !before.manageClient || clientChanged)
      if (s.enabled && !runtime.disposed && (autoConnect || (hadManaged && clientChanged && !managementDisabled))) {
        try { await connect() } catch (error) { warnLog('自动连接 iWAN 失败：' + (error?.message ?? error)) }
      }
    })
  }

  function status() {
    if (runtime.iwan && !(runtime.iwan.isAlive?.() ?? true)) runtime.iwan = null
    const s = runtime.settings
    const binary = resolveBinary(s.iwanClientPath || '')
    return {
      settings: s,
      proxy: { listening: runtime.proxy !== null, port: runtime.proxy ? s.listenPort : null },
      policyInstalled: runtime.policyDisposer !== null,
      iwan: { socksAlive: false, managed: runtime.iwan !== null },
      binary: { path: binary.path ?? '', kind: binary.kind ?? null, error: binary.error ?? null },
      download: downloadState(),
      auth: authState(),
      log: ring.slice(-40),
    }
  }

  function dispose() {
    if (disposePromise) return disposePromise
    runtime.disposed = true
    cancelAllAuth()
    const downloading = cancelDownload()
    const stopping = disconnect()
    disposePromise = enqueue(async () => {
      const results = await Promise.allSettled([stopProxy(), stopping, downloading, waitForAuthCleanup()])
      const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason)
      if (errors.length) {
        for (const error of errors) warnLog('卸载清理失败：' + (error?.message ?? error))
        throw new AggregateError(errors, '插件部分资源清理失败')
      }
    })
    return disposePromise
  }

  function init() {
    return enqueue(async () => {
      if (runtime.disposed) return
      if (runtime.settings.enabled) {
        try { await startProxy() }
        catch (error) { warnLog('分流代理启动失败（' + (error?.message ?? error) + '），本插件暂不介入') }
      } else {
        info('enabled=false，分流未启用')
      }
      if (!runtime.disposed && runtime.settings.manageClient && runtime.settings.enabled) {
        try { await connect() }
        catch (error) { warnLog('托管 iWAN 启动失败：' + (error?.message ?? error)) }
      }
    })
  }

  return {
    runtime,
    decide,
    connect,
    disconnect,
    applySettings,
    status,
    dispose,
    init,
    refreshDerived,
    beginAuth,
    completeAuth,
    abandonAuth,
  }
}
