# dsh-ustc-iwan

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%E8%AF%8D%E5%85%83%E5%B7%A5%E5%9D%8A-1f6feb)](https://github.com/deepseek-ai/deepseek-harness)

让**词元工坊**（DSH / DeepSeek Harness）访问 **USTC 系列模型（如 llm.ustc.edu.cn）与科大系列网站**
时自动走 [ustc-iwan](https://github.com/yyy1mu/ustc-iwan)，其余流量保持原样；
与 **Clash TUN、WireGuard、Panabit iWAN** 等代理/隧道软件**共存不冲突**。

- 不改系统路由、不创建虚拟网卡、不改注册表——分流完全在应用进程内完成。
- 零第三方依赖：只需宿主自带的 `@deepseek-ai/dsh-http-proxy`（不可用时自动降级）。
- 带完整设置界面：状态指示灯、一键下载 iWAN 客户端、配置表单、分流测试、运行日志。

## 快速安装

词元工坊 → 侧边栏「插件」→ 安装，把下面任一来源粘贴进去，然后**完全退出并重启应用**：

```text
https://github.com/cloudbywu/dsh-ustc-iwan      # GitHub 仓库地址（推荐）
github:cloudbywu/dsh-ustc-iwan                  # 同上，GitHub 简写
C:\Users\<你>\dsh-ustc-iwan                     # 本地目录（必须是绝对路径）
```

详见 [安装](#安装)。安装后打开 **设置 → USTC IWAN**。

---

## 目录

- [工作原理](#工作原理)
- [内置网段](#内置网段)
- [安装](#安装)
- [首次使用](#首次使用)
- [设置卡片](#设置卡片)
- [配置项](#配置项)
- [与代理软件共存](#与代理软件共存)
- [排错](#排错)
- [已知边界](#已知边界)
- [开发](#开发)
- [许可](#许可)

## 工作原理

```
词元工坊出站请求（模型调用 / web 抓取 / 子进程 curl…）
        │  HTTP(S)_PROXY 指向本地分流代理
        ▼
┌─ 分流代理 127.0.0.1:18118（插件内置）────────────────┐
│  目标域名 → 解析 IPv4                                 │
│  ① 命中 USTC 网段（11 段，内置） ──→ iWAN SOCKS5:1080 │
│  ② 域名后缀命中 ustc.edu.cn 等   ──→ iWAN SOCKS5:1080 │
│  ③ fake-ip（TUN 接管 DNS）按 ② 兜底判断              │
│  ④ 其余目标 ──→ 用户原有代理（如 Clash 7890）或直连   │
│  ※ iWAN 出口连不上时自动回退直连，不掉线              │
└──────────────────────────────────────────────┘
```

插件在宿主进程内做三件事：

1. 启动本地分流代理，按「网段命中 / 域名后缀命中」决定出口；
2. 通过宿主自带的 `@deepseek-ai/dsh-http-proxy` 把 `HTTP(S)_PROXY` 指向分流代理
   （卸载时整体恢复原状）；
3. 可选：托管 `iwan-client-oidc --connect --socks` 进程。

转发给 iWAN 的是**域名**（由 iWAN 在校内解析），因此不依赖本机 DNS；
遇到 Clash TUN 的 fake-ip 时自动改用域名后缀判断。

## 内置网段

```text
114.214.160.0/19  114.214.192.0/18  202.38.64.0/19   210.45.64.0/20
210.45.112.0/20   211.86.144.0/20   222.195.64.0/19   210.72.22.0/24
202.141.160.0/19  218.22.21.0/27    218.104.71.160/28
```

域名后缀默认：`ustc.edu.cn`、`ustclug.org`、`ustc.life`（均可在设置卡片中修改）。

## 安装

词元工坊的插件页支持 **GitHub 仓库地址 / npm 包名 / 本地目录路径** 三种来源，
任选一种粘贴进「插件 → 安装」即可。安装完成后**完全退出并重启应用**，
再打开 设置 → USTC IWAN。

### 方式一：GitHub 仓库地址（推荐）

在「插件 → 安装」中输入仓库地址：

```text
https://github.com/cloudbywu/dsh-ustc-iwan
```

以下写法等价，任选其一：

| 写法 | 说明 |
| --- | --- |
| `https://github.com/cloudbywu/dsh-ustc-iwan` | 仓库 URL（推荐） |
| `github:cloudbywu/dsh-ustc-iwan` | GitHub 简写 |
| `git+https://github.com/cloudbywu/dsh-ustc-iwan.git` | 显式 git 地址 |
| `https://github.com/cloudbywu/dsh-ustc-iwan#v0.1.0` | 固定到某个 tag / 分支 / 提交 |
| `github:cloudbywu/dsh-ustc-iwan#<40 位提交号>` | 固定到具体提交（可被插件页更新检查追踪） |

> 通过 Git 安装时，插件以**副本**形式装进 profile 的 `node_modules`。要升级，
> 在插件页对它执行**检查更新 / 更新**，或改为固定提交后重新安装。
> 首次安装需要宿主能访问 GitHub。

### 方式二：npm 包名

```text
dsh-ustc-iwan
```

```bash
npm view dsh-ustc-iwan version   # 有版本号即可安装；404 表示尚未发布
```

> 注册表上查不到版本号时请改用方式一（GitHub）或方式三（本地目录）。
> 维护者发布流程见 [docs/PUBLISHING.md](docs/PUBLISHING.md)（登录与 2FA、打包自检、
> 发布、验证、版本升级、回滚与常见报错对照）。

### 方式三：本地目录路径

```bash
git clone https://github.com/cloudbywu/dsh-ustc-iwan.git
```

在「插件 → 安装」中填入**绝对路径**（也支持 `file:` / `link:` 前缀）：

```text
C:\Users\<你>\dsh-ustc-iwan
file:C:\Users\<你>\dsh-ustc-iwan
```

或直接下 `Release` 里的 `dsh-ustc-iwan-0.1.0.zip` 解压，再按同样方式填入解压目录。

> **本地路径必须以绝对路径给出**（相对路径会被插件管理器拒绝）。
> 以 `link:` 链接方式安装时不会执行依赖安装，因此本项目**刻意保持零第三方依赖**，
> 链接安装同样可用；这种方式改代码后重启应用即生效。

### 方式四：直接写进 profile（CLI / 进阶）

```bash
# 把 <DSH_HOME> 换成你的数据目录：
#   Windows 桌面端：%APPDATA%\tokenworks-desktop-harness
#   CLI 默认：~/.dsh
cd <DSH_HOME>/profiles/<profile>
pnpm add github:cloudbywu/dsh-ustc-iwan     # 或 link:<本仓库绝对路径>
```

并把 `dsh-ustc-iwan` 加入该 profile `package.json` 的 `dsh.profile.bundles`。

### 安装后

1. **完全退出并重启词元工坊**（客户端 bundle 在启动时组合，仅刷新页面可能不够）；
2. 打开 **设置 → USTC IWAN**，确认「分流代理」指示灯为绿色；
3. 按 [首次使用](#首次使用) 下载 iWAN 客户端并完成一次认证。

## 首次使用

1. 打开 **设置 → USTC iWAN**；
2. 点 **下载 iwan-client-oidc**（自动存到 `<DSH_HOME>/cache/ustc-iwan/`，
   不做系统级安装；也可自行下载后填入「客户端路径」）；
3. 完成一次统一身份认证（终端执行，只需一次）：

   ```bat
   iwan-client-oidc-windows-x86_64.exe --fetch
   ```

   按提示在浏览器完成认证，把 `com.panabit.mobile://...` 回调 URL 粘贴回终端。
   线路配置保存在 `~/.config/iwan/servers.json`。

4. 回到卡片点 **启动 iWAN**（或在配置里开启「托管 iWAN 客户端」）；
5. 用 **测试分流** 输入 `llm.ustc.edu.cn`，显示「走 iWAN」即成功。

## 设置卡片

安装后 **设置 → USTC iWAN** 出现一张卡片，分四组：

| 分组 | 内容 |
| --- | --- |
| 运行状态 | 分流代理 / 出站策略 / iWAN SOCKS5 / 托管进程 四个指示灯；启动 iWAN、停止托管、刷新状态、**分流测试** |
| iWAN 客户端 | **一键下载 iwan-client-oidc**（进度条、sha256 记录、失败自动清理） |
| 配置 | 全部配置项表单化，保存即时生效（改端口自动重启代理；开托管自动连接） |
| 最近日志 | 最近 40 条运行日志 |

宿主侧对应路由：`/ustc-iwan/api/{status,settings,download,connect,disconnect,test}`。

## 配置项

配置持久化在 `<DSH_HOME>/storages/ustc-iwan-settings.json`（原子写）。
环境变量优先级最高：

| 环境变量 | 对应配置 |
| --- | --- |
| `USTC_IWAN_CLIENT_PATH` | `iwanClientPath` |
| `USTC_IWAN_SERVER` | `iwanServer` |
| `USTC_IWAN_UPSTREAM_PROXY` | `upstreamProxy` |
| `USTC_IWAN_SOCKS_PORT` | `iwanSocksPort` |
| `USTC_IWAN_DNS` | `dnsServer` |
| `USTC_IWAN_DISABLED=1` | 完全停用本插件 |

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关闭后插件完全不介入（策略恢复原状） |
| `listenPort` | `18118` | 本地分流代理端口 |
| `iwanSocksHost` / `iwanSocksPort` | `127.0.0.1` / `1080` | iWAN SOCKS5 地址 |
| `manageClient` | `false` | 是否由插件代启 iWAN |
| `iwanClientPath` | 空 | 托管模式下 exe 路径；留空用已下载副本 |
| `iwanServer` | 空 | 线路名或序号（传给 `--server`） |
| `upstreamProxy` | 自动 | 非 USTC 流量的上游 HTTP 代理；留空自动沿用启动环境里的 `HTTP(S)_PROXY`，再无则直连 |
| `cidrs` | 上表 11 段 | USTC 网段（逗号分隔） |
| `domainSuffixes` | `ustc.edu.cn,ustclug.org,ustc.life` | 域名后缀兜底 |
| `dnsServer` | 系统 | 分流解析用 DNS；TUN fake-ip 环境建议 `223.5.5.5` |
| `verbose` | `false` | 逐请求日志 |

## 与代理软件共存

- **Clash TUN 开着也能用**：分流在应用进程内完成；Clash 接管 DNS 出现 fake-ip 时，
  插件改用域名后缀兜底，且转发给 iWAN 的是域名（由 iWAN 在校内解析）。
  建议在 Clash 配置里把 iWAN 服务器地址与上述 USTC 网段设为 `DIRECT` 更稳。
- **iWAN 隧道不被抢走**：ustc-iwan 客户端本身把隧道 UDP 绑定到物理网卡
  （排除 VPN/TUN 虚拟网卡）。
- **WireGuard / Panabit iWAN**：它们接管系统路由不影响应用层分流，插件不与之争抢
  任何系统资源。
- **iWAN 掉线**：USTC 请求自动回退直连（校内场景仍可用），并在日志中提示。

## 排错

| 现象 | 处理 |
| --- | --- |
| 设置里没有「USTC IWAN」卡片 | 完全退出应用后重启（客户端 bundle 需重建）；仍无则按 F12 看控制台报错 |
| `端口 1080 上没有…且未配置 iwanClientPath` | 先手动启动 iWAN，或填写「客户端路径」 |
| iWAN 客户端一启动就退出 | 先在终端单独跑 `--connect --socks` 看输出；多为线路选择或认证过期，重跑 `--fetch` |
| USTC 请求走了直连且校外不可达 | 确认 iWAN SOCKS 端口存活；看日志是否提示 fake-ip，必要时设 DNS 为 `223.5.5.5` |
| 下载失败 | 走 GitHub Releases，网络不畅时手动下载并填入「客户端路径」 |

## 已知边界

- 网段决策只覆盖 IPv4；IPv6 字面量或仅有 AAAA 记录时按域名后缀兜底。
- 浏览器渲染层自身发出的请求不经宿主网络栈，不在分流范围内；分流目标是
  **应用出站请求**（模型调用、web 抓取、子进程等）。
- 自动化测试覆盖：CIDR 边界、SOCKS5 握手、分流决策、设置热应用与策略恢复。

## 开发

```
lib/index.js          Host 入口（运行时 + 路由挂载）
lib/runtime.js        运行时状态机（设置、分流代理、策略、托管）
lib/routes.js         /ustc-iwan/api/* 路由
lib/split-proxy.js    本地分流代理（CONNECT + 明文 HTTP）
lib/socks.js          极简 SOCKS5 CONNECT 客户端
lib/cidr.js           USTC 网段匹配 + fake-ip 识别
lib/resolver.js       带缓存 DNS 解析
lib/iwan-client.js    iWAN 客户端探测/托管
lib/binary.js         iWAN 客户端下载
lib/policy.js         出站策略安装/恢复
lib/settings-store.js 设置持久化
lib/client.js         浏览器半边（设置卡片）
```

修改 `lib/client.js` 后需**重启应用**，浏览器才会拉到新的客户端 bundle。

## 许可

[MIT](LICENSE)。ustc-iwan 客户端由 [yyy1mu/ustc-iwan](https://github.com/yyy1mu/ustc-iwan)
提供，本项目仅在运行时调用它，不重新分发其二进制。
