/*
 * dsh-ustc-iwan 浏览器半边：设置 → 「USTC iWAN」卡片。
 * 结构与交互样式沿用 @eddyskywalker/dsh-chatgpt-subscription 的线路卡片惯例：
 * settings.section 槽位注册 + 分组卡片 + --dsw-alias-* 主题 token。
 */
window.__ModuleLoader__.load({
  id: "dsh-ustc-iwan",
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
      if (parsed && parsed.ok === false) throw new Error(parsed.error || '操作失败');
      return parsed && parsed.ok ? parsed.value : parsed;
    }
    const post = (path, body) => request(API + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
    const api = {
      status: () => request(API + "/status"),
      settings: (patch) => post("/settings", patch),
      download: () => post("/download", {}),
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
    // ---------- 设置卡片 ----------
    function UstcIwanSection() {
      const [status, setStatus] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [busy, setBusy] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      const [testHost, setTestHost] = React.useState('llm.ustc.edu.cn');
      const [testResult, setTestResult] = React.useState(null);

      const apply = React.useCallback((next) => {
        setStatus(next);
        if (next?.settings) setDraft(next.settings);
      }, []);
      const reload = React.useCallback(async () => {
        try { apply(await api.status()); setError(null); }
        catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      }, [apply]);
      React.useEffect(() => { reload(); }, [reload]);
      React.useEffect(() => {
        const timer = setInterval(() => { reload(); }, (status?.download?.state === 'downloading') ? 1500 : 10000);
        return () => clearInterval(timer);
      }, [reload, status?.download?.state]);

      const run = React.useCallback(async (label, action) => {
        setBusy(label); setError(null); setNotice(null);
        try {
          const next = await action();
          if (next) apply(next);
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
        finally { setBusy(null); }
      }, [apply]);

      const set = (key, value) => setDraft((d) => ({ ...d, [key]: value }));
      const save = () => run('save', async () => {
        const patch = { ...draft };
        for (const key of ['listenPort', 'iwanSocksPort']) {
          patch[key] = Number(patch[key]) || 0;
        }
        const next = await api.settings(patch);
        setNotice('配置已保存并即时生效');
        return next;
      });
      const doTest = () => run('test', async () => {
        const result = await api.test(testHost);
        setTestResult(result);
        return null;
      });

      if (!status || !draft) {
        return h('div', { className: 'dsh-ustc-card' }, error ? h('div', { className: 'dsh-ustc-error' }, error) : '加载中…');
      }
      const s = status;
      const dl = s.download ?? {};
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
            h(Dot, { on: s.iwan.socksAlive, label: draft.iwanSocksHost + ':' + draft.iwanSocksPort + (s.iwan.socksAlive ? '（在线）' : '（离线）') }),
            h(Dot, { on: s.iwan.managed, label: s.iwan.managed ? '插件托管中' : '无托管进程' })),
          h('div', { className: 'dsh-ustc-row' },
            h('button', { className: 'dsh-ustc-btn primary', disabled: busy !== null, onClick: () => run('connect', async () => { await api.connect(); return api.status(); }) }, busy === 'connect' ? '启动中…' : '启动 iWAN'),
            h('button', { className: 'dsh-ustc-btn', disabled: busy !== null, onClick: () => run('disconnect', async () => { await api.disconnect(); return api.status(); }) }, '停止托管'),
            h('button', { className: 'dsh-ustc-btn', disabled: busy !== null, onClick: reload }, '刷新状态')),
          h('div', { className: 'dsh-ustc-row' },
            h('input', { className: 'dsh-ustc-input t', value: testHost, onChange: (e) => setTestHost(e.target.value), placeholder: '要测试的域名' }),
            h('button', { className: 'dsh-ustc-btn', disabled: busy !== null, onClick: doTest }, '测试分流'),
            testResult ? h('span', { className: 'dsh-ustc-hint' },
              testResult.host + ' → ' + (testResult.decision?.kind === 'iwan' ? '走 iWAN' : testResult.decision?.kind === 'upstream' ? '走上游代理' : '直连') +
              '（解析到 ' + ((testResult.resolvedIps || [])[0] || '无') + '）') : null),
        ),

        // iWAN 客户端下载
        h('div', { className: 'dsh-ustc-group' },
          h('h3', null, 'iWAN 客户端（Windows x64）'),
          h('p', { className: 'dsh-ustc-hint' },
            '当前：' + (s.binary.path ? s.binary.path + '（' + (s.binary.kind === 'configured' ? '手动配置' : '已下载') + '）' : '未找到可执行文件')),
          h('div', { className: 'dsh-ustc-row' },
            h('button', { className: 'dsh-ustc-btn primary', disabled: busy !== null || dl.state === 'downloading',
              onClick: () => run('download', async () => { await api.download(); return api.status(); }) },
              dl.state === 'downloading' ? '下载中…' : '下载 iwan-client-oidc'),
            dl.state === 'downloading' ? h('div', { className: 'dsh-ustc-bar' }, h('div', { style: { width: Math.max(5, dlPct) + '%' } })) : null,
            dl.state === 'downloading' ? h('span', { className: 'dsh-ustc-hint' }, (dl.bytes / 1048576).toFixed(1) + ' MB' + (dl.total ? ' / ' + (dl.total / 1048576).toFixed(1) + ' MB' : '')) : null),
          dl.state === 'error' ? h('div', { className: 'dsh-ustc-error' }, '上次下载失败：' + dl.error) : null,
          dl.state === 'done' ? h('div', { className: 'dsh-ustc-ok' }, '下载完成。首次使用前需运行一次 --fetch 完成统一身份认证登录（见 README）。') : null,
          h('p', { className: 'dsh-ustc-hint' },
            '下载保存到词元工坊数据目录 cache/ustc-iwan/ 下，不做系统级安装。已有手动下载的 exe 时，在下方「客户端路径」填写即可优先使用。'),
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
          h(Row, { label: '托管 iWAN 客户端', hint: '开启后应用启动时自动拉起 iWAN，退出时自动结束' },
            h('input', { type: 'checkbox', checked: !!draft.manageClient, onChange: (e) => set('manageClient', e.target.checked) })),
          h(Row, { label: '客户端路径' },
            h('input', { className: 'dsh-ustc-input t', value: draft.iwanClientPath ?? '', placeholder: '留空则使用已下载的副本', onChange: (e) => set('iwanClientPath', e.target.value) })),
          h(Row, { label: '线路' },
            h('input', { className: 'dsh-ustc-input t', value: draft.iwanServer ?? '', placeholder: '如：教育网 或序号 1（托管模式用）', onChange: (e) => set('iwanServer', e.target.value) })),
          h(Row, { label: '上游代理', hint: '非 USTC 流量的去处；留空自动沿用系统已有的 HTTP(S)_PROXY，再无则直连' },
            h('input', { className: 'dsh-ustc-input t', value: draft.upstreamProxy ?? '', placeholder: 'http://127.0.0.1:7890', onChange: (e) => set('upstreamProxy', e.target.value) })),
          h(Row, { label: 'USTC 网段' },
            h('textarea', { className: 'dsh-ustc-input t', rows: 4, value: draft.cidrs ?? '', onChange: (e) => set('cidrs', e.target.value) })),
          h(Row, { label: '域名后缀' },
            h('input', { className: 'dsh-ustc-input t', value: draft.domainSuffixes ?? '', onChange: (e) => set('domainSuffixes', e.target.value) })),
          h(Row, { label: 'DNS' },
            h('input', { className: 'dsh-ustc-input t', value: draft.dnsServer ?? '', placeholder: '留空用系统；TUN fake-ip 环境建议 223.5.5.5', onChange: (e) => set('dnsServer', e.target.value) })),
          h(Row, { label: '逐请求日志' },
            h('input', { type: 'checkbox', checked: !!draft.verbose, onChange: (e) => set('verbose', e.target.checked) })),
          h('div', { className: 'dsh-ustc-row' },
            h('button', { className: 'dsh-ustc-btn primary', disabled: busy !== null, onClick: save }, busy === 'save' ? '保存中…' : '保存配置')),
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
