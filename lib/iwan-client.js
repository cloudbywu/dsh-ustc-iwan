/**
 * ustc-iwan 客户端托管：探测 SOCKS5 端口是否已有 iWAN 在监听；
 * 没有且配置了可执行文件路径时，代为启动 iwan-client-oidc --connect --socks。
 */
import { spawn } from 'node:child_process'
import net from 'node:net'

/** 探测 TCP 端口是否可连。 */
export function isPortOpen(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 确保 iWAN SOCKS5 可用。
 * @returns {{ managed: boolean, stop(): void }}
 */
export async function ensureIwanClient({
  exePath,
  server,
  socksHost = '127.0.0.1',
  socksPort = 1080,
  extraArgs = [],
  log = () => {},
} = {}) {
  if (await isPortOpen(socksPort, socksHost)) {
    log(`iWAN SOCKS5 已在 ${socksHost}:${socksPort} 监听（外部启动），插件不重复拉起`)
    return { managed: false, stop() {} }
  }
  if (!exePath) {
    throw new Error(
      `端口 ${socksPort} 上没有正在运行的 iWAN SOCKS5，且未配置 iwanClientPath。` +
        '请先自行运行 iwan-client-oidc --connect --socks，或在插件配置中启用托管模式。',
    )
  }
  const args = ['--connect', '--socks', '--socks-listen', `${socksHost}:${socksPort}`, ...extraArgs]
  if (server) args.push('--server', server)
  log(`启动 iWAN 客户端：${exePath} ${args.join(' ')}`)
  const child = spawn(exePath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout?.on('data', (d) => log(String(d).trimEnd()))
  child.stderr?.on('data', (d) => log(String(d).trimEnd()))

  const deadline = Date.now() + 30_000
  for (;;) {
    if (await isPortOpen(socksPort, socksHost)) break
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`iWAN 客户端进程已退出（code=${child.exitCode ?? child.signalCode}），请检查线路与登录配置`)
    }
    if (Date.now() > deadline) {
      child.kill()
      throw new Error('等待 iWAN SOCKS5 端口就绪超时（30s）')
    }
    await sleep(400)
  }
  log(`iWAN SOCKS5 就绪（${socksHost}:${socksPort}，pid=${child.pid}）`)
  return {
    managed: true,
    stop() {
      try {
        child.kill()
      } catch {}
    },
  }
}
