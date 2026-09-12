/**
 * What `ctx.fs` actually costs, and what a directory's version token can be
 * trusted for.
 *
 * Two findings came out of P5 that are worth keeping reproducible, because both
 * of them changed a design decision:
 *
 * 1. **`dsh-fs-local` resolves every path with a `realpath`, including every
 *    child in a directory listing** (`resolveListedChildTarget`). On Windows
 *    that is roughly eight times the cost of a `stat`, and it is the single
 *    largest remaining cost of a warm project scan — a scan that has already
 *    stopped reading files.
 * 2. **A directory's own version token is not a reliable signal that its set of
 *    children changed.** That rules out the obvious optimisation — "gate the
 *    expensive listing on the directory token" — which would silently miss
 *    newly created chapters.
 *
 * Neither is a bug in DSH; both are facts a plugin has to plan around. The
 * second one especially: it is exactly the kind of assumption that is cheap to
 * believe and expensive to ship.
 *
 * Usage: node spike/fs-cost-check.mjs [book-root]
 */
import { mkdir, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import path from 'node:path'

/**
 * Time one awaited pass.
 * @param label - what is being measured.
 * @param run - the work.
 * @returns the duration in milliseconds.
 */
async function time(label, run) {
  const started = performance.now()
  await run()
  const elapsed = performance.now() - started
  console.log(`  ${label.padEnd(38)} ${elapsed.toFixed(0).padStart(5)} ms`)
  return elapsed
}

/**
 * Time one pass, discarding an unmeasured warm-up first.
 * @param label - what is being measured.
 * @param run - the work.
 * @returns the duration in milliseconds.
 */
async function steady(label, run) {
  await run()
  return await time(label, run)
}

console.log('--- 一次目录列举里，钱花在哪 ---')
const book = path.resolve(process.argv[2] ?? '.spike-novel-perf')
const chaptersDir = path.join(book, 'chapters')
let volumes = []
try {
  volumes = (await readdir(chaptersDir, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name)
} catch {
  volumes = []
}
if (volumes.length === 0) {
  console.log(`  （${book} 里没有 chapters/，先跑一次 spike/perf-check.mjs 生成合成工程）`)
} else {
  const files = []
  for (const volume of volumes) {
    for (const entry of await readdir(path.join(chaptersDir, volume), { withFileTypes: true })) {
      files.push(path.join(chaptersDir, volume, entry.name))
    }
  }
  console.log(`  ${String(volumes.length)} 个目录 / ${String(files.length)} 个文件`)

  await steady('readdir，不算子项', async () => {
    for (const volume of volumes) await readdir(path.join(chaptersDir, volume), { withFileTypes: true })
  })
  await steady('readdir + 每子项 stat(bigint)', async () => {
    for (const volume of volumes) {
      for (const entry of await readdir(path.join(chaptersDir, volume), { withFileTypes: true })) {
        await stat(path.join(chaptersDir, volume, entry.name), { bigint: true })
      }
    }
  })
  await steady('readdir + 每子项 realpath', async () => {
    for (const volume of volumes) {
      for (const entry of await readdir(path.join(chaptersDir, volume), { withFileTypes: true })) {
        await realpath(path.join(chaptersDir, volume, entry.name))
      }
    }
  })
  const full = await time('readdir + realpath + stat（fs-local 的做法）', async () => {
    for (const volume of volumes) {
      for (const entry of await readdir(path.join(chaptersDir, volume), { withFileTypes: true })) {
        const absolute = path.join(chaptersDir, volume, entry.name)
        await realpath(absolute)
        await stat(absolute, { bigint: true })
      }
    }
  })
  console.log(`  → 每文件约 ${(full / Math.max(files.length, 1)).toFixed(2)} ms；realpath 是主要那一项`)
}

console.log('\n--- 目录自己的令牌能不能当「子项集合变了」的信号 ---')
const probeDir = path.resolve('.spike-dirversion')
await rm(probeDir, { recursive: true, force: true })
await mkdir(probeDir, { recursive: true })
await writeFile(path.join(probeDir, 'a.md'), 'one')

/** The token `dsh-fs-local` builds for the probe directory. */
async function dirToken() {
  const info = await stat(probeDir, { bigint: true })
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
}

/**
 * Count how often the directory token moves across create/delete cycles.
 *
 * Once is not a measurement. The first version of this probe ran each case a
 * single time and printed `false` for create and delete; a second run of the
 * same code printed `true` for both. The signal is not merely weak, it is
 * *nondeterministic*, so the only honest thing to record is the rate.
 * @param waitMs - how long to wait after the change before reading the token.
 * @returns how many of the cycles moved the token.
 */
async function moveRates(waitMs) {
  const rounds = 20
  let created = 0
  let deleted = 0
  for (let index = 0; index < rounds; index += 1) {
    const before = await dirToken()
    const child = path.join(probeDir, `r${String(index)}.md`)
    await writeFile(child, 'x')
    if (waitMs > 0) await new Promise(resolve => { setTimeout(resolve, waitMs) })
    const mid = await dirToken()
    if (mid !== before) created += 1
    await rm(child)
    if (waitMs > 0) await new Promise(resolve => { setTimeout(resolve, waitMs) })
    if ((await dirToken()) !== mid) deleted += 1
  }
  return { rounds, created, deleted }
}

for (const waitMs of [0, 10]) {
  const rates = await moveRates(waitMs)
  const suffix = waitMs === 0 ? '立刻读' : `等 ${String(waitMs)} ms 再读`
  console.log(`  ${String(rates.rounds)} 轮新增/删除（${suffix}）：新增后令牌变了 ${String(rates.created)} 次，删除后变了 ${String(rates.deleted)} 次`)
}

const beforeEdit = await dirToken()
await writeFile(path.join(probeDir, 'a.md'), 'one, but longer')
console.log(`  只改子项内容后目录令牌变化：${String((await dirToken()) !== beforeEdit)}（这一条必须为 false——内容改动只能靠子项自己的令牌）`)
console.log('  → 目录令牌不是可靠的「子项集合变了」信号：拿它跳过列举会漏掉新增/删除的章，不做')

await rm(probeDir, { recursive: true, force: true })
