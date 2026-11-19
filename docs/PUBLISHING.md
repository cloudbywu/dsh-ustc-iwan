# 发布到 npm 指南

当前包名：**`@cloudbywu/dsh-ustc-iwan`**，版本：`0.1.5`。
旧的无作用域包 `dsh-ustc-iwan` 已撤销；scoped 包的 npm 发布由维护者手动管理。
以下流程用于后续发版和验收，不要重复上传已发布的同一版本。
本文中的登录、发布和注册表验证命令由维护者自行执行。
GitHub 仓库仍为 `cloudbywu/dsh-ustc-iwan`，无需随 npm scope 改名。

## 1. 账号与命名空间

```sh
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm view @cloudbywu/dsh-ustc-iwan version --registry=https://registry.npmjs.org/
```

- 确认当前账号有 `@cloudbywu` 命名空间的发布权限。
- 查询到版本号表示该包已存在；不能重复发布相同版本。
- 查询返回 404 只表示当前查询不可见，不能单凭它保证可发布或权限正确。
- 按 npm 提示完成浏览器授权或双因素认证；不要把 token、密码或 OTP 写进仓库。

## 2. 本地自检（不会发布）

使用 Node.js 24.9.0 或更新版本，在仓库根目录执行：

```sh
npm run check
npm test
npm pack --dry-run --json --ignore-scripts
```

确认打包报告中的 `name` 为 `@cloudbywu/dsh-ustc-iwan`、`version` 为本次拟发布版本。
文件清单必须包含：

- `package.json`、`cordis.patch.yml`；
- `lib/index.js`、`lib/client.js`、`lib/auth.js` 及其他运行模块；
- `README.md`、`LICENSE`、`CHANGELOG.md`、本指南。

不应包含 `.git/`、`node_modules/`、测试文件、临时归档、凭据或本地配置。
文件数量和体积以当次打包报告为准，不使用历史固定值。

加载标识必须同步：

| 配置 | 期望值 |
| --- | --- |
| `package.json` 的 `name` | `@cloudbywu/dsh-ustc-iwan` |
| `cordis.patch.yml` 的行 `name` | `@cloudbywu/dsh-ustc-iwan` |
| Host 导出的 `name` | `@cloudbywu/dsh-ustc-iwan` |
| 浏览器 `__ModuleLoader__.load` 的 `id` | `@cloudbywu/dsh-ustc-iwan` |
| `publishConfig.access` | `public` |

Cordis 行 `id`、样式标识和设置存储名保留原值，它们不是 npm 包解析名称。

## 3. 由维护者正式发布

可先自行预演：

```sh
npm publish --dry-run --access public --registry=https://registry.npmjs.org/
```

确认包内容、账号、版本与访问权限后，再由维护者执行真正发布：

```sh
npm publish --access public --registry=https://registry.npmjs.org/
```

`publishConfig.access` 已设为 `public`；命令显式指定以便检查 scoped 包的公开发布意图。
预期成功输出为 `+ @cloudbywu/dsh-ustc-iwan@0.1.5`（以实际版本为准）。
旧包与 scoped 包是不同的 npm 包；撤回或更名不意味着已发布版本可以覆盖。

## 4. 发布后验收

```sh
npm view @cloudbywu/dsh-ustc-iwan version dist.tarball --registry=https://registry.npmjs.org/
```

在独立临时目录安装验证：

```sh
npm init -y
npm install @cloudbywu/dsh-ustc-iwan --registry=https://registry.npmjs.org/
node -e "console.log(require.resolve('@cloudbywu/dsh-ustc-iwan/package.json'))"
```

安装目录应为 `node_modules/@cloudbywu/dsh-ustc-iwan/`。
词元工坊中先卸载旧的无作用域插件，再安装 `@cloudbywu/dsh-ustc-iwan` 并完全重启，
确认设置卡片、认证和分流均正常。不要同时安装新旧包，否则可能争用代理端口。

每次发版后同步 README、CHANGELOG 与对应 GitHub Release；公开可用性以官方注册表查询为准。
镜像可能有同步延迟，验收时显式查询 npm 官方注册表。

## 5. 后续版本与安全

- 保持包版本、更新日志和 GitHub tag 一致；相同 npm 包版本不可覆盖。
- 发布前重复运行测试与打包预检，核对 scope 和 `public`。
- 发布失败时先查看明确状态，避免未经检查重复操作。
- 如需撤回或弃用，先核对 npm 当前规则和依赖影响，不依赖固定的历史撤回时限。
- 本项目 CI 只运行检查和测试，不自动发布；不要提交 npm token。
