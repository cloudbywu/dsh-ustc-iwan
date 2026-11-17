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
    const REQUEST_TIMEOUT_MS = 30000;
    async function request(url, init = {}) {
      const controller = new AbortController();
      const parent = init.signal;
      let timer, cancel;
      // fetch（含读取响应体）不一定遵守 abort，必须让调用方也有独立的完成边界。
      const cancelled = new Promise((_, reject) => {
        cancel = () => { reject(new Error('请求已取消')); controller.abort(); };
        timer = setTimeout(() => {
          reject(new Error('请求超时，请刷新状态后重试'));
          controller.abort();
        }, REQUEST_TIMEOUT_MS);
      });
      parent?.addEventListener('abort', cancel, { once: true });
      try {
        if (parent?.aborted) { cancel(); return await cancelled; }
        return await Promise.race([cancelled, (async () => {
          const response = await fetch(url, { ...init, signal: controller.signal, credentials: "same-origin" });
          const text = await response.text();
          let parsed;
          try { parsed = JSON.parse(text); } catch {
            throw new Error('宿主返回了无法解析的应答（HTTP ' + response.status + '），请查看宿主日志');
          }
          if (!response.ok || (parsed && parsed.ok === false)) throw new Error(parsed?.error || '操作失败（HTTP ' + response.status + '）');
          return parsed && parsed.ok ? parsed.value : parsed;
        })()]);
      } finally {
        clearTimeout(timer);
        parent?.removeEventListener('abort', cancel);
      }
    }
    function createApi(signal) {
      const post = (path, body) => request(API + path, { signal, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
      return {
        status: () => request(API + "/status", { signal }),
        settings: (patch) => post("/settings", patch),
        download: (mode = "download") => post("/download", { mode }),
        cancelDownload: () => post("/download/cancel", {}),
        checkUpdates: () => post("/update/check", {}),
        authStart: () => post("/auth/start", {}),
        authComplete: (id, redirectUrl) => post("/auth/complete", { id, redirectUrl }),
        authCancel: (id) => post("/auth/cancel", { id }),
        connect: () => post("/connect", {}),
        reconnect: () => post("/reconnect", {}),
        disconnect: () => post("/disconnect", {}),
        test: (host) => post("/test", { host }),
      };
    }

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
      .dsh-ustc-warn { color: #d97706; font-size: 12px; margin: 6px 0; }
      .dsh-ustc-guide { border: 0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.28)); border-radius: 9px; padding: 10px 12px; margin: 10px 0 12px; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.05)); }
      .dsh-ustc-guide-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
      .dsh-ustc-guide-title { font-size: 13px; font-weight: 600; }
      .dsh-ustc-steps { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
      .dsh-ustc-step { display: flex; align-items: flex-start; gap: 8px; }
      .dsh-ustc-badge { flex: 0 0 auto; font-size: 11px; line-height: 18px; padding: 0 7px; border-radius: 999px; border: 0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); opacity: .8; }
      .dsh-ustc-badge.done { color: #16a34a; border-color: rgba(22,163,74,.4); opacity: 1; }
      .dsh-ustc-badge.active { color: #2563eb; border-color: rgba(59,130,246,.5); opacity: 1; font-weight: 600; }
      .dsh-ustc-step-body { flex: 1 1 auto; min-width: 0; }
      .dsh-ustc-step-title { font-size: 12px; font-weight: 600; }
      .dsh-ustc-details { margin-top: 8px; padding-top: 6px; border-top: 0.5px dashed var(--dsw-alias-border-l2, rgba(128,128,128,.22)); }
      .dsh-ustc-details > summary { cursor: pointer; font-size: 12px; opacity: .8; padding: 4px 0; user-select: none; }
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
    function renderAuth(auth, { busy, startAuth, completeAuth, cancelAuth, redirectUrl, setRedirectUrl, installing, binaryInstalled, externalMode, externalOnline, connect, refresh, canConnect, copyAuthorizeUrl, copiedAuthUrl }) {
      const state = auth.state ?? 'idle';
      const saved = auth.credentials ?? { state: 'missing', serverCount: 0 };
      const canStart = auth.canStart ?? binaryInstalled;
      const blocked = busy !== null || installing || !canStart;
      const cancellingBlocked = busy !== null && !['authStart', 'authComplete'].includes(busy);
      if (state === 'awaiting') {
        const trimmed = redirectUrl.trim();
        const isHttpUrl = /^https?:\/\//i.test(trimmed);
        const isMalformed = trimmed.length > 0 && !isHttpUrl && (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || /[\s\r\n\0]/.test(trimmed));
        const submitBlocked = busy !== null || !trimmed || isHttpUrl || isMalformed;
        return h('div', null,
          h('p', { className: 'dsh-ustc-hint' }, '① 在浏览器中打开统一身份认证页面并完成校内登录：'),
          h('div', { className: 'dsh-ustc-row' },
            h('a', { className: 'dsh-ustc-link', href: auth.authorizeUrl, target: '_blank', rel: 'noreferrer noopener' }, '打开统一身份认证页面 ↗'),
            h('button', { className: 'dsh-ustc-btn', type: 'button', onClick: copyAuthorizeUrl }, copiedAuthUrl ? '已复制链接' : '复制授权链接')),
          h('div', { className: 'dsh-ustc-url' }, auth.authorizeUrl),
          h('p', { className: 'dsh-ustc-hint' }, '② 登录成功后会跳转到 com.panabit.mobile:// 开头的地址（若浏览器提示“无法打开此链接”或询问是否打开应用，取消弹窗并复制浏览器地址栏中的完整链接即可），粘贴到下方：'),
          h('div', { className: 'dsh-ustc-row' },
            h('input', {
              className: 'dsh-ustc-input t',
              value: redirectUrl,
              placeholder: 'com.panabit.mobile://oauth2redirect?code=…',
              onChange: (e) => setRedirectUrl(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter' && !submitBlocked) completeAuth(); },
            }),
            h('button', { className: 'dsh-ustc-btn primary', disabled: submitBlocked, onClick: completeAuth }, busy === 'authComplete' ? '提交中…' : '完成认证'),
            h('button', { className: 'dsh-ustc-btn', disabled: cancellingBlocked, onClick: cancelAuth }, '取消认证')),
          isHttpUrl ? h('p', { className: 'dsh-ustc-warn' }, '你粘贴的是网页登录地址（http/https），请改贴登录跳转后 com.panabit.mobile:// 开头的完整回调链接。') : null,
          isMalformed ? h('p', { className: 'dsh-ustc-warn' }, '回调链接格式无效，应为 com.panabit.mobile://oauth2redirect?code=… 形式的单行完整地址。') : null);
      }
      if (state === 'starting' || state === 'submitting') {
        return h('div', null,
          h('p', { className: 'dsh-ustc-hint' }, state === 'starting' ? '正在获取授权地址，请稍候…' : '正在向校内服务器换取线路配置，完成后将按托管设置自动连接…'),
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
        !binaryInstalled ? h('p', { className: 'dsh-ustc-hint' }, externalOnline ? '当前已有外部 iWAN 客户端在线；如需由插件托管认证，请先下载客户端或配置路径。' : externalMode ? '此前检测到外部 iWAN 客户端，当前端口已离线；请启动外部客户端，如需改由插件托管认证，请先下载客户端或配置路径。' : '请先下载客户端或配置可信的客户端路径。') : null,
        h('div', { className: 'dsh-ustc-row' },
          h('button', { className: 'dsh-ustc-btn' + (!stored ? ' primary' : ''), disabled: blocked, onClick: startAuth }, stored || state === 'done' ? '重新认证' : '开始认证'),
          stored && !valid ? h('button', { className: 'dsh-ustc-btn', disabled: !canConnect || busy !== null, onClick: connect }, '连接并验证') : null,
          h('button', { className: 'dsh-ustc-btn', disabled: busy !== null, onClick: refresh }, '刷新认证状态')));
    }

    /** 首次使用与排障指引：按当前就绪度高亮下一步，完全就绪后自动收起。 */
    function renderOnboarding({ status, binaryInstalled, installing, authenticating, savedAuth, externalMode, externalOnline, showGuide, toggleGuide }) {
      const s = status;
      const hasSavedAuth = savedAuth.serverCount > 0 && !['missing', 'invalid', 'expired'].includes(savedAuth.state);
      const step1Done = binaryInstalled || externalOnline;
      const step2Done = externalOnline || hasSavedAuth;
      const step3Done = Boolean(s.settings.enabled && s.proxy.listening && (s.iwan.socksAlive || (s.iwan.managed && savedAuth.state === 'valid')));
      const completedCount = (step1Done ? 1 : 0) + (step2Done ? 1 : 0) + (step3Done ? 1 : 0);
      const needsGuide = !s.settings.enabled || !step1Done || !step2Done || !step3Done;
      const headerTitle = !s.settings.enabled
        ? '使用指引 · 分流已停用'
        : !needsGuide
          ? '使用指引 · 已就绪'
          : '首次使用指引（已完成 ' + completedCount + '/3 步）';
      const stepBadge = (done, active, labelDone, labelActive, labelPending) =>
        h('span', { className: 'dsh-ustc-badge' + (done ? ' done' : active ? ' active' : '') }, done ? labelDone : active ? labelActive : labelPending);
      return h('div', { className: 'dsh-ustc-guide' },
        h('div', { className: 'dsh-ustc-guide-head' },
          h('span', { className: 'dsh-ustc-guide-title' }, headerTitle),
          h('button', { className: 'dsh-ustc-link', type: 'button', onClick: toggleGuide }, showGuide ? '收起指引' : '查看指引')),
        showGuide ? h('div', null,
          !s.settings.enabled ? h('p', { className: 'dsh-ustc-warn' }, '当前「启用分流」已关闭，插件不会拦截流量。请在下方「配置」中勾选「启用分流」并保存。') : null,
          h('ul', { className: 'dsh-ustc-steps' },
            h('li', { className: 'dsh-ustc-step' },
              stepBadge(step1Done, !step1Done, externalOnline && !binaryInstalled ? '外部在线' : '已完成', installing ? '下载中' : externalMode && !binaryInstalled ? '外部离线' : '当前步骤', '待完成'),
              h('div', { className: 'dsh-ustc-step-body' },
                h('div', { className: 'dsh-ustc-step-title' }, '1. 准备 iWAN 客户端'),
                h('div', { className: 'dsh-ustc-hint' }, step1Done
                  ? (externalOnline && !binaryInstalled ? '已检测到外部 iWAN SOCKS5 在线，可直接分流使用。' : '客户端已准备就绪。')
                  : externalMode
                    ? '检测到此前使用外部 iWAN 客户端，但当前 SOCKS5 端口离线；请启动外部 Panabit iWAN 客户端，或在下方下载/配置插件客户端。'
                    : '在下方「iWAN 客户端」点击下载按钮自动获取客户端（仅存放在插件缓存目录，不做系统安装）；若本机已安装或已启动 Panabit iWAN，也可在「配置」填入路径或直接保持外部客户端运行。'))),
            h('li', { className: 'dsh-ustc-step' },
              stepBadge(step2Done, step1Done && !step2Done, externalOnline && !hasSavedAuth ? '外部管理' : '已完成', authenticating ? '认证中' : '当前步骤', '待第 1 步'),
              h('div', { className: 'dsh-ustc-step-body' },
                h('div', { className: 'dsh-ustc-step-title' }, '2. 完成中国科大统一身份认证'),
                h('div', { className: 'dsh-ustc-hint' }, step2Done
                  ? (hasSavedAuth ? '本地已保存加密线路配置，后续无需重复登录。' : '当前由外部 iWAN 客户端管理认证，无需在插件内重复登录。')
                  : '在「统一身份认证」点「开始认证」并在浏览器登录校内账号；登录后浏览器会跳转到 com.panabit.mobile:// 回调地址（若提示无法打开或询问打开应用，取消弹窗并复制地址栏完整链接），粘贴回输入框提交即可。'))),
            h('li', { className: 'dsh-ustc-step' },
              stepBadge(step3Done, step1Done && step2Done && !step3Done, '已在线', s.iwan.connecting ? '连接中' : '当前步骤', '待前两步'),
              h('div', { className: 'dsh-ustc-step-body' },
                h('div', { className: 'dsh-ustc-step-title' }, '3. 启动连接并验证分流'),
                h('div', { className: 'dsh-ustc-hint' }, step3Done
                  ? '分流代理与 iWAN 通道均已在线，可直接使用科大模型与校内站点。'
                  : (externalMode && !externalOnline
                    ? '当前外部 iWAN 客户端已离线，请先启动外部客户端；若已安装插件客户端并完成认证，也可在「运行状态」点击「启动 iWAN」切换为插件托管。随后在「测试分流」输入 llm.ustc.edu.cn，显示「走 iWAN」表示规则命中，还需确认 SOCKS 在线并实际访问目标。'
                    : '新配置默认开启「托管 iWAN 客户端」，前两步完成后会自动连接；也可在「运行状态」手动点击启动，随后在「测试分流」输入 llm.ustc.edu.cn，显示「走 iWAN」表示规则命中，还需确认 SOCKS 在线并实际访问目标。'))))),
          h('p', { className: 'dsh-ustc-hint', style: { marginTop: '8px' } }, '提示：若同时运行 Clash TUN、WireGuard 等代理软件，只需保持默认分流配置；非科大流量会自动走「上游代理」或直连，无需关闭现有代理。')) : null);
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
      const [guideOpen, setGuideOpen] = React.useState(null);
      const [advOpen, setAdvOpen] = React.useState(null);
      const [copiedAuthUrl, setCopiedAuthUrl] = React.useState(false);
      const dirty = React.useRef(false);
      const editVersion = React.useRef(0);
      const operationVersion = React.useRef(0);
      const copyVersion = React.useRef(0);
      const pollVersion = React.useRef(0);
      const busyRef = React.useRef(null);
      const statusRef = React.useRef(null);
      const mounted = React.useRef(false);
      const pollRequest = React.useRef(null);
      const operationRequest = React.useRef(null);

      statusRef.current = status;
      const apply = React.useCallback((next) => {
        statusRef.current = next;
        setStatus(next);
        if (next?.settings && !dirty.current) setDraft({ ...next.settings });
      }, []);
      const reload = React.useCallback(async (force = false) => {
        if (!mounted.current || (pollRequest.current && !force)) return;
        const operation = operationVersion.current;
        const poll = ++pollVersion.current;
        // 普通轮询 single-flight；唤醒/手动刷新才替换休眠前可能挂起的请求。
        pollRequest.current?.abort();
        const controller = new AbortController();
        pollRequest.current = controller;
        // 等待授权 URL 的 POST 可能长时间不完成，必须靠状态轮询取得会话 ID 才能取消。
        // 保存等其他操作仍保留屏障；操作结束后版本递增，期间发出的响应也不再落地。
        const current = () => mounted.current
          && (busyRef.current === null || ['authStart', 'authComplete'].includes(busyRef.current))
          && operation === operationVersion.current && poll === pollVersion.current;
        try {
          const next = await createApi(controller.signal).status();
          if (!current()) return;
          apply(next);
          setError(null);
        } catch (cause) {
          if (current()) setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          if (pollRequest.current === controller) pollRequest.current = null;
        }
      }, [apply]);
      React.useEffect(() => {
        mounted.current = true;
        let hidden = document.visibilityState === 'hidden';
        const resume = () => { reload(true); };
        const visibility = () => {
          const nextHidden = document.visibilityState === 'hidden';
          if (hidden && !nextHidden) resume();
          hidden = nextHidden;
        };
        window.addEventListener('focus', resume);
        window.addEventListener('online', resume);
        document.addEventListener('visibilitychange', visibility);
        reload();
        return () => {
          mounted.current = false;
          ++operationVersion.current;
          ++copyVersion.current;
          ++pollVersion.current;
          pollRequest.current?.abort();
          operationRequest.current?.abort();
          busyRef.current = null;
          window.removeEventListener('focus', resume);
          window.removeEventListener('online', resume);
          document.removeEventListener('visibilitychange', visibility);
        };
      }, [reload]);
      React.useEffect(() => {
        // 下载中或认证等待中都需要更密的轮询，好让进度与结果及时反映出来。
        const active = status?.download?.state === 'downloading'
          || status?.auth?.state === 'starting'
          || status?.auth?.state === 'awaiting'
          || status?.auth?.state === 'submitting'
          || status?.maintenance?.running
          || status?.binary?.checking
          || status?.iwan?.connecting
          || status?.iwan?.stopping
          || ['checking', 'waiting', 'recovering'].includes(status?.recovery?.state);
        const timer = setInterval(() => { reload(); }, active ? 1500 : 10000);
        return () => clearInterval(timer);
      }, [reload, status?.download?.state, status?.auth?.state, status?.maintenance?.running, status?.binary?.checking, status?.iwan?.connecting, status?.iwan?.stopping, status?.recovery?.state]);

      const run = React.useCallback(async (label, action) => {
        if (busyRef.current !== null && !(label === 'authCancel' && ['authStart', 'authComplete'].includes(busyRef.current)) && !(label === 'disconnect' && ['connect', 'checkUpdates'].includes(busyRef.current)) && !(label === 'cancelDownload' && busyRef.current === 'download')) return;
        if (!mounted.current) return;
        const operation = ++operationVersion.current;
        ++pollVersion.current;
        pollRequest.current?.abort();
        operationRequest.current?.abort();
        const controller = new AbortController();
        operationRequest.current = controller;
        const current = () => mounted.current && operation === operationVersion.current;
        busyRef.current = label;
        setBusy(label); setError(null); setNotice(null);
        try {
          const next = await action(current, createApi(controller.signal));
          if (current() && next) apply(next);
        } catch (cause) {
          if (current()) setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
          if (current()) {
            operationRequest.current = null;
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
      const save = () => {
        if (busyRef.current !== null || status?.maintenance?.running === true || status?.download?.state === 'downloading') return;
        const listenPort = Number(String(draft?.listenPort ?? '').trim());
        const socksPort = Number(String(draft?.iwanSocksPort ?? '').trim());
        const socksHost = String(draft?.iwanSocksHost ?? '').trim();
        const upstreamProxy = String(draft?.upstreamProxy ?? '').trim();
        if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
          setNotice(null);
          setError('「分流代理端口」必须是 1–65535 之间的整数');
          return;
        }
        if (!socksHost) {
          setNotice(null);
          setError('「iWAN SOCKS 地址」不能为空');
          return;
        }
        if (!Number.isInteger(socksPort) || socksPort < 1 || socksPort > 65535) {
          setNotice(null);
          setError('「iWAN SOCKS 端口」必须是 1–65535 之间的整数');
          return;
        }
        if (upstreamProxy) {
          let validProxy = /^https?:\/\/(?:[^@\s]+@)?(?:\[[^\]]+\]|[^\s:/?#]+)(?::\d{1,5})?(?:\/[^\s]*)?$/i.test(upstreamProxy);
          if (validProxy && typeof URL === 'function') {
            try {
              const parsed = new URL(upstreamProxy);
              validProxy = ['http:', 'https:'].includes(parsed.protocol) && Boolean(parsed.hostname);
            } catch { validProxy = false; }
          }
          if (!validProxy) {
            setNotice(null);
            setError('「上游代理」格式应为 http://host:port 或 https://host:port');
            return;
          }
        }
        return run('save', async (current, api) => {
          const version = editVersion.current;
          const patch = {
            ...draft,
            listenPort,
            iwanSocksHost: socksHost,
            iwanSocksPort: socksPort,
            iwanClientPath: String(draft.iwanClientPath ?? '').trim(),
            iwanServer: String(draft.iwanServer ?? '').trim(),
            upstreamProxy,
            dnsServer: String(draft.dnsServer ?? '').trim(),
          };
          const next = await api.settings(patch);
          if (!current()) return;
          if (version === editVersion.current) dirty.current = false;
          setNotice(dirty.current ? '已保存提交的配置；当前仍有未保存修改' : '配置已保存并即时生效');
          return next;
        });
      };
      const normalizeTestHost = (raw) => {
        let value = String(raw ?? '').trim();
        if (!value) return '';
        value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
        value = value.split(/[/?#]/)[0];
        if (value.includes('@')) value = value.slice(value.lastIndexOf('@') + 1);
        if (value.startsWith('[')) {
          const end = value.indexOf(']');
          return end > 0 ? value.slice(1, end) : value;
        }
        return value.replace(/:\d+$/, '');
      };
      const doTest = () => {
        const host = normalizeTestHost(testHost);
        if (!host) {
          setNotice(null);
          setError('请输入要测试的域名，例如 llm.ustc.edu.cn');
          return;
        }
        return run('test', async (current, api) => {
          const result = await api.test(host);
          if (current()) setTestResult(result);
          return null;
        });
      };
      const copyAuthorizeUrl = async () => {
        const auth = statusRef.current?.auth;
        const url = auth?.authorizeUrl;
        const authId = auth?.id ?? null;
        if (!url) return;
        const copySeq = ++copyVersion.current;
        const opVersion = operationVersion.current;
        const stillCurrent = () => mounted.current
          && copySeq === copyVersion.current
          && opVersion === operationVersion.current
          && statusRef.current?.auth?.state === 'awaiting'
          && (statusRef.current?.auth?.id ?? null) === authId
          && statusRef.current?.auth?.authorizeUrl === url;
        try {
          if (typeof navigator !== 'undefined' && navigator?.clipboard?.writeText) {
            await navigator.clipboard.writeText(url);
            if (!stillCurrent()) return;
            setCopiedAuthUrl(true);
            setError(null);
            setNotice('已复制授权链接，请在浏览器中打开并登录');
            return;
          }
        } catch {}
        if (!stillCurrent()) return;
        setNotice(null);
        setError('当前环境不支持自动复制，请手动选中下方授权链接复制');
      };
      const startAuth = () => {
        ++copyVersion.current;
        return run('authStart', async (current, api) => {
          setRedirectUrl('');
          setCopiedAuthUrl(false);
          setStatus((s) => {
            const next = { ...s, auth: { state: 'starting', id: null } };
            statusRef.current = next;
            return next;
          });
          await api.authStart();
          return api.status();
        });
      };
      const completeAuth = () => {
        ++copyVersion.current;
        return run('authComplete', async (current, api) => {
          const auth = status?.auth ?? {};
          await api.authComplete(auth.id, redirectUrl.trim());
          if (!current()) return;
          setRedirectUrl('');
          setCopiedAuthUrl(false);
          setNotice('已提交回调链接，正在向校内服务器换取线路配置…');
          return api.status();
        });
      };
      const cancelAuth = () => {
        ++copyVersion.current;
        return run('authCancel', async (current, api) => {
          const auth = status?.auth ?? {};
          await api.authCancel(auth.id);
          setCopiedAuthUrl(false);
          if (current()) setNotice('已取消当前认证');
          return api.status();
        });
      };

      const connect = () => run('connect', async (current, api) => {
        await api.connect();
        const next = await api.status();
        if (current()) setNotice(next?.iwan?.managed ? 'iWAN 客户端已启动并在线' : next?.iwan?.socksAlive ? '检测到外部 iWAN 客户端已在线' : '已发起 iWAN 连接');
        return next;
      });
      const reconnect = () => run('connect', async (current, api) => {
        await api.reconnect();
        const next = await api.status();
        if (current()) setNotice('iWAN 客户端已重新连接');
        return next;
      });
      const installClient = (mode) => run('download', async (current, api) => {
        const result = await api.download(mode);
        if (result.error) throw new Error(result.error);
        if (current()) setNotice(result.started ? '客户端维护已开始，完成后将按原托管设置恢复' : (result.reason || '客户端已就绪'));
        return api.status();
      });
      const cancelDownload = () => run('cancelDownload', async (current, api) => {
        await api.cancelDownload();
        if (current()) setNotice('已取消客户端下载');
        return api.status();
      });
      const checkUpdates = () => run('checkUpdates', async (current, api) => {
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
      const recovery = s.recovery ?? {};
      const recoveryActive = ['checking', 'waiting', 'recovering'].includes(recovery.state);
      const externalMode = recovery.state === 'external' && !s.iwan.managed;
      const externalOnline = Boolean(s.iwan.socksAlive && !s.iwan.managed);
      const connectionReady = Boolean(s.settings.enabled && binaryInstalled && !installing && !authenticating &&
        savedAuth.serverCount > 0 && ['valid', 'unknown'].includes(savedAuth.state));
      const canConnect = connectionReady && recovery.state !== 'recovering' &&
        !s.iwan.managed && !s.iwan.socksAlive && !s.iwan.connecting && !s.iwan.stopping;
      const canReconnect = connectionReady && !binary.checking && !externalMode && !externalOnline && recovery.state !== 'recovering' &&
        !s.iwan.connecting && !s.iwan.stopping;
      const recoveryLabel = {
        idle: '自动恢复待命', checking: '正在检查 SOCKS 连接…', healthy: 'SOCKS 端口检查正常',
        waiting: '等待网络，稍后自动重试', recovering: '正在自动重新连接…',
        paused: '自动重连已暂停', external: '外部客户端，不干预', blocked: '自动重连受阻',
      }[recovery.state];
      const nativeReconnecting = Boolean(s.iwan.nativeReconnect && recovery.state === 'waiting' && recovery.reason?.includes('自行重连'));
      const connectLabel = nativeReconnecting ? '客户端重连中…' : s.iwan.stopping ? '停止中…' : s.iwan.connecting || busy === 'connect' ? '启动中…' : s.iwan.managed ? '托管运行中' : s.iwan.socksAlive ? '外部客户端在线' : '启动 iWAN';
      const downloadBlocked = busy !== null || installing || authenticating || binary.checking;
      const dlPct = dl.total ? Math.min(100, Math.round((dl.bytes / dl.total) * 100)) : (dl.state === 'downloading' ? 0 : 100);
      const step1Done = binaryInstalled || externalOnline;
      const step2Done = externalOnline || (savedAuth.serverCount > 0 && !['missing', 'invalid', 'expired'].includes(savedAuth.state));
      const step3Done = Boolean(s.settings.enabled && s.proxy.listening && (s.iwan.socksAlive || (s.iwan.managed && savedAuth.state === 'valid')));
      const needsGuide = !s.settings.enabled || !step1Done || !step2Done || !step3Done;
      const showGuide = guideOpen === null ? needsGuide : guideOpen;
      const hasCustomAdvanced = Boolean(
        (draft.iwanClientPath ?? '').trim()
        || (draft.dnsServer ?? '').trim()
        || draft.verbose
        || Number(draft.listenPort) !== 18118
        || (draft.iwanSocksHost ?? '127.0.0.1') !== '127.0.0.1'
        || Number(draft.iwanSocksPort) !== 1080
      );
      const showAdv = advOpen === null ? hasCustomAdvanced : advOpen;
      const connectBlockedHint = (!s.iwan.managed && !s.iwan.socksAlive && !s.iwan.connecting && !s.iwan.stopping)
        ? (!s.settings.enabled ? '当前无法启动：分流总开关已关闭，请在下方开启「启用分流」并保存。'
          : installing ? '当前无法启动：客户端正在下载或维护，完成后将按设置处理。'
          : !binaryInstalled ? (externalMode
            ? '当前无法启动：外部客户端已离线且插件尚未准备客户端，请启动外部 iWAN 客户端或在下方下载/配置路径。'
            : '当前无法启动：尚未准备 iWAN 客户端，请先在下方下载或配置路径。')
          : authenticating ? '当前无法启动：正在进行统一身份认证，请先完成或取消。'
          : (savedAuth.serverCount === 0 || !['valid', 'unknown'].includes(savedAuth.state)) ? (externalMode
            ? '当前无法启动：外部客户端已离线且尚未完成插件认证，请启动外部客户端或在下方完成认证。'
            : '当前无法启动：尚未完成有效的统一身份认证，请先在下方完成认证。')
          : s.iwan.paused ? '已手动暂停自动托管；点击「启动 iWAN」可立即恢复连接。'
          : externalMode ? '此前检测到外部客户端，当前端口已离线；可重新启动外部客户端，或直接点击「启动 iWAN」改由插件托管。'
          : null)
        : null;
      const configuredPathMissing = Boolean((s.settings.iwanClientPath ?? '').trim() && !binaryInstalled);

      return h('div', { className: 'dsh-ustc-card' },
        h('p', { className: 'dsh-ustc-hint' },
          '访问科大模型与校内网站时自动走 ustc-iwan，其余流量保持原样；与 Clash TUN、WireGuard、Panabit iWAN 共存。'),
        error ? h('div', { className: 'dsh-ustc-error' }, error) : null,
        notice ? h('div', { className: 'dsh-ustc-ok' }, notice) : null,

        renderOnboarding({
          status: s,
          binaryInstalled,
          installing,
          authenticating,
          savedAuth,
          externalMode,
          externalOnline,
          showGuide,
          toggleGuide: () => setGuideOpen(!showGuide),
        }),

        // 运行状态
        h('div', { className: 'dsh-ustc-group' },
          h('h3', null, '运行状态'),
          h('div', { className: 'dsh-ustc-row' }, h('label', null, '分流代理'),
            h(Dot, { on: s.proxy.listening, label: s.proxy.listening ? '运行中（127.0.0.1:' + s.proxy.port + '）' : '未运行' }),
            h(Dot, { on: s.policyInstalled, label: '出站策略' + (s.policyInstalled ? '已生效' : '未生效') })),
          h('div', { className: 'dsh-ustc-row' }, h('label', null, 'iWAN SOCKS5'),
            h(Dot, { on: s.iwan.socksAlive, label: s.settings.iwanSocksHost + ':' + s.settings.iwanSocksPort + (s.iwan.socksAlive ? '（在线）' : '（离线）') }),
            h(Dot, { on: s.iwan.managed, label: s.iwan.managed ? '插件托管中' : '无托管进程' })),
          recoveryLabel ? h('div', { className: 'dsh-ustc-hint', role: 'status' },
            recoveryLabel,
            recovery.attempts > 0 ? ' · 已尝试 ' + recovery.attempts + ' 次' : '',
            recovery.state === 'waiting' && recovery.nextRetryAt ? ' · 下次重试：' + new Date(recovery.nextRetryAt).toLocaleTimeString() : '',
            recovery.reason ? ' · ' + recovery.reason : '') : null,
          recovery.lastError ? h('div', { className: 'dsh-ustc-error' }, '最近恢复错误：' + recovery.lastError) : null,
          h('div', { className: 'dsh-ustc-row' },
            h('button', { className: 'dsh-ustc-btn primary', disabled: busy !== null || !canConnect, onClick: connect }, connectLabel),
            h('button', { className: 'dsh-ustc-btn', disabled: busy !== null || !canReconnect, onClick: reconnect }, '重新连接'),
            h('button', { className: 'dsh-ustc-btn', disabled: (busy !== null && !['connect', 'checkUpdates'].includes(busy)) || (!s.iwan.managed && !s.iwan.connecting && busy !== 'connect' && !installing && !recoveryActive), onClick: () => run('disconnect', async (current, api) => { await api.disconnect(); const next = await api.status(); if (current()) setNotice('已停止插件托管的 iWAN 客户端'); return next; }) }, '停止托管'),
            h('button', { className: 'dsh-ustc-btn', disabled: busy !== null, onClick: () => reload(true) }, '刷新状态')),
          connectBlockedHint ? h('p', { className: 'dsh-ustc-hint' }, connectBlockedHint) : null,
          h('div', { className: 'dsh-ustc-row' },
            h('input', {
              className: 'dsh-ustc-input t',
              value: testHost,
              onChange: (e) => setTestHost(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter' && busy === null && testHost.trim()) doTest(); },
              placeholder: '输入要测试的域名或网址，如 llm.ustc.edu.cn',
            }),
            h('button', { className: 'dsh-ustc-btn', disabled: busy !== null || !testHost.trim(), onClick: doTest }, busy === 'test' ? '测试中…' : '测试分流'),
            testResult ? h('span', { className: 'dsh-ustc-hint' },
              testResult.host + ' → ' + (testResult.decision?.kind === 'iwan' ? '走 iWAN' : testResult.decision?.kind === 'upstream' ? '走上游代理' : '直连') +
              (testResult.resolvedIps && testResult.resolvedIps.length ? '（解析到 ' + testResult.resolvedIps.join(', ') + '）' : '（未解析到 IPv4，按域名后缀判定）') +
              (testResult.decision?.kind === 'iwan' && !s.iwan.socksAlive ? ' · 注意：当前 iWAN SOCKS5 离线，实际请求将暂回退直连' : '') +
              (!s.settings.enabled ? ' · 注意：当前「启用分流」已关闭' : '')) : null),
        ),

        // iWAN 客户端：安装事实来自校验后的缓存，而不是本次下载进度。
        h('div', { className: 'dsh-ustc-group' },
          h('h3', null, 'iWAN 客户端（Windows x64）'),
          h('p', { className: 'dsh-ustc-hint' }, '当前：' + (binary.path || '未找到可执行文件') +
            (binary.version ? ' · ' + binary.version : downloaded ? ' · 版本未知' : binaryInstalled ? ' · 手动配置' : '')),
          configuredPathMissing ? h('div', { className: 'dsh-ustc-error' }, '配置的「客户端路径」不可用或文件不存在，请检查路径或清空后使用自动下载。') : null,
          !configuredPathMissing && binary.error && !String(binary.error).startsWith('尚未配置') ? h('div', { className: 'dsh-ustc-error' }, binary.error) : null,
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
            '首次使用需完成一次校内登录以保存加密线路配置；上游不提供离线有效期，仅在本次托管连接在线验证后显示「认证有效」，刷新页面不会触发重连或重登。'),
          renderAuth(auth, { busy, startAuth, completeAuth, cancelAuth, redirectUrl, setRedirectUrl, installing, binaryInstalled, externalMode, externalOnline, connect, refresh: () => reload(true), canConnect, copyAuthorizeUrl, copiedAuthUrl }),
        ),

        // 配置
        h('div', { className: 'dsh-ustc-group' },
          h('h3', null, '配置'),
          h(Row, { label: '启用分流', hint: '关闭后插件不再介入或转发词元工坊的出站请求' },
            h('input', { type: 'checkbox', checked: !!draft.enabled, onChange: (e) => set('enabled', e.target.checked) })),
          h(Row, { label: '托管 iWAN 客户端', hint: '新配置默认开启；客户端与认证配置就绪后自动连接，退出时结束。已保存的关闭选项保持不变' },
            h('input', { type: 'checkbox', checked: !!draft.manageClient, onChange: (e) => set('manageClient', e.target.checked) })),
          h(Row, { label: '线路', hint: '留空时托管会自动选第一条（教育网）；可填序号 1-4 或名称关键词，如 电信' },
            h('input', { className: 'dsh-ustc-input t', value: draft.iwanServer ?? '', placeholder: '留空自动选教育网；或填 1 / 电信 / 教育网', onChange: (e) => set('iwanServer', e.target.value) })),
          h(Row, { label: '上游代理', hint: '非 USTC 流量的去处；留空自动沿用系统已有的 HTTP(S)_PROXY，再无则直连' },
            h('input', { className: 'dsh-ustc-input t', value: draft.upstreamProxy ?? '', placeholder: 'http://127.0.0.1:7890', onChange: (e) => set('upstreamProxy', e.target.value) })),
          h('div', { className: 'dsh-ustc-details' },
            h('button', { className: 'dsh-ustc-link', type: 'button', onClick: () => setAdvOpen(!showAdv) },
              (showAdv ? '▾ 收起高级设置' : '▸ 展开高级设置') + '（端口、客户端路径、网段、域名后缀、DNS、日志，通常保持默认即可）'),
            h('div', { style: showAdv ? null : { display: 'none' } },
              h(Row, { label: '分流代理端口', hint: '本地 HTTP 代理监听端口（1–65535），修改保存后自动重启' },
                h('input', { className: 'dsh-ustc-input', type: 'number', style: { width: 100 }, value: draft.listenPort, onChange: (e) => set('listenPort', e.target.value) })),
              h(Row, { label: 'iWAN SOCKS 地址', hint: '本地 iWAN 客户端（或外部客户端）监听的 SOCKS5 地址与端口' },
                h('input', { className: 'dsh-ustc-input', value: draft.iwanSocksHost, onChange: (e) => set('iwanSocksHost', e.target.value) }),
                h('input', { className: 'dsh-ustc-input', type: 'number', style: { width: 90 }, value: draft.iwanSocksPort, onChange: (e) => set('iwanSocksPort', e.target.value) })),
              h(Row, { label: '客户端路径', hint: '仅在使用自己准备的 exe 时填写；自动下载的副本留空即可' },
                h('input', { className: 'dsh-ustc-input t', value: draft.iwanClientPath ?? '', placeholder: '留空则使用已下载的副本', onChange: (e) => set('iwanClientPath', e.target.value) })),
              h(Row, { label: 'USTC 网段', hint: '每行或逗号分隔一个 CIDR；目标 IPv4 命中后自动走 iWAN' },
                h('textarea', { className: 'dsh-ustc-input t', rows: 4, value: draft.cidrs ?? '', onChange: (e) => set('cidrs', e.target.value) })),
              h(Row, { label: '域名后缀', hint: '逗号分隔；在 TUN / fake-ip 模式下用于兜底识别校内域名' },
                h('input', { className: 'dsh-ustc-input t', value: draft.domainSuffixes ?? '', onChange: (e) => set('domainSuffixes', e.target.value) })),
              h(Row, { label: 'DNS', hint: '本机解析用；留空用系统。托管启动 iWAN 时会另用校内 DNS（202.38.64.1）解析域名' },
                h('input', { className: 'dsh-ustc-input t', value: draft.dnsServer ?? '', placeholder: '留空用系统；TUN fake-ip 环境建议 223.5.5.5', onChange: (e) => set('dnsServer', e.target.value) })),
              h(Row, { label: '逐请求日志', hint: '开启后会在下方日志记录每个域名的分流判定依据（排错用）' },
                h('input', { type: 'checkbox', checked: !!draft.verbose, onChange: (e) => set('verbose', e.target.checked) })))),
          h('div', { className: 'dsh-ustc-row' },
            h('button', { className: 'dsh-ustc-btn primary', disabled: busy !== null || installing, onClick: save }, busy === 'save' ? '保存中…' : '保存配置'),
            h('button', { className: 'dsh-ustc-btn', disabled: busy !== null || !dirty.current, onClick: () => { dirty.current = false; ++editVersion.current; setError(null); setNotice('已放弃未保存的修改'); setDraft({ ...status.settings }); } }, '放弃未保存修改'),
            dirty.current ? h('span', { className: 'dsh-ustc-warn' }, '有未保存的修改（点击「保存配置」后生效）') : null),
        ),

        // 日志
        h('div', { className: 'dsh-ustc-group' },
          h('h3', null, '最近日志'),
          h('p', { className: 'dsh-ustc-hint' }, '显示最近 40 条运行与诊断日志。'),
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
