/**
 * DSH 主目录解析（内联实现，替代 @deepseek-ai/dsh-home-paths，令插件零第三方依赖）。
 * 语义与官方包一致：DSH_HOME 环境变量优先，否则 ~/.dsh。
 */
import os from 'node:os'
import path from 'node:path'

export function resolveDshHome() {
  const env = process.env.DSH_HOME?.trim()
  if (env) return path.resolve(env)
  return path.join(os.homedir(), '.dsh')
}
