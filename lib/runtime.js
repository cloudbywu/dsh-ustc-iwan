/**
 * 插件运行时：设置文档的唯一持有者，分流代理 / iWAN 托管 / 代理策略三件套的
 * 生命周期都在这里，宿主路由（设置卡片的后端）只调用它。
 */
import { makeCidrMatcher } from './cidr.js'
import { createResolver } from './resolver.js'
import { startSplitProxy } from './split-proxy.js'
import { ensureIwanClient, DEFAULT_IWAN_DNS } from './iwan-client.js'
import { installSplitPolicy } from './policy.js'
import { resolveBinary, binaryState, downloadState, startDownload, waitForDownload, cancelDownload, checkForUpdates, cancelUpdateCheck } from './binary.js'
import { readCredentialStatus } from './credentials.js'
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
  let manuallyPaused = false
  let clientMaintenance = null
  let maintenanceStatus = { running: false, mode: null, phase: 'idle', error: null }
  let authenticatedConnection = null
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
    try {
      assertActive()
      if (clientMaintenance) throw new Error('客户端正在下载或更新，请稍候')
      if (authRunning()) throw new Error('请先完成或取消当前认证')
    } catch (error) { return Promise.reject(error) }
    manuallyPaused = false
    return connectManaged()
  }

  function connectManaged() {
    try { assertActive() } catch (error) { return Promise.reject(error) }
    if (runtime.iwan && (runtime.iwan.isAlive?.() ?? true)) return Promise.resolve(runtime.iwan)
    if (clientPending && !clientPending.controller.signal.aborted) return clientPending.promise
    const waitingForStop = clientStopping
    const controller = new AbortController()
    const pending = { controller, promise: null }
    pending.promise = (async () => {
      await waitingForStop
      assertActive()
      if (hasRetiringClients()) throw new Error('尚未确认旧 iWAN 客户端退出，请手动结束进程后重试')
      controller.signal.throwIfAborted()
      const s = runtime.settings
      const resolved = resolveBinary(s.iwanClientPath || '')
      const startingCredentials = credentials()
      // 外部 SOCKS 已运行时不要求本机再有一份可执行文件。
      const handle = await ensureIwanClient({
        exePath: resolved.path,
        server: s.iwanServer || undefined,
        socksHost: s.iwanSocksHost,
        socksPort: s.iwanSocksPort,
        dns: s.dnsServer || DEFAULT_IWAN_DNS,
        signal: controller.signal,
        onSpawned: (handle) => { pending.handle = handle },
        log: info,
      })
      if (runtime.disposed || controller.signal.aborted) {
        if (handle.managed) await handle.stop()
        throw new Error('iWAN 连接已取消')
      }
      if (handle.managed && (handle.isAlive?.() ?? true)) {
        runtime.iwan = handle
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
      return handle
    })().finally(() => {
      if (pending.handle?.isAlive?.() === false && pending.handle.hasExited?.() === false) retiringClients.add(pending.handle)
      if (clientPending === pending) clientPending = null
    })
    clientPending = pending
    return pending.promise
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
    return startAuth({
      exePath: requireBinary(), log: info,
      onComplete: () => enqueue(async () => {
        if (runtime.disposed || !runtime.settings.manageClient) return
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
      if (!s.enabled || managementDisabled || clientChanged) await stopClient()
      if (proxyChanged) await restartProxy()
      const autoConnect = s.manageClient && (!before.enabled || !before.manageClient || clientChanged)
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

  function status() {
    if (runtime.iwan && !(runtime.iwan.isAlive?.() ?? true)) { runtime.iwan = null; authenticatedConnection = null }
    const s = runtime.settings
    const binary = binaryState(s.iwanClientPath || '')
    return {
      settings: s,
      proxy: { listening: runtime.proxy !== null, port: runtime.proxy ? s.listenPort : null },
      policyInstalled: runtime.policyDisposer !== null,
      iwan: { socksAlive: false, managed: runtime.iwan !== null, connecting: clientPending !== null, stopping: hasRetiringClients(), paused: manuallyPaused },
      binary: { ...binary, path: binary.path ?? '', kind: binary.kind ?? null, error: binary.error ?? null },
      download: downloadState(),
      maintenance: { ...maintenanceStatus },
      auth: { ...authState(), canStart: Boolean(binary.installed && !clientMaintenance), credentials: credentialStatus() },
      log: ring.slice(-40),
    }
  }

  function dispose() {
    if (disposePromise) return disposePromise
    runtime.disposed = true
    cancelAllAuth()
    if (clientMaintenance) clientMaintenance.cancelled = true
    const downloading = cancelDownload()
    const checking = cancelUpdateCheck()
    const stopping = stopClient()
    disposePromise = enqueue(async () => {
      const results = await Promise.allSettled([stopProxy(), stopping, downloading, checking, waitForAuthCleanup()])
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
    inspectUpdates,
    installClient,
    cancelClientInstall,
    waitForClientMaintenance,
  }
}
