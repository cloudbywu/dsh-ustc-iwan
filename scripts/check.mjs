import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

for (const file of readdirSync(new URL('../lib/', import.meta.url))) {
  if (!file.endsWith('.js')) continue
  const result = spawnSync(process.execPath, ['--check', fileURLToPath(new URL('../lib/' + file, import.meta.url))], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
console.log('All JavaScript modules passed syntax checks')
