import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture } from './helpers/client-fixture.mjs'

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
