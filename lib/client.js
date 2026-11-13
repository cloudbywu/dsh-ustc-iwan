/*
 * @cloudbywu/dsh-ustc-iwan 浏览器半边：设置 → 「USTC iWAN」卡片。
 * 结构与交互样式沿用 @eddyskywalker/dsh-chatgpt-subscription 的线路卡片惯例：
 * settings.section 槽位注册 + 分组卡片 + --dsw-alias-* 主题 token。
 */
window.__ModuleLoader__.load({
  id: "@cloudbywu/dsh-ustc-iwan",
  factory: (require) => {
    // 模块系统只提供 factory(require) → 返回值，不注入 module/exports 魔法；
    // 两个变量都必须自己声明，否则下面的 exports.apply 会抛 ReferenceError，
    // 整条 entry 在物化阶段失败（宿主仅记录 warning: import failed: exports is not defined）。
    var module = { exports: {} };
    var exports = module.exports;
    var React = require('react');
    const h = React.createElement;

    // ---------- API ----------
    const API = "/ustc-iwan/api";
    async function request(url, init) {
      const response = await fetch(url, { ...init, credentials: "same-origin" });
      let text = '';
      try { text = await response.text(); } catch {}
      let parsed;
      try { parsed = JSON.parse(text); } catch {
        throw new Error('宿主返回了无法解析的应答（HTTP ' + response.status + '），请查看宿主日志');
      }
      if (!response.ok || (parsed && parsed.ok === false)) throw new Error(parsed?.error || '操作失败（HTTP ' + response.status + '）');
      return parsed && parsed.ok ? parsed.value : parsed;
    }
    const post = (path, body) => request(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
    const api = {
      status: () => request(API + "/status"),
      settings: (patch) => post("/settings", patch),
      download: (mode = "download") => post("/download", { mode }),
      cancelDownload: () => post("/download/cancel", {}),
      checkUpdates: () => post("/update/check", {}),
      authStart: () => post("/auth/start", {}),
      authComplete: (id, redirectUrl) => post("/auth/complete", { id, redirectUrl }),
      authCancel: (id) => post("/auth/cancel", { id }),
      connect: () => post("/connect", {}),
      disconnect: () => post("/disconnect", {}),
      test: (host) => post("/test", { host }),
    };

    // ---------- 样式 ----------
    const STYLE_ID = "dsh-ustc-iwan-style";
    const CSS = `
      .dsh-ustc-card { color: var(--dsw-alias-label-primary, inherit); font-size: 13px; max-width: 720px; }
      .dsh-ustc-group { border-top: 0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25)); padding: 12px 0; }
      .dsh-ustc-group h3 { margin: 0 0 8px; font-size: 13px; }
      .dsh-ustc-row { display: flex; align-items: center; gap: 10px; margin: 8px 0; flex-wrap: wrap; }
      .dsh-ustc-row > label:first-child { flex: 0 0 150px; }
      .dsh-ustc-hint { opacity: .65; font-size: 12px; margin: 4px 0; }
      .dsh-ustc-input { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08)); border: 0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); border-radius: 7px; color: inherit; font: inherit; font-size: 12px; padding: 6px 9px; }
      .dsh-ustc-input.t { flex: 1 1 260px; min-width: 200px; max-width: 460px; }
      .dsh-ustc-btn { border: 0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35)); border-radius: 7px; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08)); color: inherit; font: inherit; font-size: 12px; padding: 6px 12px; cursor: pointer; }
      .dsh-ustc-btn:disabled { opacity: .5; cursor: default; }
      .dsh-ustc-btn.primary { background: rgba(59,130,246,.85); color: #fff; border-color: transparent; }
      .dsh-ustc-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
      .dsh-ustc-dot.on { background: #22c55e; } .dsh-ustc-dot.off { background: #94a3b8; }
      .dsh-ustc-bar { flex: 1 1 220px; height: 6px; border-radius: 3px; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.15)); overflow: hidden; }
      .dsh-ustc-bar > div { height: 100%; background: rgba(59,130,246,.85); transition: width .3s; }
      .dsh-ustc-log { font-family: ui-monospace, monospace; font-size: 11px; opacity: .75; max-height: 180px; overflow: auto; white-space: pre-wrap; margin: 6px 0 0; padding: 8px; border-radius: 7px; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08)); }
      .dsh-ustc-link { color: inherit; text-decoration: underline; cursor: pointer; background: none; border: none; font: inherit; font-size: 12px; padding: 0; }
      .dsh-ustc-url { font-family: ui-monospace, monospace; font-size: 11px; opacity: .7; word-break: break-all; margin: 4px 0; }
      .dsh-ustc-error { color: #dc2626; font-size: 12px; margin: 6px 0; }
      .dsh-ustc-ok { color: #16a34a; font-size: 12px; margin: 6px 0; }
    `;
    function installStyle() {
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.setAttribute("data-plugin", "dsh-ustc-iwan");
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    // ---------- 小组件 ----------
    function Dot({ on, label }) {
      return h('span', null, h('span', { className: 'dsh-ustc-dot ' + (on ? 'on' : 'off') }), label);
    }
    function Row({ label, hint, children }) {
      return h('div', { className: 'dsh-ustc-row' },
        h('label', null, label),
        children,
        hint ? h('div', { className: 'dsh-ustc-hint', style: { flexBasis: '100%' } }, hint) : null,
      );
    }
    /**
     * 认证区：三种状态各画一种界面。
     *  idle      —— 一个「开始认证」按钮
     *  awaiting  —— 展示授权地址，并提供回调 URL 输入框
     *  submitting/done/failed —— 进度与结果
     */
    function renderAuth(auth, { busy, startAuth, completeAuth, cancelAuth, redirectUrl, setRedirectUrl, installing, binaryInstalled, connect, refresh, canConnect }) {
      const state = auth.state ?? 'idle';
      const saved = auth.credentials ?? { state: 'missing', serverCount: 0 };
      const canStart = auth.canStart ?? binaryInstalled;
      const blocked = busy !== null || installing || !canStart;
      const cancellingBlocked = busy !== null && !['authStart', 'authComplete'].includes(busy);
      if (state === 'awaiting') {
        return h('div', null,
          h('p', { className: 'dsh-ustc-hint' }, '① 打开授权页完成校内登录：'),
          h('a', { className: 'dsh-ustc-link', href: auth.authorizeUrl, target: '_blank', rel: 'noreferrer noopener' }, '打开统一身份认证页面 ↗'),
          h('div', { className: 'dsh-ustc-url' }, auth.authorizeUrl),
          h('p', { className: 'dsh-ustc-hint' }, '② 把登录后 com.panabit.mobile:// 开头的完整回调地址粘贴到下面：'),
          h('div', { className: 'dsh-ustc-row' },
            h('input', { className: 'dsh-ustc-input t', value: redirectUrl, placeholder: 'com.panabit.mobile://oauth2redirect?code=…', onChange: (e) => setRedirectUrl(e.target.value) }),
            h('button', { className: 'dsh-ustc-btn primary', disabled: busy !== null || !redirectUrl.trim(), onClick: completeAuth }, busy === 'authComplete' ? '提交中…' : '完成认证'),
            h('button', { className: 'dsh-ustc-btn', disabled: cancellingBlocked, onClick: cancelAuth }, '取消认证')));
      }
      if (state === 'starting' || state === 'submitting') {
        return h('div', null,
          h('p', { className: 'dsh-ustc-hint' }, state === 'starting' ? '正在获取授权地址…' : '正在换取线路配置，完成后将按托管设置自动连接…'),
          h('button', { className: 'dsh-ustc-btn', disabled: !auth.id || cancellingBlocked, onClick: cancelAuth }, '取消认证'));
      }
      const valid = saved.state === 'valid';
      const stored = saved.serverCount > 0;
      const title = valid ? '认证有效' : saved.state === 'expired' ? '认证已过期' : saved.state === 'invalid' ? '认证配置无效' : stored ? '认证已保存，待连接验证' : '尚未认证';
      return h('div', null,
        h('div', { className: valid ? 'dsh-ustc-ok' : (saved.state === 'expired' || saved.state === 'invalid') ? 'dsh-ustc-error' : 'dsh-ustc-hint' }, title),
        saved.message ? h('p', { className: 'dsh-ustc-hint' }, saved.message) : null,
        saved.expiresAt ? h('p', { className: 'dsh-ustc-hint' }, '有效至：' + new Date(saved.expiresAt).toLocaleString()) : null,
        valid && saved.verifiedAt ? h('p', { className: 'dsh-ustc-hint' }, '本次连接验证：' + new Date(saved.verifiedAt).toLocaleString()) : null,
        state === 'failed' ? h('p', { className: 'dsh-ustc-error' }, '上次认证操作失败：' + (auth.error || '未知原因')) : null,
        state === 'done' && !valid ? h('p', { className: 'dsh-ustc-hint' }, '认证流程已完成，连接成功后会验证当前线路是否有效。') : null,
        !binaryInstalled ? h('p', { className: 'dsh-ustc-hint' }, '请先下载客户端或配置可信的客户端路径。') : null,
        h('div', { className: 'dsh-ustc-row' },
          h('button', { className: 'dsh-ustc-btn' + (!stored ? ' primary' : ''), disabled: blocked, onClick: startAuth }, stored || state === 'done' ? '重新认证' : '开始认证'),
          stored && !valid ? h('button', { className: 'dsh-ustc-btn', disabled: !canConnect || busy !== null, onClick: connect }, '连接并验证') : null,
          h('button', { className: 'dsh-ustc-btn', disabled: busy !== null, onClick: refresh }, '刷新认证状态')));
    }

    // ---------- 设置卡片 ----------
    function UstcIwanSection() {
      const [status, setStatus] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [busy, setBusy] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      const [testHost, setTestHost] = React.useState('llm.ustc.edu.cn');
      const [testResult, setTestResult] = React.useState(null);
      const [redirectUrl, setRedirectUrl] = React.useState('');
      const dirty = React.useRef(false);
      const editVersion = React.useRef(0);
      const operationVersion = React.useRef(0);
      const pollVersion = React.useRef(0);
      const busyRef = React.useRef(null);

      const apply = React.useCallback((next) => {
        setStatus(next);
        if (next?.settings && !dirty.current) setDraft({ ...next.settings });
      }, []);
      const reload = React.useCallback(async () => {
        const operation = operationVersion.current;
        const poll = ++pollVersion.current;
        try {
          const next = await api.status();
          if (operation !== operationVersion.current || poll !== pollVersion.current) return;
          apply(next);
        } catch (cause) {
          if (operation === operationVersion.current && poll === pollVersion.current) setError(cause instanceof Error ? cause.message : String(cause));
        }
      }, [apply]);
      React.useEffect(() => { reload(); }, [reload]);
      React.useEffect(() => {
        // 下载中或认证等待中都需要更密的轮询，好让进度与结果及时反映出来。
        const active = status?.download?.state === 'downloading'
          || status?.auth?.state === 'starting'
          || status?.auth?.state === 'awaiting'
          || status?.auth?.state === 'submitting'
          || status?.maintenance?.running
          || status?.binary?.checking
          || status?.iwan?.connecting
          || status?.iwan?.stopping;
        const timer = setInterval(() => { reload(); }, active ? 1500 : 10000);
        return () => clearInterval(timer);
      }, [reload, status?.download?.state, status?.auth?.state, status?.maintenance?.running, status?.binary?.checking, status?.iwan?.connecting, status?.iwan?.stopping]);

      const run = React.useCallback(async (label, action) => {
        if (busyRef.current !== null && !(label === 'authCancel' && ['authStart', 'authComplete'].includes(busyRef.current)) && !(label === 'disconnect' && ['connect', 'checkUpdates'].includes(busyRef.current)) && !(label === 'cancelDownload' && busyRef.current === 'download')) return;
        const operation = ++operationVersion.current;
        busyRef.current = label;
        setBusy(label); setError(null); setNotice(null);
        try {
          const next = await action(() => operation === operationVersion.current);
          if (operation === operationVersion.current && next) apply(next);
        } catch (cause) {
          if (operation === operationVersion.current) setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          if (operation === operationVersion.current) {
            ++operationVersion.current; // 丢弃操作进行期间发出的旧轮询。
            busyRef.current = null;
            setBusy(null);
          }
        }
      }, [apply]);

      const set = (key, value) => {
        dirty.current = true;
        ++editVersion.current;
        setDraft((d) => ({ ...d, [key]: value }));
      };
      const save = () => run('save', async () => {
        const version = editVersion.current;
        const patch = { ...draft };
        for (const key of ['listenPort', 'iwanSocksPort']) {
          patch[key] = Number(patch[key]) || 0;
        }
        const next = await api.settings(patch);
        if (version === editVersion.current) dirty.current = false;
        setNotice(dirty.current ? '已保存提交的配置；当前仍有未保存修改' : '配置已保存并即时生效');
        return next;
      });
      const doTest = () => run('test', async () => {
        const result = await api.test(testHost);
        setTestResult(result);
        return null;
      });
      const startAuth = () => run('authStart', async () => {
        setRedirectUrl('');
        setStatus((s) => ({ ...s, auth: { state: 'starting', id: null } }));
        await api.authStart();
        return api.status();
      });
      const completeAuth = () => run('authComplete', async () => {
        const auth = status?.auth ?? {};
        await api.authComplete(auth.id, redirectUrl);
        setRedirectUrl('');
        setNotice('已提交回调 URL，正在换取线路配置…');
        return api.status();
      });
      const cancelAuth = () => run('authCancel', async () => {
        const auth = status?.auth ?? {};
        await api.authCancel(auth.id);
        return api.status();
      });

      const connect = () => run('connect', async () => { await api.connect(); return api.status(); });
      const installClient = (mode) => run('download', async (current) => {
        const result = await api.download(mode);
        if (result.error) throw new Error(result.error);
        if (current()) setNotice(result.started ? '客户端维护已开始，托管进程将按原设置恢复。' : (result.reason || '客户端已就绪'));
        return api.status();
      });
      const cancelDownload = () => run('cancelDownload', async () => { await api.cancelDownload(); return api.status(); });
      const checkUpdates = () => run('checkUpdates', async (current) => {
        const result = await api.checkUpdates();
        if (result.error || result.updateError) throw new Error(result.error || result.updateError);
        if (current()) setNotice(result.updateAvailable === false ? '当前客户端已是最新版本' : result.latestVersion ? '最新客户端版本：' + result.latestVersion : (result.reason || '检查更新完成'));
        return api.status();
      });

      if (!status || !draft) {
        return h('div', { className: 'dsh-ustc-card' }, error ? h('div', { className: 'dsh-ustc-error' }, error) : '加载中…');
      }
      const s = status;
      const auth = s.auth ?? {};
      const dl = s.download ?? {};
      const binary = s.binary ?? {};
      const savedAuth = auth.credentials ?? { state: 'missing', serverCount: 0 };
      const maintenance = s.maintenance ?? {};
      const installing = maintenance.running === true || dl.state === 'downloading';
      const authenticating = ['starting', 'awaiting', 'submitting'].includes(auth.state);
      const binaryInstalled = binary.installed ?? Boolean(binary.path);
      const downloaded = binary.downloaded ?? (binaryInstalled && binary.kind === 'downloaded');
      const canConnect = Boolean(s.settings.enabled && binaryInstalled && !installing && !authenticating &&
        savedAuth.serverCount > 0 && ['valid', 'unknown'].includes(savedAuth.state) &&
        !s.iwan.managed && !s.iwan.socksAlive && !s.iwan.connecting && !s.iwan.stopping);
      const connectLabel = s.iwan.stopping ? '停止中…' : s.iwan.connecting || busy === 'connect' ? '启动中…' : s.iwan.managed ? '托管运行中' : s.iwan.socksAlive ? '外部客户端在线' : '启动 iWAN';
      const downloadBlocked = busy !== null || installing || authenticating || binary.checking;
      const dlPct = dl.total ? Math.min(100, Math.round((dl.bytes / dl.total) * 100)) : (dl.state === 'downloading' ? 0 : 100);

      return h('div', { className: 'dsh-ustc-card' },
        h('p', { className: 'dsh-ustc-hint' },
          '访问科大模型与校内网站时自动走 ustc-iwan，其余流量保持原样；与 Clash TUN、WireGuard、Panabit iWAN 共存。'),
        error ? h('div', { className: 'dsh-ustc-error' }, error) : null,
        notice ? h('div', { className: 'dsh-ustc-ok' }, notice) : null,

        // 运行状态
        h('div', { className: 'dsh-ustc-group' },
          h('h3', null, '运行状态'),
          h('div', { className: 'dsh-ustc-row' }, h('label', null, '分流代理'),
            h(Dot, { on: s.proxy.listening, label: s.proxy.listening ? '运行中（127.0.0.1:' + s.proxy.port + '）' : '未运行' }),
            h(Dot, { on: s.policyInstalled, label: '出站策略' + (s.policyInstalled ? '已生效' : '未生效') })),
          h('div', { className: 'dsh-ustc-row' }, h('label', null, 'iWAN SOCKS5'),
            h(Dot, { on: s.iwan.socksAlive, label: s.settings.iwanSocksHost + ':' + s.settings.iwanSocksPort + (s.iwan.socksAlive ? '（在线）' : '（离线）') }),
            h(Dot, { on: s.iwan.managed, label: s.iwan.managed ? '插件托管中' : '无托管进程' })),
          h('div', { className: 'dsh-ustc-row' },
            h('button', { className: 'dsh-ustc-btn primary', disabled: busy !== null || !canConnect, onClick: connect }, connectLabel),
            h('button', { className: 'dsh-ustc-btn', disabled: (busy !== null && !['connect', 'checkUpdates'].includes(busy)) || (!s.iwan.managed && !s.iwan.connecting && busy !== 'connect' && !installing), onClick: () => run('disconnect', async () => { await api.disconnect(); return api.status(); }) }, '停止托管'),
            h('button', { className: 'dsh-ustc-btn', disabled: busy !== null, onClick: reload }, '刷新状态')),
          h('div', { className: 'dsh-ustc-row' },
            h('input', { className: 'dsh-ustc-input t', value: testHost, onChange: (e) => setTestHost(e.target.value), placeholder: '要测试的域名' }),
            h('button', { className: 'dsh-ustc-btn', disabled: busy !== null, onClick: doTest }, '测试分流'),
            testResult ? h('span', { className: 'dsh-ustc-hint' },
              testResult.host + ' → ' + (testResult.decision?.kind === 'iwan' ? '走 iWAN' : testResult.decision?.kind === 'upstream' ? '走上游代理' : '直连') +
              '（解析到 ' + ((testResult.resolvedIps || [])[0] || '无') + '）') : null),
        ),

        // iWAN 客户端：安装事实来自校验后的缓存，而不是本次下载进度。
        h('div', { className: 'dsh-ustc-group' },
          h('h3', null, 'iWAN 客户端（Windows x64）'),
          h('p', { className: 'dsh-ustc-hint' }, '当前：' + (binary.path || '未找到可执行文件') +
            (binary.version ? ' · ' + binary.version : downloaded ? ' · 版本未知' : binaryInstalled ? ' · 手动配置' : '')),
          h('div', { className: 'dsh-ustc-row' },
            h('button', { className: 'dsh-ustc-btn primary', disabled: downloadBlocked || binaryInstalled, onClick: () => installClient('download') },
              installing ? (maintenance.phase === 'preparing' ? '准备中…' : maintenance.phase === 'restoring' ? '恢复托管中…' : '下载中…') : downloaded ? '已下载' : binaryInstalled ? '已配置' : '下载 iwan-client-oidc'),
            binaryInstalled ? h('button', { className: 'dsh-ustc-btn', disabled: downloadBlocked, onClick: checkUpdates }, binary.checking || busy === 'checkUpdates' ? '检查中…' : '检查更新') : null,
            downloaded ? h('button', { className: 'dsh-ustc-btn', disabled: downloadBlocked, onClick: () => installClient('reinstall') }, '重新下载') : null,
            binaryInstalled && !downloaded ? h('button', { className: 'dsh-ustc-btn', disabled: downloadBlocked, onClick: () => installClient('reinstall') }, '下载缓存副本') : null,
            downloaded && binary.latestVersion && binary.updateAvailable !== false ? h('button', { className: 'dsh-ustc-btn primary', disabled: downloadBlocked, onClick: () => installClient('update') }, (binary.updateAvailable ? '更新到 ' : '安装最新版本 ') + binary.latestVersion) : null,
            installing && maintenance.phase !== 'restoring' ? h('button', { className: 'dsh-ustc-btn', disabled: busy !== null && busy !== 'download', onClick: cancelDownload }, '取消下载') : null),
          dl.state === 'downloading' ? h('div', { className: 'dsh-ustc-row' },
            h('div', { className: 'dsh-ustc-bar' }, h('div', { style: { width: Math.max(5, dlPct) + '%' } })),
            h('span', { className: 'dsh-ustc-hint' }, (dl.bytes / 1048576).toFixed(1) + ' MB' + (dl.total ? ' / ' + (dl.total / 1048576).toFixed(1) + ' MB' : ''))) : null,
          maintenance.phase === 'preparing' ? h('p', { className: 'dsh-ustc-hint' }, '正在停止托管进程并等待文件可替换…') : null,
          maintenance.phase === 'restoring' ? h('p', { className: 'dsh-ustc-hint' }, '客户端已就绪，正在恢复原托管状态…') : null,
          maintenance.error ? h('div', { className: 'dsh-ustc-error' }, '上次客户端操作：' + maintenance.error) : dl.state === 'error' ? h('div', { className: 'dsh-ustc-error' }, '上次下载失败：' + dl.error) : null,
          binary.updateError ? h('div', { className: 'dsh-ustc-error' }, '检查更新失败：' + binary.updateError) : null,
          binary.updateAvailable === false && !binary.updateError ? h('div', { className: 'dsh-ustc-ok' }, (binary.versionComparison > 0 ? '已安装更高版本，无需更新' : '已是最新版本') + (binary.latestVersion ? '（' + binary.latestVersion + '）' : '')) : null,
          downloaded && !installing ? h('p', { className: 'dsh-ustc-hint' }, savedAuth.state === 'valid' ? '客户端已就绪，当前连接的认证有效，无需重复登录。' : savedAuth.serverCount > 0 ? '客户端与认证配置已保存；托管连接成功后会显示认证有效。' : '客户端已就绪，请在下方完成统一身份认证。') : null,
          h('p', { className: 'dsh-ustc-hint' }, binary.kind === 'configured' ? '当前使用手动客户端；检查仅查询版本，下载仅管理插件缓存，不修改其他手动路径。' : '客户端保存在数据目录 cache/ustc-iwan/，不做系统安装。更新和重下会暂时停止插件托管并按原设置恢复。'),
        ),

        // 统一身份认证
        h('div', { className: 'dsh-ustc-group' },
          h('h3', null, '统一身份认证'),
          h('p', { className: 'dsh-ustc-hint' },
            '已保存的线路会自动识别；上游未保存认证有效期，只有本次托管连接确实通过认证时才显示有效。重新认证不会仅因刷新页面而触发。'),
          renderAuth(auth, { busy, startAuth, completeAuth, cancelAuth, redirectUrl, setRedirectUrl, installing, binaryInstalled, connect, refresh: reload, canConnect }),
        ),

        // 配置
        h('div', { className: 'dsh-ustc-group' },
          h('h3', null, '配置'),
          h(Row, { label: '启用分流' },
            h('input', { type: 'checkbox', checked: !!draft.enabled, onChange: (e) => set('enabled', e.target.checked) })),
          h(Row, { label: '分流代理端口', hint: '本地 HTTP 代理监听端口，修改后自动重启' },
            h('input', { className: 'dsh-ustc-input', type: 'number', style: { width: 100 }, value: draft.listenPort, onChange: (e) => set('listenPort', e.target.value) })),
          h(Row, { label: 'iWAN SOCKS 地址' },
            h('input', { className: 'dsh-ustc-input', value: draft.iwanSocksHost, onChange: (e) => set('iwanSocksHost', e.target.value) }),
            h('input', { className: 'dsh-ustc-input', type: 'number', style: { width: 90 }, value: draft.iwanSocksPort, onChange: (e) => set('iwanSocksPort', e.target.value) })),
          h(Row, { label: '托管 iWAN 客户端', hint: '新配置默认开启；客户端与认证配置就绪后自动连接，退出时结束。已保存的关闭选项保持不变' },
            h('input', { type: 'checkbox', checked: !!draft.manageClient, onChange: (e) => set('manageClient', e.target.checked) })),
          h(Row, { label: '客户端路径' },
            h('input', { className: 'dsh-ustc-input t', value: draft.iwanClientPath ?? '', placeholder: '留空则使用已下载的副本', onChange: (e) => set('iwanClientPath', e.target.value) })),
          h(Row, { label: '线路', hint: '留空时托管会自动选第一条（教育网）；可填序号 1-4 或名称关键词，如 电信' },
            h('input', { className: 'dsh-ustc-input t', value: draft.iwanServer ?? '', placeholder: '留空自动选教育网；或填 1 / 电信 / 教育网', onChange: (e) => set('iwanServer', e.target.value) })),
          h(Row, { label: '上游代理', hint: '非 USTC 流量的去处；留空自动沿用系统已有的 HTTP(S)_PROXY，再无则直连' },
            h('input', { className: 'dsh-ustc-input t', value: draft.upstreamProxy ?? '', placeholder: 'http://127.0.0.1:7890', onChange: (e) => set('upstreamProxy', e.target.value) })),
          h(Row, { label: 'USTC 网段' },
            h('textarea', { className: 'dsh-ustc-input t', rows: 4, value: draft.cidrs ?? '', onChange: (e) => set('cidrs', e.target.value) })),
          h(Row, { label: '域名后缀' },
            h('input', { className: 'dsh-ustc-input t', value: draft.domainSuffixes ?? '', onChange: (e) => set('domainSuffixes', e.target.value) })),
          h(Row, { label: 'DNS', hint: '本机解析用；留空用系统。托管启动 iWAN 时会另用校内 DNS（202.38.64.1）解析域名' },
            h('input', { className: 'dsh-ustc-input t', value: draft.dnsServer ?? '', placeholder: '留空用系统；TUN fake-ip 环境建议 223.5.5.5', onChange: (e) => set('dnsServer', e.target.value) })),
          h(Row, { label: '逐请求日志' },
            h('input', { type: 'checkbox', checked: !!draft.verbose, onChange: (e) => set('verbose', e.target.checked) })),
          h('div', { className: 'dsh-ustc-row' },
            h('button', { className: 'dsh-ustc-btn primary', disabled: busy !== null || installing, onClick: save }, busy === 'save' ? '保存中…' : '保存配置'),
            h('button', { className: 'dsh-ustc-btn', disabled: busy !== null || !dirty.current, onClick: () => { dirty.current = false; ++editVersion.current; setDraft({ ...status.settings }); } }, '放弃未保存修改'),
            dirty.current ? h('span', { className: 'dsh-ustc-hint' }, '有未保存的修改') : null),
        ),

        // 日志
        h('div', { className: 'dsh-ustc-group' },
          h('h3', null, '最近日志'),
          h('pre', { className: 'dsh-ustc-log' },
            (s.log ?? []).map((line) => new Date(line.at).toLocaleTimeString() + ' ' + line.msg).join('\n') || '（暂无）')),
      );
    }

    // ---------- 入口 ----------
    const inject = ['slots'];
    function report(message, cause) {
      const detail = cause && cause.message ? cause.message : String(cause ?? '');
      try { console.error('[ustc-iwan] ' + message + (detail ? '：' + detail : ''), cause); }
      catch { /* console 不可用时不再二次抛出 */ }
    }
    function apply(ctx) {
      // 失败必须可见：宿主会把「行失败」降级成一条启动警告，页面本身毫无提示。
      try {
        const slots = ctx && ctx.slots;
        if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
          report('未取得 slots 服务，设置卡片无法注册');
          return;
        }
        installStyle();
        // 与订阅服务/进展更新一致的延迟注册：settings.section 槽位族可能晚于本插件
        // 挂载，slots.inject 会在它出现（或重建）时回调注册，而不是只在 apply 时试一次。
        slots.inject("settings.section", () => {
          try {
            return slots.register({
              name: "settings.section",
              id: "ustc-iwan",
              order: 46,
              label: () => 'USTC iWAN',
            }, UstcIwanSection);
          } catch (cause) {
            report('注册设置卡片失败', cause);
            return () => {};
          }
        });
      } catch (cause) {
        report('apply 阶段失败', cause);
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
