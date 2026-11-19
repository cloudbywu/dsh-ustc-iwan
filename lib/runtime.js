/**
 * 插件运行时：设置文档的唯一持有者，分流代理 / iWAN 托管 / 代理策略三件套的
 * 生命周期都在这里，宿主路由（设置卡片的后端）只调用它。
 */
import { makeCidrMatcher } from './cidr.js'
import { createResolver, parseDnsServer } from './resolver.js'
import { startSplitProxy } from './split-proxy.js'
import { ensureIwanClient, isPortOpen, DEFAULT_IWAN_DNS } from './iwan-client.js'
import { installSplitPolicy } from './policy.js'
import { resolveBinary, binaryState, downloadState, startDownload, waitForDownload, cancelDownload, checkForUpdates, cancelUpdateCheck } from './binary.js'
import { readCredentialStatus } from './credentials.js'
import { startAuth, submitRedirect, cancelAuth, cancelAllAuth, waitForAuthCleanup, authState } from './auth.js'
import { readSettings, readSettingsUpdate, writeSettings } from './settings-store.js'
import { DEFAULT_CIDRS } from './defaults.js'
import { createReconnectMonitor } from './reconnect-monitor.js'

/** 最近日志环形缓冲，供设置卡片展示。 */
const LOG_LIMIT = 200

/** 用于公开状态和诊断，绝不返回用户信息、路径或查询参数。 */
export function httpProxyOrigin(value) {
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin
  } catch {}
  return ''
}

export function createRuntime({ log = () => {}, warn = () => {}, overrides = {}, detectedUpstreamProxy = '', monitoring = {} } = {}) {
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
  const currentTime = typeof monitoring.now === 'function' ? monitoring.now : Date.now
  const NATIVE_RECONNECT_STEP_MS = 30_000
  const NATIVE_RECONNECT_TOTAL_MS = 90_000

  let savedSettings = readSettings({ cidrs: DEFAULT_CIDRS })
  const environmentOverrides = Object.keys(overrides)
  const autoUpstreamProxy = httpProxyOrigin(detectedUpstreamProxy)
  const runtime = {
    settings: { ...savedSettings, ...overrides },
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
  let manuallyPaused = false
  let clientMaintenance = null
  let maintenanceStatus = { running: false, mode: null, phase: 'idle', error: null }
  let authenticatedConnection = null
  let externalObserved = false
  let connectionIntent = 0
  let explicitReconnecting = null
  let reconnectMonitor = null
  const retiringClients = new Set()
  const hasRetiringClients = () => {
    for (const owned of retiringClients) if (owned.hasExited()) retiringClients.delete(owned)
    return retiringClients.size > 0
  }

  const credentials = () => readCredentialStatus({ server: runtime.settings.iwanServer || undefined })
  const authRunning = () => ['starting', 'awaiting', 'submitting'].includes(authState().state)
  const assertActive = () => {
    if (runtime.disposed) throw new Error('插件已停止，不能再执行此操作')
  }

  let stamp = ''
  let matchCidr = null
  let suffixes = []
  let resolve4 = null

  function refreshDerived() {
    const s = runtime.settings
    const next = JSON.stringify([s.cidrs, s.domainSuffixes, s.dnsServer])
    if (next === stamp) return
    stamp = next
    matchCidr = makeCidrMatcher(s.cidrs ?? DEFAULT_CIDRS)
    suffixes = String(s.domainSuffixes ?? '')
      .split(/[\s,]+/).filter(Boolean)
      .map((x) => x.toLowerCase().replace(/^\*\./, '').replace(/^\./, ''))
    resolve4 = createResolver({ dnsServer: s.dnsServer, warn: warnLog })
  }

  /** 路由决策：域名后缀命中或 IPv4 命中 USTC 网段 → iWAN；否则上游代理/直连。 */
  async function decide(host, onResolved) {
    refreshDerived()
    const h = String(host ?? '').toLowerCase().replace(/\.$/, '')
    if (!h) return { kind: 'direct' }
    const hitSuffix = suffixes.find((sfx) => h === sfx || h.endsWith('.' + sfx))
    if (hitSuffix !== undefined) {
      if (verboseLog()) info(h + ' 命中域名后缀 ' + hitSuffix + ' → 走 iWAN')
      if (onResolved) onResolved(await resolve4(h)) // 只在诊断时解析已经命中后缀的域名。
      return { kind: 'iwan' }
    }
    const resolved = await resolve4(h)
    onResolved?.(resolved)
    const hitCidr = resolved.ips.find((ip) => matchCidr(ip) !== null)
    if (hitCidr !== undefined) {
      if (verboseLog()) info(h + ' 命中网段 ' + hitCidr + ' → 走 iWAN')
      return { kind: 'iwan' }
    }
    const upstream = runtime.settings.upstreamProxy.trim() || (autoUpstreamProxy ? detectedUpstreamProxy : '')
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

  async function testRoute(host) {
    let resolvedIps = []
    let fake = false
    const decision = await decide(host, (resolved) => {
      resolvedIps = resolved.ips
      fake = resolved.fake
    })
    if (decision.kind === 'upstream') decision.url = httpProxyOrigin(decision.url)
    return { host, decision, resolvedIps, fake }
  }

  async function stopProxy() {
    const restore = runtime.policyDisposer
    const proxy = runtime.proxy
    runtime.policyDisposer = null
    runtime.proxy = null
    // 策略还原可能等待活跃请求结束；不能先等它、再关闭这些请求的隧道。
    const closing = (async () => {
      if (!proxy) return
      await proxy.close()
      info('分流代理已停止')
    })()
    const restoring = (async () => {
      try { await restore?.() }
      catch (error) { warnLog('恢复代理策略失败：' + (error?.message ?? error)) }
    })()
    const [result] = await Promise.allSettled([closing, restoring])
    if (result.status === 'rejected') throw result.reason
  }

  // 托管时只路由到已就绪的自有进程。首选端口上的其他监听不属于 iWAN。
  function socksEndpoint() {
    const s = runtime.settings
    const handle = runtime.iwan
    if (handle && (handle.isAlive?.() ?? true)) {
      return { proxyHost: handle.socksHost ?? s.iwanSocksHost, proxyPort: handle.socksPort ?? s.iwanSocksPort }
    }
    return s.manageClient ? null : { proxyHost: s.iwanSocksHost, proxyPort: s.iwanSocksPort }
  }

  async function startProxy() {
    if (runtime.proxy || runtime.disposed || !runtime.settings.enabled) return
    const s = runtime.settings
    const proxy = await startSplitProxy({
      port: s.listenPort,
      listenHost: '127.0.0.1',
      decide,
      iwan: () => nativeReconnectStatus() ? null : socksEndpoint(),
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
    try {
      assertActive()
      if (clientMaintenance) throw new Error('客户端正在下载或更新，请稍候')
      if (authRunning()) throw new Error('请先完成或取消当前认证')
    } catch (error) { return Promise.reject(error) }
    manuallyPaused = false
    externalObserved = false
    connectionIntent++
    reconnectMonitor?.reset()
    return connectManaged()
  }

  function connectManaged({ signal } = {}) {
    try { assertActive(); signal?.throwIfAborted() } catch (error) { return Promise.reject(error) }
    if (runtime.iwan && (runtime.iwan.isAlive?.() ?? true)) return Promise.resolve(runtime.iwan)
    if (clientPending && !clientPending.controller.signal.aborted) return clientPending.promise
    const waitingForStop = clientStopping
    const controller = new AbortController()
    const pending = { controller, promise: null }
    const onParentAbort = () => controller.abort(signal.reason)
    signal?.addEventListener('abort', onParentAbort, { once: true })
    if (signal?.aborted) onParentAbort()
    pending.promise = (async () => {
      await waitingForStop
      assertActive()
      if (hasRetiringClients()) throw new Error('尚未确认旧 iWAN 客户端退出，请手动结束进程后重试')
      controller.signal.throwIfAborted()
      const s = runtime.settings
      const resolved = resolveBinary(s.iwanClientPath || '')
      const startingCredentials = credentials()
      // 非自动托管时，仍可直接复用用户配置的外部 SOCKS。
      const handle = await ensureIwanClient({
        exePath: resolved.path,
        server: s.iwanServer || undefined,
        socksHost: s.iwanSocksHost,
        socksPort: s.iwanSocksPort,
        autoSwitchPort: s.manageClient,
        dns: parseDnsServer(s.dnsServer) || DEFAULT_IWAN_DNS,
        signal: controller.signal,
        onSpawned: (handle) => { pending.handle = handle },
        now: currentTime,
        log: info,
      })
      if (runtime.disposed || controller.signal.aborted) {
        if (handle.managed) await handle.stop()
        throw new Error('iWAN 连接已取消')
      }
      if (handle.managed && (handle.isAlive?.() ?? true)) {
        runtime.iwan = handle
        externalObserved = false
        const currentCredentials = credentials()
        if (startingCredentials.serverCount > 0 && currentCredentials.revision === startingCredentials.revision) {
          authenticatedConnection = { handle, revision: currentCredentials.revision, server: s.iwanServer || '', verifiedAt: Date.now() }
        }
        clientUnsubscribe?.()
        clientUnsubscribe = handle.onExit?.(() => {
          if (runtime.iwan === handle) {
            runtime.iwan = null
            authenticatedConnection = null
            if (handle.hasExited?.() === false) retiringClients.add(handle)
            info('插件托管的 iWAN 客户端已退出')
          }
        }) ?? null
      }
      if (!handle.managed) externalObserved = true
      return handle
    })().finally(() => {
      signal?.removeEventListener('abort', onParentAbort)
      if (pending.handle?.isAlive?.() === false && pending.handle.hasExited?.() === false) retiringClients.add(pending.handle)
      if (clientPending === pending) clientPending = null
    })
    clientPending = pending
    return pending.promise
  }

  function nativeReconnectStatus() {
    const value = runtime.iwan?.reconnectState?.()
    if (!value || !Number.isFinite(value.since) || !Number.isFinite(value.lastAttemptAt)) return null
    return { since: value.since, lastAttemptAt: value.lastAttemptAt, attempt: value.attempt, maxAttempts: value.maxAttempts }
  }

  function recoverySnapshot() {
    const s = runtime.settings
    const owned = Boolean(runtime.iwan && (runtime.iwan.isAlive?.() ?? true))
    const view = (mode, reason) => ({ mode, owned, reason })
    if (runtime.disposed || !s.enabled || !s.manageClient || manuallyPaused) return view('paused', '分流或自动托管已关闭，或用户已手动暂停')
    if (clientMaintenance || authRunning() || clientPending || explicitReconnecting) return view('busy', '等待当前下载、认证或连接操作完成')
    if (hasRetiringClients()) return view('busy', '等待旧客户端真实退出；未退出时不会拉起新进程')
    if (externalObserved && !owned) return view('external', '外部客户端由用户管理，不会自动重启')
    const native = owned ? nativeReconnectStatus() : null
    const time = currentTime()
    const nativeWaiting = native && time >= native.since && time >= native.lastAttemptAt &&
      time - native.since < NATIVE_RECONNECT_TOTAL_MS && time - native.lastAttemptAt < NATIVE_RECONNECT_STEP_MS
    if (nativeWaiting) return view('native-reconnecting', '客户端正在自行重连，等待其监听恢复')
    if (!resolveBinary(s.iwanClientPath || '').path) return view('blocked', '请先安装或配置 iWAN 客户端')
    const saved = credentials()
    if (!saved.serverCount || !['valid', 'unknown'].includes(saved.state)) return view('blocked', '请先完成有效的线路认证配置')
    return { ...view('managed', null), nativeReconnectExpired: Boolean(native) }
  }

  function recoverManaged({ signal, reason } = {}) {
    const intent = connectionIntent
    const original = runtime.iwan
    return enqueue(async () => {
      const state = recoverySnapshot()
      if (signal?.aborted || intent !== connectionIntent || original !== runtime.iwan || state.mode !== 'managed' ||
          (reason === 'native-reconnect-timeout' && !state.nativeReconnectExpired)) return false
      info('正在恢复插件托管的 iWAN 连接')
      await stopClient()
      if (signal?.aborted || intent !== connectionIntent || recoverySnapshot().mode !== 'managed') return false
      try {
        const handle = await connectManaged({ signal })
        return Boolean(handle.managed && (handle.isAlive?.() ?? true))
      } catch (error) {
        // 启动 Promise 可能先于子进程退出而 reject；等清理后再报告给退避器。
        await stopClient()
        throw error
      }
    })
  }

  function reconnect() {
    try {
      assertActive()
      if (clientMaintenance) throw new Error('客户端正在下载或更新，请稍候')
      if (authRunning()) throw new Error('请先完成或取消当前认证')
      if (!runtime.settings.enabled) throw new Error('请先启用分流')
      if (externalObserved && !runtime.iwan) throw new Error('当前为外部客户端，请在其自身界面重连；插件不会结束外部进程')
    } catch (error) { return Promise.reject(error) }
    if (explicitReconnecting) return explicitReconnecting.promise
    manuallyPaused = false
    reconnectMonitor?.reset()
    const intent = ++connectionIntent
    const operation = { promise: null }
    explicitReconnecting = operation
    // 立即中止旧启动，避免它占据队列；真实退出仍由 stopClient 等待。
    const stopping = stopClient().then(() => null, (error) => error)
    operation.promise = enqueue(async () => {
      const error = await stopping
      if (error) throw error
      assertActive()
      if (intent !== connectionIntent || manuallyPaused || clientMaintenance || authRunning()) throw new Error('重新连接已取消或被新的操作替代')
      externalObserved = false
      return connectManaged()
    }).finally(() => { if (explicitReconnecting === operation) explicitReconnecting = null })
    return operation.promise
  }

  async function maybeAutoConnect(reason, resumeManaged = false, maintenanceOperation = null) {
    const s = runtime.settings
    if (runtime.disposed || !s.enabled || manuallyPaused || (!s.manageClient && !resumeManaged) ||
        (clientMaintenance && clientMaintenance !== maintenanceOperation)) return
    if (!resolveBinary(s.iwanClientPath || '').path) {
      info(reason + '：等待安装客户端后再启动托管')
      return
    }
    const saved = credentials()
    if (!saved.serverCount || !['valid', 'unknown'].includes(saved.state)) {
      info(reason + '：等待有效的线路认证配置后再启动托管')
      return
    }
    try { await connectManaged() }
    catch (error) { if (!runtime.disposed) warnLog('自动连接 iWAN 失败：' + (error?.message ?? error)) }
  }

  function inspectUpdates() {
    assertActive()
    if (clientMaintenance) throw new Error('客户端正在下载或更新，请稍候再检查更新')
    return checkForUpdates(runtime.settings.iwanClientPath || '', info)
  }

  /** 后台维护串行执行，HTTP 立即返回；状态与取消由卡片轮询驱动。 */
  function installClient({ mode = 'download' } = {}) {
    assertActive()
    if (!['download', 'update', 'reinstall'].includes(mode)) throw new Error('不支持的客户端安装操作')
    if (clientMaintenance) return { started: false, reason: '已有客户端操作正在进行' }
    if (authRunning()) throw new Error('请先完成或取消当前认证，再下载客户端')
    if (hasRetiringClients()) return { started: false, reason: '尚未确认旧客户端退出，请手动结束进程后重试' }
    const current = binaryState(runtime.settings.iwanClientPath || '')
    if (current.checking) return { started: false, reason: '正在检查客户端更新，请稍候' }
    if (mode === 'download' && current.downloaded) return { started: false, reason: '客户端已下载，可检查更新或重新下载' }
    if (mode === 'update' && !current.latestVersion) throw new Error('请先检查客户端更新')
    if (mode === 'update' && current.updateAvailable === false) return { started: false, reason: '当前缓存版本不低于最新发行版，无需更新' }
    connectionIntent++
    reconnectMonitor?.reset()
    const operation = { cancelled: false, promise: null }
    const resumeManaged = Boolean(runtime.iwan || clientPending)
    clientMaintenance = operation
    maintenanceStatus = { running: true, mode, phase: 'preparing', error: null }
    // 立即取消待就绪连接，避免生命周期队列被旧的启动等待占用。
    const stopping = stopClient().then(() => null, (error) => error)
    operation.promise = enqueue(async () => {
      let succeeded = false
      let canRestore = true
      try {
        const stopError = await stopping
        if (stopError) { canRestore = false; throw stopError }
        assertActive()
        if (operation.cancelled) throw new Error('客户端下载已取消')
        try { await stopClient() } catch (error) { canRestore = false; throw error }
        if (operation.cancelled || runtime.disposed) throw new Error('客户端下载已取消')
        maintenanceStatus.phase = 'downloading'
        const result = await startDownload(info, { mode })
        if (!result.started) throw new Error(result.error || result.reason || '客户端下载未开始')
        await waitForDownload()
        if (downloadState().state !== 'done') throw new Error(downloadState().error || '客户端下载失败')
        succeeded = true
      } catch (error) {
        maintenanceStatus.error = error?.message ?? String(error)
        if (!runtime.disposed && !operation.cancelled) warnLog('客户端维护失败：' + maintenanceStatus.error)
      } finally {
        if (!runtime.disposed && canRestore && (succeeded || resumeManaged)) {
          maintenanceStatus.phase = 'restoring'
          await maybeAutoConnect(succeeded ? '客户端已就绪' : '恢复原客户端', resumeManaged, operation)
        }
      }
    }).catch((error) => { maintenanceStatus.error = error?.message ?? String(error) }).finally(() => {
      maintenanceStatus.running = false
      maintenanceStatus.phase = operation.cancelled ? 'cancelled' : maintenanceStatus.error ? 'error' : 'done'
      if (clientMaintenance === operation) clientMaintenance = null
    })
    return { started: true, mode }
  }

  async function cancelClientInstall() {
    assertActive()
    if (!clientMaintenance) return { cancelled: false }
    clientMaintenance.cancelled = true
    if (maintenanceStatus.phase === 'restoring') { manuallyPaused = true; await stopClient() }
    await cancelDownload()
    return { cancelled: true }
  }

  function waitForClientMaintenance() {
    return clientMaintenance?.promise ?? Promise.resolve()
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
    if (clientMaintenance) throw new Error('客户端正在下载或更新，请稍候再认证')
    connectionIntent++
    return startAuth({
      exePath: requireBinary(), log: info,
      onComplete: () => enqueue(async () => {
        if (runtime.disposed || !runtime.settings.manageClient) return
        reconnectMonitor?.reset()
        await stopClient()
        await maybeAutoConnect('认证完成')
      }),
    })
  }

  function completeAuth(id, redirectUrl) {
    return submitRedirect(id, redirectUrl)
  }

  function abandonAuth(id) {
    return cancelAuth(id)
  }

  function disconnect() {
    connectionIntent++
    manuallyPaused = true
    return stopClient()
  }

  function stopClient() {
    authenticatedConnection = null
    const pending = clientPending
    const handle = runtime.iwan
    pending?.controller.abort()
    runtime.iwan = null
    for (const owned of [handle, pending?.handle]) {
      if (owned?.hasExited && !owned.hasExited()) retiringClients.add(owned)
    }
    clientUnsubscribe?.()
    clientUnsubscribe = null
    const previousStop = clientStopping
    const stopping = Promise.allSettled([
      previousStop,
      Promise.resolve().then(async () => {
        const handles = [...new Set([handle, pending?.handle, ...retiringClients].filter(Boolean))]
        await Promise.all(handles.map((owned) => owned.stop()))
        if (handles.some((owned) => owned.hasExited?.() === false)) throw new Error('尚未确认 iWAN 客户端退出，请手动结束进程后重试')
      }),
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

  /** 校验并应用设置补丁，必要时重启分流代理/自动连接。 */
  function applySettings(update) {
    return enqueue(async () => {
      assertActive()
      const { patch, error } = readSettingsUpdate(update)
      if (error) throw Object.assign(new Error(error), { status: 400 })
      // 全表单可能回传当前环境值；锁定字段保留原始设置，不让环境值写进文档。
      for (const key of environmentOverrides) delete patch[key]
      const before = runtime.settings
      const nextSaved = { ...savedSettings, ...patch }
      writeSettings(nextSaved) // 写盘失败时保留原运行状态。
      savedSettings = nextSaved
      const s = { ...savedSettings, ...overrides }
      runtime.settings = s
      refreshDerived()
      info('设置已保存：' + (Object.keys(patch).join(', ') || '空补丁'))
      const changed = (keys) => keys.some((key) => s[key] !== before[key])
      const proxyChanged = changed(['listenPort', 'enabled', 'verbose'])
      const clientChanged = changed(['iwanSocksHost', 'iwanSocksPort', 'iwanClientPath', 'iwanServer', 'dnsServer'])
      const hadManaged = Boolean(runtime.iwan || clientPending)
      const managementDisabled = before.manageClient && !s.manageClient
      if (clientChanged || changed(['enabled', 'manageClient'])) { connectionIntent++; reconnectMonitor?.reset() }
      if (!s.enabled || managementDisabled || clientChanged) await stopClient()
      if (proxyChanged) await restartProxy()
      const autoConnect = s.manageClient && (!before.enabled || !before.manageClient || clientChanged)
      if (!before.manageClient && s.manageClient) externalObserved = false
      if ((!before.manageClient && s.manageClient) || (!before.enabled && s.enabled)) manuallyPaused = false
      if (s.enabled && !runtime.disposed && (autoConnect || (hadManaged && clientChanged && !managementDisabled))) {
        await maybeAutoConnect('配置已更新', hadManaged && !managementDisabled)
      }
    })
  }

  function credentialStatus() {
    const saved = credentials()
    const proof = authenticatedConnection
    if (proof && runtime.iwan === proof.handle && proof.handle.isAlive?.() && proof.handle.isAuthenticated?.() === true &&
        proof.revision === saved.revision && proof.server === (runtime.settings.iwanServer || '') &&
        saved.serverCount > 0 && ['valid', 'unknown'].includes(saved.state)) {
      return { ...saved, state: 'valid', source: 'managed-connection', verifiedAt: proof.handle.authenticatedAt ?? proof.verifiedAt,
        message: '当前托管客户端已完成线路认证并建立连接；上游未提供独立的长期有效期' }
    }
    return saved
  }

  reconnectMonitor = createReconnectMonitor({
    ...monitoring,
    inspect: recoverySnapshot,
    probe: async ({ signal }) => {
      const endpoint = socksEndpoint()
      const intent = connectionIntent
      const handle = runtime.iwan
      const alive = endpoint && !nativeReconnectStatus()
        ? await isPortOpen(endpoint.proxyPort, endpoint.proxyHost, 800, { signal }) : false
      if (intent !== connectionIntent || handle !== runtime.iwan || (alive && nativeReconnectStatus())) {
        const error = new Error('连接状态已变化，丢弃旧端口探测结果')
        error.name = 'AbortError'
        throw error
      }
      return alive
    },
    recover: recoverManaged,
    onWake: () => {
      authenticatedConnection = null
      stamp = '' // 唤醒后重新建立解析缓存，不复用休眠前的 DNS 结果。
      info('检测到系统长时间暂停，等待网络恢复后检查 iWAN 会话')
    },
    onExternal: () => { externalObserved = true },
    log: info,
  })

  function status() {
    if (runtime.iwan && !(runtime.iwan.isAlive?.() ?? true)) {
      if (runtime.iwan.hasExited?.() === false) retiringClients.add(runtime.iwan)
      runtime.iwan = null; authenticatedConnection = null
    }
    const s = runtime.settings
    const binary = binaryState(s.iwanClientPath || '')
    const endpoint = socksEndpoint()
    const recovery = reconnectMonitor.status()
    if (recoverySnapshot().mode === 'native-reconnecting') {
      recovery.state = 'waiting'
      recovery.nextRetryAt = null
      recovery.reason = 'iWAN 客户端正在自行重连，暂不重启进程'
    }
    return {
      settings: Object.hasOwn(overrides, 'upstreamProxy') ? { ...s, upstreamProxy: httpProxyOrigin(s.upstreamProxy) } : s,
      environmentOverrides: [...environmentOverrides],
      autoUpstreamProxy,
      proxy: { listening: runtime.proxy !== null, port: runtime.proxy ? s.listenPort : null },
      policyInstalled: runtime.policyDisposer !== null,
      iwan: { socksAlive: false, socksHost: endpoint?.proxyHost ?? s.iwanSocksHost,
        socksPort: endpoint?.proxyPort ?? s.iwanSocksPort, managed: runtime.iwan !== null, connecting: clientPending !== null || explicitReconnecting !== null, nativeReconnect: nativeReconnectStatus(), stopping: hasRetiringClients(), paused: manuallyPaused },
      binary: { ...binary, path: binary.path ?? '', kind: binary.kind ?? null, error: binary.error ?? null },
      download: downloadState(),
      maintenance: { ...maintenanceStatus },
      recovery,
      auth: { ...authState(), canStart: Boolean(binary.installed && !clientMaintenance), credentials: credentialStatus() },
      log: ring.slice(-40),
    }
  }

  function dispose() {
    if (disposePromise) return disposePromise
    runtime.disposed = true
    connectionIntent++
    const monitoringStopped = reconnectMonitor.stop()
    cancelAllAuth()
    if (clientMaintenance) clientMaintenance.cancelled = true
    const downloading = cancelDownload()
    const checking = cancelUpdateCheck()
    // 先释放监听和隧道，不排在配置变更、策略安装或其它进行中的操作后面。
    const proxyStopped = stopProxy()
    const stopping = stopClient()
    const pendingLifecycle = lifecycle
    disposePromise = Promise.allSettled([
      proxyStopped, stopping, downloading, checking, monitoringStopped, waitForAuthCleanup(), pendingLifecycle,
    ]).then((results) => {
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
        await maybeAutoConnect('应用启动')
      }
    }).then(() => { if (!runtime.disposed) reconnectMonitor.start() })
  }

  return {
    runtime,
    decide,
    testRoute,
    connect,
    disconnect,
    reconnect,
    applySettings,
    status,
    dispose,
    init,
    refreshDerived,
    beginAuth,
    completeAuth,
    abandonAuth,
    inspectUpdates,
    installClient,
    cancelClientInstall,
    waitForClientMaintenance,
  }
}
