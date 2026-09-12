/**
 * The P5 performance baseline: a synthetic million-word book, measured on the
 * **real IO layer**.
 *
 * `06` §2.1 and `07` §5 both record the same deliberate trade: the search corpus
 * and the check corpus are rescanned from disk on every request, because that is
 * what makes "the answer comes from what is on disk right now" true. Both say
 * P5 is where that has to become incremental. This script is the number that
 * decides whether the fix worked, and — more importantly — *which* fix matters:
 * reading and `js-yaml`-parsing every chapter, or scanning every body per query.
 *
 * It is not a unit test. It asserts nothing except that the shape of the answer
 * is right (a search finds what it should); every line of output is a duration,
 * because the question here is "how slow is it", not "is it correct".
 *
 * The filesystem double is not in memory: a real directory is written and read
 * through a `ctx.fs` slice that mirrors `dsh-fs-local`'s behaviour, including the
 * `dev:ino:size:mtimeNs:ctimeNs` version token and the per-child `version` in a
 * directory listing. A memory double would measure the wrong thing — it would
 * make a file read free.
 *
 * Usage:
 *   node --experimental-transform-types spike/perf-check.mjs
 *   node --experimental-transform-types spike/perf-check.mjs --chapters 800
 */
import { mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import path from 'node:path'
import { NovelIo } from '../src/novel/io.ts'

const CHAPTER_ARG = process.argv.indexOf('--chapters')
const CHAPTERS = CHAPTER_ARG < 0 ? 400 : Number(process.argv[CHAPTER_ARG + 1])
/** Words per chapter; 3000 is an ordinary Chinese web-novel chapter. */
const WORDS_PER_CHAPTER = 3000
/** Chapters per volume. */
const VOLUME_SIZE = 50
const ROOT = path.resolve('.spike-novel-perf')

// --- the synthetic book -----------------------------------------------------

/** Deterministic PRNG, so two runs measure the same bytes. */
function rng(seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

const SUBJECTS = ['墨尘', '林晚', '青阳子', '叶疏影', '老掌柜', '沈鹤', '白无常', '苏九娘']
const PLACES = ['断魂崖', '青石巷', '演武场', '藏经阁', '北境关隘', '寒潭', '剑冢', '乱葬岗']
const OBJECTS = ['半块青铜镜', '锈剑', '碎玉符', '残卷', '灵犀灯', '镇魂铃', '玄铁令', '血书']
const VERBS = ['握紧', '放下', '掷出', '收起', '端详', '递过', '藏进袖中', '按在案上']
const TAILS = [
  '风从山口灌进来，带着铁锈与雪的味道。',
  '远处传来更鼓，一声，又一声。',
  '他忽然想起许多年前那个雨夜。',
  '没有人说话，只有火光在墙上跳。',
  '这一夜之后，事情再也回不到原样了。',
  '她抬头看了看天，云层压得很低。',
  '剑锋上凝着一线血珠，缓缓滑落。',
  '廊下的灯笼晃了晃，灭了。',
]

/**
 * One chapter's prose, roughly `WORDS_PER_CHAPTER` characters.
 * @param random - the book's PRNG.
 * @param index - chapter index, used to place the rare names.
 * @returns the body text.
 */
function prose(random, index) {
  const lines = []
  let length = 0
  while (length < WORDS_PER_CHAPTER) {
    const tail = TAILS[Math.floor(random() * TAILS.length)]
    const line = `${SUBJECTS[Math.floor(random() * SUBJECTS.length)]}走进${PLACES[Math.floor(random() * PLACES.length)]}，`
      + `${VERBS[Math.floor(random() * VERBS.length)]}那${OBJECTS[Math.floor(random() * OBJECTS.length)]}。${tail}`
    lines.push(line)
    length += line.length
  }
  // Two names that appear rarely, so a search has both a hot and a cold query.
  if (index % 97 === 0) lines.splice(2, 0, '半块青铜镜上刻着两个字：墨尘。')
  return `${lines.join('\n')}\n`
}

/**
 * Write the whole book with plain `node:fs`.
 *
 * Setup is not what is being measured, and going through the seam would make the
 * fixture slower than the thing under test.
 * @param root - project root to create.
 * @param chapters - how many chapter files to write.
 * @returns the character count actually written, for the report.
 */
async function buildBook(root, chapters) {
  const random = rng(20260911)
  await rm(root, { recursive: true, force: true })
  await mkdir(path.join(root, 'chapters'), { recursive: true })
  await writeFile(path.join(root, 'novel.yaml'), 'title: 测量之书\ngenre: 仙侠\ntargetWords: 1000000\n')
  await mkdir(path.join(root, 'settings'), { recursive: true })
  await writeFile(path.join(root, 'settings', 'world.md'), '# 世界观\n\n灵气自北境南下，宗门林立。\n')
  await mkdir(path.join(root, 'settings', 'characters'), { recursive: true })
  await mkdir(path.join(root, 'settings', 'locations'), { recursive: true })
  await mkdir(path.join(root, 'settings', 'threads'), { recursive: true })
  await mkdir(path.join(root, 'outline', 'volumes'), { recursive: true })
  await mkdir(path.join(root, 'style', 'samples'), { recursive: true })
  await writeFile(path.join(root, 'outline', 'book.md'), '# 全书主线\n\n少年墨尘持半块青铜镜北上。\n')

  for (let index = 0; index < SUBJECTS.length; index += 1) {
    const id = ['chen-mo', 'lin-wan', 'qing-yang-zi', 'ye-shu-ying', 'lao-zhang-gui', 'shen-he', 'bai-wu-chang', 'su-jiu-niang'][index]
    await writeFile(
      path.join(root, 'settings', 'characters', `${id}.md`),
      `---\nid: ${id}\nname: ${SUBJECTS[index]}\naliases: [${SUBJECTS[index]}子]\nstatus: 在用\ntags: [主要角色]\n---\n\n`
        + `## 外貌\n\n一身青衫。\n\n## 性格\n\n沉默，但认死理。\n\n## 不可违背的设定（硬约束）\n\n尚未筑基。\n`,
    )
  }
  for (let index = 0; index < PLACES.length; index += 1) {
    const id = `fs-${String(index + 1).padStart(3, '0')}`
    await writeFile(
      path.join(root, 'settings', 'locations', `${id}.md`),
      `---\nid: ${id}\nname: ${PLACES[index]}\naliases: []\nstatus: 在用\ntags: []\n---\n\n## 地理\n\n北境以南三百里。\n`,
    )
  }
  for (let index = 0; index < 10; index += 1) {
    const id = `th-${String(index + 1).padStart(3, '0')}`
    await writeFile(
      path.join(root, 'settings', 'threads', `${id}.md`),
      `---\nid: ${id}\nname: 伏笔 ${String(index + 1)}\naliases: []\nstatus: 未回收\ntags: []\nplantedIn: c0001\npayoffIn: []\nreinforcedIn: []\n---\n\n## 埋点方式\n\n第一章的一枚旧钱。\n`,
    )
  }

  let characters = 0
  let previousVolume = 0
  for (let index = 0; index < chapters; index += 1) {
    const number = index + 1
    const volume = Math.floor(index / VOLUME_SIZE) + 1
    if (volume !== previousVolume) {
      previousVolume = volume
      await mkdir(path.join(root, 'chapters', `v${String(volume).padStart(2, '0')}`), { recursive: true })
      await writeFile(path.join(root, 'outline', 'volumes', `v${String(volume).padStart(2, '0')}.md`), `# 第 ${volume} 卷卷纲\n\n北上。\n`)
    }
    const body = prose(random, index)
    characters += body.length
    const character = ['chen-mo', 'lin-wan', 'qing-yang-zi', 'ye-shu-ying'][index % 4]
    const location = `fs-${String((index % PLACES.length) + 1).padStart(3, '0')}`
    const text = `---\n`
      + `id: c${String(number).padStart(4, '0')}\n`
      + `number: ${number}\n`
      + `volume: ${volume}\n`
      + `title: 第 ${number} 章 · ${PLACES[index % PLACES.length]}\n`
      + `status: 草稿\n`
      + `summary: ${SUBJECTS[index % SUBJECTS.length]}在${PLACES[index % PLACES.length]}遇到麻烦。\n`
      + `beats: [铺垫, 冲突, 收束]\n`
      + `characters: [${character}]\n`
      + `locations: [${location}]\n`
      + `pov: ${character}\n`
      + `wordCount: 0\n`
      + `---\n\n${body}`
    await writeFile(path.join(root, 'chapters', `v${String(volume).padStart(2, '0')}`, `c${String(number).padStart(4, '0')}.md`), text)
  }
  return characters
}

// --- the real-shaped ctx.fs -------------------------------------------------

/** The version token `dsh-fs-local` builds, so freshness behaves the same way. */
function versionOf(info) {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
}

/**
 * The realpath identity of a path, mirroring `resolveLocalTarget`: for a path
 * that does not exist yet, realpath the nearest existing ancestor and re-append
 * the missing suffix.
 *
 * This is not decoration. `dsh-fs-local` resolves **every** path this way, and a
 * `realpath` on Windows costs about as much as eight `stat`s — measured in
 * `spike/fs-cost-check.mjs`. A double that skipped it would report a warm scan
 * nine times faster than the real thing, which is exactly the kind of number
 * that gets a design decided for the wrong reason.
 * @param absolute - the absolute path to resolve.
 * @returns the realpath-derived stable key.
 */
async function realTarget(absolute) {
  try { return await realpath(absolute) } catch { /* fall through to the ancestor walk */ }
  const missing = [path.basename(absolute)]
  let ancestor = path.dirname(absolute)
  for (;;) {
    try { return path.join(await realpath(ancestor), ...missing) } catch { /* walk up */ }
    const parent = path.dirname(ancestor)
    if (parent === ancestor) return absolute
    missing.unshift(path.basename(ancestor))
    ancestor = parent
  }
}

/** `ctx.fs` over `node:fs`, mirroring the local backend's metadata and syscalls. */
const rawFs = {
  async resolve(target) {
    const absolute = path.resolve(target)
    return { targetKey: await realTarget(absolute), displayPath: absolute }
  },
  contains(parent, child) { return child.targetKey === parent.targetKey || child.targetKey.startsWith(`${parent.targetKey}${path.sep}`) },
  async stat(target) {
    try {
      const info = await stat(target.targetKey, { bigint: true })
      return {
        version: versionOf(info),
        type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
        size: Number(info.size),
      }
    } catch { return undefined }
  },
  async readText(target) {
    // `fs-local` stats before every read; skipping it would understate a cold scan.
    await stat(target.targetKey, { bigint: true })
    return await readFile(target.targetKey, 'utf8')
  },
  async listDir(target) {
    const entries = await readdir(target.targetKey, { withFileTypes: true })
    const out = []
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(target.targetKey, entry.name)
      // `listDirectory` resolves each child (a realpath) and then probes it.
      const key = await realTarget(absolute)
      let info
      try { info = await stat(key, { bigint: true }) } catch { info = undefined }
      out.push({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
        target: { targetKey: key, displayPath: absolute },
        ...(info === undefined ? {} : { version: versionOf(info) }),
        ...(info !== undefined && info.isFile() ? { size: Number(info.size) } : {}),
      })
    }
    return out
  },
  async writeText(target, content) {
    const before = await readFile(target.targetKey, 'utf8').catch(() => null)
    await writeFile(target.targetKey, content)
    const info = await stat(target.targetKey, { bigint: true })
    return { operation: before === null ? 'create' : 'update', version: versionOf(info), before, after: content }
  },
}

/**
 * A pass-through that counts what the IO layer asks the filesystem for.
 *
 * The measurement that matters is not "how long did a search take" but "was the
 * time in the files, in the parser, or in the matcher": those three have three
 * different fixes, and guessing between them is how a performance change ends up
 * optimising the part that was never slow.
 */
const spent = { resolve: 0, stat: 0, readText: 0, listDir: 0, writeText: 0 }
const calls = { resolve: 0, stat: 0, readText: 0, listDir: 0, writeText: 0 }
const fsService = Object.fromEntries(
  Object.entries(rawFs).map(([method, implementation]) => [method, async (...args) => {
    if (!(method in spent)) return await implementation(...args)
    const started = performance.now()
    try { return await implementation(...args) } finally {
      spent[method] += performance.now() - started
      calls[method] += 1
    }
  }]),
)

/** Print and reset the per-method tallies since the last call. */
function report() {
  const total = spent.readText + spent.stat + spent.listDir + spent.resolve
  for (const method of ['listDir', 'stat', 'readText', 'resolve']) {
    if (calls[method] === 0) continue
    console.log(`      ${method.padEnd(9)} ${spent[method].toFixed(0).padStart(5)} ms  ×${String(calls[method])}`)
  }
  console.log(`      ${'文件系统合计'.padEnd(7)} ${total.toFixed(0).padStart(5)} ms`)
  for (const method of Object.keys(spent)) { spent[method] = 0; calls[method] = 0 }
}

// --- measurement ------------------------------------------------------------

let failed = 0
/**
 * Assert one expectation.
 * @param {string} label - what is being checked.
 * @param {boolean} ok - the result.
 * @param {string} detail - what was seen, for a failure.
 */
function check(label, ok, detail = '') {
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || detail === '' ? '' : ` — ${detail}`}`)
}

/**
 * Time one awaited operation.
 * @param {string} label - what is being timed.
 * @param {() => Promise<unknown>} run - the operation.
 * @returns the duration in milliseconds.
 */
async function time(label, run) {
  const started = performance.now()
  await run()
  const elapsed = performance.now() - started
  console.log(`  ${label.padEnd(34)} ${elapsed.toFixed(0).padStart(6)} ms`)
  report()
  return elapsed
}

console.log(`合成工程：${CHAPTERS} 章 × ${WORDS_PER_CHAPTER} 字，写入 ${ROOT}`)
const startedAt = performance.now()
const characters = await buildBook(ROOT, CHAPTERS)
console.log(`  建造用时 ${(performance.now() - startedAt).toFixed(0)} ms，正文合计 ${characters} 字\n`)

const io = new NovelIo({
  fs: fsService,
  sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: ROOT }) },
  sessions: { get: () => undefined },
})
const scope = { root: ROOT, sessionId: 'perf-check' }

/**
 * A brand-new IO layer, which is to say an empty cache.
 *
 * This is how the "before" number is produced without keeping a second copy of
 * the old code around: a fresh instance has nothing cached, so every call reads
 * and parses the whole book exactly as it did before P5.
 * @returns the IO layer.
 */
const coldIo = () => new NovelIo({
  fs: fsService,
  sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: ROOT }) },
  sessions: { get: () => undefined },
})

console.log('--- 工程树 ---')
await time('snapshot 第 1 次（冷）', () => io.snapshot(scope))
await time('snapshot 第 2 次', () => io.snapshot(scope))

console.log('\n--- 检索 ---')
const hot = await io.search(scope, '墨尘')
await time('search「墨尘」第 1 次（冷）', () => io.search(scope, '墨尘'))
await time('search「墨尘」第 2 次', () => io.search(scope, '墨尘'))
await time('search「墨尘」第 3 次', () => io.search(scope, '墨尘'))
const cold = await io.search(scope, '半块青铜镜')
await time('search「半块青铜镜」', () => io.search(scope, '半块青铜镜'))

console.log('\n--- 一致性检查 ---')
await time('check 第 1 次（冷）', () => io.check(scope))
await time('check 第 2 次', () => io.check(scope))

console.log('\n--- 拆开看：语料重建 vs 查询匹配 ---')
await time('searchCorpus（只重建语料）', () => io.searchCorpus(scope))
await time('search（同样语料 + 匹配全文）', () => io.search(scope, '墨尘'))

console.log('\n--- 对照：改动前的全量重扫（每次新建 IO，缓存是空的） ---')
await time('snapshot', () => coldIo().snapshot(scope))
await time('search「墨尘」', () => coldIo().search(scope, '墨尘'))
await time('check', () => coldIo().check(scope))

console.log('\n--- 正确性（慢但答错没有意义） ---')
check('检索命中「墨尘」', hot.hits.length > 0, `hits=${String(hot.hits.length)}`)
check('检索命中「半块青铜镜」', cold.hits.length > 0, `hits=${String(cold.hits.length)}`)
check('工程树读完所有章节', (await io.snapshot(scope)).chapterCount === CHAPTERS)

console.log(`\nRESULT: ${failed === 0 ? 'PASS' : 'FAIL'}`)
process.exit(failed === 0 ? 0 : 1)
