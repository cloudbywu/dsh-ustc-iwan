# @cloudbywu/dsh-ustc-iwan

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%E8%AF%8D%E5%85%83%E5%B7%A5%E5%9D%8A-1f6feb)](https://github.com/deepseek-ai/deepseek-harness)
[![npm](https://img.shields.io/npm/v/@cloudbywu/dsh-ustc-iwan.svg)](https://www.npmjs.com/package/@cloudbywu/dsh-ustc-iwan)

让**词元工坊**（DSH / DeepSeek Harness）访问 **USTC 系列模型（如 llm.ustc.edu.cn）与科大系列网站**
时自动走 [ustc-iwan](https://github.com/yyy1mu/ustc-iwan)，其余流量保持原样；
与 **Clash TUN、WireGuard、Panabit iWAN** 等代理/隧道软件**共存不冲突**。

- 不改系统路由、不创建虚拟网卡、不改注册表——分流完全在应用进程内完成。
- 零第三方依赖：只需宿主自带的 `@deepseek-ai/dsh-http-proxy`（不可用时自动降级）。
- 带完整设置界面：状态指示灯、一键下载 iWAN 客户端、配置表单、分流测试、运行日志。

## 快速安装

词元工坊 → 侧边栏「插件」→ 安装，把下面任一来源粘贴进去，然后**完全退出并重启应用**：

```text
@cloudbywu/dsh-ustc-iwan                       # npm 包名
https://github.com/cloudbywu/dsh-ustc-iwan      # GitHub 仓库地址
C:\Users\<你>\dsh-ustc-iwan                     # 本地目录（必须是绝对路径）
```

旧的无作用域包已撤销，请使用 scoped 包名；若官方源暂不可见，可改用 GitHub 或本地路径。
详见 [安装](#安装)。安装后打开 **设置 → USTC iWAN**。内置自动下载目前只提供 **Windows x64** 客户端；Linux/macOS 请自行准备兼容的客户端，或连接外部 SOCKS5（关闭插件托管并填写其监听地址）。

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
│  ① 命中 USTC 网段（11 段，内置） ──→ iWAN SOCKS5:21080 │
│  ② 域名后缀命中 ustc.edu.cn 等   ──→ iWAN SOCKS5:21080 │
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

词元工坊的插件页支持 **npm 包名 / GitHub 仓库地址 / 本地目录路径** 三种来源，
任选一种粘贴进「插件 → 安装」即可。安装完成后**完全退出并重启应用**，
再打开 设置 → USTC iWAN。

| 来源 | 适合 | 升级方式 |
| --- | --- | --- |
| npm 包名（最简单） | 只想用，不改代码 | 插件页「检查更新」 |
| GitHub 仓库地址 | 想跟随仓库最新提交 | 插件页「检查更新」 |
| 本地目录路径 | 想改代码（改完重启即生效） | 手动 `git pull` |

### 方式一：GitHub 仓库地址

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
| `https://github.com/cloudbywu/dsh-ustc-iwan#v0.1.4` | 固定到某个 tag / 分支 / 提交 |
| `github:cloudbywu/dsh-ustc-iwan#<40 位提交号>` | 固定到具体提交（可被插件页更新检查追踪） |

> 通过 Git 安装时，插件以**副本**形式装进 profile 的 `node_modules`。要升级，
> 在插件页对它执行**检查更新 / 更新**，或改为固定提交后重新安装。
> 首次安装需要宿主能访问 GitHub。

### 方式二：npm 包名

```text
@cloudbywu/dsh-ustc-iwan
```

旧的无作用域包已撤销。npm 安装使用 `@cloudbywu/dsh-ustc-iwan`：
<https://www.npmjs.com/package/@cloudbywu/dsh-ustc-iwan>

```bash
npm view @cloudbywu/dsh-ustc-iwan version --registry=https://registry.npmjs.org/
```

> 若查询返回 404，请确认包名、公开访问权限和注册表；刚发布的包也可能尚不可见。
> 暂时可使用方式一（GitHub）或本地路径安装。维护者发布流程见 [发布指南](docs/PUBLISHING.md)。

### 方式三：本地目录路径

```bash
git clone https://github.com/cloudbywu/dsh-ustc-iwan.git
```

在「插件 → 安装」中填入**绝对路径**（也支持 `file:` / `link:` 前缀）：

```text
C:\Users\<你>\dsh-ustc-iwan
file:C:\Users\<你>\dsh-ustc-iwan
```

或下载 [v0.1.4 源码 ZIP](https://github.com/cloudbywu/dsh-ustc-iwan/archive/refs/tags/v0.1.4.zip) 解压，再按同样方式填入解压目录。

> **本地路径必须以绝对路径给出**（相对路径会被插件管理器拒绝）。
> 以 `link:` 链接方式安装时不会执行依赖安装，因此本项目**刻意保持零第三方依赖**，
> 链接安装同样可用；这种方式改代码后重启应用即生效。

### 方式四：直接写进 profile（CLI / 进阶）

```bash
# 把 <DSH_HOME> 换成你的数据目录：
#   Windows 桌面端：%APPDATA%\tokenworks-desktop-harness
#   CLI 默认：~/.dsh
cd <DSH_HOME>/profiles/<profile>
pnpm add @cloudbywu/dsh-ustc-iwan
# 也可用 pnpm add github:cloudbywu/dsh-ustc-iwan 或 link:<本仓库绝对路径>
```

并把 `@cloudbywu/dsh-ustc-iwan` 加入该 profile `package.json` 的 `dsh.profile.bundles`。

### 安装后

1. **完全退出并重启词元工坊**（客户端 bundle 在启动时组合，仅刷新页面可能不够）；
2. 打开 **设置 → USTC iWAN**，确认「分流代理」指示灯为绿色；
3. 按 [首次使用](#首次使用) 下载 iWAN 客户端并完成一次认证。

## 首次使用

1. 打开 **设置 → USTC iWAN**；
2. 点 **下载 iwan-client-oidc**（自动存到 `<DSH_HOME>/cache/ustc-iwan/`，
   不做系统级安装；也可自行解压下载后填入「客户端路径」）。上游提供 ZIP，插件解出 exe，
   并在使用自动缓存前校验 SHA-256；旧缓存缺少记录时请重新下载。手动路径由用户确认可信。
   此哈希用于检测本地缓存变化，不是上游发布签名。
3. 在卡片的「统一身份认证」中点「开始认证」，打开授权页完成登录，
   把 `com.panabit.mobile://...` 回调 URL 粘贴回卡片并提交。
   线路配置保存在 `~/.config/iwan/servers.json`；启动、等待和提交阶段均可取消。
   如需终端方式，也可自行运行 `iwan-client-oidc-windows-x86_64.exe --fetch`。

4. 新配置默认启用「托管 iWAN 客户端」；下载或认证完成后自动尝试连接。已有关闭选项会保留，也可手动点 **启动 iWAN**；
5. 用 **测试分流** 输入 `llm.ustc.edu.cn`，显示「走 iWAN」表示规则命中；还需确认 SOCKS5 在线并实际访问目标。

## 设置卡片

安装后 **设置 → USTC iWAN** 出现一张卡片。首次使用按「准备客户端 → 统一身份认证 → 启动并验证分流」展示三步指引，就绪后可收起。外部客户端模式与实时端口状态分别判断；「走 iWAN」只代表规则命中，不等于真实目标可达。

卡片包含以下分组：

| 分组 | 内容 |
| --- | --- |
| 运行状态 | 分流代理、出站策略、SOCKS5、托管进程和恢复进度；支持启动、重新连接、停止托管、刷新状态和分流规则测试 |
| 统一身份认证 | 应用内授权、提交回调、全阶段取消与结果状态 |
| iWAN 客户端 | **一键下载 iwan-client-oidc**（进度条、sha256 记录、失败自动清理） |
| 配置 | SOCKS 地址、端口和日志开关热更新；轮询保留未保存草稿，支持显式放弃修改 |
| 最近日志 | 最近 40 条运行日志，可复制 |

宿主侧对应路由：`/ustc-iwan/api/{status,settings,download,connect,disconnect,test}`，
以及 `/ustc-iwan/api/{reconnect,download/cancel,update/check}`、`/ustc-iwan/api/auth/{start,complete,cancel}`。停止托管可取消正在启动的进程；
关闭分流或卸载插件会清理托管进程及全部代理隧道，外部启动的进程不受影响。

## 状态驱动的操作

- **已下载**：根据实际校验后的缓存显示，重启后仍可识别；安装版本和时间来自本地元数据，旧缓存版本缺失时明确显示未知。
- **检查更新 → 更新到指定版本**：只在点击时访问上游 GitHub Release API，安装已检查的精确版本；已知更高版本不自动降级，无法比较的 tag 不冒充升级。普通状态轮询不查询 GitHub。
- **重新下载**：已知版本重下同一版本；旧缓存版本未知时才获取最新。手动客户端仅显示「已配置」，缓存操作不覆盖其他手动路径。
- **安全替换**：暂停插件托管，等待旧进程真实退出再下载；支持取消。完成或失败后按原状态恢复；用户手动停止会保持暂停，不结束外部进程。
- **默认托管**：仅对新配置或缺少该字段的配置启用；缺少客户端或认证配置时等待引导，不反复拉起失败进程。

### 休眠、网络恢复与重新连接

- 设置卡片在窗口重新获得焦点、页面重新可见或浏览器恢复联网时立即刷新；旧响应不覆盖新状态及未保存草稿，请求有 30 秒超时。
- 启用自动托管后，后台每 10 秒检查本地 SOCKS 端口；普通端口异常连续两次才重建托管连接。
- 检测到 30 秒以上的事件循环长暂停（如系统休眠）时，先留 5 秒网络恢复宽限，再重新建立自己的托管会话，避免旧监听仍开但休眠前会话已经失效。
- 重连失败按 10 / 20 / 40 / 60 秒退避，连续 5 次失败后暂停自动尝试，提示人工检查；可点「重新连接」明确重试。
- 「停止托管」、关闭自动托管/分流、下载维护或认证期间不会被后台抢先拉起；外部启动的进程不会被结束或自动重启。
- 唤醒后撤销旧认证会话证明，并清除旧 DNS 解析缓存；新托管连接完成真实认证后才重新显示有效。本地 SOCKS 端口在线不等于远端目标站全链路可达。

### 瞬时 connect error 与客户端内部重连

- 托管默认显式使用 `--server 1`，等价于原先空线路选择第一条；避免上游每次内部重连再次等待交互选线。显式线路或 `auto` 不被改写。
- `connection ended: ...; reconnecting (...)` 表示原生会话中断，此时进程存活不代表 SOCKS 监听和认证仍有效。卡片显示客户端重连中，直到新的正确监听行出现才恢复认证证明。
- 插件优先等原生客户端自行恢复：单轮无新进度最多 30 秒、一次断线总计最多 90 秒；超时或进程退出才由监测器接管，手动停止/重连仍可立即打断。
- 仅对明确回环地址的本地 SOCKS 建立期传输错误，最多等待 3 秒、最多尝试 7 次，再按既有策略回退直连；路由、所有尝试和回退共用同一总时限。认证拒绝、坏协议、目标错误和握手超时不泛重试。
- 上述等待发生在 CONNECT 200 和 HTTP 业务字节发送前；一旦隧道已交接，不自动重放模型 POST、已建立隧道或响应流，避免增加重复执行/计费风险。宿主自身的模型请求重试是独立机制。
- `send VPN packet` 是上游隧道 UDP 发送错误的外层上下文，不足以定位 Windows errno。上述修复避免选线挂起、两套重连相互打断和短闪断过早回退，不等于已根治所有底层网络错误。

### 认证状态的含义

上游持久化的是加密线路配置，**没有保存 token、证书或认证有效期**。因此：

| 状态 | 含义 |
| --- | --- |
| 尚未认证 / 配置无效 | 没有可用的本地线路配置，需要完成认证或修正配置 |
| 认证已保存，待连接验证 | 本地配置存在，但不能仅凭文件或 TCP 端口判断在线认证有效 |
| 认证有效 | 本次插件托管的进程已完成认证并输出正确地址的 SOCKS5 监听行，且进程仍存活、配置及线路未改变 |

认证有效状态会在进程退出、停止或配置变化后撤销，并不表示保存的配置立即失效；下次连接成功后再次确认。
外部端口在线、曾经完成认证流程、文件修改时间或额外的 expiry/JWT 字段都不会被当作有效证据。
凭据状态对象仅返回脱敏状态、数量和配置变更标识，不返回密码、密钥或完整凭据。

依据：[上游配置格式](https://github.com/yyy1mu/ustc-iwan/blob/60237d88f7f1f2df4a21c79e61af392cadad4944/src/bin/oidc/config.rs)、[认证及代理启动顺序](https://github.com/yyy1mu/ustc-iwan/blob/60237d88f7f1f2df4a21c79e61af392cadad4944/src/bin/oidc/connect.rs)。

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

设置卡片会标记当前由环境变量覆盖的字段。取消环境变量后重启，原来保存的值仍然有效。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关闭后插件完全不介入（策略恢复原状） |
| `listenPort` | `18118` | 本地分流代理端口 |
| `iwanSocksHost` / `iwanSocksPort` | `127.0.0.1` / `21080` | 托管 SOCKS5 首选地址；已有配置沿用保存值 |
| `manageClient` | `true` | 新配置默认托管；客户端和认证配置就绪后自动连接，保留已有明确关闭选项 |
| `iwanClientPath` | 空 | 托管客户端路径；留空用已下载副本，显式路径无效会报错，不会回退 |
| `iwanServer` | 空 | 线路名或序号（传给 `--server`） |
| `upstreamProxy` | 空（自动） | 非 USTC 流量的上游 HTTP(S) 代理；留空沿用启动时的环境代理，再无则直连；自动探测值不写入配置 |
| `cidrs` | 上表 11 段 | IPv4 CIDR，支持换行、空白或逗号分隔 |
| `domainSuffixes` | `ustc.edu.cn,ustclug.org,ustc.life` | 域名后缀兜底 |
| `dnsServer` | 系统 | 分流解析用 DNS；接受 IPv4、IPv6、`IPv4:端口` 或 `[IPv6]:端口`，留空使用默认解析；TUN fake-ip 环境可尝试 `223.5.5.5` |
| `verbose` | `false` | 逐请求日志 |

托管启动时，若首选端口已被进程占用或被 Windows 保留，插件会尝试操作系统分配的可用端口。运行状态显示实际端口，分流和健康检查随之切换；保存的首选端口不变，下次启动仍优先尝试它。使用外部客户端时请关闭托管并填写其实际监听地址（例如 `127.0.0.1:1080`）；不会改动外部进程或自动切换其端口。

## 与代理软件共存

- **Clash TUN 开着也能用**：分流在应用进程内完成；Clash 接管 DNS 出现 fake-ip 时，
  插件改用域名后缀兜底，且转发给 iWAN 的是域名（由 iWAN 在校内解析）。
  建议在 Clash 配置里把 iWAN 服务器地址与上述 USTC 网段设为 `DIRECT` 更稳。
- **iWAN 隧道与 TUN**：客户端优先选择物理接口，但 Windows 上绑定源 IPv4 不等于强制绕过 TUN 路由；建议把实际 iWAN 服务器地址设置为 `DIRECT`（含 UDP）。网卡变化或路由环路需要用底层错误链另行核实，不能仅凭外层 `send VPN packet` 断言。
- **WireGuard / Panabit iWAN**：它们接管系统路由不影响应用层分流，插件不与之争抢
  任何系统资源。
- **iWAN 掉线**：USTC 请求自动回退直连（校内场景仍可用），并在日志中提示。

## 排错

| 现象 | 处理 |
| --- | --- |
| 设置里没有「USTC iWAN」卡片 | 完全退出应用后重启（客户端 bundle 需重建）；仍无则按 F12 看控制台报错 |
| SOCKS5 离线且没有客户端 | 下载或配置客户端；如使用外部 iWAN，请关闭托管、填写实际监听地址并启动它 |
| iWAN 客户端一启动就退出 | 先在终端单独跑 `--connect --socks` 看输出；多为线路选择或认证过期，重跑 `--fetch` |
| USTC 请求走了直连且校外不可达 | 确认 iWAN SOCKS 端口存活；看日志是否提示 fake-ip，必要时设 DNS 为 `223.5.5.5` |
| 下载失败 | 走 GitHub Releases，网络不畅时手动下载并填入「客户端路径」 |
| 休眠后离线 | 自动托管会在宽限和退避后恢复；检查恢复提示，必要时点「重新连接」。手动暂停或外部客户端不会被自动拉起 |
| 宿主更新已下载但未完成安装 | 若旧版插件可能影响退出，可先停用插件，结束运行中的任务，完全退出宿主后再更新。若停用后仍失败，请记录宿主版本和更新退出日志 |

## 已知边界

- 网段决策只覆盖 IPv4；IPv6 字面量或仅有 AAAA 记录时按域名后缀兜底。
- 浏览器渲染层自身发出的请求不经宿主网络栈，不在分流范围内；分流目标是
  **应用出站请求**（模型调用、web 抓取、子进程等）。
- iWAN 不可达时仍按设计回退直连，本插件不是强制禁止直连的隐私代理。
- 测试覆盖代理分包与数据交接、HTTP/TLS 上游、认证和进程取消、缓存校验、配置热更新、表单草稿及卸载清理。
- 测试使用本机回环与模拟进程，不替代真实校园认证和宿主环境验收。

## 开发

使用 Node.js 24.9.0 或更新版本，无需安装额外测试依赖：

```sh
npm run check
npm test
```

测试命令已包含隔离模拟需要的 `--experimental-vm-modules`；网络测试只使用本机回环临时端口。
CI 配置覆盖 Windows / Linux 的 Node 24、26，不自动发布 npm。

```
lib/index.js          Host 入口（运行时 + 路由挂载）
lib/runtime.js        运行时状态机（设置、分流代理、策略、托管）
lib/routes.js         /ustc-iwan/api/* 路由
lib/split-proxy.js    本地分流代理（CONNECT + 明文 HTTP）
lib/socks.js          极简 SOCKS5 CONNECT 客户端
lib/cidr.js           USTC 网段匹配 + fake-ip 识别
lib/resolver.js       带缓存 DNS 解析
lib/iwan-client.js    iWAN 客户端探测/托管
lib/reconnect-monitor.js 休眠心跳、健康检查与重试退避
lib/binary.js         iWAN 客户端下载
lib/auth.js           应用内统一身份认证
lib/credentials.js    线路配置的脱敏检查
lib/defaults.js       默认端口与分流规则
lib/home.js           插件数据目录定位
lib/owned-process.js  托管子进程退出保护
lib/policy.js         出站策略安装/恢复
lib/settings-store.js 设置持久化
lib/client.js         浏览器半边（设置卡片）
```

修改 `lib/client.js` 后需**重启应用**，浏览器才会拉到新的客户端 bundle。

## 许可

[MIT](LICENSE)。ustc-iwan 客户端由 [yyy1mu/ustc-iwan](https://github.com/yyy1mu/ustc-iwan)
提供，本项目仅在运行时调用它，不重新分发其二进制。
