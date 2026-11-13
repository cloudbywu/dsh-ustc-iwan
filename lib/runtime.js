/**
 * 插件运行时：设置文档的唯一持有者，分流代理 / iWAN 托管 / 代理策略三件套的
 * 生命周期都在这里，宿主路由（设置卡片的后端）只调用它。
 */
import { makeCidrMatcher } from './cidr.js'
import { createResolver } from './resolver.js'
import { startSplitProxy } from './split-proxy.js'
import { ensureIwanClient } from './iwan-client.js'
import { installSplitPolicy } from './policy.js'
import { resolveBinary, downloadState } from './binary.js'
import { readSettings, writeSettings } from './settings-store.js'
import { DEFAULT_CIDRS } from './defaults.js'

/** 最近日志环形缓冲，供设置卡片展示。 */
const LOG_LIMIT = 200

export function createRuntime({ log = () => {}, warn = () => {} } = {}) {
  const ring = []
  const emit = (level) => (msg) => {
    ring.push({ at: Date.now(), level, msg: String(msg) })
    if (ring.length > LOG_LIMIT) ring.shift()
    ;(level === 'warn' ? warn : log)(msg)
  }
  const info = emit('info')
  const warnLog = emit('warn')

  const runtime = {
    settings: readSettings({ cidrs: DEFAULT_CIDRS }),
    proxy: null,           // { close() } | null
    policyDisposer: null,  // () => void | Promise
    iwan: null,            // { managed, stop() } | null
    disposed: false,
    ring,
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
    matchCidr = makeCidrMatcher(s.cidrs || DEFAULT_CIDRS)
    suffixes = String(s.domainSuffixes ?? '')
      .split(/[\\s,]+/).filter(Boolean)
      .map((x) => x.toLowerCase().replace(/^\\*\\./, '').replace(/^\\./, ''))
    resolve4 = createResolver({ dnsServer: s.dnsServer || undefined })
  }

  /** 路由决策：域名后缀命中或 IPv4 命中 USTC 网段 → iWAN；否则上游代理/直连。 */
  async function decide(host) {
    refreshDerived()
    const h = String(host ?? '').toLowerCase().replace(/\\.$/, '')
    if (!h) return { kind: 'direct' }
    if (suffixes.some((sfx) => h === sfx || h.endsWith('.' + sfx))) return { kind: 'iwan' }
    const resolved = await resolve4(h)
    if (resolved.ips.some((ip) => matchCidr(ip) !== null)) return { kind: 'iwan' }
    if (resolved.fake) info(h + ' 解析到 fake-ip（TUN 接管 DNS）且未命中域名列表 → 不走 iWAN')
    const upstream = runtime.settings.upstreamProxy
    return upstream ? { kind: 'upstream', url: upstream } : { kind: 'direct' }
  }

  async function stopProxy() {
    if (runtime.policyDisposer) {
      try { await runtime.policyDisposer() } catch {}
      runtime.policyDisposer = null
    }
    if (runtime.proxy) {
      runtime.proxy.close()
      runtime.proxy = null
      info('分流代理已停止')
    }
  }

  async function startProxy() {
    if (runtime.proxy) return
    const s = runtime.settings
    runtime.proxy = await startSplitProxy({
      port: s.listenPort,
      listenHost: '127.0.0.1',
      decide,
      iwan: { proxyHost: s.iwanSocksHost, proxyPort: s.iwanSocksPort },
      log: info,
      verbose: s.verbose,
    })
    try {
      runtime.policyDisposer = await installSplitPolicy(s.listenPort, info)
      info('已安装分流策略：HTTP(S)_PROXY → 本地分流代理')
    } catch (error) {
      warnLog('安装代理策略失败：' + (error?.message ?? error))
    }
  }

  async function restartProxy() {
    await stopProxy()
    if (runtime.settings.enabled && !runtime.disposed) await startProxy()
  }

  async function connect() {
    const s = runtime.settings
    const resolved = resolveBinary(s.iwanClientPath || '')
    if (resolved.error) {
      throw new Error(resolved.error + '。可在设置页下载，或手动运行 iwan-client-oidc --connect --socks')
    }
    const handle = await ensureIwanClient({
      exePath: resolved.path,
      server: s.iwanServer || undefined,
      socksHost: s.iwanSocksHost,
      socksPort: s.iwanSocksPort,
      log: info,
    })
    if (handle.managed) runtime.iwan = handle
    return handle
  }

  function disconnect() {
    if (runtime.iwan) {
      runtime.iwan.stop()
      runtime.iwan = null
      info('已停止插件托管的 iWAN 客户端（外部启动的不受影响）')
      return true
    }
    return false
  }

  /** 应用一个已校验的设置补丁，必要时重启分流代理/自动连接。 */
  async function applySettings(patch) {
    const before = runtime.settings
    runtime.settings = { ...before, ...patch }
    writeSettings(runtime.settings)
    info('设置已保存：' + (Object.keys(patch).join(', ') || '空补丁'))
    const s = runtime.settings
    const portChanged = patch.listenPort !== undefined && patch.listenPort !== before.listenPort
    const enabledChanged = patch.enabled !== undefined && patch.enabled !== before.enabled
    if (portChanged || enabledChanged) await restartProxy()
    if (patch.manageClient === true && s.enabled) {
      try { await connect() } catch (error) { warnLog('自动连接 iWAN 失败：' + (error?.message ?? error)) }
    }
    if (patch.manageClient === false) disconnect()
  }

  function status() {
    const s = runtime.settings
    const binary = resolveBinary(s.iwanClientPath || '')
    return {
      settings: s,
      proxy: { listening: runtime.proxy !== null, port: runtime.proxy ? s.listenPort : null },
      policyInstalled: runtime.policyDisposer !== null,
      iwan: { socksAlive: false, managed: runtime.iwan !== null },
      binary: { path: binary.path ?? '', kind: binary.kind ?? null, error: binary.error ?? null },
      download: downloadState(),
      log: ring.slice(-40),
    }
  }

  function dispose() {
    runtime.disposed = true
    disconnect()
    void stopProxy()
  }

  async function init() {
    if (runtime.settings.enabled) {
      try { await startProxy() }
      catch (error) { warnLog('分流代理启动失败（' + (error?.message ?? error) + '），本插件暂不介入') }
    } else {
      info('enabled=false，分流未启用')
    }
    if (runtime.settings.manageClient && runtime.settings.enabled) {
      try { await connect() }
      catch (error) { warnLog('托管 iWAN 启动失败：' + (error?.message ?? error)) }
    }
  }

  return { runtime, decide, connect, disconnect, applySettings, status, dispose, init, refreshDerived }
}
