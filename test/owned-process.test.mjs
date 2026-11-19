import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import net from 'node:net'

// A throwaway host launches a mock iWAN child and exits without calling plugin dispose.
// The test parent, not the host, holds the witness socket and observes the child closing.
for (const exit of ['natural', 'explicit']) {
  test('owned child does not pin host on ' + exit + ' exit and is terminated', { timeout: 8000 }, async t => {
    const peers = new Set()
    let ended = false
    const witness = net.createServer(s => {
      peers.add(s)
      s.on('error', () => {})
      s.on('close', () => { peers.delete(s); ended = true })
    })
    await new Promise((resolve, reject) => { witness.once('error', reject); witness.listen(0, '127.0.0.1', resolve) })
    const workerSource = [
      "import net from 'node:net'",
      'const socket = net.connect(' + witness.address().port + ', "127.0.0.1")',
      "socket.on('connect', () => console.log('mock-ready'))",
    ].join(String.fromCharCode(10))
    const hostSource = [
      "import { spawn } from 'node:child_process'",
      'import { trackOwnedProcess } from ' + JSON.stringify(new URL('../lib/owned-process.js', import.meta.url).href),
      'const hold = setInterval(() => {}, 1000)',
      'const child = spawn(process.execPath, ["--input-type=module", "-e", ' + JSON.stringify(workerSource) + '], { stdio: ["pipe", "pipe", "pipe"] })',
      'trackOwnedProcess(child)',
      'let seen = ""',
      'child.stdout.on("data", chunk => {',
      '  seen += chunk',
      '  if (!seen.includes("mock-ready")) return',
      '  process.stdout.write("mock-started", () => { ' + (exit === 'explicit' ? 'process.exit(0)' : 'clearInterval(hold)') + ' })',
      '})',
    ].join(String.fromCharCode(10))
    const host = spawn(process.execPath, ['--input-type=module', '-e', hostSource], { stdio: ['ignore', 'pipe', 'pipe'] })
    t.after(async () => {
      if (host.exitCode == null && host.signalCode == null) host.kill('SIGKILL')
      for (const socket of peers) socket.destroy()
      await new Promise(resolve => witness.close(resolve))
    })
    let stdout = '', stderr = ''
    host.stdout.on('data', chunk => { stdout += chunk })
    host.stderr.on('data', chunk => { stderr += chunk })
    const [code, signal] = await once(host, 'close', { signal: t.signal })
    assert.equal(code, 0, stderr)
    assert.equal(signal, null)
    assert.match(stdout, /mock-started/)
    // Allow the child's TCP EOF to arrive after the host process exit event.
    if (!ended && peers.size) await once([...peers][0], 'close', { signal: t.signal })
    assert.equal(ended, true, 'plugin-owned process must not survive host exit')
  })
}
