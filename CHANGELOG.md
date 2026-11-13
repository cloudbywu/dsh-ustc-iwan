# 更新日志

本项目遵循语义化版本；版本号与 `package.json` 保持一致。

## 0.1.0

首个可用版本。原无作用域包 `dsh-ustc-iwan` 已撤销；当前 npm 包名为
`@cloudbywu/dsh-ustc-iwan`，由维护者手动发布。

### 包名迁移

- 更新 npm 包名、Host 与浏览器模块标识及 bundle 加载名称。
- GitHub 仓库地址、设置存储、API 路径和样式标识保持不变。
- 已安装旧包的用户应先卸载旧插件，再安装新 scoped 包，避免同时加载两份。

### 修复与验证

- 修复明文 HTTP 绕过分流、SOCKS 分片与首段数据丢失、握手悬挂及隧道清理。
- 应用内认证支持完整行解析、全阶段互斥、超时和取消；处理进程启动错误与 stdin EPIPE。
- 修复配置热更新、表单草稿覆盖、启动/卸载竞态与陈旧托管状态。
- ZIP 实际解压大小有界；下载支持取消、仅 HTTPS 重定向、缓存哈希校验及替换失败回滚。
- 新增 136 个回归测试、语法检查和 Windows/Linux CI；不自动发布 npm。

### 功能

- **应用内分流**：内置本地 HTTP 分流代理（默认 `127.0.0.1:18118`），按目标 IPv4 是否命中
  11 个 USTC 网段、或域名后缀命中 USTC 列表，决定走 ustc-iwan 的 SOCKS5；其余流量直连或
  沿用原有上游代理。
- **零第三方依赖**：仅动态可选依赖宿主自带的 `@deepseek-ai/dsh-http-proxy`（不可用时自动
  退级为仅环境变量模式），因此以本地链接方式安装也能正常加载。
- **设置卡片**：设置 → 「USTC iWAN」，含运行状态指示灯、启动/停止托管、分流测试、
  一键下载 iwan-client-oidc（Windows x64）、完整配置表单与最近日志。
- **iWAN 托管**：可选由插件拉起 / 结束 `iwan-client-oidc --connect --socks`。
- **共存与兜底**：iWAN 出口不可达时自动回退直连；识别 Clash TUN fake-ip 并改用域名后缀
  判断；不改系统路由、不建网卡，与 Clash TUN / WireGuard / Panabit iWAN 共存。
- **设置持久化**：`<DSH_HOME>/storages/ustc-iwan-settings.json` 原子写；
  `USTC_IWAN_*` 环境变量优先级最高。
