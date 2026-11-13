import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import test from 'node:test'
import assert from 'node:assert/strict'
import { name as hostName } from '../lib/index.js'

const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8')
const metadata = JSON.parse(read('package.json'))
const packageName = '@cloudbywu/dsh-ustc-iwan'

test('package metadata uses the public scoped name and keeps repository identity', () => {
  assert.equal(metadata.name, packageName)
  assert.equal(metadata.publishConfig.access, 'public')
  assert.equal(metadata.repository.url, 'git+https://github.com/cloudbywu/dsh-ustc-iwan.git')
  assert.ok(metadata.scripts.test)
  assert.ok(metadata.scripts.check)
})

test('Host plugin name matches the npm package', () => {
  assert.equal(hostName, packageName)
})

test('browser loader ID matches the scoped package', () => {
  let entry
  vm.runInNewContext(read('lib/client.js'), {window:{__ModuleLoader__:{load:value=>{entry=value}}}})
  assert.equal(entry.id, packageName)
  assert.equal(typeof entry.factory, 'function')
})

test('bundle resolves the scoped package while retaining stable instance ID', () => {
  const patch = read(metadata.dsh.bundle.patch)
  assert.equal(patch.match(/name: '([^']+)'/)[1], packageName)
  assert.match(patch, /id: dsh-ustc-iwan/)
  assert.ok(fs.existsSync(new URL('../' + metadata.main, import.meta.url)))
  assert.ok(fs.existsSync(new URL('../' + metadata.exports['./client'], import.meta.url)))
})

test('scoped self-reference resolves package metadata without installation', () => {
  const require = createRequire(import.meta.url)
  const resolved = require.resolve(packageName + '/package.json')
  assert.equal(JSON.parse(fs.readFileSync(resolved, 'utf8')).name, packageName)
})

test('installation and publishing docs refer to the new npm package', () => {
  for (const file of ['README.md', 'docs/PUBLISHING.md']) {
    const text = read(file)
    assert.ok(text.includes(packageName))
    assert.doesNotMatch(text, /npm (?:view|i|install) dsh-ustc-iwan(?: |$)/m)
    assert.equal(text.includes('npmjs.com/package/dsh-ustc-iwan'), false)
  }
})
