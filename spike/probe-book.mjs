/**
 * Read-only probe: ask the host's real IO layer what it sees in a book on disk.
 *
 * This is the tool for "the panel says X, the file says Y" reports: it runs
 * `NovelIo` over `node:fs` (the same double `perf-check.mjs` uses) and prints the
 * card library, every chapter's reference fields, and the deterministic findings
 * — no panel, no HTTP, no cache left behind. It never writes.
 *
 * Usage: `node --experimental-transform-types spike/probe-book.mjs <book-root>`
 */
import path from 'node:path'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { NovelIo } from '../src/novel/io.ts'

function versionOf(info) {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
}

async function realTarget(absolute) {
  try { return await realpath(absolute) } catch { /* walk up */ }
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

const fsService = {
  async resolve(target) {
    const absolute = path.resolve(target)
    return { targetKey: await realTarget(absolute), displayPath: absolute }
  },
  contains(parent, child) {
    return child.targetKey === parent.targetKey || child.targetKey.startsWith(`${parent.targetKey}${path.sep}`)
  },
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
  async readText(target) { return await readFile(target.targetKey, 'utf8') },
  async listDir(target) {
    const entries = await readdir(target.targetKey, { withFileTypes: true })
    const out = []
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(target.targetKey, entry.name)
      const key = await realTarget(absolute)
      let info
      try { info = await stat(key, { bigint: true }) } catch { info = undefined }
      out.push({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
        target: { targetKey: key, displayPath: absolute },
        ...(info === undefined ? {} : { version: versionOf(info) }),
      })
    }
    return out
  },
}

const ROOT = process.argv[2] ?? 'E:/GameProject/AI-Novel-Copilot/novel'
const io = new NovelIo({
  fs: fsService,
  sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: ROOT }) },
  sessions: { get: () => undefined },
})
const scope = { root: ROOT, sessionId: 'probe-book' }

const library = await io.library(scope)
console.log('--- library() ---')
for (const group of library.groups) {
  console.log(`${group.type}（${group.label}）: ${group.cards.map(card => `${card.id}=${card.name}${card.archived ? '[已存档]' : ''}${card.role === undefined ? '' : ` role=${card.role}`}`).join(' | ')}`)
}
console.log(`total=${String(library.total)} archived=${String(library.archived)}`)

console.log('\n--- 章节 frontmatter ---')
for (const chapter of (await io.snapshot(scope)).volumes.flatMap(volume => volume.chapters)) {
  const loaded = await io.readChapter(scope, chapter.path)
  console.log(`${chapter.path}: characters=${JSON.stringify(loaded.data.characters)} locations=${JSON.stringify(loaded.data.locations)} refs=${JSON.stringify(loaded.data.refs)}`)
}

console.log('\n--- check() ---')
const report = await io.check(scope)
console.log(`scanned: chapters=${String(report.scanned.chapters)} cards=${String(report.scanned.cards)} pages=${String(report.scanned.pages)}`)
for (const issue of report.issues) console.log(`${issue.severity} ${issue.key}`)
