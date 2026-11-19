import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import test from 'node:test'
import assert from 'node:assert/strict'
import { binaryState, extractFromZip, BINARY_NAME, MAX_BINARY_BYTES, cachedBinaryPath, resolveBinary, startDownload, waitForDownload, cancelDownload, downloadState } from '../lib/binary.js'

function crc32(data) {
  let crc=0xffffffff
  for(const byte of data) {crc^=byte;for(let k=0;k<8;k++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1}
  return (crc^0xffffffff)>>>0
}
function zip(data=Buffer.from('MZ-test-client'),{method=8,declared=data.length,name='folder/'+BINARY_NAME}={}) {
  const raw=method===8?zlib.deflateRawSync(data):data
  const fileName=Buffer.from(name)
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(method,8);local.writeUInt32LE(crc32(data),14);local.writeUInt32LE(raw.length,18);local.writeUInt32LE(declared,22);local.writeUInt16LE(fileName.length,26)
  const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(method,10);central.writeUInt32LE(crc32(data),16);central.writeUInt32LE(raw.length,20);central.writeUInt32LE(declared,24);central.writeUInt16LE(fileName.length,28)
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+fileName.length,12);end.writeUInt32LE(local.length+fileName.length+raw.length,16)
  return Buffer.concat([local,fileName,raw,central,fileName,end])
}
async function home(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-iwan-test-'))
  const before=process.env.DSH_HOME;process.env.DSH_HOME=dir
  t.after(async()=>{await cancelDownload();if(before===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=before;fs.rmSync(dir,{recursive:true,force:true})})
  return dir
}

test('ZIP extraction accepts stored and deflated nested executable entries',()=>{
  for(const method of [0,8])assert.equal(extractFromZip(zip(undefined,{method}),BINARY_NAME).toString(),'MZ-test-client')
})

test('ZIP extraction bounds actual inflation by declared output before allocation grows',()=>{
  const archive=zip(Buffer.alloc(1024*1024),{declared:1})
  assert.throws(()=>extractFromZip(archive,BINARY_NAME),{code:'ERR_BUFFER_TOO_LARGE'})
})

test('ZIP extraction rejects CRC errors, oversized output and out-of-bounds headers',()=>{
  const archive=zip();const cd=archive.readUInt32LE(archive.length-6)
  const crc=Buffer.from(archive);crc.writeUInt32LE(0,cd+16);assert.throws(()=>extractFromZip(crc,BINARY_NAME),/校验和/)
  const size=Buffer.from(archive);size.writeUInt32LE(MAX_BINARY_BYTES+1,cd+24);assert.throws(()=>extractFromZip(size,BINARY_NAME),/上限/)
  const offset=Buffer.from(archive);offset.writeUInt32LE(0xffffffff,cd+42);assert.throws(()=>extractFromZip(offset,BINARY_NAME),/文件头/)
  assert.throws(()=>extractFromZip(archive.subarray(0,archive.length-5),BINARY_NAME),/zip/)
})

test('automatic cache requires matching hash and invalidates memoization on file changes',async t=>{
  await home(t);const file=cachedBinaryPath();fs.mkdirSync(path.dirname(file),{recursive:true})
  const binary=Buffer.from('MZ-original');fs.writeFileSync(file,binary,{mode:0o700})
  assert.match(resolveBinary('').error,/校验失败/)
  fs.writeFileSync(file+'.meta.json',JSON.stringify({bytes:binary.length,sha256:crypto.createHash('sha256').update(binary).digest('hex')}))
  assert.equal(resolveBinary('').kind,'downloaded')
  let reads=0;const original=fs.readFileSync
  t.mock.method(fs,'readFileSync',(...args)=>{reads++;return original(...args)})
  assert.equal(resolveBinary('').kind,'downloaded');assert.equal(reads,0)
  fs.writeFileSync(file,Buffer.from('MZ-modified'));fs.utimesSync(file,new Date(),new Date(Date.now()+2000))
  assert.match(resolveBinary('').error,/SHA-256/)
})

test('explicit manual paths must be files, not directories',async t=>{
  const dir=await home(t);assert.ok(resolveBinary(dir).error)
  const file=path.join(dir,'manual.exe');fs.writeFileSync(file,'trusted',{mode:0o700})
  assert.equal(resolveBinary(file).kind,'configured')
})

test('an explicit invalid path cannot silently select a verified cached client', async t => {
  const dir = await home(t)
  const cached = cachedBinaryPath(), binary = Buffer.from('MZ-cached')
  fs.mkdirSync(path.dirname(cached), { recursive: true })
  fs.writeFileSync(cached, binary, { mode: 0o700 })
  fs.writeFileSync(cached + '.meta.json', JSON.stringify({ bytes: binary.length, sha256: crypto.createHash('sha256').update(binary).digest('hex') }))
  assert.equal(binaryState('  ').kind, 'downloaded')
  for (const invalid of [dir, path.join(dir, 'missing.exe')]) {
    const state = binaryState(invalid)
    assert.equal(state.installed, false)
    assert.equal(state.downloaded, false)
    assert.match(state.error, /配置的 iWAN 客户端路径/)
  }
})

test('download writes a verified binary and leaves no temporary files',async t=>{
  await home(t);const archive=zip()
  t.mock.method(globalThis,'fetch',async()=>new Response(archive,{headers:{'content-length':String(archive.length)}}))
  assert.equal((await startDownload()).started,true);await waitForDownload()
  assert.equal(downloadState().state,'done');assert.equal(resolveBinary('').kind,'downloaded')
  assert.equal(fs.existsSync(cachedBinaryPath()+'.part'),false);assert.equal(fs.existsSync(cachedBinaryPath()+'.meta.json.part'),false)
})

test('download rejects declared oversize before consuming body',async t=>{
  await home(t);let cancelled=false
  const stream=new ReadableStream({cancel(){cancelled=true}})
  t.mock.method(globalThis,'fetch',async()=>new Response(stream,{headers:{'content-length':String(MAX_BINARY_BYTES+1)}}))
  await startDownload();await waitForDownload()
  assert.equal(downloadState().state,'error');assert.match(downloadState().error,/上限/);assert.equal(cancelled,true)
})

test('download refuses redirects to plaintext HTTP',async t=>{
  await home(t);let calls=0
  t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(null,{status:302,headers:{location:'http://example.test/client.zip'}})})
  await startDownload();await waitForDownload()
  assert.equal(calls,1);assert.match(downloadState().error,/HTTPS/)
})

test('cancel aborts an in-flight download and prevents duplicate starts',async t=>{
  await home(t)
  t.mock.method(globalThis,'fetch',(_,opts)=>new Promise((_,reject)=>{opts.signal.addEventListener('abort',()=>reject(opts.signal.reason),{once:true})}))
  await startDownload();assert.equal((await startDownload()).started,false)
  await cancelDownload();assert.equal(downloadState().state,'error');assert.match(downloadState().error,/取消/)
  assert.equal(fs.existsSync(cachedBinaryPath()+'.part'),false)
})

test('download deadline aborts stalled responses',async t=>{
  await home(t)
  t.mock.method(globalThis,'fetch',(_,opts)=>new Promise((_,reject)=>{opts.signal.addEventListener('abort',()=>reject(opts.signal.reason),{once:true})}))
  await startDownload(()=>{},{timeoutMs:10})
  await new Promise(r=>setTimeout(r,30));await waitForDownload()
  assert.match(downloadState().error,/超时/)
})

test('failed metadata replacement rolls back the previous valid binary',async t=>{
  await home(t);const file=cachedBinaryPath();fs.mkdirSync(path.dirname(file),{recursive:true})
  const original=Buffer.from('MZ-old-client');fs.writeFileSync(file,original,{mode:0o700})
  fs.writeFileSync(file+'.meta.json',JSON.stringify({bytes:original.length,sha256:crypto.createHash('sha256').update(original).digest('hex')}))
  assert.equal(resolveBinary('').kind,'downloaded')
  const rename=fs.renameSync;let failed=false
  t.mock.method(fs,'renameSync',(from,to)=>{if(String(to).endsWith('.meta.json')&&!failed){failed=true;throw Object.assign(new Error('metadata rename denied'),{code:'EACCES'})}return rename(from,to)})
  t.mock.method(globalThis,'fetch',async()=>new Response(zip(Buffer.from('MZ-new-client'))))
  await startDownload();await waitForDownload()
  assert.equal(downloadState().state,'error');assert.equal(fs.readFileSync(file).toString(),original.toString())
  assert.equal(resolveBinary('').kind,'downloaded')
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(),[BINARY_NAME,BINARY_NAME+'.meta.json'].sort())
})
