import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, deferred } from './helpers/client-fixture.mjs'

test('persisted downloaded client shows installed state even when current progress is idle',async()=>{
  const ui=fixture();await ui.mount()
  assert.equal(ui.button('已下载').props.disabled,true)
  assert.equal(ui.button('检查更新').props.disabled,false);assert.equal(ui.button('重新下载').props.disabled,false)
  assert.equal(ui.button('下载 iwan-client-oidc'),undefined);assert.match(ui.text(),/v1[.]0/)
})

test('check update and explicit update use distinct actions and latest release label',async()=>{
  const ui=fixture();await ui.mount()
  ui.override(url=>{if(!url.endsWith('/update/check'))return null;ui.setServer({...ui.server(),binary:{...ui.server().binary,latestVersion:'v2.0',updateAvailable:true}});return ui.response({started:true,...ui.server().binary})})
  await ui.button('检查更新').props.onClick();ui.render();assert.equal(ui.button('更新到 v2.0').props.disabled,false)
  await ui.button('更新到 v2.0').props.onClick()
  assert.equal(JSON.parse(ui.requests.find(x=>x.url.endsWith('/download')).init.body).mode,'update')
})

test('re-download explicitly sends reinstall rather than repeating first install',async()=>{
  const ui=fixture();await ui.mount();await ui.button('重新下载').props.onClick()
  assert.equal(JSON.parse(ui.requests.find(x=>x.url.endsWith('/download')).init.body).mode,'reinstall')
})

test('latest version state does not offer a redundant update',async()=>{
  const ui=fixture();ui.setServer({...ui.server(),binary:{...ui.server().binary,latestVersion:'v1.0',updateAvailable:false}});await ui.mount()
  assert.ok(ui.element('已是最新版本（v1.0）'));assert.equal(ui.button('更新到 v1.0'),undefined)
})

test('unknown installed version can explicitly install checked latest without claiming no update',async()=>{
  const ui=fixture();ui.setServer({...ui.server(),binary:{...ui.server().binary,version:null,latestVersion:'v2.0',updateAvailable:null}});await ui.mount()
  assert.ok(ui.button('安装最新版本 v2.0'));assert.match(ui.text(),/版本未知/)
})

test('stored credentials are recognized after restart but are not called valid offline',async()=>{
  const ui=fixture();await ui.mount()
  assert.ok(ui.element('认证已保存，待连接验证'));assert.equal(ui.element('认证有效'),undefined)
  assert.ok(ui.button('重新认证'));assert.equal(ui.button('开始认证'),undefined);assert.equal(ui.button('连接并验证').props.disabled,false)
})

test('active attested authentication is valid without asking for another login',async()=>{
  const ui=fixture();ui.setServer({...ui.server(),iwan:{managed:true,socksAlive:true},auth:{state:'idle',credentials:{state:'valid',serverCount:1,source:'managed-connection',verifiedAt:123,message:'当前托管会话已认证'}}});await ui.mount()
  assert.equal(ui.element('认证有效').props.className,'dsh-ustc-ok')
  assert.equal(ui.button('托管运行中').props.disabled,true);assert.equal(ui.button('开始认证'),undefined);assert.equal(ui.button('连接并验证'),undefined)
})

test('completed fetch alone still waits for connection verification',async()=>{
  const ui=fixture();ui.setServer({...ui.server(),auth:{...ui.server().auth,state:'done'}});await ui.mount()
  assert.ok(ui.element('认证已保存，待连接验证'));assert.equal(ui.element('认证有效'),undefined)
})

test('missing binary guides first download and disables impossible auth and start actions',async()=>{
  const ui=fixture();ui.setServer({...ui.server(),binary:{installed:false,downloaded:false},auth:{state:'idle',credentials:{state:'missing',serverCount:0}}});await ui.mount()
  assert.equal(ui.button('下载 iwan-client-oidc').props.disabled,false)
  assert.equal(ui.button('开始认证').props.disabled,true);assert.equal(ui.button('启动 iWAN').props.disabled,true);assert.ok(ui.element('尚未认证'))
})

test('maintenance blocks conflicting actions and offers cancellation with accurate phase',async()=>{
  const ui=fixture();ui.setServer({...ui.server(),maintenance:{running:true,mode:'update',phase:'preparing'}});await ui.mount()
  assert.equal(ui.button('准备中…').props.disabled,true);assert.equal(ui.button('检查更新').props.disabled,true)
  assert.equal(ui.button('重新认证').props.disabled,true);assert.equal(ui.button('保存配置').props.disabled,true);assert.equal(ui.button('取消下载').props.disabled,false)
  await ui.button('取消下载').props.onClick();assert.ok(ui.requests.some(x=>x.url.endsWith('/download/cancel')))
})

test('configured manual client is not labeled downloaded and cache action is explicit',async()=>{
  const ui=fixture();ui.setServer({...ui.server(),binary:{path:'custom.exe',installed:true,downloaded:false,kind:'configured',version:null}});await ui.mount()
  assert.equal(ui.button('已配置').props.disabled,true);assert.equal(ui.button('已下载'),undefined)
  assert.ok(ui.button('下载缓存副本'));assert.equal(ui.button('重新下载'),undefined);assert.match(ui.text(),/不修改其他手动路径/)
})

test('unknown process termination blocks restart and remains observable',async()=>{
  const ui=fixture();ui.setServer({...ui.server(),iwan:{managed:false,connecting:false,stopping:true,socksAlive:false}});await ui.mount()
  assert.equal(ui.button('停止中…').props.disabled,true)
})

test('first-time onboarding guides progress step by step, toggles cleanly, and auto-collapses once ready',async()=>{
  const ui=fixture()
  ui.setServer({...ui.server(),binary:{installed:false,downloaded:false},auth:{state:'idle',credentials:{state:'missing',serverCount:0}}})
  await ui.mount()
  assert.match(ui.text(),/首次使用指引（已完成 0\/3 步）/)
  assert.match(ui.text(),/当前无法启动：尚未准备 iWAN 客户端/)
  assert.ok(ui.button('收起指引'))
  ui.button('收起指引').props.onClick();ui.render()
  assert.ok(ui.button('查看指引'));assert.doesNotMatch(ui.text(),/1. 准备 iWAN 客户端/)
  ui.button('查看指引').props.onClick();ui.render()
  assert.match(ui.text(),/1. 准备 iWAN 客户端/)

  ui.setServer({...ui.server(),binary:{installed:true,downloaded:true},auth:{state:'idle',credentials:{state:'missing',serverCount:0}}})
  ui.poll();await new Promise(setImmediate);ui.render()
  assert.match(ui.text(),/首次使用指引（已完成 1\/3 步）/)
  assert.match(ui.text(),/当前无法启动：尚未完成有效的统一身份认证/)

  ui.setServer({...ui.server(),binary:{installed:true,downloaded:true},auth:{state:'idle',credentials:{state:'unknown',serverCount:1}}})
  ui.poll();await new Promise(setImmediate);ui.render()
  assert.match(ui.text(),/首次使用指引（已完成 2\/3 步）/)

  const uiReady=fixture()
  uiReady.setServer({...uiReady.server(),iwan:{managed:true,socksAlive:true},auth:{state:'idle',credentials:{state:'valid',serverCount:1,source:'managed-connection',verifiedAt:123}}})
  await uiReady.mount()
  assert.match(uiReady.text(),/使用指引 · 已就绪/)
  assert.ok(uiReady.button('查看指引'))
  assert.doesNotMatch(uiReady.text(),/1. 准备 iWAN 客户端/)
})

test('awaiting auth validates callback URL format before submission and supports Enter key',async()=>{
  const ui=fixture()
  ui.setServer({...ui.server(),auth:{state:'awaiting',id:'auth-9',authorizeUrl:'https://id.ustc.edu.cn/cas/login'}})
  await ui.mount()
  const input=ui.input('com.panabit.mobile://oauth2redirect?code=…')
  assert.equal(ui.button('完成认证').props.disabled,true)

  input.props.onChange({target:{value:'https://id.ustc.edu.cn/cas/login'}});ui.render()
  assert.equal(ui.button('完成认证').props.disabled,true)
  assert.match(ui.text(),/你粘贴的是网页登录地址/)

  ui.input('com.panabit.mobile://oauth2redirect?code=…').props.onChange({target:{value:'not-a-redirect'}});ui.render()
  assert.equal(ui.button('完成认证').props.disabled,true)
  assert.match(ui.text(),/回调链接格式无效/)

  ui.input('com.panabit.mobile://oauth2redirect?code=…').props.onChange({target:{value:'  com.panabit.mobile://oauth2redirect?code=xyz  '}});ui.render()
  assert.equal(ui.button('完成认证').props.disabled,false)
  await ui.input('com.panabit.mobile://oauth2redirect?code=…').props.onKeyDown({key:'Enter'})
  const post=ui.requests.find(x=>x.url.endsWith('/auth/complete'))
  assert.deepEqual(JSON.parse(post.init.body),{id:'auth-9',redirectUrl:'com.panabit.mobile://oauth2redirect?code=xyz'})
})

test('settings form validates ports and upstream proxy before posting and discard clears validation errors',async()=>{
  const ui=fixture();await ui.mount()
  const portInput=ui.nodes().find(n=>n.type==='input'&&n.props.type==='number'&&n.props.value===18118)
  portInput.props.onChange({target:{value:'99999'}});ui.render()
  await ui.button('保存配置').props.onClick();ui.render()
  assert.match(ui.text(),/「分流代理端口」必须是 1–65535 之间的整数/)
  assert.equal(ui.requests.some(x=>x.url.endsWith('/settings')),false)

  ui.button('放弃未保存修改').props.onClick();ui.render()
  assert.doesNotMatch(ui.text(),/1–65535 之间的整数/)

  ui.input('http://127.0.0.1:7890').props.onChange({target:{value:'socks5://127.0.0.1:1080'}});ui.render()
  await ui.button('保存配置').props.onClick();ui.render()
  assert.match(ui.text(),/「上游代理」格式应为/)
  assert.equal(ui.requests.some(x=>x.url.endsWith('/settings')),false)
})

test('split test normalizes pasted URLs and warns when iWAN SOCKS5 is offline',async()=>{
  const ui=fixture()
  ui.override(url=>url.endsWith('/test')?ui.response({host:'llm.ustc.edu.cn',decision:{kind:'iwan'},resolvedIps:['202.38.64.10']}):null)
  await ui.mount()
  const hostInput=ui.input('输入要测试的域名或网址，如 llm.ustc.edu.cn')
  hostInput.props.onChange({target:{value:'https://llm.ustc.edu.cn/v1/chat'}});ui.render()
  await ui.button('测试分流').props.onClick();ui.render()
  const req=ui.requests.find(x=>x.url.endsWith('/test'))
  assert.deepEqual(JSON.parse(req.init.body),{host:'llm.ustc.edu.cn'})
  assert.match(ui.text(),/llm.ustc.edu.cn → 走 iWAN/)
  assert.match(ui.text(),/当前 iWAN SOCKS5 离线/)
})

test('external mode distinguishes offline vs online and guides starting external client when offline',async()=>{
  const ui=fixture()
  ui.setServer({
    ...ui.server(),
    binary:{installed:false,downloaded:false},
    auth:{state:'idle',credentials:{state:'missing',serverCount:0}},
    iwan:{managed:false,socksAlive:false},
    recovery:{state:'external',attempts:0,reason:'外部客户端由用户管理，不会自动重启'},
  })
  await ui.mount()
  assert.match(ui.text(),/首次使用指引（已完成 0\/3 步）/)
  assert.match(ui.text(),/外部离线/)
  assert.match(ui.text(),/请启动外部 Panabit iWAN 客户端/)
  assert.doesNotMatch(ui.text(),/已检测到外部 iWAN SOCKS5 在线/)
  assert.doesNotMatch(ui.text(),/本地已保存加密线路配置/)
  assert.doesNotMatch(ui.text(),/显示「走 iWAN」即成功/)
  assert.match(ui.text(),/显示「走 iWAN」表示规则命中，还需确认 SOCKS 在线并实际访问目标/)
  assert.equal(ui.button('启动 iWAN').props.disabled,true)

  ui.setServer({
    ...ui.server(),
    binary:{installed:false,downloaded:false},
    auth:{state:'idle',credentials:{state:'missing',serverCount:0}},
    iwan:{managed:false,socksAlive:true},
    recovery:{state:'external',attempts:0,reason:'外部客户端由用户管理，不会自动重启'},
  })
  ui.poll();await new Promise(setImmediate);ui.render()
  assert.match(ui.text(),/使用指引 · 已就绪/)
  ui.button('查看指引').props.onClick();ui.render()
  assert.match(ui.text(),/已检测到外部 iWAN SOCKS5 在线/)
  assert.match(ui.text(),/当前由外部 iWAN 客户端管理认证/)
})

test('stale clipboard copy from canceled auth session does not pollute a new auth session',async()=>{
  const copyA=deferred()
  const copyB=deferred()
  const copied=[]
  const ui=fixture({
    navigator:{
      clipboard:{
        writeText(text){
          copied.push(text)
          return text.includes('session-a')?copyA.promise:copyB.promise
        },
      },
    },
  })
  ui.setServer({...ui.server(),auth:{state:'awaiting',id:'auth-a',authorizeUrl:'https://id.ustc.edu.cn/cas/login?state=session-a'}})
  await ui.mount()

  const copyPromiseA=ui.button('复制授权链接').props.onClick()
  ui.setServer({...ui.server(),auth:{state:'idle',id:null,credentials:{state:'unknown',serverCount:1}}})
  await ui.button('取消认证').props.onClick();ui.render()

  ui.setServer({...ui.server(),auth:{state:'awaiting',id:'auth-b',authorizeUrl:'https://id.ustc.edu.cn/cas/login?state=session-b'}})
  await ui.button('重新认证').props.onClick();ui.render()
  assert.ok(ui.button('复制授权链接'))
  assert.equal(ui.button('已复制链接'),undefined)

  copyA.resolve()
  await copyPromiseA
  ui.render()
  assert.equal(ui.button('已复制链接'),undefined)
  assert.doesNotMatch(ui.text(),/已复制授权链接/)

  const copyPromiseB=ui.button('复制授权链接').props.onClick()
  copyB.resolve()
  await copyPromiseB
  ui.render()
  assert.ok(ui.button('已复制链接'))
  assert.match(ui.text(),/已复制授权链接/)
  assert.deepEqual(copied,[
    'https://id.ustc.edu.cn/cas/login?state=session-a',
    'https://id.ustc.edu.cn/cas/login?state=session-b',
  ])

  // Also verify unmount mid-copy causes no stale state updates.
  const copyC=deferred()
  const ui2=fixture({navigator:{clipboard:{writeText:()=>copyC.promise}}})
  ui2.setServer({...ui2.server(),auth:{state:'awaiting',id:'auth-c',authorizeUrl:'https://id.ustc.edu.cn/cas/login?state=session-c'}})
  await ui2.mount()
  const copyPromiseC=ui2.button('复制授权链接').props.onClick()
  ui2.unmount()
  copyC.resolve()
  await copyPromiseC
  assert.equal(ui2.staleUpdates(),0)

  ui.unmount()
})
