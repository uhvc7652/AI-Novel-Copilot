/**
 * Discriminates a sandbox restriction from a plugin bug.
 *
 * Both writes below run in ONE child process of the agent shell, on a file that
 * already exists. Plain `fs.writeFileSync` is the baseline; `writeFileAtomic` is
 * the exact routine DSH's filesystem backend uses for a replace, including its
 * Windows DACL copy.
 */
import { writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'

const target = 'E:/GameProject/AI-Novel-Copilot/.spike-novel/probe.md'
const fsioPath = 'E:/GameProject/deepseek-harness/packages/fs/fs-local/lib/fsio.js'
console.log('fs-local lib present:', existsSync(fsioPath))

try {
  writeFileSync(target, 'baseline\n', 'utf8')
  writeFileSync(target, 'baseline overwrite\n', 'utf8')
  console.log('baseline: create + overwrite via node:fs  -> OK')
} catch (error) {
  console.log('baseline FAILED:', error.message)
}

try {
  const { writeFileAtomic } = await import(`file:///${fsioPath}`)
  await writeFileAtomic(target, 'first\n', undefined, undefined)
  console.log('writeFileAtomic create -> OK')
  await writeFileAtomic(target, 'second\n', undefined, undefined)
  console.log('writeFileAtomic replace -> OK')
} catch (error) {
  console.log('writeFileAtomic FAILED:', error.message)
}
