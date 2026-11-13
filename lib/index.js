/**
 * @cloudbywu/dsh-ustc-iwan：让词元工坊访问 USTC 模型/站点的流量走 ustc-iwan，其余流量保持原样。
 *
 * Host 侧入口：创建运行时（分流代理 + iWAN 托管 + 代理策略），并把设置卡片的后端
 * 路由挂到宿主 Web 服务上；浏览器半边见 ./client.js（设置 → USTC iWAN）。
 * 插件零第三方依赖：配置由设置文档（设置卡片）+ USTC_IWAN_* 环境变量驱动。
 */
import { createRuntime } from './runtime.js'
import { createRouteHandler, registerRoutes } from './routes.js'

export const name = '@cloudbywu/dsh-ustc-iwan'
export const inject = []

/** 环境变量覆盖（优先级最高）：USTC_IWAN_*。 */
function envOverrides(warn) {
  const env = process.env
  const port = Number(env.USTC_IWAN_SOCKS_PORT)
  const validPort = Number.isInteger(port) && port >= 1 && port <= 65535
  if (env.USTC_IWAN_SOCKS_PORT && !validPort) warn('USTC_IWAN_SOCKS_PORT 无效，忽略该环境变量')
  return {
    ...(env.USTC_IWAN_CLIENT_PATH ? { iwanClientPath: env.USTC_IWAN_CLIENT_PATH } : {}),
    ...(env.USTC_IWAN_SERVER ? { iwanServer: env.USTC_IWAN_SERVER } : {}),
    ...(env.USTC_IWAN_UPSTREAM_PROXY ? { upstreamProxy: env.USTC_IWAN_UPSTREAM_PROXY } : {}),
    ...(env.USTC_IWAN_SOCKS_PORT && validPort ? { iwanSocksPort: port } : {}),
    ...(env.USTC_IWAN_DNS ? { dnsServer: env.USTC_IWAN_DNS } : {}),
  }
}

/** 用户未显式配置上游代理时，沿用启动环境里已有的代理（保持原有代理行为）。 */
function detectUpstreamProxy() {
  const env = process.env
  for (const key of ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY']) {
    const value = env[key]?.trim()
    if (value && /^https?:\/\//i.test(value)) return value
  }
  return ''
}

export function apply(ctx) {
  const log = (msg) => ctx.logger.info('[ustc-iwan] ' + msg)
  const warn = (msg) => ctx.logger.warn('[ustc-iwan] ' + msg)

  if (process.env.USTC_IWAN_DISABLED === '1') {
    log('USTC_IWAN_DISABLED=1，本插件不做任何事')
    return
  }

  // 运行时设置文档为唯一事实来源；这里只补首次默认值（文档缺失的字段）。
  const env = envOverrides(warn)
  const rt = createRuntime({ log, warn, overrides: env })
  const detected = detectUpstreamProxy()
  const s = rt.runtime.settings
  if (detected && !s.upstreamProxy) s.upstreamProxy = detected
  rt.refreshDerived()

  ctx.on('dispose', () => rt.dispose())

  const handler = createRouteHandler(rt, { log })
  registerRoutes(ctx, handler)

  void rt.init().catch((error) => warn('初始化未预期失败：' + (error?.message ?? error)))
}
