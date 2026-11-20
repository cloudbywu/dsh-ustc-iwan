import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

test('syntax checker reports invalid JavaScript in nested backend directories', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ustc-iwan-check-'))
  t.after(() => fs.rmSync(root,{recursive:true,force:true}))
  const scripts = path.join(root,'scripts'), nested = path.join(root,'lib','node-iwan','nested module')
  fs.mkdirSync(scripts,{recursive:true}); fs.mkdirSync(nested,{recursive:true})
  fs.writeFileSync(path.join(root,'package.json'),'{}')
  const entry = path.join(scripts,'check.mjs')
  fs.copyFileSync(new URL('../scripts/check.mjs',import.meta.url),entry)
  fs.writeFileSync(path.join(root,'lib','entry.js'),'const entry = true;')
  const file = path.join(nested,'bad.js')
  fs.writeFileSync(file,'const = 42;')
  const bad = spawnSync(process.execPath,[entry],{encoding:'utf8',timeout:5000})
  assert.equal(bad.status,1,bad.error?.message)
  assert.match(bad.stderr,/bad[.]js/)
  fs.writeFileSync(file,'const nested = true;')
  const good = spawnSync(process.execPath,[entry],{encoding:'utf8',timeout:5000})
  assert.equal(good.status,0,good.stderr || good.error?.message)
})
