# Clash Verge TUN 与 USTC iWAN 共用指南

| 你的需求 | 怎么配 |
| --- | --- |
| 只让词元工坊访问校内站点和模型 | 只做[第一步](#第一步让-iwan-线路服务器绕过-tun)。保留插件分流，不必在 Clash 添加 iWAN 代理或校内规则。 |
| 浏览器等其它应用也要走 iWAN | 先做第一步，再按[第二步](#第二步可选让-clash-分流校内流量)添加 SOCKS5 和规则。 |

## 插件内检测和配置（Windows Clash Verge Rev）

1. 用本机地址打开词元工坊，在「设置 → USTC iWAN → Clash TUN 共存设置」点检测。插件显示已排除与仍需添加的地址；**检测不会写配置**，也不会启停 TUN。
2. 选择范围。「仅排除 iWAN 线路」从本机线路列表读取有效 IP，只排除这些主机地址（IPv4 为 `/32`，IPv6 为 `/128`），是默认建议。「排除全部 USTC 网段」还排除 11 段校园 IPv4 网段，**这些网段可能不再进入 Clash 的校园分流规则**；这不是设置规则集或代理出站的按钮。
3. 从托盘**完全退出 Clash Verge Rev**，不只是关窗口或关 TUN。重新检测，查看预览后确认写入；插件先备份，再合并排除项，保留原有配置。等待卡片确认完成后再重新打开 Clash Verge，开启 TUN，用同一请求复测。
4. 如需撤回，从托盘再次完全退出，在卡片重新检测并确认回退。若配置后来被修改，插件不会用旧备份直接覆盖，请按检测提示核对或手工撤销。恢复并校验成功后，插件会尝试清理这次使用的备份，不会批量删除历史备份。其它 Clash 客户端、受保护或不识别的配置，请用下面的手工步骤。

此功能只检测 TUN 的 `route-exclude-address` 字面地址及网段（含已有更宽网段的覆盖），不把 `DIRECT` 规则算作系统路由排除；在 `auto-route` 启用时才生效。插件不修改 Clash 规则集和订阅，也不会自动重启或停止其它应用。

- **其它 Clash 客户端、便携版或非 Windows**：同样可在卡片检测并复制本机 iWAN 线路地址，按下文手动追加；如果提示「无法确认现有排除项」，清单只是候选，不代表 Clash 漏配。粘贴前请对照现有配置，避免重复。
- **尚无 TUN 设置或运行配置不完整**：先在 Clash 的 TUN 设置页保存一次，确认当前订阅能正常生成配置；再完全退出 Clash 后重新检测。遇到重复键或无法核对现有排除项时不要强制写入。
- **没有字面线路 IP**：两档均禁止自动写入。请先完成认证得到线路列表；如果线路只有域名，请核对它的真实入口 IP 后手填，而不是直接复制 fake-IP。校园模式使用插件内置的 11 段 IPv4 网段，并补充这些网段覆盖不到的线路地址，不读取「高级设置」中的自定义网段。

## 第一步：让 iWAN 线路服务器绕过 TUN

**线路服务器和校内目标是两回事。** 校内网站、模型 API 是要送进 iWAN 的目标；iWAN 客户端自己连接的线路服务器是隧道入口，不能再走 iWAN。开 TUN 后出现 `Connection error`、关 TUN 后无需重连就恢复时，先从这个入口排查，不要把全部 USTC 网段都排除。

1. 在「设置 → USTC iWAN → 最近日志」里查找当前线路的连接日志，例如 `Connecting to … (202.38.64.106:6001)`。如果日志已滚出，可在下次启动或重连时查看。这里的 IP 和端口**只是示例**，换线路后需核对实际地址。
2. 在 Clash Verge Rev 的 **TUN 设置**中找到「路由排除地址」（`route-exclude-address`），追加实际线路 IP 的 `/32`，不要写端口。IPv6 地址用 `/128`。保留原有排除项。使用配置文件管理的 Mihomo 客户端，可在现有 `tun` 下合并（该项在 `auto-route` 启用时生效）：

```yaml
tun:
  auto-route: true
  route-exclude-address:
    - 202.38.64.106/32  # 示例，换成当前线路服务器 IP
```

3. 应用配置并保持 TUN 开启，先不重连 iWAN，重试同一个词元工坊请求。若 TUN 设置中保存过该字段，Clash Verge 可能用界面设置覆盖订阅中的值，应以生效配置为准。配置的合并方式和优先级见 [Clash Verge Rev 官方文档](https://www.clashverge.dev/guide/extend.html)。

`route-exclude-address` 是系统路由层面的排除；`DIRECT` 是流量已进入 Clash 后的出站动作，两者不等价。不要用 11 段校园网段替代线路 IP 排除项，否则相应流量可能绕过 Clash 的校内分流。详见 [Mihomo TUN 文档](https://wiki.metacubex.one/config/inbound/tun/#route-exclude-address)。

## 第二步（可选）：让 Clash 分流校内流量

1. 确认 iWAN SOCKS5 已启动，记下插件卡片上的**实际**监听地址和端口。默认首选端口是 `21080`，但托管模式遇到端口冲突时可能换端口，Clash 不会自动跟随。长期用于系统分流时宜使用固定的 iWAN SOCKS5 地址；若由词元工坊托管，退出应用后该 SOCKS5 也会停止。不要把 Clash 自己的 mixed-port、SOCKS 端口或插件的 HTTP 端口 `18118` 配成 iWAN 出站。
2. 将 [iwan.yaml](iwan.yaml) 复制到 **Mihomo 工作目录**（内核 `-d` 指定的目录）的 `rules/iwan.yaml`。它包含 11 段 USTC IPv4 网段和 `ustc.edu.cn`、`ustc.edu` 两个域名后缀。规则只影响 Clash，不会修改词元工坊插件内的域名后缀。
3. 将下列片段合并到生效配置。保留已有代理、规则集和规则，不要用示例覆盖整份订阅。Clash Verge Rev 可用订阅的「编辑扩展」配置 `proxies` 和 `rule-providers`，再用「编辑规则」的 **prepend / 前置** 添加下列两条规则。如果已经有同名代理或规则集，请改名并同步修改引用。

```yaml
proxies:
  - name: iwan
    type: socks5
    server: 127.0.0.1
    port: 21080  # 换成 iWAN SOCKS5 的实际端口
    udp: false

rule-providers:
  iwan:
    type: file
    behavior: classical
    path: ./rules/iwan.yaml

rules:
  - IP-CIDR,202.38.64.106/32,DIRECT,no-resolve  # 示例：先匹配实际线路 IP
  - RULE-SET,iwan,iwan                        # 再把校内目标交给 iWAN
  # 原有的宽泛规则（如 GEOIP,CN）与 MATCH 保留在后面
```

- Clash 选择「规则」模式。**线路服务器的 `DIRECT` 必须在 `RULE-SET` 前**：示例线路 `202.38.64.106` 本身就在 `202.38.64.0/19` 内，顺序反了就可能把隧道入口送回 iWAN。IPv6 线路的兜底规则用 `IP-CIDR6`。示例 SOCKS5 出站只用于 TCP；iWAN 连接线路服务器所用的外层 UDP 仍要能直接到达。
- 不支持 `rule-providers` 的经典 Clash：把规则文件的 `payload` 条目展开到主配置的 `rules`，如 `IP-CIDR,202.38.64.0/19,iwan,no-resolve` 与 `DOMAIN-SUFFIX,ustc.edu.cn,iwan`；线路服务器例外仍放最前。若客户端也不支持 TUN 路由排除，建议改用支持该功能的 Mihomo 客户端，或关闭 TUN。
- `no-resolve` 让 IP 规则不为匹配额外发起 DNS；遇到 fake-IP 时，校园 IPv4 网段规则不能代替域名规则。保留域名后缀，优先用域名验证分流。详见 [Mihomo 路由规则](https://wiki.metacubex.one/config/rules/)与[规则集合](https://wiki.metacubex.one/config/rule-providers/)。

## 验证和排错

1. 先看插件卡片的 SOCKS5 地址是否正确。**「在线」只表示本地端口可用，「测试分流」只表示规则命中**；用实际模型请求验证连通性。
2. Windows 可用下列命令绕过插件 HTTP 代理、直接测试 iWAN。能收到 HTTP 状态码（例如 `200`、`302` 或未认证的 `401`）表示能连到该站点，不代表模型授权或额度正常。

```powershell
$port = 21080 # 使用实际端口
curl.exe --disable --noproxy localhost --proxy "socks5h://127.0.0.1:$port" --head --max-time 10 https://api.llm.ustc.edu.cn/
```

3. 仍失败时，只切换 TUN，保持 iWAN 进程不变，再测同一目标。若仅在 TUN 开启时失败，核对当前线路 IP 是否仍在**生效**的排除列表；也可运行 `Find-NetRoute -RemoteIPAddress 202.38.64.106`（换成实际 IP），检查首选路由是否还指向 TUN。该命令反映 Windows 的选路结果，不是对 iWAN UDP 报文的抓包验证。
4. 若直接走 SOCKS5 成功，但经 Clash 的浏览器流量失败，查看 Clash 连接记录是否命中 `RULE-SET,iwan,iwan`、出站端口是否改变。若关 TUN 后直接走 SOCKS5 仍失败，先排查 iWAN 线路与认证，不要单纯调长插件超时。
