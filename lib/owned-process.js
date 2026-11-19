/** A managed child may use the host, but must not keep an otherwise idle host alive. */
export function trackOwnedProcess(child) {
  // 'exit' also covers a normal process.exit() when plugin disposers were skipped.
  // Only this exact plugin-owned child is stopped, synchronously, before the host goes away.
  const stopAtExit = () => { try { child.kill('SIGKILL') } catch {} }
  const release = () => {
    process.removeListener('exit', stopAtExit)
    child.removeListener('exit', release)
    child.removeListener('close', release)
  }
  process.once('exit', stopAtExit)
  child.once('exit', release)
  child.once('close', release) // A failed spawn has close but may not have exit.
  child.unref()
  for (const stream of child.stdio) stream?.unref?.()
}
