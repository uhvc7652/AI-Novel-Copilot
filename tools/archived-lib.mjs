/**
 * Shared guts of the archived-file maintenance scripts.
 *
 * **Why these are scripts and not panel buttons.** The panel writes through
 * `ctx.fs`, whose whole capability surface is read/write/edit — no delete, no
 * rename, no move (verified in `packages/fs/fs/src/index.ts`: `resolve`,
 * `processPath`, `fileUrl`, `contains`, `stat`, `lstat`, `readText`,
 * `streamText`, `readBytes`, `readByteRange`, `listDir`, `writeText`,
 * `editText`). That is deliberate: the sandbox policy is the author's own
 * statement about their files, so the plugin does not reach around it with
 * `node:fs`. A script the author runs in their own terminal is a different
 * thing entirely — it *is* the author acting, so `node:fs` is the right tool.
 *
 * Everything here is read-only except for the two commands built on it
 * (`archive-delete.mjs`, `archive-suffix.mjs`), which are dry-run by default.
 *
 * Run with the same flag the checks use, because the frontmatter parser is the
 * plugin's real one (one parser, one truth — `format-check.mjs` makes the same
 * choice):
 *
 *   node --experimental-transform-types tools/archive-delete.mjs <novel-root>
 *
 * @module tools/archived-lib
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { parseDocument } from '../src/novel/document.ts'
import { summarizeChapter } from '../src/novel/project.ts'
import {
  CARD_LABELS,
  CHAPTERS_DIR,
  OUTLINE_DIR,
  SETTINGS_DIR,
  STYLE_DIR,
  cardTypeOfPath,
  chapterIdOfPath,
  isDocumentPath,
} from '../src/novel/paths.ts'

/** The four trees the plugin treats as editable documents (format §1). */
export const DOC_TREES = [CHAPTERS_DIR, SETTINGS_DIR, OUTLINE_DIR, STYLE_DIR]

/**
 * A file the author retired with `archived: true`.
 *
 * @typedef {object} ArchivedFile
 * @property {string} rel - storage-relative path.
 * @property {string} abs - absolute path.
 * @property {string} kind - `章节` / `角色卡` / … , for the report.
 * @property {string} id - the identity a reference would use.
 * @property {string} name - display name from the frontmatter.
 * @property {number} bytes - file size, so a report says how much is at stake.
 */

/**
 * Every file under `dir`, recursively. An absent directory is not an error.
 * @param {string} dir - directory to walk.
 * @returns {Promise<string[]>} absolute file paths.
 */
export async function walkFiles(dir) {
  const found = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...await walkFiles(full))
    else if (entry.isFile()) found.push(full)
  }
  return found
}

/**
 * Whether a parsed frontmatter block retires the file.
 * @param {Record<string, unknown>} data - parsed frontmatter.
 * @returns {boolean} true when the author archived it.
 */
export function isArchivedData(data) {
  return data.archived === true
}

/**
 * The name a retired file gets.
 * @param {string} name - the current file name.
 * @param {string} suffix - the marker to append (default `.archived`).
 * @returns {string | undefined} the new name, or undefined when it already has the suffix.
 */
export function suffixedName(name, suffix) {
  return name.endsWith(suffix) ? undefined : `${name}${suffix}`
}

/**
 * Whether a suffix is one that actually hides the file from the plugin.
 *
 * A name that still ends in `.md` is still a document: the host scans chapters by
 * extension and cards by `settings/<type>/<id>.md`, so `c0009.archived.md` would
 * be read as a chapter whose id is `c0009.archived` — and immediately reported as
 * `id-mismatch` against the `id: c0009` inside it. The marker therefore has to go
 * after the extension.
 * @param {string} suffix - the proposed marker.
 * @returns {string | undefined} why it will not work, or undefined when it will.
 */
export function suffixProblem(suffix) {
  if (suffix === '') return '后缀不能是空的'
  if (suffix.endsWith('.md')) {
    return `后缀「${suffix}」还是以 .md 结尾：那样的名字仍然会被当成文档扫描到，`
      + '而且检查会立刻报 id-mismatch。用默认的 .archived（加在扩展名之后）就好。'
  }
  return undefined
}

/**
 * The name a suffixed file goes back to.
 *
 * It only strips the marker; whether the result is a document again is the
 * caller's question, because only the caller has the full storage-relative path
 * (this function sees one name). That split is what keeps `--restore` from
 * touching an unrelated `notes.archived` elsewhere in the project.
 * @param {string} name - the suffixed file name.
 * @param {string} suffix - the marker to strip.
 * @returns {string | undefined} the original name, or undefined when there is nothing to restore.
 */
export function restoredName(name, suffix) {
  if (!name.endsWith(suffix) || name.length === suffix.length) return undefined
  return name.slice(0, -suffix.length)
}

/**
 * Clean up a root path as a human types or pastes it.
 *
 * `set /p` in the `.cmd` wrappers does not trim, and a path copied out of
 * Explorer's address bar or out of a chat message arrives with quotes, trailing
 * spaces, or both. The scripts' first real-world test failed exactly here —
 * `E:\...\.tmp-cmd-trial ` (one trailing space) was refused as "not a directory",
 * which is a safe failure but a useless one.
 * @param {string} value - the raw command-line or prompted value.
 * @returns {string} the path to use.
 */
export function cleanRootArg(value) {
  let text = String(value ?? '').trim()
  while (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2)
    || (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    text = text.slice(1, -1).trim()
  }
  return text
}

/**
 * Refuse to operate on something that is not a novel project.
 *
 * Both commands delete or rename files; the one failure that would really hurt is
 * running them one directory up.
 * @param {string} root - the project root as given on the command line.
 * @returns {Promise<string>} the absolute root.
 * @throws {Error} when the root does not look like a novel project.
 */
export async function novelRoot(root) {
  const absolute = resolve(cleanRootArg(root))
  const info = await stat(absolute).catch(() => undefined)
  if (info === undefined || !info.isDirectory()) {
    throw new Error(`不是目录：${absolute}`)
  }
  let looksLikeNovel = false
  for (const probe of ['novel.yaml', CHAPTERS_DIR, SETTINGS_DIR]) {
    const found = await stat(join(absolute, probe)).catch(() => undefined)
    if (found !== undefined) looksLikeNovel = true
  }
  if (!looksLikeNovel) {
    throw new Error(
      `${absolute} 看起来不是小说工程（没有 novel.yaml / chapters/ / settings/）——`
      + '这两个脚本会删改文件，路径给错了代价很大，所以在这里停下。',
    )
  }
  return absolute
}

/**
 * Every archived document in the project.
 * @param {string} root - absolute project root.
 * @returns {Promise<ArchivedFile[]>} the retired files, in path order.
 */
export async function scanArchived(root) {
  /** @type {ArchivedFile[]} */
  const found = []
  for (const tree of DOC_TREES) {
    for (const abs of await walkFiles(join(root, tree))) {
      const rel = relative(root, abs).split(sep).join('/')
      if (!isDocumentPath(rel) || !rel.endsWith('.md')) continue
      let text
      try {
        text = await readFile(abs, 'utf8')
      } catch {
        continue
      }
      let data
      try {
        data = parseDocument(text).data
      } catch {
        // A file whose frontmatter does not parse is not something these scripts
        // touch: silently skipping it is the only safe reading, and the panel
        // reports it as a parse error when the author opens it.
        continue
      }
      if (!isArchivedData(data)) continue
      const size = await stat(abs).catch(() => undefined)
      const cardType = cardTypeOfPath(rel)
      found.push({
        rel,
        abs,
        kind: chapterIdOfPath(rel) !== undefined
          ? '章节'
          : (cardType === undefined ? '文档' : (CARD_LABELS[cardType] ?? '卡')),
        id: chapterIdOfPath(rel) ?? String(data.id ?? rel.split('/').pop()?.replace(/\.md$/, '') ?? ''),
        name: String(data.title ?? data.name ?? ''),
        bytes: size?.size ?? 0,
      })
    }
  }
  return found.sort((left, right) => left.rel.localeCompare(right.rel))
}

/**
 * Every chapter in the project, archived ones included.
 *
 * Read through the plugin's own `summarizeChapter`, so "which volume, which
 * number, is it archived" is answered exactly as the panel answers it (frontmatter
 * first, path as fallback) instead of by a second regex that could drift.
 * @param {string} root - absolute project root.
 * @returns {Promise<{rel: string, abs: string, volume: number, number: number, archived: boolean, title: string}[]>} the chapters.
 */
export async function scanChapters(root) {
  const found = []
  for (const abs of await walkFiles(join(root, CHAPTERS_DIR))) {
    const rel = relative(root, abs).split(sep).join('/')
    if (!rel.endsWith('.md') || chapterIdOfPath(rel) === undefined) continue
    const text = await readFile(abs, 'utf8').catch(() => undefined)
    if (text === undefined) continue
    try {
      const summary = summarizeChapter(rel, text)
      found.push({
        rel,
        abs,
        volume: summary.volume,
        number: summary.number,
        archived: summary.archived,
        title: summary.title,
      })
    } catch {
      // Unparseable frontmatter: not this script's business (the panel says so
      // when the author opens the file).
    }
  }
  return found
}

/**
 * Which other documents mention one of these ids in their frontmatter.
 *
 * It is a **string match on the parsed frontmatter**, not a semantic reference
 * walk: that is what makes it honest about what it can promise — it finds
 * `characters: [chen-mo]`, `pov: chen-mo`, a thread's `plantedIn: c0001`, and
 * nothing else. Deleting a file whose id is listed here will make the checks
 * report those references as dangling, which is the point of printing this
 * before anything is removed.
 * @param {string} root - absolute project root.
 * @param {ReadonlySet<string>} ids - the ids about to disappear.
 * @param {ReadonlySet<string>} skip - absolute paths to ignore (the files themselves).
 * @returns {Promise<Map<string, string[]>>} id → the paths that name it.
 */
export async function referencesTo(root, ids, skip) {
  /** @type {Map<string, string[]>} */
  const found = new Map()
  for (const tree of DOC_TREES) {
    for (const abs of await walkFiles(join(root, tree))) {
      if (skip.has(abs)) continue
      const rel = relative(root, abs).split(sep).join('/')
      if (!rel.endsWith('.md')) continue
      let text
      try {
        text = await readFile(abs, 'utf8')
      } catch {
        continue
      }
      let data
      try {
        data = parseDocument(text).data
      } catch {
        continue
      }
      const serialized = JSON.stringify(data)
      for (const id of ids) {
        if (!serialized.includes(`"${id}"`)) continue
        found.set(id, [...(found.get(id) ?? []), rel])
      }
    }
  }
  return found
}

/**
 * Whether a human is at the console, as opposed to a pipe or a redirected file.
 *
 * Everything destructive in these scripts is gated on this: with a terminal we
 * ask, without one we only ever print the dry run. That is what makes the same
 * file safe to double-click *and* safe to run from a build script.
 * @returns {boolean} true when stdin is a terminal.
 */
export function interactive() {
  return process.stdin.isTTY === true
}

/**
 * Ask one line, or take the fallback when there is nobody to ask.
 * @param {string} question - the prompt text.
 * @param {string} fallback - the value to use when stdin is not a terminal.
 * @returns {Promise<string>} the answer, cleaned like a command-line path.
 */
export async function askText(question, fallback = '') {
  if (!interactive()) return fallback
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(question)).trim()
    return answer === '' ? fallback : answer
  } finally {
    rl.close()
  }
}

/**
 * Ask a yes/no question.
 *
 * **Not a terminal means no.** A piped or redirected run must never delete or
 * rename anything without an explicit `--apply`, so the answer defaults to "no"
 * rather than hanging on a prompt nobody can see.
 * @param {string} question - the prompt text.
 * @returns {Promise<boolean>} whether the author said yes.
 */
export async function askYesNo(question) {
  if (!interactive()) return false
  const answer = (await askText(`${question}（y/N）：`)).toLowerCase()
  return answer === 'y' || answer === 'yes' || answer === '是'
}

/**
 * Read the flags these scripts share.
 *
 * `--apply` is the only thing that makes a command touch the disk: both commands
 * print what they would do otherwise, which is how a delete stays a decision the
 * author made rather than a typo they suffered.
 * @param {string[]} argv - `process.argv.slice(2)`.
 * @returns {{root: string | undefined, apply: boolean, suffix: string, restore: boolean}} the parsed command line.
 */
export function parseFlags(argv) {
  const rest = []
  let apply = false
  let restore = false
  let suffix = '.archived'
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--apply') apply = true
    else if (arg === '--restore') restore = true
    else if (arg === '--suffix') {
      const next = argv[index + 1]
      if (next === undefined || next === '') throw new Error('--suffix 后面要跟一个后缀，例如 --suffix .old')
      suffix = next
      index += 1
    } else if (arg.startsWith('--suffix=')) suffix = arg.slice('--suffix='.length)
    else rest.push(arg)
  }
  return { root: rest[0], apply, suffix, restore }
}

/** A human-readable size, for one report line. */
export function humanBytes(bytes) {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** One report line for a candidate file. */
export function describe(file) {
  const name = file.name === '' ? '' : `「${file.name}」`
  return `${file.rel}${name} · ${file.kind} · ${humanBytes(file.bytes)}`
}

/** Print a title line. */
export function heading(text) {
  console.log(`\n${text}`)
}
