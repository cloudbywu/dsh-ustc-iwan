import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { readCredentialRelayIps, readCredentialRelayPlan, readCredentialStatus } from '../lib/credentials.js'

// Every credential below is synthetic. No real user config is opened.
const cipher = Buffer.alloc(40, 0xa5).toString('base64url')
const server = (overrides = {}) => ({ name: '教育网 Synthetic', host: '192.0.2.1', port: 6001, username: 'synthetic-user', passWord: cipher, salt: '', mtu: null, ...overrides })
const config = (servers = [server()]) => ({ domain: 'synthetic.invalid', servers })
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iwan-credentials-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'servers.json')
  return { dir, file, write(value) { fs.writeFileSync(file, JSON.stringify(value)) }, read(options = {}) { return readCredentialStatus({ configDir: dir, ...options }) } }
}
function redacted(status, secrets = []) {
  assert.deepEqual(Object.keys(status).sort(), ['state', 'expiresAt', 'serverCount', 'message', 'source', 'revision'].sort())
  assert.equal(status.expiresAt, null)
  for (const value of secrets) assert.ok(!JSON.stringify(status).includes(value), 'status must not contain sensitive input')
}

test('TUN relay lookup returns only literal IPs and never exposes credentials', t => {
  const f = fixture(t), options = { configDir: f.dir }
  assert.deepEqual(readCredentialRelayIps(options), [])
  f.write(config([server(), server(), server({ host: '2001:DB8::1' }),
    server({ host: 'relay.example.test' }), server({ host: 'fe80::1%5' }), null]))
  assert.deepEqual(readCredentialRelayIps(options), ['192.0.2.1', '2001:db8::1'])
  fs.writeFileSync(f.file, 'bad JSON')
  assert.deepEqual(readCredentialRelayIps(options), [])
})

test('relay plans keep CLI selection, deduplicate endpoints, and reserve late IDs in file order', t => {
  const f = fixture(t)
  const plan = (choice) => readCredentialRelayPlan({ configDir: f.dir, server: choice })
  const firstHost = 'synthetic-relay.example.test'
  const { port, ...firstWithoutPort } = server({ name: 'Line default port', host: firstHost.toUpperCase() })
  f.write(config([
    server({ name: 'Line first', host: firstHost }),
    firstWithoutPort,
    server({ host: firstHost, port: port + 1 }),
    server({ host: '192.0.2.4', passWord: 'invalid envelope' }),
    server({ host: '192.0.2.5' }),
    server({ host: '192.0.2.6' }),
    server({ name: 'Line alias', host: firstHost }),
    server({ host: '192.0.2.8' }),
    server({ host: '192.0.2.9' }),
    server({ host: '192.0.2.10' }),
  ]))
  for (const choice of [undefined, '', 'Line', '+01']) {
    assert.deepEqual(plan(choice), { selected: '1', candidates: ['1', '3', '5', '6'] })
  }
  assert.deepEqual(plan('auto'), { selected: null, candidates: ['1', '3', '5', '6'] })
  assert.deepEqual(plan('default port'), { selected: '2', candidates: ['2', '3', '5', '6'] })
  for (const choice of ['+007', 'Line alias']) {
    assert.deepEqual(plan(choice), { selected: '7', candidates: ['3', '5', '6', '7'] })
  }
  assert.deepEqual(plan('10'), { selected: '10', candidates: ['1', '3', '5', '10'] })
  for (const choice of [4, '0', '4', '11', 'line', 'Auto']) {
    assert.deepEqual(plan(choice), { selected: null, candidates: [] })
  }
})

const emptyPlan = { selected: null, candidates: [] }

test('relay plans retain a sole viable ID and do not fall back from an invalid selection', t => {
  const f = fixture(t)
  const plan = (choice) => readCredentialRelayPlan({ configDir: f.dir, server: choice })
  assert.deepEqual(plan(), emptyPlan)
  f.write(config([]))
  assert.deepEqual(plan(), emptyPlan)
  assert.deepEqual(plan('auto'), emptyPlan)
  f.write(config([server(), server()]))
  assert.deepEqual(plan(), { selected: '1', candidates: ['1'] })
  assert.deepEqual(plan('2'), { selected: '2', candidates: ['2'] })
  assert.deepEqual(plan('auto'), { selected: null, candidates: ['1'] })
  f.write(config([
    server({ name: 'First unavailable', passWord: '' }),
    server({ name: 'Second unavailable', port: 0 }),
    server({ host: ' ' }),
    server({ name: 'Fourth unavailable' }),
  ]))
  assert.deepEqual(plan(), emptyPlan)
  assert.deepEqual(plan('unavailable'), emptyPlan)
  assert.deepEqual(plan('auto'), { selected: null, candidates: ['4'] })
})

test('missing file and empty server list report missing, without leaking paths', t => {
  const f = fixture(t)
  const missing = f.read()
  assert.equal(missing.state, 'missing')
  assert.equal(missing.revision, null)
  redacted(missing, [f.dir])
  f.write(config([]))
  assert.equal(f.read().state, 'missing')
  assert.equal(f.read().serverCount, 0)
})

test('actual upstream password schema is unknown, not locally valid', t => {
  const f = fixture(t)
  f.write(config())
  const status = f.read()
  assert.equal(status.state, 'unknown')
  assert.equal(status.serverCount, 1)
  assert.equal(status.source, 'servers.json:upstream-password-schema')
  assert.match(status.message, /未保存有效期.*未解密.*未进行在线/)
  assert.equal(typeof status.revision, 'string')
  redacted(status, [cipher, 'synthetic-user', '192.0.2.1', 'Synthetic', f.dir, 'synthetic.invalid'])
})

test('default and ~/ paths follow CLI home rather than XDG/APPDATA', t => {
  const f = fixture(t), old = {}
  for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'APPDATA', 'SUDO_USER']) { old[key] = process.env[key]; delete process.env[key] }
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  process.env.HOME = process.env.USERPROFILE = f.dir
  process.env.XDG_CONFIG_HOME = process.env.APPDATA = path.join(f.dir, 'wrong')
  const defaultDir = path.join(f.dir, '.config', 'iwan')
  fs.mkdirSync(defaultDir, { recursive: true })
  fs.writeFileSync(path.join(defaultDir, 'servers.json'), JSON.stringify(config()))
  assert.equal(readCredentialStatus().state, 'unknown')
  assert.equal(readCredentialStatus({ configDir: '~/.config/iwan' }).serverCount, 1)
})

test('upstream optional defaults and standard/padded base64 are supported', t => {
  const f = fixture(t)
  for (const passWord of [cipher, Buffer.alloc(40, 0xff).toString('base64'), Buffer.alloc(30, 0xff).toString('base64url')]) {
    f.write({ servers: [{ host: '192.0.2.2', username: 'synthetic', passWord }] })
    assert.equal(f.read().state, 'unknown')
  }
})

test('unknown schemas and fabricated expiration, JWT or certificate fields never assert validity', t => {
  const f = fixture(t)
  const jwt = 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify({ exp: 2000000000 })).toString('base64url') + '.synthetic'
  for (const raw of [null, [], {}, { token: jwt }, { serverlist: { serverlist: [server()] } }]) { f.write(raw); assert.equal(f.read().state, 'unknown') }
  f.write({ ...config([{ ...server(), exp: 1, expiresAt: 2000000000000, certificate: 'synthetic-cert' }]), access_token: jwt, id_token: jwt, expires_at: 1, authState: 'done' })
  const stat = fs.statSync(f.file)
  for (const now of [0, 1999999999000, 2000000000000, 2000000001000, 8640000000000000]) {
    const status = f.read({ now })
    assert.equal(status.state, 'unknown')
    redacted(status, [jwt, 'synthetic-cert', cipher])
  }
  assert.equal(fs.statSync(f.file).mtimeMs, stat.mtimeMs)
})

test('explicit server selection follows CLI index and first case-sensitive name substring', t => {
  const f = fixture(t)
  f.write(config([server({ name: 'Line A', passWord: '' }), server({ name: 'Line B' }), server({ name: 'Other', username: 3 })]))
  assert.equal(f.read().state, 'unknown')
  for (const choice of ['1', '+01', 'Line']) assert.equal(f.read({ server: choice }).state, 'missing')
  for (const choice of ['2', 'Line B']) { const s = f.read({ server: choice }); assert.equal(s.state, 'unknown'); assert.equal(s.serverCount, 3) }
  for (const choice of ['0', '4', 'line', 'not-found']) assert.equal(f.read({ server: choice }).state, 'invalid')
  assert.equal(f.read({ server: '3' }).state, 'invalid')
  assert.match(f.read({ server: 'auto' }).message, /测速/)
})

test('missing credentials and invalid known fields are distinguished', t => {
  const f = fixture(t)
  for (const missing of [{}, { host: '' }, { username: '' }, { passWord: '' }]) {
    f.write(config([Object.keys(missing).length ? server(missing) : {}])); assert.equal(f.read().state, 'missing')
  }
  for (const invalid of [null, [], 1, { host: 1 }, { username: null }, { salt: false }, { mtu: -1 }, { port: 65536 }, { port: 1.5 }, { passWord: 'not base64!' }, { passWord: 'aGk=' }]) {
    f.write(config([invalid && typeof invalid === 'object' && !Array.isArray(invalid) ? server(invalid) : invalid])); assert.equal(f.read().state, 'invalid')
  }
  for (const raw of [{ servers: null }, { ...config(), domain: 1 }]) { f.write(raw); assert.equal(f.read().state, 'invalid') }
})

test('invalid UTF-8, malformed/dangerous JSON, non-files and excessive input are rejected', t => {
  const f = fixture(t)
  const plan = () => readCredentialRelayPlan({ configDir: f.dir, server: 'auto' })
  for (const content of ['{synthetic-secret', '{"__proto__":{"polluted":true}}', '{"constructor":"synthetic-secret"}', '{"prototype":{}}', Buffer.from([0xff, 0xfe])]) {
    fs.writeFileSync(f.file, content)
    const status = f.read()
    assert.equal(status.state, 'invalid')
    redacted(status, ['synthetic-secret', f.dir])
    assert.deepEqual(plan(), emptyPlan)
  }
  assert.equal({}.polluted, undefined)
  fs.writeFileSync(f.file, ' '.repeat(1024 * 1024 + 1))
  assert.equal(f.read().state, 'invalid')
  assert.match(f.read().message, /1 MiB/)
  assert.deepEqual(plan(), emptyPlan)
  f.write(config([server(), ...Array.from({ length: 4096 }, () => ({}))]))
  assert.equal(f.read().state, 'invalid')
  assert.deepEqual(plan(), emptyPlan)
  f.write({ ...config(), domain: 1 })
  assert.deepEqual(plan(), emptyPlan)
  fs.rmSync(f.file)
  fs.mkdirSync(f.file)
  assert.equal(f.read().state, 'invalid')
  assert.deepEqual(plan(), emptyPlan)
})

test('file symlinks are not followed', t => {
  const f = fixture(t)
  const target = path.join(f.dir, 'synthetic-target.json')
  fs.writeFileSync(target, JSON.stringify(config()))
  try { fs.symlinkSync(target, f.file, 'file') } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return t.skip('host does not permit synthetic symlinks')
    throw error
  }
  const read = t.mock.method(fs, 'openSync', () => { throw new Error('must not follow symlink') })
  assert.equal(f.read().state, 'invalid')
  assert.equal(read.mock.callCount(), 0)
})

test('read errors are clear and never include error data or user paths', t => {
  const f = fixture(t)
  f.write(config())
  for (const code of ['EACCES', 'EPERM', 'EIO']) {
    const mocked = t.mock.method(fs, 'lstatSync', () => { const error = new Error('synthetic-password ' + f.dir); error.code = code; throw error })
    const status = f.read()
    assert.equal(status.state, 'unknown')
    assert.match(status.message, code === 'EIO' ? /读取.*失败/ : /读取被拒绝/)
    redacted(status, ['synthetic-password', f.dir])
    assert.deepEqual(readCredentialRelayPlan({ configDir: f.dir }), emptyPlan)
    mocked.mock.restore()
  }
})

test('revision is stat-only and changes on replacement, even when mtime is restored', t => {
  const f = fixture(t)
  f.write(config())
  const oldStat = fs.statSync(f.file), first = f.read()
  assert.equal(f.read({ now: 1 }).revision, first.revision)
  const replacement = path.join(f.dir, 'synthetic-replacement.json')
  fs.writeFileSync(replacement, JSON.stringify(config([server({ passWord: '' })])))
  fs.utimesSync(replacement, oldStat.atime, oldStat.mtime)
  fs.renameSync(replacement, f.file)
  const second = f.read({ now: 2 })
  assert.equal(second.state, 'missing')
  assert.notEqual(second.revision, first.revision)
  assert.match(second.revision, /^[0-9:.e+-]+$/)
  redacted(second, [f.dir, cipher])
  fs.rmSync(f.file)
  assert.equal(f.read().revision, null)
})

test('invalid API parameters fail closed before reading a file', t => {
  const f = fixture(t)
  for (const options of [null, [], { configDir: null }, { configDir: '\0' }, { server: 2 }, { now: NaN }, { now: Infinity }, { now: '2000000000' }]) {
    assert.equal(readCredentialStatus(options).state, 'invalid')
  }
  assert.equal(f.read({ now: -1 }).state, 'missing')
})

test('mocked symlink is rejected before opening, including hosts without symlink privileges', t => {
  const f = fixture(t)
  t.mock.method(fs, 'lstatSync', () => ({ isFile: () => false, isSymbolicLink: () => true }))
  const opened = t.mock.method(fs, 'openSync', () => { throw new Error('unexpected open') })
  assert.equal(f.read().state, 'invalid')
  assert.deepEqual(readCredentialRelayPlan({ configDir: f.dir }), emptyPlan)
  assert.equal(opened.mock.callCount(), 0)
})

test('growth and changes during reading fail closed with a null revision', t => {
  const f = fixture(t)
  f.write(config())
  const original = fs.fstatSync
  let call = 0
  const changing = t.mock.method(fs, 'fstatSync', fd => {
    const stat = original(fd)
    if (++call === 2) stat.mtimeMs += 1
    return stat
  })
  assert.equal(f.read().state, 'unknown')
  call = 0
  assert.equal(f.read().revision, null)
  changing.mock.restore()
  const growing = t.mock.method(fs, 'readSync', (_fd, buffer) => { buffer.fill(32); return buffer.length })
  assert.equal(f.read().state, 'invalid')
  assert.match(f.read().message, /1 MiB/)
  growing.mock.restore()
})

function platformEnv(t, platform, env) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  const old = {}
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
  for (const [key, value] of Object.entries(env)) { old[key] = process.env[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value }
  t.after(() => {
    Object.defineProperty(process, 'platform', descriptor)
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  })
}

test('Linux sudo uses bounded shell-free getent for the original user home', t => {
  const f = fixture(t)
  const dir = path.join(f.dir, '.config', 'iwan')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'servers.json'), JSON.stringify(config()))
  platformEnv(t, 'linux', { SUDO_USER: 'synthetic-sudo', HOME: path.join(f.dir, 'wrong-home') })
  const lstat = fs.lstatSync, open = fs.openSync
  const expected = path.join('/synthetic/home', '.config', 'iwan', 'servers.json')
  const syntheticFile = path.join(dir, 'servers.json')
  t.mock.method(fs, 'lstatSync', file => { assert.equal(file, expected); return lstat(syntheticFile) })
  t.mock.method(fs, 'openSync', (file, flags) => { assert.equal(file, expected); return open(syntheticFile, flags) })
  const queried = t.mock.method(childProcess, 'execFileSync', (cmd, args, opts) => {
    assert.equal(cmd, 'getent')
    assert.deepEqual(args, ['passwd', 'synthetic-sudo'])
    assert.equal(opts.timeout, 1000)
    assert.equal(opts.maxBuffer, 64 * 1024)
    assert.equal(opts.shell, undefined)
    return 'synthetic-sudo:x:123:123::/synthetic/home:/bin/false\n'
  })
  syncBuiltinESMExports()
  t.after(() => { queried.mock.restore(); syncBuiltinESMExports() })
  assert.equal(readCredentialStatus().state, 'unknown')
  assert.equal(queried.mock.callCount(), 1)
})

test('Linux sudo fallback matches upstream and does not read another user home', t => {
  platformEnv(t, 'linux', { SUDO_USER: 'synthetic-no-such-user' })
  const queried = t.mock.method(childProcess, 'execFileSync', () => { throw new Error('synthetic lookup failure') })
  syncBuiltinESMExports()
  t.after(() => { queried.mock.restore(); syncBuiltinESMExports() })
  t.mock.method(fs, 'lstatSync', file => {
    assert.equal(file, path.join('/home/synthetic-no-such-user', '.config', 'iwan', 'servers.json'))
    const error = new Error('synthetic'); error.code = 'ENOENT'; throw error
  })
  assert.equal(readCredentialStatus().state, 'missing')
})

test('Windows home fallback uses HOMEDRIVE + HOMEPATH before HOME', t => {
  const f = fixture(t), root = path.parse(f.dir).root
  const drive = root.endsWith(path.sep) ? root.slice(0, -1) : root
  platformEnv(t, 'win32', { USERPROFILE: undefined, HOMEDRIVE: drive || '/', HOMEPATH: f.dir.slice(drive.length), HOME: path.join(f.dir, 'wrong-home') })
  const dir = path.join(f.dir, '.config', 'iwan')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'servers.json'), JSON.stringify(config()))
  assert.equal(readCredentialStatus().state, 'unknown')
})
