/**
 * 代理策略安装：优先复用宿主自带的 @deepseek-ai/dsh-http-proxy（运行时解析会映射到
 * 宿主安装副本，与启动器装的那一层共用同一模块状态）；该包不可用时退级为仅写
 * 环境变量（子进程与 curl/git 仍受控，宿主进程内 dispatcher 不受影响）。
 */

const PROXY_ENV_NAMES = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'no_proxy', 'NO_PROXY']

/**
 * @param {number} port  分流代理端口
 * @param {(msg: string) => void} log
 * @returns {Promise<() => Promise<void> | void>} 恢复函数
 */
export async function installSplitPolicy(port, log) {
  const proxy = `http://127.0.0.1:${port}`
  const report = (message) => { try { log?.(message) } catch {} }
  try {
    const { installProxyFromEnvironment } = await import('@deepseek-ai/dsh-http-proxy')
    const values = {
      'http_proxy': proxy,
      'https_proxy': proxy,
      'no_proxy': 'localhost,127.0.0.1,::1',
    }
    const lookup = {
      get(name) {
        const value = values[String(name).toLowerCase()]
        return value === undefined ? undefined : { value }
      },
    }
    const disposer = await installProxyFromEnvironment(lookup, (message) => report(`代理策略：${message}`))
    return disposer
  } catch (error) {
    report(`宿主 dsh-http-proxy 不可用（${error?.message ?? error}），退级为仅环境变量模式`)
    const previous = {}
    for (const name of PROXY_ENV_NAMES) previous[name] = process.env[name]
    process.env.http_proxy = proxy
    process.env.HTTP_PROXY = proxy
    process.env.https_proxy = proxy
    process.env.HTTPS_PROXY = proxy
    process.env.no_proxy = 'localhost,127.0.0.1,::1'
    process.env.NO_PROXY = 'localhost,127.0.0.1,::1'
    let restored = false
    return () => {
      if (restored) return
      restored = true
      for (const name of PROXY_ENV_NAMES) {
        if (previous[name] === undefined) Reflect.deleteProperty(process.env, name)
        else process.env[name] = previous[name]
      }
    }
  }
}
