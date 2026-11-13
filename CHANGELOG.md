# 更新日志

本项目遵循语义化版本；版本号与 `package.json` 保持一致。

## 0.1.0

首个可用版本。

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
