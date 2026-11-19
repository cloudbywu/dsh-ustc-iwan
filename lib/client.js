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
          if (!response.ok || (parsed && parsed.ok === false)) {
            const error = new Error(parsed?.error || '操作失败（HTTP ' + response.status + '）');
            error.status = response.status;
            throw error;
          }
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

    const CLASH_TUN_API = API + '/clash-tun';
    function requestClashTun(signal, kind, confirmation) {
      const browser = { signal, mode: 'same-origin' };
      const headers = { 'X-USTC-IWAN-TUN': '1' };
      if (kind === 'inspect') return request(CLASH_TUN_API, { ...browser, headers, method: 'GET', referrerPolicy: 'same-origin', cache: 'no-store' });
      const { mode, revision } = confirmation;
      return request(CLASH_TUN_API + '/' + kind, {
        ...browser, method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(kind === 'apply' ? { mode, revision } : { revision }),
      });
    }

    // 与服务端的 IP / CIDR 校验保持一致：DNS 只能填写字面 IP，不接受域名。
    const cidrTokens = (value) => String(value ?? '').split(/[\s,]+/).filter(Boolean);
    const ipv4 = (value) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) && value.split('.').every((part) => Number(part) <= 255);
    const dnsIpv4 = (value) => ipv4(value) && value.split('.').every((part) => part === String(Number(part)));
    function dnsIpv6(value) {
      // URL 的 IPv6 主机解析遵循标准文法（含 IPv4 尾缀），不会发送请求。
      if (!/^[\da-f:.]+$/i.test(value) || !value.includes(':')) return false;
      try { return Boolean(new URL('http://[' + value + ']').hostname); }
      catch { return false; }
    }
    const validPort = (value) => Number.isInteger(value) && value >= 1 && value <= 65535;
    function validDns(value) {
      if (!value || dnsIpv4(value) || dnsIpv6(value)) return true;
      const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
      if (bracketed) return dnsIpv6(bracketed[1]) && (bracketed[2] === undefined || validPort(Number(bracketed[2])));
      const endpoint = /^([^:]+):(\d+)$/.exec(value);
      return Boolean(endpoint && dnsIpv4(endpoint[1]) && validPort(Number(endpoint[2])));
    }
    const validCidr = (token) => {
      const [address, prefix, extra] = token.split('/');
      return extra === undefined && ipv4(address) && (prefix === undefined || (/^\d{1,2}$/.test(prefix) && Number(prefix) <= 32));
    };
    function settingValue(key, value) {
      if (key === 'cidrs') return cidrTokens(value).join(', ');
      if (key === 'listenPort' || key === 'iwanSocksPort') return Number(String(value ?? '').trim());
      if (['iwanSocksHost', 'iwanClientPath', 'iwanServer', 'upstreamProxy', 'dnsServer'].includes(key)) return String(value ?? '').trim();
      return value;
    }
    function proxyOrigin(value) {
      try {
        const endpoint = new URL(value);
        return ['http:', 'https:'].includes(endpoint.protocol) ? endpoint.origin : '';
      } catch { return ''; }
    }
    const formatLog = (entries) => (entries ?? []).slice().reverse()
      .map((line) => new Date(line.at).toLocaleTimeString() + ' ' + line.msg).join('\n');
    const interruptibleByStop = ['connect', 'reconnect', 'checkUpdates'];
    const authCopyKey = (status) => status?.auth?.state === 'awaiting' && status.auth.authorizeUrl
      ? JSON.stringify([status.auth.id ?? null, status.auth.authorizeUrl]) : '';

    // ---------- 样式 ----------
    const STYLE_ID = "dsh-ustc-iwan-style";
    const CSS = `
      .dsh-ustc-card {
        --iwan-accent: light-dark(#1d4ed8, #afc7ff);
        --iwan-on-accent: light-dark(white, #14264b);
        --iwan-success: light-dark(#166534, #86efac);
        --iwan-error: light-dark(#b91c1c, #fca5a5);
        --iwan-warn: light-dark(#92400e, #fcd34d);
        color: var(--dsw-alias-label-primary, inherit); font-size: 13px; max-width: 720px;
      }
      .dsh-ustc-title { margin: 0 0 8px; font-size: 20px; font-weight: 600; }
      .dsh-ustc-card :focus-visible { outline: 2px solid var(--iwan-accent); outline-offset: 2px; }
      .dsh-ustc-group { border-top: 0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25)); padding: 12px 0; }
      .dsh-ustc-group h3 { margin: 0 0 8px; font-size: 13px; }
      .dsh-ustc-row { display: flex; align-items: center; gap: 10px; margin: 8px 0; flex-wrap: wrap; }
      .dsh-ustc-row > :is(label, .dsh-ustc-row-title):first-child { flex: 0 1 150px; }
      .dsh-ustc-row > label[for] { cursor: pointer; }
      .dsh-ustc-hint { color: var(--dsw-alias-label-secondary, inherit); font-size: 12px; margin: 4px 0; }
      .dsh-ustc-row-hint { flex: 0 0 100%; margin: 0; }
      .dsh-ustc-row-hint > div + div { margin-top: 4px; }
      .dsh-ustc-lock { color: var(--iwan-warn); }
      .dsh-ustc-endpoint { display: flex; flex: 1 1 180px; min-width: 0; max-width: 460px; gap: 6px; align-items: center; }
      .dsh-ustc-endpoint input { min-width: 0; box-sizing: border-box; }
      .dsh-ustc-endpoint .host { flex: 1 1 0; }
      .dsh-ustc-endpoint .port { flex: 0 1 90px; width: 90px; }
      .dsh-ustc-cidrs { resize: vertical; white-space: pre; overflow: auto; }
      .dsh-ustc-path { min-width: 0; overflow-wrap: anywhere; }
      .dsh-ustc-switch { appearance: none; width: 36px; height: 20px; margin: 0; border: 1px solid currentColor; border-radius: 999px; position: relative; cursor: pointer; color: var(--dsw-alias-label-secondary, inherit); }
      .dsh-ustc-switch::before { content: ''; position: absolute; top: 3px; left: 3px; width: 12px; height: 12px; border-radius: 50%; background: currentColor; }
      .dsh-ustc-switch:checked { border-color: var(--iwan-accent); background: var(--iwan-accent); color: var(--iwan-on-accent); }
      .dsh-ustc-switch:checked::before { left: 19px; }
      .dsh-ustc-card :is(input, textarea):disabled { opacity: .65; cursor: not-allowed; }
      .dsh-ustc-input { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08)); border: 0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); border-radius: 7px; color: inherit; font: inherit; font-size: 12px; padding: 6px 9px; }
      .dsh-ustc-input.t { flex: 1 1 260px; min-width: min(200px, 100%); max-width: min(460px, 100%); box-sizing: border-box; }
      .dsh-ustc-mono, .dsh-ustc-input.dsh-ustc-mono { font-family: ui-monospace, monospace; }
      .dsh-ustc-btn { border: 0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35)); border-radius: 7px; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08)); color: inherit; font: inherit; font-size: 12px; padding: 6px 12px; cursor: pointer; }
      .dsh-ustc-btn:disabled { opacity: .5; cursor: default; }
      .dsh-ustc-btn.primary { background: var(--iwan-accent); color: var(--iwan-on-accent); border-color: transparent; }
      .dsh-ustc-pill { display: inline-flex; align-items: center; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08)); font-size: 12px; font-weight: 500; padding: 4px 9px; }
      .dsh-ustc-pill.active { color: var(--iwan-success); }
      .dsh-ustc-pill.pending { color: var(--iwan-accent); }
      .dsh-ustc-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
      .dsh-ustc-dot.on { background: var(--iwan-success); } .dsh-ustc-dot.off { background: #94a3b8; }
      .dsh-ustc-bar { flex: 1 1 220px; height: 6px; border-radius: 3px; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.15)); overflow: hidden; }
      .dsh-ustc-bar > div { height: 100%; background: var(--iwan-accent); transition: width .3s; }
      .dsh-ustc-log { font-family: ui-monospace, monospace; font-size: 11px; max-height: 180px; overflow: auto; white-space: pre-wrap; margin: 6px 0 0; padding: 8px; border-radius: 7px; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08)); }
      .dsh-ustc-link { color: inherit; text-decoration: underline; cursor: pointer; background: none; border: none; font: inherit; font-size: 12px; padding: 0; }
      .dsh-ustc-url { font-family: ui-monospace, monospace; font-size: 11px; opacity: .7; word-break: break-all; margin: 4px 0; }
      .dsh-ustc-error { color: var(--iwan-error); font-size: 12px; margin: 6px 0; overflow-wrap: anywhere; }
      .dsh-ustc-ok { color: var(--iwan-success); font-size: 12px; margin: 6px 0; }
      .dsh-ustc-warn { color: var(--iwan-warn); font-size: 12px; margin: 6px 0; }
      .dsh-ustc-guide { border: 0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.28)); border-radius: 9px; padding: 10px 12px; margin: 10px 0 12px; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.05)); }
      .dsh-ustc-guide-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
      .dsh-ustc-guide-title { font-size: 13px; font-weight: 600; }
      .dsh-ustc-steps { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
      .dsh-ustc-step { display: flex; align-items: flex-start; gap: 8px; }
      .dsh-ustc-badge { flex: 0 0 auto; font-size: 11px; line-height: 18px; padding: 0 7px; border-radius: 999px; border: 0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); opacity: .8; }
      .dsh-ustc-badge.done { color: var(--iwan-success); border-color: currentColor; opacity: 1; }
      .dsh-ustc-badge.active { color: var(--iwan-accent); border-color: currentColor; opacity: 1; font-weight: 600; }
      .dsh-ustc-step-body { flex: 1 1 auto; min-width: 0; }
      .dsh-ustc-step-title { font-size: 12px; font-weight: 600; }
      .dsh-ustc-details { margin-top: 8px; padding-top: 6px; border-top: 0.5px dashed var(--dsw-alias-border-l2, rgba(128,128,128,.22)); }
      .dsh-ustc-disclosure { background: none; border: 0; border-radius: 5px; color: inherit; font: inherit; font-weight: 500; cursor: pointer; text-align: left; padding: 5px 8px; }
      .dsh-ustc-disclosure:hover { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08)); }
      .dsh-ustc-clash-heading .dsh-ustc-disclosure { margin-inline-start: -8px; font-weight: inherit; }
      .dsh-ustc-clash-cidrs { display: flex; flex-wrap: wrap; gap: 4px; list-style: none; margin: 4px 0 8px; padding: 0; }
      .dsh-ustc-clash-cidrs li { min-width: 0; max-width: 100%; box-sizing: border-box; padding: 2px 6px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08)); font-size: 12px; overflow-wrap: anywhere; }
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
    function pill(label, tone = '') {
      return h('span', { className: 'dsh-ustc-pill' + (tone ? ' ' + tone : ''), role: 'status' }, label);
    }
    function row({ id, label, hint, locks = [], children }) {
      return h('div', { className: 'dsh-ustc-row' },
        h('label', { htmlFor: id }, label),
        children,
        h('div', { id: id + '-hint', className: 'dsh-ustc-hint dsh-ustc-row-hint' },
          h('div', null, hint),
          ...locks.map((text) => h('div', { key: text, className: 'dsh-ustc-lock' }, text))),
      );
    }
    function copyFeedbackMessage(feedback) {
      return feedback ? h('span', { className: feedback.ok ? 'dsh-ustc-ok' : 'dsh-ustc-error', role: 'status' }, feedback.message) : null;
    }
    /**
     * 认证区：三种状态各画一种界面。
     *  idle      —— 一个「开始认证」按钮
     *  awaiting  —— 展示授权地址，并提供回调 URL 输入框
     *  submitting/done/failed —— 进度与结果
     */
    function renderAuth(auth, { busy, startAuth, completeAuth, cancelAuth, redirectUrl, setRedirectUrl, installing, binaryInstalled, externalMode, externalOnline, connect, refresh, canConnect, copyAuthorizeUrl, authCopyFeedback }) {
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
            h('button', { className: 'dsh-ustc-btn', type: 'button', onClick: copyAuthorizeUrl }, authCopyFeedback?.ok ? '已复制链接' : '复制授权链接'),
            copyFeedbackMessage(authCopyFeedback)),
          h('div', { className: 'dsh-ustc-url' }, auth.authorizeUrl),
          h('p', { className: 'dsh-ustc-hint' }, '② 登录成功后会跳转到 com.panabit.mobile:// 开头的地址（若浏览器提示“无法打开此链接”或询问是否打开应用，取消弹窗并复制浏览器地址栏中的完整链接即可），粘贴到下方：'),
          h('div', { className: 'dsh-ustc-row' },
            h('input', {
              className: 'dsh-ustc-input t',
              'aria-label': '认证回调链接',
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
    function renderOnboarding({ status, binaryInstalled, installing, authenticating, hasSavedAuth, steps, needsGuide, externalMode, externalOnline, guideId, showGuide, toggleGuide }) {
      const s = status;
      const [step1Done, step2Done, step3Done] = steps;
      const completedCount = steps.filter(Boolean).length;
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
          h('button', { className: 'dsh-ustc-disclosure', type: 'button', 'aria-expanded': showGuide, 'aria-controls': guideId, onClick: toggleGuide }, showGuide ? '收起指引' : '查看指引')),
        showGuide ? h('div', { id: guideId },
          !s.settings.enabled ? h('p', { className: 'dsh-ustc-warn' }, '当前「启用分流」已关闭，插件不会拦截流量。请在下方「配置」中打开「启用分流」并保存。') : null,
          h('ul', { className: 'dsh-ustc-steps' },
            h('li', { className: 'dsh-ustc-step' },
              stepBadge(step1Done, !step1Done, externalOnline && !binaryInstalled ? '外部在线' : '已完成', installing ? '下载中' : externalMode && !binaryInstalled ? '外部离线' : '当前步骤', '待完成'),
              h('div', { className: 'dsh-ustc-step-body' },
                h('div', { className: 'dsh-ustc-step-title' }, '1. 准备 iWAN 客户端'),
                h('div', { className: 'dsh-ustc-hint' }, step1Done
                  ? (externalOnline && !binaryInstalled ? '已检测到外部 iWAN SOCKS5 在线，可直接分流使用。' : '客户端已准备就绪。')
                  : externalMode
                    ? '检测到此前使用外部 iWAN 客户端，但当前 SOCKS5 端口离线；请启动外部 Panabit iWAN 客户端，或在下方下载/配置插件客户端。'
                    : '在下方「iWAN 客户端」点击下载按钮自动获取客户端（仅存放在插件缓存目录，不做系统安装）；若本机已安装客户端，也可填写路径；使用外部 Panabit iWAN 时请关闭托管并配置它的监听地址。'))),
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
                  ? '本地分流代理及 iWAN SOCKS5 均在线，出站策略已生效。请实际访问科大模型或校内站点确认可达。'
                  : (externalMode && !externalOnline
                    ? '当前外部 iWAN 客户端已离线，请先启动外部客户端；若已安装插件客户端并完成认证，也可在「运行状态」点击「启动 iWAN」切换为插件托管。随后在「测试分流」输入 llm.ustc.edu.cn，显示「走 iWAN」表示规则命中，还需确认 SOCKS 在线并实际访问目标。'
                    : '开启「托管 iWAN 客户端」后，前两步完成即可自动连接；也可在「运行状态」手动点击启动，随后在「测试分流」输入 llm.ustc.edu.cn，显示「走 iWAN」表示规则命中，还需确认 SOCKS 在线并实际访问目标。'))))),
          h('p', { className: 'dsh-ustc-hint', style: { marginTop: '8px' } }, '提示：若同时运行 Clash TUN、WireGuard 等代理软件，只需保持默认分流配置；非科大流量会自动走「上游代理」或直连，无需关闭现有代理。')) : h('div', { id: guideId, hidden: true }));
    }

    // ---------- Clash TUN（仅显式检测；与 iWAN 的状态、轮询及操作互不相干） ----------
    const CLASH_TUN_MODES = { relay: '仅排除 iWAN 线路', campus: '排除全部 USTC 网段' };
    // 旧版宿主只在读取到 GUI 排除项后返回修订标识。
    const clashCoverageKnown = (snapshot) => snapshot?.coverageKnown ?? Boolean(snapshot?.revision);
    function validClashTunSnapshot(next) {
      const entries = (values) => Array.isArray(values) && values.every((value) => typeof value === 'string');
      return ['ready', 'running', 'unsupported', 'not-found'].includes(next?.state)
        && typeof next.app === 'string' && typeof next.running === 'boolean' && typeof next.reason === 'string'
        && (next.enabled === null || typeof next.enabled === 'boolean')
        && (next.revision === null || (typeof next.revision === 'string' && Boolean(next.revision)))
        && typeof next.rollbackAvailable === 'boolean' && Number.isInteger(next.relayCount) && entries(next.existing)
        && (next.coverageKnown === undefined || typeof next.coverageKnown === 'boolean')
        && (next.effective == null || entries(next.effective))
        && Object.keys(CLASH_TUN_MODES).every((mode) => entries(next.modes?.[mode]?.desired) && entries(next.modes[mode].missing));
    }
    function canWriteClashTun(snapshot, mode, kind) {
      if (!snapshot?.revision || snapshot.running || !clashCoverageKnown(snapshot)) return false;
      if (kind === 'rollback') return snapshot.rollbackAvailable;
      if (snapshot.state !== 'ready' || snapshot.relayCount < 1) return false;
      const profile = snapshot.modes[mode];
      return profile.desired.length > 0 && profile.missing.length > 0;
    }
    const clashUnknown = '未能确认 Clash TUN 的操作结果；修改可能已生效。请先重新检测，不要直接重试。';
    function clashWriteError(cause) {
      const advice = '请重新检测并核对预览。';
      if (cause?.status === 409) return '配置、备份或检测依据已变化，操作因冲突未执行。' + advice;
      if (cause?.status === 423) return 'Clash 仍在运行，未写入配置。请从托盘完全退出后重新检测。';
      if (cause?.status === 501) return '当前环境不支持自动写入。请重新检测，或使用下方手动说明。';
      if (cause?.status === 400) return '宿主未接受此次操作请求。' + advice;
      return clashUnknown;
    }
    function useClashTun(id) {
      const [view, setView] = React.useState({ open: false, mode: 'relay', snapshot: null, confirmation: null, busy: null, feedback: null, copied: null });
      const latest = React.useRef(view);
      const alive = React.useRef(false);
      const inFlight = React.useRef(null);
      const copyVersion = React.useRef(0);
      const update = (patch) => {
        latest.current = { ...latest.current, ...patch };
        setView(latest.current);
      };
      React.useEffect(() => {
        alive.current = true;
        return () => {
          alive.current = false;
          ++copyVersion.current;
          const old = inFlight.current;
          inFlight.current = null;
          old?.controller.abort();
        };
      }, []);
      const invalidateRead = () => {
        ++copyVersion.current;
        const flight = inFlight.current;
        if (flight?.kind === 'inspect') {
          inFlight.current = null;
          flight.controller.abort();
        } else if (flight) {
          // 客户端无法撤销已送达宿主的写入；收起后仅隐藏旧结果，仍保留单次操作锁。
          flight.detached = true;
        }
      };
      const toggle = () => {
        if (!alive.current) return;
        invalidateRead();
        update({ open: !latest.current.open, snapshot: null, confirmation: null, copied: null,
          busy: inFlight.current?.kind ?? null,
          feedback: inFlight.current ? { ok: false, message: clashUnknown } : latest.current.feedback });
      };
      const changeMode = (mode) => {
        if (!alive.current || !latest.current.open || mode === latest.current.mode || !Object.hasOwn(CLASH_TUN_MODES, mode)) return;
        if (inFlight.current && inFlight.current.kind !== 'inspect') return;
        invalidateRead();
        update({ mode, confirmation: null, copied: null, busy: null });
      };
      const prepare = (kind) => {
        const { open, snapshot, mode } = latest.current;
        if (!alive.current || !open || inFlight.current || !canWriteClashTun(snapshot, mode, kind)) return;
        update({ confirmation: { kind, mode, revision: snapshot.revision }, feedback: null });
      };
      const execute = async (kind, confirmation) => {
        const { open, mode, snapshot, confirmation: current } = latest.current;
        if (!alive.current || !open || inFlight.current) return;
        const inspect = kind === 'inspect';
        if (!inspect && (!confirmation || current !== confirmation || confirmation.kind !== kind || confirmation.mode !== mode
          || confirmation.revision !== snapshot?.revision || !canWriteClashTun(snapshot, mode, kind))) return;
        const flight = { kind, controller: new AbortController(), detached: false };
        inFlight.current = flight;
        ++copyVersion.current;
        update({ busy: kind, snapshot: null, confirmation: null, copied: null, feedback: inspect ? latest.current.feedback : null });
        const stillCurrent = () => alive.current && inFlight.current === flight && !flight.detached;
        try {
          const next = await requestClashTun(flight.controller.signal, kind, confirmation);
          if (!stillCurrent()) return;
          if (!validClashTunSnapshot(next)) throw new Error('宿主返回了无法识别的 Clash TUN 检测结果');
          if (inspect) {
            update({ snapshot: next, feedback: null });
          } else {
            const rollbackVerified = kind === 'rollback' && next.result === 'rolled-back';
            const writable = next.state === 'ready' && !next.running && Boolean(next.revision) && clashCoverageKnown(next);
            const verified = kind === 'apply' ? writable && next.modes[mode].missing.length === 0 && next.rollbackAvailable
              : rollbackVerified || (writable && !next.rollbackAvailable);
            if (!verified) {
              update({ feedback: { ok: false, message: clashUnknown } });
            } else {
              update({ snapshot: next, feedback: { ok: true, message: kind === 'apply'
                ? '已写入排除地址并保存备份，可在此撤销。请手动重新启动 Clash 使更改生效。'
                : '已撤销本次 Clash TUN 修改并恢复备份。请手动重新启动 Clash 使更改生效。' } });
            }
          }
        } catch (cause) {
          if (stillCurrent()) update({ feedback: { ok: false, message: inspect
            ? 'Clash TUN 检测失败：' + (cause?.message || '未知错误') : clashWriteError(cause) } });
        } finally {
          if (inFlight.current === flight) {
            inFlight.current = null;
            if (alive.current) update({ busy: null });
          }
        }
      };
      const copyManual = async (snapshot, mode, text, label) => {
        if (!alive.current || !latest.current.open || latest.current.snapshot !== snapshot || latest.current.mode !== mode || !text) return;
        const version = ++copyVersion.current;
        update({ copied: null });
        let ok = false;
        try { await navigator.clipboard.writeText(text); ok = true; } catch { /* 下方文本可手动选择。 */ }
        if (alive.current && version === copyVersion.current) update({ copied: { ok,
          message: ok ? '已复制' + label : '无法自动复制，请手动选中下方网段复制' } });
      };
      return renderClashTun(id, view, { toggle, changeMode, prepare, execute, copyManual,
        cancel: (confirmation) => { if (alive.current && latest.current.confirmation === confirmation) update({ confirmation: null }); } });
    }

    function renderClashTun(id, { open, mode, snapshot, confirmation, busy, feedback, copied }, actions) {
      const modeId = id + '-mode';
      const profile = snapshot?.modes[mode];
      const coverageKnown = clashCoverageKnown(snapshot);
      const missing = profile?.missing ?? [];
      const manual = (coverageKnown ? missing : profile?.desired ?? []).join('\n');
      const manualLabel = coverageKnown ? '待追加的网段' : '建议核对的网段';
      const campusWarning = '校园网段排除会让 USTC 网段流量绕过 Clash，可能使通过 Clash 的可选全系统校内分流失效。';
      const running = snapshot?.state === 'running' || snapshot?.running;
      const effectiveDiffers = coverageKnown && Array.isArray(snapshot?.effective) && (snapshot.effective.length !== snapshot.existing.length
        || snapshot.effective.some((entry) => !snapshot.existing.includes(entry)));
      const state = snapshot?.state === 'ready' && running ? 'running' : snapshot?.state;
      const stateLabel = { ready: '支持自动配置', running: '运行中', unsupported: '仅手动配置', 'not-found': '未找到 Clash 配置' }[state];
      const showTunSetting = (state === 'ready' || state === 'running') && typeof snapshot?.enabled === 'boolean';
      const statusInfo = snapshot ? [state !== 'not-found' && snapshot.app,
        showTunSetting && (snapshot.enabled ? 'TUN 开关设为开启' : 'TUN 开关设为关闭'),
        snapshot.relayCount > 0 && '已识别线路 IP：' + snapshot.relayCount].filter(Boolean).join(' · ') : '';
      const showEntries = (title, entries) => h('div', null,
        h('p', { className: 'dsh-ustc-hint' }, title + '：', entries.length ? null : '无'),
        entries.length ? h('ul', { className: 'dsh-ustc-clash-cidrs', role: 'list', 'aria-label': title },
          ...entries.map((entry) => h('li', { key: entry }, h('code', { className: 'dsh-ustc-mono' }, entry)))) : null);
      const button = (label, onClick, disabled = false, primary = false) => h('button', {
        type: 'button', className: 'dsh-ustc-btn' + (primary ? ' primary' : ''), disabled, onClick,
      }, label);
      return h('section', { className: 'dsh-ustc-group', 'aria-labelledby': id + '-toggle' },
        h('h3', { className: 'dsh-ustc-clash-heading' }, h('button', { type: 'button', id: id + '-toggle', className: 'dsh-ustc-disclosure',
          'aria-expanded': open, 'aria-controls': id, onClick: actions.toggle },
        h('span', { 'aria-hidden': true }, open ? '▾ ' : '▸ '), 'Clash TUN 共存设置')),
        h('div', { id, hidden: !open }, open ? h('div', null,
          h('p', { className: 'dsh-ustc-hint' }, 'Clash 运行时仍可检测。写入或撤销前请从系统托盘完全退出 Clash（只关窗口不够），完成后手动重启。插件不会启动、退出或切换 Clash 的 TUN 开关。'),
          h('div', { className: 'dsh-ustc-row' },
            button('检测 Clash TUN', () => actions.execute('inspect'), Boolean(busy), !snapshot && !busy),
            busy ? h('span', { className: 'dsh-ustc-hint', role: 'status' }, {
              inspect: '正在检测 Clash TUN…', apply: '正在备份并写入…', rollback: '正在从备份恢复…',
            }[busy]) : null),
          feedback ? h('p', { className: feedback.ok ? 'dsh-ustc-ok' : 'dsh-ustc-error', role: feedback.ok ? 'status' : 'alert' }, feedback.message) : null,
          h('div', { role: 'status' }, snapshot ? h('div', { className: 'dsh-ustc-row' },
            h('span', { className: 'dsh-ustc-pill' + (state === 'ready' ? ' active' : state === 'running' ? ' pending' : '') }, stateLabel),
            statusInfo ? h('span', { className: 'dsh-ustc-hint dsh-ustc-path' }, statusInfo) : null) : null),
          snapshot?.reason ? h('p', { className: 'dsh-ustc-hint dsh-ustc-path' }, snapshot.reason) : null,
          running ? h('p', { className: 'dsh-ustc-warn' }, '完全退出 Clash 后，请再次检测能否写入或撤销。') : null,
          h('div', { className: 'dsh-ustc-row' }, h('label', { htmlFor: modeId }, '排除范围'),
            h('select', { className: 'dsh-ustc-input t', id: modeId, value: mode, 'aria-describedby': modeId + '-hint',
              disabled: Boolean(busy && busy !== 'inspect'), onChange: (event) => actions.changeMode(event.target.value) },
            ...Object.entries(CLASH_TUN_MODES).map(([value, label]) => h('option', { key: value, value }, label)))),
          h('div', { id: modeId + '-hint' }, mode === 'campus'
            ? [h('p', { key: 'scope', className: 'dsh-ustc-hint' }, '排除固定的 11 段内置 USTC 校园网段，以及不在这些网段内的 iWAN 线路 IP；不使用高级设置中的自定义网段。'),
              h('p', { key: 'warning', className: 'dsh-ustc-warn' }, campusWarning)]
            : h('p', { className: 'dsh-ustc-hint' }, h('span', { className: 'dsh-ustc-badge' }, '推荐'),
              ' 只补充 iWAN 线路入口的排除地址，保留原有排除项。')),
          snapshot ? h('div', { role: 'group', 'aria-label': 'Clash TUN 排除地址预览' },
            coverageKnown
              ? h('div', null, showEntries('已覆盖', profile.desired.filter((entry) => !missing.includes(entry))), showEntries('待追加', missing))
              : h('div', null, h('p', { className: 'dsh-ustc-hint' }, '无法确认现有排除项，请与当前客户端的排除项核对后手动添加。'),
                showEntries('建议核对的网段', profile.desired)),
            snapshot.relayCount < 1 ? h('p', { className: 'dsh-ustc-warn' },
              mode === 'campus' ? '未识别到可用的线路 IP，无法确认是否还需排除校园网段外的线路，因此不能自动应用。' : '没有可用的线路地址，不能自动应用。',
              '请先完成 iWAN 认证，确认已配置的线路入口为 IPv4 或 IPv6 地址（不是域名），再重新检测。')
              : coverageKnown && profile.desired.length > 0 && !missing.length
                ? h('p', { className: 'dsh-ustc-hint' }, '此模式所需地址均已覆盖，无需写入。') : null,
            coverageKnown && (snapshot.existing.length > 0 || effectiveDiffers) ? h('details', null, h('summary', null, '查看现有排除项'),
              showEntries('GUI 已保存', snapshot.existing),
              effectiveDiffers ? showEntries('内核生成配置', snapshot.effective) : null) : null) : null,
          h('div', { className: 'dsh-ustc-row' },
            button('应用所选模式…', () => actions.prepare('apply'), Boolean(busy) || !canWriteClashTun(snapshot, mode, 'apply')),
            button('从备份撤销…', () => actions.prepare('rollback'), Boolean(busy) || !canWriteClashTun(snapshot, mode, 'rollback'))),
          snapshot?.rollbackAvailable ? h('p', { className: 'dsh-ustc-hint' }, '检测到可用于撤销最近一次插件修改的备份。') : null,
          confirmation ? h('div', { className: 'dsh-ustc-guide', role: 'group', 'aria-label': '确认 Clash TUN 操作' },
            h('p', { className: 'dsh-ustc-hint' }, confirmation.kind === 'apply'
              ? '将先备份当前配置，再以「' + CLASH_TUN_MODES[confirmation.mode] + '」模式追加上述 ' + missing.length + ' 个地址。'
              : '将从备份恢复最近一次插件修改前的配置。'),
            confirmation.kind === 'apply' && confirmation.mode === 'campus' ? h('p', { className: 'dsh-ustc-warn' }, campusWarning) : null,
            h('div', { className: 'dsh-ustc-row' },
              button('取消 Clash TUN 操作', () => actions.cancel(confirmation)),
              button(confirmation.kind === 'apply' ? '确认备份并应用' : '确认撤销并恢复备份',
                () => actions.execute(confirmation.kind, confirmation), false, true))) : null,
          h('details', { className: 'dsh-ustc-details' },
            h('summary', null, '手动配置 Clash TUN'),
            h('p', { className: 'dsh-ustc-hint' }, '在 Clash 的 TUN 设置中找到「路由排除地址」（route-exclude-address）。用 YAML 配置的客户端可在 tun 下的同名列表中逐项添加，保留原有排除项。线路入口为 IPv4 时用 /32，IPv6 时用 /128。保存后重载客户端配置。参见 ',
              h('a', { href: 'https://wiki.metacubex.one/config/inbound/tun/#route-exclude-address', target: '_blank', rel: 'noopener noreferrer' }, 'Mihomo 路由排除地址文档'), '。'),
            manual ? h('div', null,
              coverageKnown ? null : h('p', { className: 'dsh-ustc-hint' }, '以下是建议网段，并非已确认缺少的网段。请对照客户端设置，只添加尚未覆盖的项。'),
              button('复制' + manualLabel, () => actions.copyManual(snapshot, mode, manual, manualLabel)),
              copyFeedbackMessage(copied), h('pre', { className: 'dsh-ustc-log dsh-ustc-path', tabIndex: 0, 'aria-label': '可手动复制的' + (coverageKnown ? '待追加网段' : '建议网段') }, manual)) : null),
        ) : null),
      );
    }

    // ---------- 设置卡片 ----------
    function UstcIwanSection() {
      const [status, setStatus] = React.useState(null);
      const [draftEdits, setDraftEdits] = React.useState({});
      const [busy, setBusy] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      const [validationError, setValidationError] = React.useState(null);
      const [testHost, setTestHost] = React.useState('llm.ustc.edu.cn');
      const [testResult, setTestResult] = React.useState(null);
      const [redirectUrl, setRedirectUrl] = React.useState('');
      const [guideOpen, setGuideOpen] = React.useState(null);
      const [advOpen, setAdvOpen] = React.useState(null);
      const [copyFeedback, setCopyFeedback] = React.useState(null);
      const id = React.useId();
      const clashTun = useClashTun(id + '-clash-tun');
      const testInputVersion = React.useRef(0);
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
        const previousSettings = statusRef.current?.settings;
        statusRef.current = next;
        setStatus(next);
        if (!previousSettings || !next?.settings || busyRef.current === 'save') return;
        // 仅有格式差异的本地文本（例如 CIDR 分隔符）不应挡住宿主的新值。
        setDraftEdits((edits) => {
          let result = edits;
          for (const [key, { value }] of Object.entries(edits)) {
            const previous = settingValue(key, previousSettings[key]);
            if (Object.is(settingValue(key, value), previous) && !Object.is(settingValue(key, next.settings[key]), previous)) {
              if (result === edits) result = { ...edits };
              delete result[key];
            }
          }
          return result;
        });
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
        if (busyRef.current !== null && !(label === 'authCancel' && ['authStart', 'authComplete'].includes(busyRef.current)) && !(label === 'disconnect' && interruptibleByStop.includes(busyRef.current)) && !(label === 'cancelDownload' && busyRef.current === 'download')) return;
        if (!mounted.current) return;
        const operation = ++operationVersion.current;
        ++pollVersion.current;
        pollRequest.current?.abort();
        operationRequest.current?.abort();
        const controller = new AbortController();
        operationRequest.current = controller;
        const current = () => mounted.current && operation === operationVersion.current;
        busyRef.current = label;
        setBusy(label); setError(null); setNotice(null); setCopyFeedback(null);
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
        if (statusRef.current?.environmentOverrides?.includes(key)) return;
        const version = ++editVersion.current;
        setValidationError(null);
        setDraftEdits((edits) => ({ ...edits, [key]: { value, version } }));
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
      const changeTestHost = (value) => {
        if (value === testHost) return;
        ++testInputVersion.current;
        setTestHost(value);
        setTestResult(null);
      };
      const doTest = () => {
        const host = normalizeTestHost(testHost);
        if (!host) {
          setNotice(null);
          setError('请输入要测试的域名，例如 llm.ustc.edu.cn');
          return;
        }
        const version = testInputVersion.current;
        return run('test', async (current, api) => {
          const result = await api.test(host);
          if (current() && version === testInputVersion.current) setTestResult(result);
          return null;
        });
      };
      const copy = async (kind, text, getKey, success, fallback, key = text) => {
        if (!mounted.current || !text || !key || getKey(statusRef.current) !== key) return;
        const copySeq = ++copyVersion.current;
        const opVersion = operationVersion.current;
        setCopyFeedback(null);
        const stillCurrent = () => mounted.current
          && copySeq === copyVersion.current
          && opVersion === operationVersion.current
          && getKey(statusRef.current) === key;
        let ok = false;
        try {
          await navigator.clipboard.writeText(text);
          ok = true;
        } catch { /* 剪贴板不可用时保留可手动复制的文本。 */ }
        if (stillCurrent()) setCopyFeedback({ kind, key, ok, message: ok ? success : fallback });
      };
      const feedbackFor = (kind, key) => copyFeedback?.kind === kind && copyFeedback.key === key ? copyFeedback : null;
      const copyAuthorizeUrl = () => copy('auth', statusRef.current?.auth?.authorizeUrl, authCopyKey,
        '已复制授权链接，请在浏览器中打开并登录', '无法自动复制，请手动选中下方授权链接复制', authCopyKey(statusRef.current));
      const startAuth = () => {
        ++copyVersion.current;
        return run('authStart', async (current, api) => {
          setRedirectUrl('');
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
          setNotice('已提交回调链接，正在向校内服务器换取线路配置…');
          return api.status();
        });
      };
      const cancelAuth = () => {
        ++copyVersion.current;
        return run('authCancel', async (current, api) => {
          const auth = status?.auth ?? {};
          await api.authCancel(auth.id);
          if (current()) setNotice('已取消当前认证');
          return api.status();
        });
      };

      const connect = () => run('connect', async (current, api) => {
        await api.connect();
        const next = await api.status();
        if (current()) setNotice(next?.iwan?.socksAlive ? (next.iwan.managed ? 'iWAN 客户端已启动并在线' : '检测到外部 iWAN 客户端已在线') : '已发起 iWAN 连接，当前 SOCKS5 尚未在线');
        return next;
      });
      const reconnect = () => run('reconnect', async (current, api) => {
        await api.reconnect();
        const next = await api.status();
        if (current()) setNotice(next?.iwan?.socksAlive ? 'iWAN 客户端已重新连接' : '已发起 iWAN 重连，当前 SOCKS5 尚未在线');
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

      const title = h('h2', { className: 'dsh-ustc-title' }, 'USTC iWAN');
      if (!status?.settings) {
        return h('div', { className: 'dsh-ustc-card' }, title, error ? h('div', { className: 'dsh-ustc-error', role: 'alert' }, error) : '加载中…');
      }
      const s = status;
      const locked = new Set(s.environmentOverrides ?? []);
      const draft = { ...s.settings, cidrs: cidrTokens(s.settings.cidrs).join('\n') };
      const patch = {};
      for (const [key, { value }] of Object.entries(draftEdits)) {
        if (locked.has(key)) continue;
        draft[key] = value;
        const normalized = settingValue(key, value);
        if (!Object.is(normalized, settingValue(key, s.settings[key]))) patch[key] = normalized;
      }
      const dirty = Object.keys(patch).length > 0;
      const configError = validationError && !locked.has(validationError.key) ? validationError : null;
      const fieldId = (key) => id + '-' + key;
      const fieldProps = (key, hintKey = key) => ({
        id: fieldId(key), disabled: locked.has(key),
        'aria-describedby': fieldId(hintKey) + '-hint' + (configError?.key === key ? ' ' + fieldId('config-error') : ''),
        'aria-invalid': configError?.key === key || undefined,
      });
      const lockText = (key, label) => locked.has(key) ? [label + '由环境变量覆盖，无法在此修改。'] : [];
      const settingRow = (key, label, hint, children, locks = lockText(key, label)) => row({ id: fieldId(key), label, hint, locks, children });
      const textField = (key, props = {}) => h('input', {
        ...fieldProps(key), className: 'dsh-ustc-input t', value: draft[key] ?? '',
        onChange: (e) => set(key, e.target.value), ...props,
      });
      const switchField = (key) => h('input', {
        ...fieldProps(key), className: 'dsh-ustc-switch', type: 'checkbox', role: 'switch',
        checked: Boolean(draft[key]), onChange: (e) => set(key, e.target.checked),
      });
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
      const stopping = busy === 'disconnect' || s.iwan.stopping;
      const starting = busy === 'connect' || (s.iwan.connecting && busy !== 'reconnect' && recovery.state !== 'recovering');
      const connectionPill = stopping ? pill('停止中…', 'pending')
        : nativeReconnecting ? pill('客户端重连中…', 'pending')
        : starting ? pill('启动中…', 'pending')
        : s.iwan.managed ? pill('托管运行中', 'active')
        : s.iwan.socksAlive ? pill('外部客户端在线', 'active') : null;
      const stopBlocked = (busy !== null && !interruptibleByStop.includes(busy))
        || (!s.iwan.managed && !s.iwan.connecting && busy !== 'connect' && busy !== 'reconnect' && !installing && !recoveryActive);
      const downloadBlocked = busy !== null || installing || authenticating || Boolean(binary.checking);
      const dlPct = dl.total ? Math.min(100, Math.round((dl.bytes / dl.total) * 100)) : (dl.state === 'downloading' ? 0 : 100);
      const hasSavedAuth = savedAuth.serverCount > 0 && !['missing', 'invalid', 'expired'].includes(savedAuth.state);
      const steps = [binaryInstalled || externalOnline, hasSavedAuth || externalOnline,
        Boolean(s.settings.enabled && s.proxy.listening && s.policyInstalled && s.iwan.socksAlive)];
      const needsGuide = steps.some((done) => !done);
      const showGuide = guideOpen === null ? needsGuide : guideOpen;
      const hasCustomAdvanced = Boolean(
        (draft.iwanClientPath ?? '').trim()
        || (draft.dnsServer ?? '').trim()
        || draft.verbose
        || Number(draft.listenPort) !== 18118
        || (draft.iwanSocksHost ?? '127.0.0.1') !== '127.0.0.1'
        || Number(draft.iwanSocksPort) !== 21080
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
      const binaryPath = binary.path ?? '';
      const log = formatLog(s.log);
      const lockedUpstream = locked.has('upstreamProxy') ? proxyOrigin(s.settings.upstreamProxy) : '';
      const rejectSetting = (key, message) => {
        setNotice(null);
        setValidationError({ key, message });
        if (['listenPort', 'iwanSocksHost', 'iwanSocksPort', 'dnsServer', 'cidrs'].includes(key)) setAdvOpen(true);
      };
      const save = () => {
        if (!dirty || busyRef.current !== null || installing) return;
        if (Object.keys(patch).some((key) => statusRef.current?.environmentOverrides?.includes(key))) return;
        if ('listenPort' in patch && !validPort(patch.listenPort)) return rejectSetting('listenPort', '「分流代理端口」必须是 1–65535 之间的整数');
        if ('iwanSocksHost' in patch && !patch.iwanSocksHost) return rejectSetting('iwanSocksHost', '「iWAN SOCKS 地址」不能为空');
        if ('iwanSocksPort' in patch && !validPort(patch.iwanSocksPort)) return rejectSetting('iwanSocksPort', '「iWAN SOCKS 端口」必须是 1–65535 之间的整数');
        if (patch.upstreamProxy) {
          const validProxy = /^https?:\/\/(?:[^@\s]+@)?(?:\[[^\]]+\]|[^\s:/?#]+)(?::\d{1,5})?(?:\/[^\s]*)?$/i.test(patch.upstreamProxy) && proxyOrigin(patch.upstreamProxy);
          if (!validProxy) return rejectSetting('upstreamProxy', '「上游代理」格式应为 http://host:port 或 https://host:port');
        }
        if ('dnsServer' in patch && !validDns(patch.dnsServer)) return rejectSetting('dnsServer', '「DNS」请输入 IPv4、IPv6、IPv4:端口 或 [IPv6]:端口，端口须为 1–65535；留空使用系统 DNS。');
        if ('cidrs' in patch) {
          const invalid = cidrTokens(patch.cidrs).find((token) => !validCidr(token));
          if (invalid) return rejectSetting('cidrs', '「USTC 网段」含无效条目：' + invalid + '。请输入 IPv4 网段（如 202.38.64.0/19，前缀为 0–32）或单个 IPv4 地址。');
        }
        setValidationError(null);
        return run('save', async (current, api) => {
          const version = editVersion.current;
          const next = await api.settings(patch);
          if (!current()) return;
          // 只清除随本次保存提交的草稿；保存期间的编辑（包括恢复到旧值）仍保留。
          setDraftEdits((edits) => Object.fromEntries(Object.entries(edits).filter(([, edit]) => edit.version > version)));
          setNotice(version === editVersion.current ? '配置已保存并即时生效' : '已保存提交的配置；当前仍有未保存修改');
          return next;
        });
      };

      return h('div', { className: 'dsh-ustc-card' },
        title,
        h('p', { className: 'dsh-ustc-hint' },
          '访问科大模型与校内网站时自动走 ustc-iwan，其余流量保持原样；与 Clash TUN、WireGuard、Panabit iWAN 共存。'),
        error ? h('div', { className: 'dsh-ustc-error', role: 'alert' }, error) : null,
        notice ? h('div', { className: 'dsh-ustc-ok', role: 'status' }, notice) : null,

        renderOnboarding({
          status: s,
          binaryInstalled,
          installing,
          authenticating,
          hasSavedAuth,
          steps,
          needsGuide,
          externalMode,
          externalOnline,
          guideId: fieldId('guide'),
          showGuide,
          toggleGuide: () => setGuideOpen(!showGuide),
        }),

        // 运行状态
        h('div', { className: 'dsh-ustc-group' },
          h('h3', null, '运行状态'),
          h('div', { className: 'dsh-ustc-row' }, h('span', { className: 'dsh-ustc-row-title' }, '分流代理'),
            h(Dot, { on: s.proxy.listening, label: s.proxy.listening ? '运行中（127.0.0.1:' + s.proxy.port + '）' : '未运行' }),
            h(Dot, { on: s.policyInstalled, label: '出站策略' + (s.policyInstalled ? '已生效' : '未生效') })),
          h('div', { className: 'dsh-ustc-row' }, h('span', { className: 'dsh-ustc-row-title' }, 'iWAN SOCKS5'),
            h(Dot, { on: s.iwan.socksAlive, label: (s.iwan.socksHost ?? s.settings.iwanSocksHost) + ':' + (s.iwan.socksPort ?? s.settings.iwanSocksPort) + (s.iwan.socksAlive ? '（在线）' : '（离线）') }),
            h(Dot, { on: s.iwan.managed, label: s.iwan.managed ? '插件托管中' : '无托管进程' })),
          s.iwan.managed && s.iwan.socksPort != null && s.iwan.socksPort !== s.settings.iwanSocksPort
            ? h('p', { className: 'dsh-ustc-hint' }, '首选端口 ' + s.settings.iwanSocksPort + ' 不可用，当前托管会话使用 ' + s.iwan.socksPort + '；已保存配置不变。') : null,
          recoveryLabel ? h('div', { className: 'dsh-ustc-hint', role: 'status' },
            recoveryLabel,
            recovery.attempts > 0 ? ' · 已尝试 ' + recovery.attempts + ' 次' : '',
            recovery.state === 'waiting' && recovery.nextRetryAt ? ' · 下次重试：' + new Date(recovery.nextRetryAt).toLocaleTimeString() : '',
            recovery.reason ? ' · ' + recovery.reason : '') : null,
          recovery.lastError ? h('div', { className: 'dsh-ustc-error' }, '最近恢复错误：' + recovery.lastError) : null,
          h('div', { className: 'dsh-ustc-row' },
            connectionPill ?? h('button', { className: 'dsh-ustc-btn' + (canConnect && !busy ? ' primary' : ''), disabled: busy !== null || !canConnect, onClick: connect }, '启动 iWAN'),
            h('button', { className: 'dsh-ustc-btn', disabled: busy !== null || !canReconnect, onClick: reconnect }, busy === 'reconnect' ? '重连中…' : '重新连接'),
            h('button', { className: 'dsh-ustc-btn', disabled: stopBlocked, onClick: () => run('disconnect', async (current, api) => { await api.disconnect(); const next = await api.status(); if (current()) setNotice('已停止插件托管的 iWAN 客户端'); return next; }) }, '停止托管'),
            h('button', { className: 'dsh-ustc-btn', disabled: busy !== null, onClick: () => reload(true) }, '刷新状态')),
          connectBlockedHint ? h('p', { className: 'dsh-ustc-hint' }, connectBlockedHint) : null,
          h('div', { className: 'dsh-ustc-row' },
            h('input', {
              className: 'dsh-ustc-input t',
              'aria-label': '测试分流的域名或网址',
              value: testHost,
              onChange: (e) => changeTestHost(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter' && busy === null && testHost.trim()) doTest(); },
              placeholder: '输入要测试的域名或网址，如 llm.ustc.edu.cn',
            }),
            h('button', { className: 'dsh-ustc-btn', disabled: busy !== null || !testHost.trim(), onClick: doTest }, busy === 'test' ? '测试中…' : '测试分流')),
          h('div', { className: 'dsh-ustc-row', role: 'group', 'aria-label': '测试分流快捷域名' },
            h('span', { className: 'dsh-ustc-hint' }, '快捷域名'),
            ...['llm.ustc.edu.cn', 'www.baidu.com'].map((host) => h('button', {
              key: host, type: 'button', className: 'dsh-ustc-btn', 'aria-pressed': testHost === host, onClick: () => changeTestHost(host),
            }, host))),
          testResult ? h('p', { className: 'dsh-ustc-hint', role: 'status' },
            testResult.host + ' → ' + (testResult.decision?.kind === 'iwan' ? '走 iWAN' : testResult.decision?.kind === 'upstream' ? '走上游代理' : '直连') +
            (testResult.resolvedIps?.length ? '（解析到 ' + testResult.resolvedIps.join(', ') + '）' : '（未解析到 IPv4，按域名后缀判定）') +
            (testResult.fake ? ' · 检测到 fake-ip，按域名后缀判定' : '') +
            (testResult.decision?.kind === 'iwan' && !s.iwan.socksAlive ? ' · 注意：当前 iWAN SOCKS5 离线，实际请求将暂回退直连' : '') +
            (!s.settings.enabled ? ' · 注意：当前「启用分流」已关闭' : '')) : null,
        ),

        // iWAN 客户端：安装事实来自校验后的缓存，而不是本次下载进度。
        h('div', { className: 'dsh-ustc-group' },
          h('h3', null, 'iWAN 客户端（Windows x64）'),
          h('div', { className: 'dsh-ustc-row' },
            h('p', { className: 'dsh-ustc-hint dsh-ustc-path' }, '当前：', binaryPath ? h('code', { className: 'dsh-ustc-mono' }, binaryPath) : '未找到可执行文件',
              binary.version ? ' · ' + binary.version : downloaded ? ' · 版本未知' : binaryInstalled ? ' · 手动配置' : ''),
            binaryPath ? h('button', { className: 'dsh-ustc-btn', type: 'button', onClick: () => copy('path', binaryPath, (next) => next?.binary?.path,
              '已复制客户端路径', '无法自动复制，请手动选中客户端路径复制') }, '复制路径') : null,
            copyFeedbackMessage(feedbackFor('path', binaryPath))),
          configuredPathMissing ? h('div', { className: 'dsh-ustc-error' }, '配置的「客户端路径」不可用或文件不存在，请检查路径或清空后使用自动下载。') : null,
          !configuredPathMissing && binary.error && !String(binary.error).startsWith('尚未配置') ? h('div', { className: 'dsh-ustc-error' }, binary.error) : null,
          h('div', { className: 'dsh-ustc-row' },
            installing ? pill(maintenance.phase === 'preparing' ? '准备中…' : maintenance.phase === 'restoring' ? '恢复托管中…' : '下载中…', 'pending')
              : binaryInstalled ? pill(downloaded ? '已下载' : '已配置', 'active')
              : h('button', { className: 'dsh-ustc-btn' + (downloadBlocked ? '' : ' primary'), disabled: downloadBlocked, onClick: () => installClient('download') }, '下载 iwan-client-oidc'),
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
            '首次使用请点击「开始认证」，完成校内登录以保存加密线路配置。连接验证通过才会显示「认证有效」；刷新状态不会重新登录。'),
          renderAuth(auth, { busy, startAuth, completeAuth, cancelAuth, redirectUrl, setRedirectUrl, installing, binaryInstalled, externalMode, externalOnline, connect, refresh: () => reload(true), canConnect, copyAuthorizeUrl, authCopyFeedback: feedbackFor('auth', authCopyKey(s)) }),
        ),

        // 配置
        h('div', { className: 'dsh-ustc-group' },
          h('h3', null, '配置'),
          locked.size ? h('p', { className: 'dsh-ustc-hint dsh-ustc-lock' }, '部分设置由 USTC_IWAN_* 环境变量覆盖，无法在此修改。') : null,
          settingRow('enabled', '启用分流', '关闭后插件不再介入词元工坊的出站请求。', switchField('enabled')),
          settingRow('manageClient', '托管 iWAN 客户端', '自动启动并重连本地 iWAN，退出词元工坊时自动关闭。使用外部 Panabit iWAN 时请关闭此项。', switchField('manageClient')),
          settingRow('iwanServer', '线路', '留空自动选第一条线路（教育网）；也可填序号 1–4 或线路名称关键词。',
            textField('iwanServer', { placeholder: '留空自动选教育网；或填 1 / 电信 / 教育网' })),
          settingRow('upstreamProxy', '上游代理', [
            '启用分流后非校内流量的去处。留空时自动沿用启动环境中的 HTTP(S)_PROXY；未检测到则直连。 ',
            h('span', { key: 'upstream-status' }, locked.has('upstreamProxy') ? '当前：由环境变量指定。'
              : (s.settings.upstreamProxy ?? '').trim() ? '当前：使用已保存的上游代理。'
              : s.autoUpstreamProxy ? '当前：自动沿用 ' + s.autoUpstreamProxy : '当前：未检测到上游代理，直连。'),
          ], textField('upstreamProxy', { placeholder: locked.has('upstreamProxy') ? '由环境变量指定' : 'http://127.0.0.1:7890',
            value: locked.has('upstreamProxy') ? lockedUpstream : draft.upstreamProxy ?? '' })),
          h('div', { className: 'dsh-ustc-details' },
            h('button', { className: 'dsh-ustc-disclosure', type: 'button', 'aria-expanded': showAdv, 'aria-controls': fieldId('advanced'), onClick: () => setAdvOpen(!showAdv) },
              (showAdv ? '▾ 收起高级设置' : '▸ 展开高级设置')),
            h('div', { id: fieldId('advanced'), hidden: !showAdv },
              settingRow('listenPort', '分流代理端口', '本地 HTTP 代理监听端口（1–65535）；修改保存后自动重启。',
                textField('listenPort', { className: 'dsh-ustc-input', type: 'number', style: { width: 100 } })),
              settingRow('iwanSocksHost', 'iWAN SOCKS 地址', '托管时使用首选端口（默认 21080），不可用时自动改用临时端口；外部客户端请关闭托管并填写实际监听地址。',
                h('div', { className: 'dsh-ustc-endpoint' },
                  textField('iwanSocksHost', { className: 'dsh-ustc-input host' }),
                  h('span', { 'aria-hidden': true }, ':'),
                  textField('iwanSocksPort', { ...fieldProps('iwanSocksPort', 'iwanSocksHost'), className: 'dsh-ustc-input port', type: 'number', 'aria-label': 'iWAN SOCKS 端口' })),
                [...lockText('iwanSocksHost', 'iWAN SOCKS 地址'), ...lockText('iwanSocksPort', 'iWAN SOCKS 端口')]),
              settingRow('iwanClientPath', '客户端路径', '仅在使用自己准备的可执行文件时填写；使用自动下载副本请留空。',
                textField('iwanClientPath', { placeholder: '留空则使用已下载的副本' })),
              settingRow('cidrs', 'USTC 网段', '建议每行一个 IPv4 网段，也可用逗号分隔。清空后仅按域名规则等判断，不再匹配这些 IPv4 网段。',
                h('textarea', { ...fieldProps('cidrs'), className: 'dsh-ustc-input t dsh-ustc-mono dsh-ustc-cidrs', rows: 4, wrap: 'off', spellCheck: false,
                  value: draft.cidrs, onChange: (e) => set('cidrs', e.target.value) })),
              settingRow('domainSuffixes', '域名后缀', '以逗号分隔，包括在 TUN / fake-ip 模式下也可识别校内域名。', textField('domainSuffixes')),
              settingRow('dnsServer', 'DNS', '留空使用系统 DNS；支持 IPv4、IPv6、IPv4:端口或 [IPv6]:端口。托管启动 iWAN 时另用校内 DNS 解析线路域名。',
                textField('dnsServer', { placeholder: '留空使用系统 DNS，例如 223.5.5.5' })),
              settingRow('verbose', '逐请求日志', '开启后会记录每个域名的分流判定依据，便于排查问题。', switchField('verbose')))),
          configError ? h('div', { className: 'dsh-ustc-error', role: 'alert', id: fieldId('config-error') }, configError.message) : null,
          h('div', { className: 'dsh-ustc-row' },
            h('button', { className: 'dsh-ustc-btn' + (dirty && busy === null && !installing ? ' primary' : ''), disabled: !dirty || busy !== null || installing, onClick: save }, busy === 'save' ? '保存中…' : '保存配置'),
            h('button', { className: 'dsh-ustc-btn', disabled: busy !== null || !dirty, onClick: () => { ++editVersion.current; setValidationError(null); setError(null); setNotice('已放弃未保存的修改'); setDraftEdits({}); } }, '放弃未保存修改'),
            dirty ? h('span', { className: 'dsh-ustc-warn' }, '有未保存的修改（点击「保存配置」后生效）') : null),
        ),

        clashTun,

        // 日志
        h('div', { className: 'dsh-ustc-group' },
          h('h3', null, '最近日志'),
          h('div', { className: 'dsh-ustc-row' },
            h('p', { className: 'dsh-ustc-hint' }, '显示最近 40 条运行与诊断日志，最新在前。'),
            h('button', { className: 'dsh-ustc-btn', type: 'button', disabled: !log, onClick: () => copy('log', log, (next) => formatLog(next?.log),
              '已复制日志', '无法自动复制，请手动选中日志文本复制') }, '复制日志'),
            copyFeedbackMessage(feedbackFor('log', log))),
          h('pre', { className: 'dsh-ustc-log', tabIndex: 0, 'aria-label': '最近运行与诊断日志' }, log || '（暂无）')),
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
