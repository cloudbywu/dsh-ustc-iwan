import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, tick, deferred } from './helpers/client-fixture.mjs'

const settingsPosts = ui => ui.requests.filter(({url}) => url.endsWith('/settings')).map(({init}) => JSON.parse(init.body))
const save = ui => ui.button('保存配置')
const edit = (ui,key,value) => {
  ui.field(key).props.onChange({target:typeof value==='boolean'?{checked:value}:{value}})
  ui.render()
}

test('settings associate switches and endpoint inputs with accessible names and descriptions',async()=>{
  const ui=fixture();await ui.mount()
  const labels={enabled:'启用分流',manageClient:'托管 iWAN 客户端',verbose:'逐请求日志',iwanSocksHost:'iWAN SOCKS 地址',dnsServer:'DNS'}
  for(const [key,label] of Object.entries(labels)) {
    const field=ui.field(key)
    assert.equal(ui.element(label).type,'label')
    assert.equal(ui.element(label).props.htmlFor,field.props.id)
    assert.ok(ui.nodes().some(node=>node.props.id===field.props['aria-describedby']))
  }
  for(const key of ['enabled','manageClient','verbose']) assert.equal(ui.field(key).props.role,'switch')
  const endpoint=ui.nodes().find(node=>node.props.className==='dsh-ustc-endpoint')
  assert.equal(endpoint.children[0],ui.field('iwanSocksHost'))
  assert.equal(endpoint.children[2],ui.field('iwanSocksPort'))
  assert.equal(ui.field('iwanSocksPort').props['aria-label'],'iWAN SOCKS 端口')
  assert.equal(ui.element('USTC iWAN').type,'h2')
  const disclosure=ui.button('▸ 展开高级设置')
  assert.equal(disclosure.props['aria-expanded'],false)
  assert.ok(ui.nodes().some(node=>node.props.id===disclosure.props['aria-controls']&&node.props.hidden))
  disclosure.props.onClick();ui.render()
  assert.equal(ui.button('▾ 收起高级设置').props['aria-expanded'],true)
  assert.equal(save(ui).props.disabled,true)
  assert.doesNotMatch(save(ui).props.className,/primary/)
})

test('CIDRs present one token per line, ignore separator-only edits, and persist explicit empty',async()=>{
  const ui=fixture()
  ui.setServer({...ui.server(),settings:{...ui.server().settings,cidrs:'202.38.64.0/19, 202.141.160.0/19'}})
  await ui.mount()
  assert.equal(ui.field('cidrs').props.value,'202.38.64.0/19\n202.141.160.0/19')
  assert.match(ui.field('cidrs').props.className,/dsh-ustc-mono/)
  edit(ui,'cidrs','202.38.64.0/19, \r\n 202.141.160.0/19,')
  assert.equal(save(ui).props.disabled,true)
  assert.doesNotMatch(ui.text(),/有未保存的修改/)
  await save(ui).props.onClick()
  assert.deepEqual(settingsPosts(ui),[])

  edit(ui,'cidrs','0.0.0.0/0,\n8.8.8.8/32  \t192.0.2.1, 010.0.0.0/8')
  assert.match(save(ui).props.className,/primary/)
  await save(ui).props.onClick();ui.render()
  assert.deepEqual(settingsPosts(ui),[{cidrs:'0.0.0.0/0, 8.8.8.8/32, 192.0.2.1, 010.0.0.0/8'}])
  assert.equal(ui.field('cidrs').props.value,'0.0.0.0/0\n8.8.8.8/32\n192.0.2.1\n010.0.0.0/8')

  edit(ui,'cidrs','')
  await save(ui).props.onClick();ui.render()
  assert.deepEqual(settingsPosts(ui).at(-1),{cidrs:''})
  assert.equal(ui.field('cidrs').props.value,'')
  assert.equal(save(ui).props.disabled,true)
})

test('invalid CIDR reports the failing token and persists across status refreshes without submitting',async()=>{
  for(const token of ['10.1.0.0/33','300.1.0.0/12','10.1.0.0/','10.1.0.0/-1','::1/32']) {
    const ui=fixture();await ui.mount()
    edit(ui,'cidrs','202.38.64.0/19, '+token)
    await save(ui).props.onClick();ui.render()
    assert.equal(ui.field('cidrs').props['aria-invalid'],true)
    const alert=ui.nodes().find(node=>node.props.role==='alert')
    assert.ok(alert.children[0].includes(token))
    await ui.button('刷新状态').props.onClick();ui.render()
    assert.equal(ui.field('cidrs').props['aria-invalid'],true)
    assert.ok(ui.text().includes(token))
    assert.deepEqual(settingsPosts(ui),[])
    ui.button('放弃未保存修改').props.onClick();ui.render()
    assert.equal(save(ui).props.disabled,true)
    assert.doesNotMatch(ui.text(),/含无效条目/)
  }
})

test('DNS accepts blank and Node-compatible IP endpoint literals',async()=>{
  const accepted=['','223.5.5.5','223.5.5.5:5353','1.2.3.4:00053','2001:db8::53','2001:db8::53:5353','[2001:db8::53]','[2001:db8::53]:65535','[::ffff:192.0.2.53]:1']
  for(const value of accepted) {
    const ui=fixture();ui.setServer({...ui.server(),settings:{...ui.server().settings,dnsServer:'8.8.8.8'}});await ui.mount()
    edit(ui,'dnsServer',' '+value+' ')
    await save(ui).props.onClick();ui.render()
    assert.deepEqual(settingsPosts(ui),[{dnsServer:value}],value)
    assert.equal(ui.field('dnsServer').props.value,value)
    assert.equal(save(ui).props.disabled,true)
  }
})

test('DNS rejects domains, noncanonical IPv4, invalid ports or literals, and scoped IPv6',async()=>{
  const rejected=['dns.alidns.com','256.0.0.1','001.2.3.4','223.5.5.5:65536','223.5.5.5:0','[1.2.3.4]:53','[::1]:','[2001:::1]:53','[::1]:+53','fe80::1%eth0','::ffff:001.2.3.4']
  for(const value of rejected) {
    const ui=fixture();await ui.mount();edit(ui,'dnsServer',value)
    await save(ui).props.onClick();ui.render()
    assert.equal(ui.field('dnsServer').props['aria-invalid'],true,value)
    assert.match(ui.text(),/「DNS」请输入 IPv4/)
    assert.deepEqual(settingsPosts(ui),[])
    assert.equal(save(ui).props.disabled,false)
  }
})

test('locked settings show effective values without posting them or leaking proxy credentials',async()=>{
  const ui=fixture()
  ui.setServer({...ui.server(),environmentOverrides:['enabled','dnsServer','upstreamProxy','iwanSocksPort'],settings:{
    ...ui.server().settings,enabled:false,dnsServer:'9.9.9.9',upstreamProxy:'http://private-user:private-pw@127.0.0.1:7890',iwanSocksPort:23456,
  }})
  await ui.mount()
  for(const key of ['enabled','dnsServer','upstreamProxy','iwanSocksPort']) assert.equal(ui.field(key).props.disabled,true)
  assert.equal(ui.field('iwanSocksHost').props.disabled,false)
  assert.equal(ui.field('enabled').props.checked,false)
  assert.equal(ui.field('dnsServer').props.value,'9.9.9.9')
  assert.equal(ui.field('iwanSocksPort').props.value,23456)
  assert.equal(ui.field('upstreamProxy').props.value,'http://127.0.0.1:7890')
  assert.match(ui.text(),/DNS由环境变量覆盖/)
  assert.match(ui.text(),/上游代理由环境变量覆盖/)
  assert.match(ui.text(),/iWAN SOCKS 端口由环境变量覆盖/)
  assert.doesNotMatch(ui.text(),/private-user|private-pw/)
  edit(ui,'dnsServer','invalid')
  assert.equal(save(ui).props.disabled,true)
  edit(ui,'verbose',true)
  await save(ui).props.onClick();ui.render()
  assert.deepEqual(settingsPosts(ui),[{verbose:true}])
  assert.equal(ui.field('dnsServer').props.value,'9.9.9.9')
})

test('detected upstream remains out of unrelated saves and resumes after explicit proxy is cleared',async()=>{
  const ui=fixture()
  ui.setServer({...ui.server(),autoUpstreamProxy:'http://127.0.0.1:7890'})
  await ui.mount()
  assert.equal(ui.field('upstreamProxy').props.value,'')
  assert.ok(ui.text().includes('当前：自动沿用 http://127.0.0.1:7890'))
  edit(ui,'verbose',true)
  await save(ui).props.onClick();ui.render()
  assert.deepEqual(settingsPosts(ui),[{verbose:true}])
  edit(ui,'upstreamProxy','https://proxy.example:1234')
  await save(ui).props.onClick();ui.render()
  assert.match(ui.text(),/当前：使用已保存的上游代理/)
  assert.deepEqual(settingsPosts(ui).at(-1),{upstreamProxy:'https://proxy.example:1234'})
  edit(ui,'upstreamProxy','   ')
  await save(ui).props.onClick();ui.render()
  assert.deepEqual(settingsPosts(ui).at(-1),{upstreamProxy:''})
  assert.match(ui.text(),/当前：自动沿用/)
  ui.setServer({...ui.server(),autoUpstreamProxy:''});ui.poll();await tick();ui.render()
  assert.match(ui.text(),/当前：未检测到上游代理，直连/)
})

test('refresh applies new locks without replacing other drafts or saving the newly locked edit',async()=>{
  const ui=fixture();await ui.mount()
  edit(ui,'dnsServer','invalid old draft')
  edit(ui,'iwanClientPath','C:/draft.exe')
  ui.setServer({...ui.server(),environmentOverrides:['dnsServer'],settings:{...ui.server().settings,dnsServer:'9.9.9.9',iwanSocksPort:21081}})
  await ui.button('刷新状态').props.onClick();ui.render()
  assert.equal(ui.field('dnsServer').props.disabled,true)
  assert.equal(ui.field('dnsServer').props.value,'9.9.9.9')
  assert.equal(ui.field('iwanSocksPort').props.value,21081)
  assert.equal(ui.field('iwanClientPath').props.value,'C:/draft.exe')
  await save(ui).props.onClick();ui.render()
  assert.deepEqual(settingsPosts(ui),[{iwanClientPath:'C:/draft.exe'}])
})

test('reverting a field during an in-flight save remains an intentional new draft',async()=>{
  const ui=fixture();await ui.mount();const pending=deferred()
  ui.override(url=>url.endsWith('/settings')?pending.promise:null)
  edit(ui,'dnsServer','8.8.8.8')
  const saving=save(ui).props.onClick()
  edit(ui,'dnsServer','')
  pending.resolve(ui.response({...ui.server(),settings:{...ui.server().settings,dnsServer:'8.8.8.8'}}))
  await saving;ui.render()
  assert.equal(ui.field('dnsServer').props.value,'')
  assert.equal(save(ui).props.disabled,false)
  assert.match(ui.text(),/当前仍有未保存修改/)
})
