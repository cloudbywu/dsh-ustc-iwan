import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { BINARY_NAME, ARCHIVE_NAME, DOWNLOAD_URL, RELEASE_API_URL, binaryState, cachedBinaryPath, checkForUpdates, waitForUpdateCheck, cancelUpdateCheck, startDownload, waitForDownload, cancelDownload, downloadState } from '../lib/binary.js'

async function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-iwan-update-'))
  const before = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  t.after(async () => {
    await cancelUpdateCheck(); await cancelDownload()
    if (before === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = before
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

function installed(meta = {}) {
  const file = cachedBinaryPath()
  const binary = Buffer.from('MZ-inert-test-data')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, binary, { mode: 0o700 })
  fs.writeFileSync(file + '.meta.json', JSON.stringify({ bytes: binary.length, sha256: crypto.createHash('sha256').update(binary).digest('hex'), ...meta }))
  return file
}

const assetUrl = tag => `https://github.com/yyy1mu/ustc-iwan/releases/download/${tag}/${ARCHIVE_NAME}`
const release = (tag = 'v2.0.0') => ({ tag_name: tag, assets: [{ name: ARCHIVE_NAME, browser_download_url: assetUrl(tag) }] })
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })

// A tiny stored ZIP containing inert bytes; never downloads or runs a real executable.
function zip() {
  const data = Buffer.from('MZ-inert-new-client')
  const name = Buffer.from(BINARY_NAME)
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  crc = (crc ^ 0xffffffff) >>> 0
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + data.length, 16)
  return Buffer.concat([local, name, data, central, name, end])
}

test('binaryState reads persisted version/time across module restart without network', async t => {
  await home(t)
  t.mock.method(globalThis, 'fetch', () => { throw new Error('status must not fetch') })
  const at = '2025-01-02T03:04:05.000Z'
  installed({ version: 'v1.0.0', at })
  const fresh = await import('../lib/binary.js?restart=' + crypto.randomUUID())
  const state = fresh.binaryState()
  assert.equal(state.installed, true); assert.equal(state.downloaded, true)
  assert.equal(state.version, 'v1.0.0'); assert.equal(state.installedAt, Date.parse(at))
  assert.equal(state.updateAvailable, null); assert.equal(state.latestVersion, null)
  assert.equal(state.checking, false); assert.equal(state.checkedAt, null); assert.equal(state.updateError, null)
})

test('legacy metadata remains installed but unknown version is not declared current', async t => {
  await home(t); installed({ at: Date.now() })
  t.mock.method(globalThis, 'fetch', async () => json(release()))
  await checkForUpdates()
  const state = binaryState()
  assert.equal(state.installed, true); assert.equal(state.version, null)
  assert.equal(state.latestVersion, 'v2.0.0'); assert.equal(state.updateAvailable, null)
})

test('manual active path is never reported downloaded or probed for version', async t => {
  const dir = await home(t); installed({ version: 'v1.0.0', at: Date.now() })
  const manual = path.join(dir, 'trusted.exe')
  fs.writeFileSync(manual, 'do not execute this file', { mode: 0o700 })
  t.mock.method(globalThis, 'fetch', async () => json(release()))
  await checkForUpdates(manual)
  const state = binaryState(manual)
  assert.equal(state.kind, 'configured'); assert.equal(state.path, manual)
  assert.equal(state.installed, true); assert.equal(state.downloaded, false)
  assert.equal(state.version, null); assert.equal(state.installedAt, null); assert.equal(state.updateAvailable, null)
  assert.equal(fs.readFileSync(manual, 'utf8'), 'do not execute this file')
})

test('explicit checks share a promise, retain installed state and block downloads', async t => {
  await home(t); installed({ version: 'v1.0.0' })
  let respond; let calls = 0
  t.mock.method(globalThis, 'fetch', () => { calls++; return new Promise(resolve => { respond = resolve }) })
  const first = checkForUpdates()
  assert.equal(first, checkForUpdates())
  assert.equal(binaryState().checking, true); assert.equal(binaryState().installed, true)
  const before = downloadState()
  assert.equal((await startDownload()).started, false)
  assert.deepEqual(downloadState(), before)
  await Promise.resolve(); respond(json(release()))
  await waitForUpdateCheck(); await first
  assert.equal(calls, 1); assert.equal(binaryState().checking, false)
  assert.equal(binaryState().updateAvailable, true); assert.ok(binaryState().checkedAt > 0)
})

test('same normalized version is current only when installed version is known', async t => {
  await home(t); installed({ version: '2.0.0' })
  t.mock.method(globalThis, 'fetch', async () => json(release()))
  await checkForUpdates()
  assert.equal(binaryState().updateAvailable, false)
})

test('check validates release tag, target asset and trusted HTTPS repository URL', async t => {
  await home(t); installed({ version: 'v1.0.0' })
  const bad = [
    { ...release(), tag_name: '../escape' },
    { ...release(), assets: [] },
    { ...release(), draft: true },
    { ...release(), assets: [...release().assets, ...release().assets] },
    ...[
      'http://github.com/yyy1mu/ustc-iwan/releases/download/v2.0.0/' + ARCHIVE_NAME,
      'https://evil.test/' + ARCHIVE_NAME,
      'https://github.com.evil.test/yyy1mu/ustc-iwan/releases/download/v2.0.0/' + ARCHIVE_NAME,
      'https://github.com/other/repo/releases/download/v2.0.0/' + ARCHIVE_NAME,
      assetUrl('v3.0.0'), assetUrl('v2.0.0') + '?token=x',
      assetUrl('v2.0.0').replace(ARCHIVE_NAME, 'wrong.zip'),
    ].map(url => ({ ...release(), assets: [{ name: ARCHIVE_NAME, browser_download_url: url }] })),
  ]
  let value
  t.mock.method(globalThis, 'fetch', async () => json(value))
  for (value of bad) {
    await checkForUpdates()
    assert.ok(binaryState().updateError); assert.equal(binaryState().installed, true)
    assert.equal(binaryState().version, 'v1.0.0'); assert.equal(binaryState().latestVersion, null)
  }
  value = release(); await checkForUpdates()
  assert.equal(binaryState().updateError, null); assert.equal(binaryState().updateAvailable, true)
})

test('check bounds declared and streamed JSON and recovers from bad JSON/HTTP', async t => {
  await home(t); installed({ version: 'v1.0.0' })
  let response
  t.mock.method(globalThis, 'fetch', async () => response)
  const responses = [
    new Response('x', { headers: { 'content-length': String(512 * 1024 + 1) } }),
    new Response(' '.repeat(512 * 1024 + 1)),
    new Response('not json'), new Response('no', { status: 403 }),
    new Response(null, { status: 302, headers: { location: 'http://evil.test/' } }),
  ]
  for (response of responses) {
    await checkForUpdates()
    assert.ok(binaryState().updateError); assert.equal(binaryState().installed, true)
  }
  response = json(release()); await checkForUpdates()
  assert.equal(binaryState().updateError, null)
})

test('checks time out and cancel even when fetch/body ignore abort', async t => {
  await home(t); installed({ version: 'v1.0.0' })
  let stream = false
  t.mock.method(globalThis, 'fetch', () => stream ? Promise.resolve(new Response(new ReadableStream({ pull() { return new Promise(() => {}) } }))) : new Promise(() => {}))
  await checkForUpdates('', () => {}, { timeoutMs: 10 })
  assert.match(binaryState().updateError, /超时/); assert.equal(binaryState().checking, false)
  stream = true
  const checking = checkForUpdates()
  await Promise.resolve(); await Promise.resolve()
  await cancelUpdateCheck(); await checking
  assert.match(binaryState().updateError, /取消/); assert.equal(binaryState().installed, true)
})

test('download blocks checks without overwriting update state and ignores progress for installed', async t => {
  await home(t)
  t.mock.method(globalThis, 'fetch', () => new Promise(() => {}))
  const before = binaryState()
  await startDownload()
  assert.equal((await checkForUpdates()).started, false)
  assert.deepEqual(binaryState(), before)
  await cancelDownload()
  assert.equal(binaryState().installed, false)
})

test('update requires a check, pins exact checked release, persists metadata and survives restart', async t => {
  await home(t); installed({ version: 'v1.0.0' })
  assert.equal((await startDownload(() => {}, { mode: 'update' })).started, false)
  const urls = []
  t.mock.method(globalThis, 'fetch', async url => { urls.push(url); return url === RELEASE_API_URL ? json(release()) : new Response(zip()) })
  await checkForUpdates()
  await startDownload(() => {}, { mode: 'update' }); await waitForDownload()
  assert.deepEqual(urls, [RELEASE_API_URL, assetUrl('v2.0.0')])
  assert.equal(downloadState().state, 'done'); assert.equal(binaryState().version, 'v2.0.0')
  assert.equal(binaryState().updateAvailable, false)
  const meta = JSON.parse(fs.readFileSync(cachedBinaryPath() + '.meta.json', 'utf8'))
  assert.equal(meta.releaseTag, 'v2.0.0'); assert.equal(meta.source, RELEASE_API_URL)
  const fresh = await import('../lib/binary.js?restart=' + crypto.randomUUID())
  assert.equal(fresh.binaryState().version, 'v2.0.0'); assert.ok(fresh.binaryState().installedAt > 0)
  fs.rmSync(cachedBinaryPath())
  assert.equal(downloadState().state, 'done'); assert.equal(binaryState().installed, false)
})

test('reinstall with unknown installed version fetches newest release instead of stale check', async t => {
  await home(t); installed()
  let tag = 'v2.0.0'; const urls = []
  t.mock.method(globalThis, 'fetch', async url => { urls.push(url); return url === RELEASE_API_URL ? json(release(tag)) : new Response(zip()) })
  await checkForUpdates(); tag = 'v3.0.0'
  await startDownload(() => {}, { mode: 'reinstall' }); await waitForDownload()
  assert.deepEqual(urls, [RELEASE_API_URL, RELEASE_API_URL, assetUrl('v3.0.0')])
  assert.equal(binaryState().version, 'v3.0.0'); assert.equal(binaryState().updateAvailable, false)
})

test('normal download records GitHub redirect version without release API query', async t => {
  await home(t); const urls = []
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(url)
    return url === DOWNLOAD_URL ? new Response(null, { status: 302, headers: { location: assetUrl('v4.0.0') } }) : new Response(zip())
  })
  await startDownload(); await waitForDownload()
  assert.deepEqual(urls, [DOWNLOAD_URL, assetUrl('v4.0.0')]); assert.equal(binaryState().version, 'v4.0.0')
  assert.equal(binaryState().updateAvailable, null)
})

test('download rejects untrusted HTTPS redirects and failed update retains old version', async t => {
  await home(t); installed({ version: 'v1.0.0', at: 12345 })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async url => {
    calls++
    return url === RELEASE_API_URL ? json(release()) : new Response(null, { status: 302, headers: { location: 'https://evil.test/client.zip' } })
  })
  await checkForUpdates(); await startDownload(() => {}, { mode: 'update' }); await waitForDownload()
  assert.equal(calls, 2); assert.match(downloadState().error, /不可信/)
  assert.equal(binaryState().installed, true); assert.equal(binaryState().version, 'v1.0.0')
  assert.equal(binaryState().installedAt, 12345); assert.equal(binaryState().updateAvailable, true)
})

test('normal download records the final GitHub tag through CDN redirect', async t => {
  await home(t)
  const cdn = 'https://release-assets.githubusercontent.com/github-production-release-asset/test?signature=abc'
  t.mock.method(globalThis, 'fetch', async url => {
    if (url === cdn) return new Response(zip())
    const location = url === DOWNLOAD_URL ? assetUrl('v1.0.0') : url === assetUrl('v1.0.0') ? assetUrl('v5.0.0') : cdn
    return new Response(null, { status: 302, headers: { location } })
  })
  await startDownload(); await waitForDownload()
  assert.equal(downloadState().state, 'done'); assert.equal(binaryState().version, 'v5.0.0')
})

test('pinned update rejects changed release tag or another GitHub repository', async t => {
  await home(t); installed({ version: 'v1.0.0' })
  let location = assetUrl('v3.0.0')
  t.mock.method(globalThis, 'fetch', async url => url === RELEASE_API_URL ? json(release()) : new Response(null, { status: 302, headers: { location } }))
  await checkForUpdates(); await startDownload(() => {}, { mode: 'update' }); await waitForDownload()
  assert.match(downloadState().error, /不匹配/); assert.equal(binaryState().version, 'v1.0.0')
  location = 'https://github.com/other/repo/releases/download/v2.0.0/' + ARCHIVE_NAME
  await startDownload(() => {}, { mode: 'update' }); await waitForDownload()
  assert.match(downloadState().error, /不可信/); assert.equal(binaryState().version, 'v1.0.0')
})

test('cancel before check starts avoids fetch and stalled download streams are bounded', async t => {
  await home(t); let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return new Response(new ReadableStream({ pull() { return new Promise(() => {}) } }))
  })
  const checking = checkForUpdates(); await cancelUpdateCheck(); await checking
  assert.equal(calls, 0); assert.match(binaryState().updateError, /取消/)
  await startDownload(() => {}, { timeoutMs: 10 })
  await new Promise(resolve => setTimeout(resolve, 25)); await waitForDownload()
  assert.match(downloadState().error, /超时/)
  assert.equal(fs.existsSync(cachedBinaryPath() + '.part'), false)
})

test('reinstall with known version re-downloads that version without upgrading or new API lookup',async t=>{
  await home(t);installed({version:'v1.0.0'});const calls=[]
  t.mock.method(globalThis,'fetch',async url=>{calls.push(url);return url===RELEASE_API_URL?json(release('v2.0.0')):new Response(zip())})
  await checkForUpdates();assert.equal(binaryState().updateAvailable,true)
  await startDownload(()=>{},{mode:'reinstall'});await waitForDownload()
  assert.deepEqual(calls,[RELEASE_API_URL,assetUrl('v1.0.0')]);assert.equal(binaryState().version,'v1.0.0');assert.equal(binaryState().latestVersion,'v2.0.0')
})

test('version comparison distinguishes upgrade, prerelease, equal and unorderable tags',async t=>{
  await home(t);let target
  t.mock.method(globalThis,'fetch',async()=>json(release(target)))
  for(const [local,remote,expected] of [
    ['v3.0.0','v2.0.0',false],['v1.10.0','v1.9.0',false],['v1.0.0-rc.2','v1.0.0',true],
    ['v1.0.0-rc.2','v1.0.0-rc.10',true],['v1.0.0','v1.0.0-rc.1',false],
    ['v1.0.0+local','v1.0.0',false],['V1.0.0','v1.0.0',false],['nightlyA','nightlyB',null],
  ]){installed({version:local});target=remote;await checkForUpdates();assert.equal(binaryState().updateAvailable,expected,local+' -> '+remote)}
})

test('explicit update does not downgrade a higher installed version',async t=>{
  await home(t);installed({version:'v3.0.0'});let calls=0
  t.mock.method(globalThis,'fetch',async()=>{calls++;return json(release('v2.0.0'))})
  await checkForUpdates();const result=await startDownload(()=>{},{mode:'update'})
  assert.equal(result.started,false);assert.equal(calls,1);assert.equal(binaryState().version,'v3.0.0')
})
