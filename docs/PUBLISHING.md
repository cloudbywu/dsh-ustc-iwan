# 发布到 npm 指南

本文件说明如何把 **dsh-ustc-iwan** 发布到 npm 公共注册表，使词元工坊的插件页可以直接用
**包名** 安装（`dsh-ustc-iwan`）。

> 本机实测环境：**node v26.7.0 / npm 11.19.0**（`C:\app\nodejs`）。
> 命令在仓库根目录（本文件上一级）执行。

---

## 0. 一次性准备

### 0.1 注册 / 登录 npm

```bash
npm login
```

浏览器会打开 npm 授权页，登录后回到终端。确认身份：

```bash
npm whoami          # 应输出你的 npm 用户名
```

若账号启用了 **双因素认证（2FA）**，发布时终端会要求输入 **OTP 动态码**（推荐开启，
否则账号被撞库后可以直接发版）。

### 0.2 确认包名可用

```bash
npm view dsh-ustc-iwan version
```

- 输出 `404 Not Found` → **名字可用**（写本文时实测为 404）。
- 输出了版本号 → 名字已被占用，必须改 `package.json` 的 `name`（例如
  `@你的作用域/dsh-ustc-iwan`；带作用域的包默认私有，发布时需加 `--access public`）。

---

## 1. 发布前自检

### 1.1 看会打包哪些文件

```bash
npm pack --dry-run --json
```

本仓库当前结果（**19 个文件，解包 74 KB，压缩包 26 KB**）：

```text
package.json  cordis.patch.yml  README.md  LICENSE  CHANGELOG.md
lib/binary.js  lib/cidr.js  lib/client.js  lib/defaults.js  lib/home.js
lib/index.js  lib/iwan-client.js  lib/policy.js  lib/resolver.js
lib/routes.js  lib/runtime.js  lib/settings-store.js  lib/socks.js  lib/split-proxy.js
```

必须包含的三样东西（缺一个插件就装不上或用不了）：

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | Host 半边入口（`main` 字段） |
| `lib/client.js` | 浏览器半边（`exports["./client"]`） |
| `cordis.patch.yml` | 组合包声明（`dsh.bundle.patch`） |

不应出现的：`.git/`、`*.zip`、测试脚本、`node_modules/`。`files` 白名单已把它们排除。

### 1.2 检查元数据

```bash
node -e "const p=require('./package.json');console.log(p.name,p.version,p.license,p.repository.url)"
```

发布前确认：

- `version` 是这次要发的新版本（首次发布为 `0.1.0`）；
- `license` 为 `MIT` 且仓库里有 `LICENSE` 文件；
- `repository` 指向真实仓库（npm 页面会显示来源链接）；
- `peerDependenciesMeta` 里 `react` 与 `@deepseek-ai/dsh-http-proxy` 标为 **optional** ——
  它们由宿提供，标 optional 可避免 `npm install`（npm 7+ 会自动装 peer）往用户环境里
  塞进第二份 react。

### 1.3 干跑一次

```bash
npm publish --dry-run
```

它会打印将要上传的清单与警告，但**不会真的发布**。看清警告后再继续：
只有 `peerDependenciesMeta`、缺 `description` 之类可以忽略，其余都要处理。

---

## 2. 正式发布

```bash
npm publish
```

- 包名无作用域时默认就是 public，无需 `--access public`（`package.json` 里的
  `publishConfig.access` 已写成 `public`，二者一致）。
- 开了 2FA 会提示输入一次性验证码。
- 成功后会输出 `+ dsh-ustc-iwan@0.1.0`。

若名字临时被占或要发到自己的作用域：

```bash
npm publish --access public      # 作用域包必须显式 public
```

---

## 3. 发布后验证

```bash
# ① 注册表上能查到
npm view dsh-ustc-iwan version dist.tarball

# ② 在一个空目录里真实安装一次，确认文件齐全
mkdir /tmp/npm-check && cd /tmp/npm-check
npm init -y
npm i dsh-ustc-iwan
ls node_modules/dsh-ustc-iwan           # 应看到 lib/ cordis.patch.yml package.json
ls node_modules/dsh-ustc-iwan/lib       # 应看到 client.js index.js 等
```

③ **在词元工坊里验收**：插件页 → 安装 → 输入 `dsh-ustc-iwan` → 重启应用 →
设置里出现「USTC IWAN」卡片。

> 国内镜像（npmmirror 等）同步有延迟，刚发布后可能查不到；`npm view` 默认读官方源，
> 不受影响。

---

## 4. 发布后要同步的仓库内容

1. **README**：把「方式二：npm 包名」里的「⚠️ 尚未发布到 npm」改成正式可用说明；
2. **CHANGELOG**：在对应版本下补充「已发布至 npm」；
3. **GitHub Release**：给同一个版本打 tag（`git tag v0.1.0 && git push --follow-tags`），
   并在 Release 说明里注明 npm 包名；
4. 本文档第 0.2 节的「写本文时实测为 404」在首次发布后即失效，可删。

---

## 5. 后续发版流程

```bash
# 1) 改代码、更新 CHANGELOG
# 2) 升版本（会同时打 git tag）
npm version patch      # 修 bug；minor 加功能；major 破坏性变更
# 3) 推代码与 tag
git push && git push --follow-tags
# 4) 发布
npm publish
```

词元工坊插件页的「检查更新」按 **semver 版本号**判断，因此：修 bug 用 `patch`，
新增功能用 `minor`，不要为了“发个新版”而滥用 `major`。

---

## 6. 常见错误对照

| 报错 | 原因 | 处理 |
| --- | --- | --- |
| `E403 Forbidden - PUT ... : You do not have permission to publish` | 包名已被他人占用 | 改名或加作用域 `@cloudbywu/dsh-ustc-iwan` |
| `E402 Payment required` | 向组织作用域发布私有包但未付费 | 加 `--access public` |
| `ENEEDAUTH` | 未登录或 token 失效 | `npm login`，或设置 `NPM_TOKEN` 环境变量 |
| `EOTP` / 要求输入验证码 | 账号开了 2FA | 输入动态码；CI 里用 automation token |
| `EPUBLISHCONFLICT` / `cannot publish over previously published version` | 同版本号已发布过 | 升版本号；版本号**不可覆盖** |
| `npm ERR! 404 ... is not in this registry` | 国内镜像未同步或源配置错误 | `npm config get registry` 确认是 `https://registry.npmjs.org/` |
| `EBADENGINE` 警告 | `engines.node >=24.9.0` 与用户 node 版本不符 | 属预期：词元工坊自带 node 24+ |

---

## 7. 安全与回滚

- **不要**把 token 写进仓库或 `package.json`；CI 用 `NPM_TOKEN` secret。
- npm 允许在**发布后 24 小时内**执行 `npm unpublish dsh-ustc-iwan@0.1.0` 撤回；
  超过 24 小时只能发新版本覆盖（旧版本仍可被安装，除非联系 npm 支持）。
- 撤回后同版本号**不能再次发布**，必须升版本。
- 发布前建议再跑一次 `npm pack --dry-run`，确认没有把 `.env`、密钥、本地路径打进包里。

---

## 附：切换到 npm 安装方式后

插件从 npm 安装是**副本**形式进入 profile 的 `node_modules`：

- 升级：在插件页点「检查更新」；
- 想回到改代码即时生效的开发方式：改用 `link:` 本地路径安装。

词元工坊 profile 的 `pnpm-workspace.yaml` 里 `autoInstallPeers: false`，
因此本包的两个 optional peer 不会被自动拉取，安装是干净的。
