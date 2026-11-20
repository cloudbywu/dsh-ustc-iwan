import test from 'node:test'
import assert from 'node:assert/strict'
import { fixture, tick, deferred } from './helpers/client-fixture.mjs'

const path = '/ustc-iwan/api/clash-tun'
const relay = '192.0.2.8/32'
const campus = '198.51.100.0/24'
const snapshot = (patch = {}) => ({
  state: 'ready', app: 'Clash Verge Rev', running: false, enabled: true, reason: '',
  revision: 'seen', rollbackAvailable: false, relayCount: 2, existing: ['192.0.2.0/30'],
  modes: {
    relay: { desired: ['192.0.2.1/32', relay], missing: [relay] },
    campus: { desired: ['192.0.2.1/32', relay, campus], missing: [relay, campus] },
  },
  ...patch,
})
const calls = ui => ui.requests.filter(({url}) => url.startsWith(path))
const writes = ui => calls(ui).filter(({init}) => init.method === 'POST')
const mode = ui => ui.nodes().find(n => n.type === 'select' && n.props.id?.endsWith('-clash-tun-mode'))
const select = (ui, value) => { mode(ui).props.onChange({target:{value}}); ui.render() }
const action = (ui, label) => ui.button(label).props.onClick
const click = (ui, label) => { const done = action(ui, label)(); ui.render(); return done }
const open = ui => click(ui, 'Clash TUN 共存设置')
const detect = async ui => { await click(ui, '检测 Clash TUN'); ui.render() }
const inspect = (ui, value = snapshot()) => ui.override(url => url === path ? ui.response(value) : null)
const failed = (status, error) => ({ok:false,status,text:async()=>JSON.stringify({ok:false,error})})

test('only the exact desktop application origin marks detection and mutation for gateway authentication', async () => {
  for (const [url, expected] of [['dsh-app://app/settings', '1'], ['dsh-app://not-app/settings', undefined], ['http://127.0.0.1:18777/', undefined]]) {
    const ui = fixture({ location: new URL(url) }); await ui.mount(); open(ui)
    ui.override((requestUrl) => requestUrl === path ? ui.response(snapshot())
      : requestUrl === path + '/apply' ? ui.response(snapshot({ rollbackAvailable: true })) : null)
    await detect(ui)
    click(ui, '应用所选模式…')
    await click(ui, '确认备份并应用')
    assert.equal(calls(ui).length, 2)
    assert.deepEqual(calls(ui).map(({init}) => init.headers['X-USTC-IWAN-Desktop']), [expected, expected])
  }
})

test('Clash diagnostics distinguish saved exclusions from generated profile exclusions', async () => {
  const ui = fixture(); await ui.mount()
  open(ui)
  inspect(ui, snapshot({ state: 'running', running: true, effective: ['192.0.2.0/30', '203.0.113.8/32'] }))
  await detect(ui)
  assert.match(ui.text(), /GUI 已保存/)
  assert.match(ui.text(), /内核生成配置.*203[.]0[.]113[.]8/)
  assert.equal(ui.button('应用所选模式…').props.disabled, true)
})

test('verified backup recovery can finish while the generated configuration still awaits reload', async () => {
  const ui = fixture(); await ui.mount(); open(ui)
  ui.override(url => url === path ? ui.response(snapshot({ state: 'unsupported', rollbackAvailable: true }))
    : url === path + '/rollback' ? ui.response(snapshot({ state: 'unsupported', rollbackAvailable: false, result: 'rolled-back' })) : null)
  await detect(ui)
  assert.equal(ui.button('应用所选模式…').props.disabled, true)
  assert.equal(ui.button('从备份撤销…').props.disabled, false)
  click(ui, '从备份撤销…')
  await click(ui, '确认撤销并恢复备份'); ui.render()
  assert.match(ui.text(), /已撤销本次 Clash TUN 修改并恢复备份/)
})

// Requests use the host envelope, with a raw JSON response also accepted by the shared helper.
test('collapsed Clash controls never inspect on mount, opening, iWAN polls or wake', async () => {
  const ui = fixture(); await ui.mount()
  const disclosure = ui.button('Clash TUN 共存设置')
  assert.equal(disclosure.props['aria-expanded'], false)
  assert.equal(ui.nodes().find(n => n.props.id === disclosure.props['aria-controls']).props.hidden, true)
  assert.equal(ui.button('检测 Clash TUN'), undefined)
  open(ui)
  ui.poll(); ui.emit('focus'); await tick(); ui.render()
  assert.equal(calls(ui).length, 0)
  assert.equal(ui.button('Clash TUN 共存设置').props['aria-expanded'], true)
  const label = ui.element('排除范围')
  assert.equal(label.props.htmlFor, mode(ui).props.id)
  assert.match(mode(ui).props.className, /\bt\b/)
  assert.ok(ui.nodes().some(n => n.props.id === mode(ui).props['aria-describedby']))
  assert.equal(mode(ui).props.value, 'relay')
  assert.equal(mode(ui).children[0].children[0], '仅排除 iWAN 线路')
  assert.match(ui.element('推荐').props.className, /dsh-ustc-badge/)
  assert.match(ui.text(), /只补充 iWAN 线路入口的排除地址，保留原有排除项/)
  assert.equal(ui.button('应用所选模式…').props.disabled, true)
  assert.equal(ui.button('从备份撤销…').props.disabled, true)
  inspect(ui); await detect(ui)
  assert.deepEqual(calls(ui).map(({url,init}) => [url,init.method,init.credentials,init.mode,init.headers['X-USTC-IWAN-TUN'],init.referrerPolicy,init.cache]), [[path, 'GET', 'same-origin', 'same-origin', '1', 'same-origin', 'no-store']])
  assert.match(ui.element('支持自动配置').props.className, /dsh-ustc-pill active/)
  assert.match(ui.text(), /Clash Verge Rev.*TUN 开关设为开启/)
  assert.match(ui.text(), /已覆盖：.*192[.]0[.]2[.]1[/]32/)
  assert.match(ui.text(), /待追加：.*192[.]0[.]2[.]8[/]32/)
  assert.match(ui.text(), /现有排除项.*192[.]0[.]2[.]0[/]30/)
  assert.equal(ui.button('应用所选模式…').props.disabled, false)
  assert.equal(ui.button('从备份撤销…').props.disabled, true)
  ui.poll(); await tick(); ui.render()
  assert.equal(calls(ui).length, 1)
  assert.equal(ui.button('应用所选模式…').props.disabled, false)
})

test('apply requires matching confirmation and verified backup; rollback is a separately confirmed write', async () => {
  const ui = fixture(); await ui.mount(); open(ui)
  ui.override(url => {
    if (url === path) return ui.response(snapshot())
    if (url === path + '/apply') return ui.response(snapshot({ revision:'applied', rollbackAvailable:true,
      modes:{ ...snapshot().modes, campus:{ ...snapshot().modes.campus, missing:[] } } }))
    if (url === path + '/rollback') return ui.response(snapshot({revision:'restored'}))
    return null
  })
  await detect(ui)
  click(ui, '应用所选模式…')
  assert.match(ui.text(), /以「仅排除 iWAN 线路」模式追加上述 1 个地址/)
  const staleRelay = action(ui, '确认备份并应用')
  select(ui, 'campus')
  await staleRelay()
  assert.equal(ui.button('确认备份并应用'), undefined)
  assert.equal(writes(ui).length, 0)
  assert.match(ui.text(), /固定的 11 段内置 USTC 校园网段.*不在这些网段内的 iWAN 线路 IP.*不使用高级设置中的自定义网段/)
  assert.match(ui.text(), /USTC 网段流量绕过 Clash.*可选全系统校内分流失效/)
  assert.match(ui.text(), /待追加：.*198[.]51[.]100[.]0[/]24/)
  click(ui, '应用所选模式…')
  assert.ok(ui.nodes().some(n => n.props['aria-label'] === '确认 Clash TUN 操作'))
  assert.match(ui.text(), /排除全部 USTC 网段.*模式追加上述 2 个地址/)
  assert.equal(writes(ui).length, 0)
  const confirm = action(ui, '确认备份并应用')
  const apply = confirm(); await confirm(); await apply; ui.render()
  assert.match(ui.text(), /已写入排除地址并保存备份.*手动重新启动 Clash/)
  assert.equal(ui.button('应用所选模式…').props.disabled, true)
  assert.equal(ui.button('从备份撤销…').props.disabled, false)
  click(ui, '从备份撤销…'); assert.equal(writes(ui).length, 1)
  click(ui, '取消 Clash TUN 操作'); assert.equal(ui.button('确认撤销并恢复备份'), undefined)
  click(ui, '从备份撤销…'); await click(ui, '确认撤销并恢复备份'); ui.render()
  assert.match(ui.text(), /已撤销本次 Clash TUN 修改并恢复备份.*手动重新启动 Clash/)
  assert.equal(ui.button('从备份撤销…').props.disabled, true)
  assert.deepEqual(writes(ui).map(({url,init}) => [url,JSON.parse(init.body),init.credentials,init.mode,init.headers['X-USTC-IWAN-TUN'],init.headers['Content-Type']]), [
    [path + '/apply', {mode:'campus',revision:'seen'}, 'same-origin', 'same-origin', '1', 'application/json'],
    [path + '/rollback', {revision:'applied'}, 'same-origin', 'same-origin', '1', 'application/json'],
  ])
  assert.ok(ui.element('运行状态'))
})

test('running, unsupported, not found, empty or already covered proposals cannot apply', async () => {
  const noProposal = { ...snapshot().modes, relay:{desired:[],missing:[]} }
  const covered = { ...snapshot().modes, relay:{desired:[relay],missing:[]} }
  for (const [patch, hint, rollback] of [
    [{state:'running',running:true,rollbackAvailable:true}, /完全退出 Clash 后，请再次检测/, false],
    [{state:'ready',running:true,rollbackAvailable:true}, /完全退出 Clash 后，请再次检测/, false],
    [{state:'unsupported',reason:'只能手动',rollbackAvailable:false}, /仅手动配置.*只能手动/, false],
    [{state:'not-found',app:'',revision:null,rollbackAvailable:true}, /未找到 Clash 配置/, false],
    [{state:'ready',revision:null,rollbackAvailable:true}, /支持自动配置/, false],
    [{modes:noProposal,relayCount:0}, /没有可用的线路地址/, false],
    [{modes:covered,rollbackAvailable:true}, /所需地址均已覆盖，无需写入/, true],
  ]) {
    const ui = fixture(); await ui.mount(); open(ui); inspect(ui, snapshot(patch)); await detect(ui)
    assert.match(ui.text(), hint)
    assert.equal(ui.button('应用所选模式…').props.disabled, true)
    assert.equal(ui.button('从备份撤销…').props.disabled, !rollback)
    click(ui, '应用所选模式…'); assert.equal(ui.button('确认备份并应用'), undefined)
    assert.match(ui.text(), /手动配置 Clash TUN.*route-exclude-address/)
    assert.equal(writes(ui).length, 0)
  }
})

test('campus mode does not offer automatic writes when there are no reliable relay IPs', async () => {
  const ui = fixture(); await ui.mount(); open(ui)
  inspect(ui, snapshot({relayCount:0, modes:{relay:{desired:[],missing:[]},campus:{desired:[campus],missing:[campus]}}}))
  await detect(ui); select(ui, 'campus')
  assert.match(ui.text(), /未识别到可用的线路 IP.*校园网段外的线路.*不能自动应用.*IPv4 或 IPv6 地址（不是域名）/)
  assert.doesNotMatch(ui.text(), /已识别线路 IP：0/)
  assert.equal(ui.button('应用所选模式…').props.disabled, true)
  assert.equal(writes(ui).length, 0)
})

test('manual fallback copies proposal text and keeps it selectable without clipboard access', async () => {
  let copied
  const ui = fixture({navigator:{clipboard:{writeText:async text => {copied = text}}}})
  await ui.mount(); open(ui); inspect(ui, snapshot({state:'running',running:true})); await detect(ui)
  select(ui, 'campus')
  await click(ui, '复制待追加的网段'); ui.render()
  assert.equal(copied, relay + '\n' + campus)
  assert.equal(ui.element('已复制待追加的网段').props.role, 'status')
  const unavailable = fixture(); await unavailable.mount(); open(unavailable); inspect(unavailable); await detect(unavailable)
  await click(unavailable, '复制待追加的网段'); unavailable.render()
  assert.match(unavailable.text(), /请手动选中下方网段复制/)
  const manual = unavailable.nodes().find(n => n.props['aria-label'] === '可手动复制的待追加网段')
  assert.equal(manual.children[0], relay)
  assert.equal(manual.props.tabIndex, 0)
})

for (const [state, pill] of [['unsupported', '仅手动配置'], ['not-found', '未找到 Clash 配置']]) {
  test(state + ' copies manual IPv4 and IPv6 candidates without claiming verified coverage', async () => {
    const ipv6 = '2001:db8:1234:5678:9abc:def0:1234:5678/128'
    const relayEntries = [relay, ipv6]
    const campusEntries = [campus, ...relayEntries]
    const copied = []
    const ui = fixture({navigator:{clipboard:{writeText:async text => {copied.push(text)}}}})
    await ui.mount(); open(ui)
    inspect(ui, snapshot({state, coverageKnown:false, revision:null, existing:[], modes:{
      relay:{desired:relayEntries,missing:relayEntries}, campus:{desired:campusEntries,missing:campusEntries},
    }}))
    await detect(ui)
    assert.equal(ui.element(pill).props.className, 'dsh-ustc-pill')
    assert.match(ui.text(), /已识别线路 IP：2.*无法确认现有排除项/)
    assert.doesNotMatch(ui.text(), /TUN 开关设为|未确认 TUN 开关|已覆盖：|待追加：|无需写入/)
    const preview = () => ui.nodes().find(n => n.type === 'ul' && n.props['aria-label'] === '建议核对的网段')
    const chips = () => preview().children.map(item => {
      assert.equal(item.type, 'li')
      assert.equal(item.children[0].type, 'code')
      return item.children[0].children[0]
    })
    assert.deepEqual(chips(), relayEntries)
    assert.match(ui.text(), /并非已确认缺少的网段.*只添加尚未覆盖的项/)
    assert.equal(ui.element('Mihomo 路由排除地址文档').props.href, 'https://wiki.metacubex.one/config/inbound/tun/#route-exclude-address')
    assert.equal(ui.button('复制待追加的网段'), undefined)
    await click(ui, '复制建议核对的网段'); ui.render()
    assert.equal(ui.element('已复制建议核对的网段').props.role, 'status')
    select(ui, 'campus')
    assert.equal(ui.element('已复制建议核对的网段'), undefined)
    assert.deepEqual(chips(), campusEntries)
    const manual = ui.nodes().find(n => n.type === 'pre' && n.props['aria-label'] === '可手动复制的建议网段')
    assert.equal(manual.children[0], campusEntries.join('\n'))
    assert.equal(manual.props.tabIndex, 0)
    await click(ui, '复制建议核对的网段')
    assert.deepEqual(copied, [relayEntries.join('\n'), campusEntries.join('\n')])
    assert.equal(ui.button('应用所选模式…').props.disabled, true)
    assert.equal(ui.button('从备份撤销…').props.disabled, true)
    assert.equal(writes(ui).length, 0)
  })
}

test('a readable empty exclusion list remains a verified diff even in manual-only mode', async () => {
  const ui = fixture(); await ui.mount(); open(ui)
  inspect(ui, snapshot({state:'unsupported', coverageKnown:true, existing:[], modes:{relay:{desired:[relay],missing:[relay]}, campus:{desired:[campus,relay],missing:[campus,relay]}}}))
  await detect(ui)
  assert.match(ui.text(), /已覆盖： 无.*待追加：.*192[.]0[.]2[.]8[/]32/)
  assert.doesNotMatch(ui.text(), /无法确认现有排除项|TUN 开关设为/)
  assert.ok(ui.button('复制待追加的网段'))
  assert.equal(ui.button('复制建议核对的网段'), undefined)
  assert.equal(ui.button('应用所选模式…').props.disabled, true)
  assert.equal(writes(ui).length, 0)
})

test('mode and collapse discard stale detection and stale click handlers', async () => {
  const ui = fixture(); await ui.mount(); open(ui)
  const abandoned = deferred(); ui.override(url => url === path ? abandoned.promise : null)
  const first = click(ui, '检测 Clash TUN')
  assert.equal(mode(ui).props.disabled, false)
  select(ui, 'campus')
  assert.equal(calls(ui)[0].init.signal.aborted, true)
  inspect(ui, snapshot({revision:'current',reason:'新检测结果'})); await detect(ui)
  abandoned.resolve(ui.response(snapshot({revision:'abandoned',reason:'旧检测结果'}))); await first; ui.render()
  assert.doesNotMatch(ui.text(), /旧检测结果/)
  assert.match(ui.text(), /新检测结果/)
  click(ui, '应用所选模式…')
  const staleConfirm = action(ui, '确认备份并应用')
  open(ui); open(ui)
  await staleConfirm(); ui.render()
  assert.equal(writes(ui).length, 0)
  assert.equal(ui.button('应用所选模式…').props.disabled, true)
  assert.doesNotMatch(ui.text(), /新检测结果/)
  const collapsing = deferred(); ui.override(url => url === path ? collapsing.promise : null)
  const request = click(ui, '检测 Clash TUN'); open(ui); open(ui)
  collapsing.resolve(ui.response(snapshot({reason:'收起后不显示'}))); await request; ui.render()
  assert.equal(calls(ui).at(-1).init.signal.aborted, true)
  assert.doesNotMatch(ui.text(), /收起后不显示/)
})

test('a detached write cannot land late or allow a second request before settlement', async () => {
  const ui = fixture(); await ui.mount(); open(ui); inspect(ui); await detect(ui)
  const applying = deferred(); ui.override(url => url === path + '/apply' ? applying.promise : null)
  click(ui, '应用所选模式…'); const apply = click(ui, '确认备份并应用')
  assert.equal(mode(ui).props.disabled, true)
  open(ui); open(ui)
  assert.equal(ui.button('检测 Clash TUN').props.disabled, true)
  await click(ui, '检测 Clash TUN')
  assert.equal(calls(ui).length, 2)
  applying.resolve(ui.response(snapshot({reason:'不可显示的旧写入结果',rollbackAvailable:true}))); await apply; ui.render()
  assert.doesNotMatch(ui.text(), /不可显示的旧写入结果|已写入排除地址/)
  assert.match(ui.text(), /修改可能已生效.*先重新检测，不要直接重试/)
  assert.equal(ui.button('检测 Clash TUN').props.disabled, false)
  assert.equal(ui.button('从备份撤销…').props.disabled, true)
})

test('timeout is unknown, never retried, and only a fresh detection can restore controls', async () => {
  const ui = fixture(); await ui.mount(); open(ui); inspect(ui); await detect(ui)
  const hanging = deferred(); ui.override(url => url === path + '/apply' ? hanging.promise : null)
  click(ui, '应用所选模式…'); const stale = action(ui, '确认备份并应用'); const apply = stale()
  ui.advance(30000); await apply; ui.render()
  assert.match(ui.text(), /修改可能已生效.*先重新检测，不要直接重试/)
  assert.equal(writes(ui)[0].init.signal.aborted, true)
  await stale(); await click(ui, '应用所选模式…'); assert.equal(writes(ui).length, 1)
  inspect(ui, snapshot({revision:'after-timeout',rollbackAvailable:true,reason:'重新检测的配置'})); await detect(ui)
  hanging.resolve(ui.response(snapshot({reason:'超时后的旧应答'}))); await tick(); ui.render()
  assert.match(ui.text(), /重新检测的配置/)
  assert.doesNotMatch(ui.text(), /超时后的旧应答|修改可能已生效/)
  assert.equal(ui.button('从备份撤销…').props.disabled, false)
  assert.equal(writes(ui).length, 1)
})

for (const [status, text] of [[409,/因冲突.*重新检测/], [423,/仍在运行.*完全退出/], [501,/不支持自动写入.*手动/]]) {
  test('write status ' + status + ' is actionable and discards the inspected revision', async () => {
    const ui = fixture(); await ui.mount(); open(ui); inspect(ui); await detect(ui)
    ui.override(url => url === path + '/apply' ? failed(status, 'server reason') : null)
    click(ui, '应用所选模式…'); await click(ui, '确认备份并应用'); ui.render()
    assert.ok(ui.nodes().find(n => n.props.role === 'alert' && text.test(n.children[0])))
    assert.doesNotMatch(ui.text(), /已写入排除地址/)
    assert.equal(ui.button('应用所选模式…').props.disabled, true)
    await click(ui, '应用所选模式…'); assert.equal(writes(ui).length, 1)
  })
}

test('unmount aborts work and suppresses state updates even from fetch ignoring abort', async () => {
  for (const kind of ['inspect','apply']) {
    const ui = fixture(); await ui.mount(); open(ui)
    if (kind === 'apply') { inspect(ui); await detect(ui); click(ui, '应用所选模式…') }
    const hanging = deferred(); ui.override(url => url.startsWith(path) ? hanging.promise : null)
    const pending = click(ui, kind === 'inspect' ? '检测 Clash TUN' : '确认备份并应用')
    ui.unmount()
    hanging.resolve(ui.response(snapshot({rollbackAvailable:true}))); await pending; await tick()
    assert.equal(calls(ui).at(-1).init.signal.aborted, true)
    assert.equal(ui.staleUpdates(), 0)
    assert.equal(ui.timeoutCount(), 0)
  }
})

test('Clash requests do not cancel or replace existing iWAN operations or status', async () => {
  const ui = fixture(); await ui.mount(); open(ui)
  const clash = deferred(); const iwan = deferred()
  ui.override(url => url === path ? clash.promise : url.endsWith('/connect') ? iwan.promise : null)
  const attaching = click(ui, '启动 iWAN'); const detecting = click(ui, '检测 Clash TUN')
  const connect = ui.requests.find(x => x.url.endsWith('/connect'))
  assert.equal(connect.init.signal.aborted, false)
  assert.equal(ui.button('停止托管').props.disabled, false)
  ui.poll(); await tick(); ui.render()
  clash.resolve(ui.response(snapshot())); await detecting; ui.render()
  assert.equal(connect.init.signal.aborted, false)
  assert.equal(ui.button('应用所选模式…').props.disabled, false)
  assert.ok(ui.element('启动中…'))
  iwan.resolve(ui.response({started:true})); await attaching; ui.render()
  assert.ok(ui.element('运行状态'))
  assert.equal(ui.button('应用所选模式…').props.disabled, false)
  assert.equal(calls(ui).length, 1)
})
