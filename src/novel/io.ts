/**
 * IO layer: everything that touches the host filesystem.
 *
 * Three rules shape this module:
 *
 * 1. **`ctx.fs` is the only door.** Reads and writes go through the composed
 *    filesystem seam, never `node:fs`, so whatever backend the deployment
 *    composed (local, sandboxed, remote) owns the behaviour.
 * 2. **Writes carry the session's sandbox policy.** Every `writeText` passes
 *    `sandboxPolicy.resolve({ session })`, so an author in `read-only` cannot
 *    be written through by a panel button, and `workspace-write` keeps writes
 *    inside the session workspace exactly as it does for the agent's own tools.
 * 3. **The project root is a fence, not a hint.** Each resolved target is
 *    checked with `ctx.fs.contains` against the project root, so a crafted
 *    `../` path cannot leave the novel even when the sandbox would allow it.
 *
 * @module dsh-ai-novel-copilot/novel/io
 */
import { ProjectCache, type ScanRequest, type ScanSource, type ScannedFile } from './cache.ts'
import {
  ExportError,
  renderExport,
  type ExportPlan,
  type ExportRequest,
} from './book-export.ts'
import { parseDocument, parseYamlData, serializeDocument, serializeYamlData } from './document.ts'
import {
  actionOf,
  parseHistoryEntry,
  type HistoryEntry,
  type HistorySource,
  type HistorySummary,
} from './history.ts'
import {
  CARD_LABELS,
  cardPath,
  compareHistoryFiles,
  EXPORTS_DIR,
  freeHistoryStamp,
  historyDirOf,
  historyFileOf,
  isCardPath,
  isDocumentPath,
  isSlug,
  OUTLINE_DIR,
  STYLE_GUIDE_FILE,
  TIMELINE_FILE,
  WORLD_FILE,
} from './paths.ts'
import { CARD_SECTIONS } from './cards.ts'
import { writeDenialNote } from './sandbox.ts'
import { countWords } from './words.ts'
import { checkProject, type CheckCard, type CheckChapter, type CheckCorpus, type CheckPage, type CheckRelation, type CheckReport } from './checks.ts'
import {
  searchDocs,
  type SearchDoc,
  type SearchResult,
} from './search.ts'
import {
  CARD_DIRS,
  CARD_TYPES,
  CHAPTERS_DIR,
  MACHINE_DIR,
  PROJECT_FILE,
  chapterPath,
  groupCards,
  identityOfPath,
  isChapterPath,
  mergeVolumes,
  nextChapterNumber,
  referenceIndex,
  scaffoldFiles,
  summarizeCard,
  summarizeChapter,
  summarizeParsedCard,
  summarizeParsedChapter,
  threadChaptersOf,
  type CardGroup,
  type CardSummary,
  type CardType,
  type ChapterStatus,
  type ChapterSummary,
  type ProjectSnapshot,
  type VolumeOutline,
} from './project.ts'

/**
 * Where the author's "ignore this finding" decisions live.
 *
 * Deliberately **not** `.novel/index.json`, which the requirement names: the
 * format document defines that file as a rebuildable cache that never enters git
 * (`03` §5), and an ignore decision is the author's, not something derivable.
 * Keeping it in its own committed file is what makes "可忽略并记忆" (§8) true
 * after a cache rebuild.
 */
const CHECK_IGNORE_FILE = `${MACHINE_DIR}/checks.json`

/**
 * How one loose document presents itself to the readers that scan it.
 *
 * The search corpus needs a title and a label; the project snapshot needs to know
 * which volumes exist and what the author named them (format §4.11). Both read the
 * same cached scan, so both facts are derived in one place.
 */
interface PageInfo {
  /** Display title, e.g. `世界观` / `第 2 卷卷纲`. */
  title: string
  /** Grouping label, e.g. `设定文档` / `大纲`. */
  label: string
  /** Volume number, for a volume outline only. */
  volume?: number
  /** The volume's name, from the outline's frontmatter `title`. */
  volumeTitle?: string
}

/** An opaque filesystem target as the host seam hands it out. */
interface FsTarget {
  targetKey: string
  displayPath: string
}
/** File metadata the host seam reports. */
interface FsInfo {
  version: string
  type: 'file' | 'directory' | 'other'
  size?: number
}

/**
 * One directory child the host seam reports.
 *
 * `version` is optional because not every backend reports one in a listing
 * (`dsh-fs-local` does; the in-memory double in the checks does not). The scan
 * cache falls back to a stat when it is absent, and refuses to cache at all when
 * neither gives a token — see `cache.ts`.
 */
interface FsDirEntry {
  name: string
  type: 'file' | 'directory' | 'other'
  target: FsTarget
  version?: string
  size?: number
}

/** Guarded write intent. */
type FsWriteIntent = { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion', version: string }

/** The write outcome, including the pre-write text used as a diff basis. */
interface FsWriteOutcome {
  operation: 'create' | 'update'
  version: string
  before: string | null
  after: string
}

/** The slice of the host filesystem seam this plugin uses. */
export interface FsService {
  resolve(path: string, opts?: { cwd?: string, signal?: AbortSignal }): Promise<FsTarget>
  contains(parent: FsTarget, child: FsTarget): boolean
  stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>
  readText(target: FsTarget, signal?: AbortSignal): Promise<string>
  listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>
  writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: unknown,
  ): Promise<FsWriteOutcome>
}

/** One resolved sandbox policy: the mode and the workspace it fences writes to. */
export interface SandboxExecutionPolicy {
  mode: 'read-only' | 'workspace-write' | 'danger-full-access'
  workspaceRoot: string
}

/** The slice of the sandbox-policy service this plugin uses. */
export interface SandboxPolicyService {
  resolve(request?: { session?: unknown }): SandboxExecutionPolicy
}

/** The slice of the session registry this plugin uses. */
export interface SessionsService {
  get(sessionId: string): { header?: { cwd?: string } } | undefined
}

/** The host services this plugin's IO half needs. */
export interface NovelContext {
  fs: FsService
  sandboxPolicy: SandboxPolicyService
  sessions: SessionsService
  logger?: { warn(message: unknown): void }
}

/** A failure with a stable code, so the HTTP layer can choose a status. */
export class NovelError extends Error {
  /**
   * @param code - stable machine code, `novel/<reason>`.
   * @param message - human-readable explanation.
   */
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'NovelError'
  }
}

/** One chapter as the editor loads it. */
export interface LoadedChapter {
  /** Storage-relative path. */
  path: string
  /** Frontmatter data, verbatim. */
  data: Record<string, unknown>
  /** Prose. */
  body: string
  /** Measured body length. */
  wordCount: number
  /** Freshness token for a guarded write. */
  version: string
}

/** What a chapter write produced. */
export interface WrittenChapter {
  /** Measured body length after the write. */
  wordCount: number
  /** Whether the file was created or replaced. */
  operation: 'create' | 'update'
  /** Freshness token after the write. */
  version: string
  /** Text before the write, or null for a create. */
  before: string | null
  /** Text after the write. */
  after: string
  /**
   * Why the modification record did not get a version, when it did not.
   *
   * The write itself succeeded — that is why this is a warning rather than an
   * error — but "your edit is safe, its undo entry is not" is exactly the kind of
   * half-failure an author has to be told about, since the record is the only
   * way back (`11` §5 used to list this as "面板不会说").
   */
  warning?: string
}

/** The novel root and the enforcement context every call carries. */
export interface NovelScope {
  /** Absolute project root. */
  root: string
  /** Session whose sandbox policy fences writes. */
  sessionId: string
}

/** One frontmatter document — a chapter, a setting card, or an outline. */
export interface LoadedDocument {
  /** Storage-relative path. */
  path: string
  /** Frontmatter data, verbatim; empty for a file that carries none. */
  data: Record<string, unknown>
  /** Everything after the frontmatter. */
  body: string
  /** Freshness token for a guarded write. */
  version: string
}

/** What a document write produced. */
export interface WrittenDocument {
  /** Storage-relative path. */
  path: string
  /** Whether the file was created or replaced. */
  operation: 'create' | 'update'
  /** Freshness token after the write. */
  version: string
  /** Text before the write, or null for a create. */
  before: string | null
  /** Text after the write. */
  after: string
  /** Why the modification record did not get a version, when it did not. */
  warning?: string
}

/** One directory listing. */
export interface DirListing {
  /** Storage-relative directory path; empty string means the project root. */
  path: string
  /** Whether the directory exists. An absent directory is a fact, not an error. */
  exists: boolean
  /** Direct children, in stable name order. */
  entries: { name: string, type: 'file' | 'directory' | 'other', path: string }[]
}

/** One single-file settings page as the library lists it. */
export interface SettingsPage {
  /** Storage-relative path. */
  path: string
  /** Whether the file exists yet. */
  exists: boolean
  /** Display label. */
  title: string
  /** First non-empty body line, for the list. */
  gist: string
}

/** The whole settings library: cards grouped by type, plus the two single-file pages. */
export interface SettingsLibrary {
  /** Cards grouped by type, in the format's display order. */
  groups: CardGroup[]
  /** `world.md` and `timeline.md`, existing or not. */
  pages: SettingsPage[]
  /** How many cards of every type are listed. */
  total: number
  /** How many of them are archived. */
  archived: number
}

/** Everything needed to create one chapter. */
export interface NewChapterSpec {
  /** Volume to append to. */
  volume: number
  /** Chapter title. */
  title: string
  /** Explicit chapter number; omitted means "one past the current last". */
  number?: number
  /** Outline beats to write into frontmatter. */
  beats?: string[]
  /** Character card ids the chapter features. */
  characters?: string[]
  /** Location card ids the chapter uses. */
  locations?: string[]
  /**
   * Ids of the generic `lore` cards this chapter is written against.
   *
   * A separate field because the other two are read literally elsewhere — `pov`
   * has to be in `characters`, and retrieval answers "who appears in which
   * chapter" from both — so putting a cultivation ladder in `characters` would
   * make those answers lie. These ids reach the chapter-writing task the same way
   * character cards do.
   */
  refs?: string[]
  /** One-line summary. */
  summary?: string
  /** Point-of-view character id. */
  pov?: string
  /** Target length in words. */
  targetWords?: number
  /** What asked for the chapter, recorded with the version it creates. */
  source?: HistorySource
}

/** Normalize a storage-relative path: forward slashes, no leading or trailing separators. */
function normalizeRelative(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

/**
 * The body skeleton a new card starts with.
 *
 * The headings themselves live in `novel/cards.ts` (`CARD_SECTIONS`) because the
 * panel's editor names the same sections in its placeholder: one table, so the
 * textarea cannot describe a shape the scaffold does not write.
 * @param type - card type.
 * @returns the Markdown skeleton.
 */
function cardSections(type: CardType): string {
  return CARD_SECTIONS[type].map(title => `## ${title}\n`).join('\n')
}

/** Read a non-blank string field, or undefined. */
function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Read a list-of-strings field, where frontmatter may hold a bare scalar.
 * @param value - the raw field.
 * @returns the non-blank entries.
 */
function stringList(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() === '' ? [] : [value.trim()]
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
}

/** The first non-empty line of a file's body, with Markdown decoration stripped. */
function firstContentLine(text: string): string {
  const body = text.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '')
  for (const raw of body.split(/\r?\n/)) {
    const line = raw
      .replace(/^[ \t]*#{1,6}[ \t]*/, '')
      .replace(/^[ \t]*[-*+][ \t]*/, '')
      .trim()
    if (line !== '') return line.length > 80 ? `${line.slice(0, 80)}…` : line
  }
  return ''
}

/**
 * The filesystem-backed novel operations, bound to one host context.
 */
export class NovelIo {
  /**
   * The parsed-file cache behind every whole-project scan.
   *
   * One instance lives as long as the plugin does, which is as long as the host
   * process — so a second search in the same session re-reads the directory
   * listings and nothing else. See `cache.ts` for what it will and will not
   * cache, and why the promise "the answer comes from what is on disk right now"
   * survives it.
   */
  private readonly cache = new ProjectCache()

  /** @param ctx - host context carrying the filesystem, sandbox policy, and sessions. */
  constructor(private readonly ctx: NovelContext) {}

  /**
   * The sandbox policy that fences this session's writes.
   * @param sessionId - session whose mode applies.
   * @returns the resolved policy.
   */
  policy(sessionId: string): SandboxExecutionPolicy {
    const session = this.ctx.sessions.get(sessionId)
    return this.ctx.sandboxPolicy.resolve(session === undefined ? {} : { session })
  }

  /**
   * Resolve a storage-relative path, refusing anything outside the project root.
   * @param scope - project root and session.
   * @param relative - storage-relative path; empty selects the root itself.
   * @returns the resolved target.
   * @throws {NovelError} `novel/outside-project` when the path escapes the root.
   */
  private async target(scope: NovelScope, relative: string): Promise<FsTarget> {
    const clean = normalizeRelative(relative)
    const rootTarget = await this.ctx.fs.resolve(scope.root)
    const target = await this.ctx.fs.resolve(clean === '' ? scope.root : `${scope.root}/${clean}`)
    if (!this.ctx.fs.contains(rootTarget, target)) {
      throw new NovelError('novel/outside-project', `"${relative}" 在小说工程目录之外`)
    }
    return target
  }

  /**
   * Read a text file inside the project.
   * @param scope - project root and session.
   * @param relative - storage-relative path.
   * @returns the text, or undefined when the file does not exist.
   */
  async read(scope: NovelScope, relative: string): Promise<string | undefined> {
    const target = await this.target(scope, relative)
    const info = await this.ctx.fs.stat(target)
    if (info === undefined || info.type !== 'file') return undefined
    return await this.ctx.fs.readText(target)
  }

  /**
   * Write a text file inside the project, fenced by the session's sandbox policy.
   *
   * This is the one place every editable document goes through, which is why the
   * modification record (M7) hangs off it: chapter saves, card saves, outline
   * saves and the rollback itself all arrive here with both the old and the new
   * text already in hand, and none of them can forget to record a version.
   * @param scope - project root and session.
   * @param relative - storage-relative path.
   * @param content - full file content.
   * @param source - what produced the change, recorded with the version.
   * @returns the write outcome.
   */
  async write(
    scope: NovelScope,
    relative: string,
    content: string,
    source: HistorySource = { kind: 'manual' },
  ): Promise<FsWriteOutcome & { warning?: string }> {
    const outcome = await this.writeRaw(scope, relative, content)
    const warning = await this.recordHistory(scope, relative, outcome.before ?? '', content, source)
    return warning === undefined ? outcome : { ...outcome, warning }
  }

  /**
   * Write without recording a version.
   *
   * Used for the history files themselves — recording a version of a version
   * would be a loop, and `.novel/` is not a document tree anyway — and for any
   * future writer that is not an edit of the author's prose.
   * @param scope - project root and session.
   * @param relative - storage-relative path.
   * @param content - full file content.
   * @returns the write outcome.
   */
  private async writeRaw(scope: NovelScope, relative: string, content: string): Promise<FsWriteOutcome> {
    const target = await this.target(scope, relative)
    const policy = this.policy(scope.sessionId)
    try {
      const outcome = await this.ctx.fs.writeText(target, content, undefined, undefined, policy)
      // Our own write is the one change we never have to re-derive from a token.
      this.cache.invalidate(scope.root, normalizeRelative(relative))
      return outcome
    } catch (error) {
      // A sandbox denial is the author's environment talking, not a plugin bug:
      // name the root this session may write under and where the book actually is,
      // or the only thing the panel can say is "access denied". The message is
      // appended to rather than wrapped — the code is what the HTTP layer maps to a
      // status and what the panel prints, and a new error would drop it.
      if (error instanceof Error) {
        const raw = error as unknown as { code?: unknown }
        const code = typeof raw.code === 'string' ? raw.code : error.name
        const session = this.ctx.sessions.get(scope.sessionId)
        const sessionCwd = session?.header?.cwd
        const note = writeDenialNote({
          code,
          mode: policy.mode,
          workspaceRoot: policy.workspaceRoot,
          projectRoot: scope.root,
          session: {
            id: scope.sessionId,
            found: session !== undefined,
            ...(typeof sessionCwd === 'string' && sessionCwd !== '' ? { cwd: sessionCwd } : {}),
          },
        })
        if (note !== undefined) error.message += ` ${note}`
      }
      throw error
    }
  }

  /**
   * Append one version to a document's modification record.
   *
   * Two deliberate non-failures live here:
   *
   * 1. **A save that changed nothing is not a version.** Re-saving an untouched
   *    chapter would otherwise fill the record with entries that say "no
   *    difference", and the author would stop trusting the list.
   * 2. **A history write that fails does not fail the save.** The chapter is
   *    already on disk by the time this runs; reporting a failure would be
   *    reporting the wrong thing, so the problem is logged **and returned** for
   *    the caller to pass on as a warning. Until P5 it was only logged, which
   *    meant the panel said "已保存" while the author's only way back had not
   *    been written — a half-truth the panel now has the vocabulary to tell.
   * @param scope - project root and session.
   * @param relative - storage-relative path that was written.
   * @param before - the file's text before the write; empty when it did not exist.
   * @param after - the file's text after the write.
   * @param source - what produced the change.
   * @returns why no version was recorded, or undefined when one was.
   */
  private async recordHistory(
    scope: NovelScope,
    relative: string,
    before: string,
    after: string,
    source: HistorySource,
  ): Promise<string | undefined> {
    const path = normalizeRelative(relative)
    // `novel.yaml`, `.novel/*` and `runs/` are not documents: they have no panel
    // editing surface and no undo.
    if (!isDocumentPath(path) || before === after) return undefined
    try {
      const beforeData = parseDocument(before).data
      const afterData = parseDocument(after).data
      const dir = historyDirOf(path)
      const taken = new Set((await this.list(scope, dir))
        .filter(entry => entry.type === 'file')
        .map(entry => entry.name))
      const at = freeHistoryStamp(taken, new Date().toISOString())
      if (at === undefined) {
        throw new NovelError('novel/conflict', `修改记录目录里连续一千毫秒都已被占用：${dir}`)
      }
      const entry: HistoryEntry = {
        at,
        path,
        action: actionOf(before, after, beforeData.archived === true, afterData.archived === true, source),
        source,
        before,
        after,
      }
      await this.writeRaw(scope, historyFileOf(path, at), `${JSON.stringify(entry, null, 2)}\n`)
      return undefined
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      this.ctx.logger?.warn(`AI-Novel-Copilot: 修改记录写入失败（${path}）：${why}`)
      return `修改记录没写进去（${why}）——文件已保存，但这一版不能回滚`
    }
  }

  /**
   * Whether a path is an existing regular file.
   * @param scope - project root and session.
   * @param relative - storage-relative path.
   * @returns true when the file exists.
   */
  private async isFile(scope: NovelScope, relative: string): Promise<boolean> {
    const target = await this.target(scope, relative)
    const info = await this.ctx.fs.stat(target)
    return info !== undefined && info.type === 'file'
  }

  /**
   * List a directory inside the project.
   * @param scope - project root and session.
   * @param relative - storage-relative directory path; empty selects the root.
   * @returns the children, or an empty array when the directory is absent.
   */
  async list(scope: NovelScope, relative: string): Promise<FsDirEntry[]> {
    const target = await this.target(scope, relative)
    const info = await this.ctx.fs.stat(target)
    if (info === undefined || info.type !== 'directory') return []
    return await this.ctx.fs.listDir(target)
  }

  /**
   * The freshness token for one file, asked of the filesystem directly.
   *
   * This is the fallback for a backend whose directory listing carries no
   * version; `dsh-fs-local` reports one per child, so the common path never
   * reaches here.
   * @param scope - project root and session.
   * @param relative - storage-relative path.
   * @returns the token, or undefined when the path is not a readable file.
   */
  private async statVersion(scope: NovelScope, relative: string): Promise<string | undefined> {
    const target = await this.target(scope, relative)
    const info = await this.ctx.fs.stat(target)
    if (info === undefined || info.type !== 'file') return undefined
    return info.version
  }

  /**
   * The filesystem reads one cached scan needs, bound to this project and session.
   * @param scope - project root and session.
   * @returns the version and read callbacks.
   */
  private scanSource(scope: NovelScope): ScanSource {
    return {
      version: async (relative: string) => await this.statVersion(scope, relative),
      read: async (relative: string) => await this.read(scope, relative),
    }
  }

  /**
   * One scan request per directory child worth reading.
   *
   * The listing is where a full scan gets its freshness tokens for free: the
   * local backend already probed every child to build the listing, so carrying
   * its `version` forward turns "read and parse every file" into "compare a token
   * per file" without an extra stat.
   * @param scope - project root and session.
   * @param relative - directory to list.
   * @param accept - which file names this scan wants.
   * @param prefix - path prefix the children live under.
   * @returns one request per matching child, in listing order.
   */
  private async requestsIn(
    scope: NovelScope,
    relative: string,
    accept: (name: string) => boolean,
    prefix: string,
  ): Promise<ScanRequest[]> {
    const requests: ScanRequest[] = []
    for (const entry of await this.list(scope, relative)) {
      if (entry.type !== 'file' || !accept(entry.name)) continue
      const path = `${prefix}${entry.name}`
      requests.push(entry.version === undefined ? { path } : { path, version: entry.version })
    }
    return requests
  }

  /**
   * Read the whole project tree.
   *
   * The two headline counts describe the *live* book — an archived chapter is
   * withdrawn from the story, not part of its length — while `volumes` carries
   * every chapter with its flag, so the tree can show archived rows on demand.
   * @param scope - project root and session.
   * @returns the snapshot the panel draws.
   */
  async snapshot(scope: NovelScope): Promise<ProjectSnapshot> {
    const meta = await this.projectMeta(scope)
    const chapters = await this.scanChapters(scope)
    // A volume exists when its outline does, not only when it has chapters — so
    // a volume the author planned ahead (第二卷 whose 卷纲 is written, not yet
    // written into) is offered everywhere a volume is offered. The pages scan is
    // the cached one the search corpus already pays for; the extra cost here is
    // the listing of `outline/volumes`, and only on a cold cache the reads.
    const volumes = mergeVolumes(chapters, await this.scanVolumeOutlines(scope))
    const live = chapters.filter(chapter => !chapter.archived)
    const retired = chapters.filter(chapter => chapter.archived)
    return {
      title: meta.title,
      ...(meta.genre === undefined ? {} : { genre: meta.genre }),
      ...(meta.targetWords === undefined ? {} : { targetWords: meta.targetWords }),
      volumes,
      chapterCount: live.length,
      wordCount: live.reduce((sum, chapter) => sum + chapter.wordCount, 0),
      archivedCount: retired.length,
      archivedWords: retired.reduce((sum, chapter) => sum + chapter.wordCount, 0),
    }
  }

  /**
   * Read every chapter's frontmatter, once.
   *
   * Both the project tree and the settings library need this scan — the tree for
   * its chapter list, the library for the reverse links — so it exists once
   * rather than as two loops that can drift apart.
   * @param scope - project root and session.
   * @returns one summary per chapter, in scan order.
   */
  async scanChapters(scope: NovelScope): Promise<ChapterSummary[]> {
    return (await this.scanChapterTexts(scope)).map(entry => entry.summary)
  }

  /**
   * Read every chapter's frontmatter **and** prose in one pass.
   *
   * The search scan needs the bodies as well as the metadata, and the checks
   * need the raw frontmatter (a chapter's *declared* `id` is only visible before
   * the summary falls back to the filename). Reading each file twice — or
   * parsing it twice — to get those would be a cost paid on every query for no
   * reason. One read, one parse, all three.
   *
   * Since P5 that read and parse are cached against each file's freshness token:
   * the listing is re-read every time, so a chapter rewritten outside the panel
   * is picked up on the next query, but an unchanged chapter costs one token
   * comparison instead of a file read and a YAML parse.
   *
   * The returned summaries and frontmatter belong to the cache and are shared
   * with every other caller of this scan: **read them, never write to them.**
   * @param scope - project root and session.
   * @returns one entry per chapter, in scan order.
   */
  private async scanChapterTexts(
    scope: NovelScope,
  ): Promise<{ summary: ChapterSummary, data: Record<string, unknown>, body: string }[]> {
    const requests: ScanRequest[] = []
    for (const volumeEntry of await this.list(scope, CHAPTERS_DIR)) {
      if (volumeEntry.type !== 'directory') continue
      requests.push(...await this.requestsIn(
        scope,
        `${CHAPTERS_DIR}/${volumeEntry.name}`,
        name => name.endsWith('.md'),
        `${CHAPTERS_DIR}/${volumeEntry.name}/`,
      ))
    }
    const scanned = await this.cache.scan(
      scope.root,
      'chapters',
      this.scanSource(scope),
      requests,
      ({ path, data, body }) => summarizeParsedChapter(path, data, body),
    )
    return scanned.map(entry => ({ summary: entry.value, data: entry.data, body: entry.body }))
  }

  /**
   * Read the project metadata file.
   * @param scope - project root and session.
   * @returns title, genre, and target length, each defaulted when absent.
   */
  async projectMeta(scope: NovelScope): Promise<{ title: string, genre?: string, targetWords?: number }> {
    const text = await this.read(scope, PROJECT_FILE)
    if (text === undefined) {
      return { title: scope.root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '未命名小说' }
    }
    try {
      // `novel.yaml` is plain YAML: parsed as a frontmatter document it would
      // silently yield nothing, and every field below would fall back to a default.
      const data = parseYamlData(text)
      const title = typeof data.title === 'string' && data.title !== '' ? data.title : '未命名小说'
      const genre = typeof data.genre === 'string' && data.genre !== '' ? data.genre : undefined
      const targetWords = typeof data.targetWords === 'number' && Number.isFinite(data.targetWords)
        ? data.targetWords
        : undefined
      return { title, ...(genre === undefined ? {} : { genre }), ...(targetWords === undefined ? {} : { targetWords }) }
    } catch (error) {
      throw new NovelError('novel/parse-error', `novel.yaml 不是合法 YAML：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Merge changes into the project metadata file.
   *
   * Only the fields given are touched; anything else the author has written in
   * `novel.yaml` survives, because the panel edits one field at a time and must
   * not silently drop the rest.
   * @param scope - project root and session.
   * @param patch - metadata fields to set.
   * @returns the metadata after the write.
   */
  async writeMeta(
    scope: NovelScope,
    patch: { title?: string, genre?: string, targetWords?: number },
  ): Promise<{ title: string, genre?: string, targetWords?: number }> {
    const text = await this.read(scope, PROJECT_FILE)
    let data: Record<string, unknown> = {}
    if (text !== undefined) {
      try {
        data = parseYamlData(text)
      } catch (error) {
        throw new NovelError(
          'novel/parse-error',
          `novel.yaml 不是合法 YAML，改名前请先修好它：${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    if (patch.title !== undefined) data.title = patch.title
    if (patch.genre !== undefined) data.genre = patch.genre
    if (patch.targetWords !== undefined) data.targetWords = patch.targetWords
    await this.write(scope, PROJECT_FILE, serializeYamlData(data))
    return await this.projectMeta(scope)
  }

  /**
   * Load one chapter for editing.
   * @param scope - project root and session.
   * @param path - storage-relative chapter path.
   * @returns the parsed chapter.
   * @throws {NovelError} `novel/not-a-chapter` for a non-chapter path, `novel/not-found` when absent.
   */
  async readChapter(scope: NovelScope, path: string): Promise<LoadedChapter> {
    const relative = normalizeRelative(path)
    if (!isChapterPath(relative)) {
      throw new NovelError('novel/not-a-chapter', `"${path}" 不是章节文件`)
    }
    const target = await this.target(scope, relative)
    const info = await this.ctx.fs.stat(target)
    if (info === undefined) throw new NovelError('novel/not-found', `章节不存在：${relative}`)
    const text = await this.ctx.fs.readText(target)
    try {
      const { data, body } = parseDocument(text)
      return { path: relative, data, body, wordCount: countWords(body), version: info.version }
    } catch (error) {
      throw new NovelError('novel/parse-error', `${relative} 的 frontmatter 不是合法 YAML：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Write one chapter, replacing the file wholesale.
   * @param scope - project root and session.
   * @param path - storage-relative chapter path.
   * @param data - frontmatter data.
   * @param body - prose.
   * @returns the write result.
   */
  async writeChapter(
    scope: NovelScope,
    path: string,
    data: Record<string, unknown>,
    body: string,
    source: HistorySource = { kind: 'manual' },
  ): Promise<WrittenChapter> {
    const relative = normalizeRelative(path)
    if (!isChapterPath(relative)) {
      throw new NovelError('novel/not-a-chapter', `"${path}" 不是章节文件`)
    }
    const content = serializeDocument(this.stampWordCount(relative, data, body), body)
    const outcome = await this.write(scope, relative, content, source)
    return {
      wordCount: countWords(body),
      operation: outcome.operation,
      version: outcome.version,
      before: outcome.before,
      after: outcome.after,
      ...(outcome.warning === undefined ? {} : { warning: outcome.warning }),
    }
  }

  /**
   * Append a chapter to a volume, numbering it one past the current last.
   * @param scope - project root and session.
   * @param spec - volume, title, and any frontmatter the caller already knows
   *   (beats from a plan, the characters the outline named, a summary).
   * @returns the created chapter's summary.
   * @throws {NovelError} `novel/conflict` when an explicit number is already taken.
   */
  async createChapter(scope: NovelScope, spec: NewChapterSpec): Promise<ChapterSummary> {
    const chapters = await this.scanChapters(scope)
    const volumes = mergeVolumes(chapters, await this.scanVolumeOutlines(scope))
    // The number is the **book's** next number, not the volume's: chapter numbers
    // run continuously across volumes (`project.ts` `nextChapterNumber`), which is
    // what keeps the id derived from it unique across the whole project.
    const number = spec.number ?? nextChapterNumber(volumes)
    const path = chapterPath(spec.volume, number)
    if (spec.number !== undefined && (await this.read(scope, path)) !== undefined) {
      throw new NovelError('novel/conflict', `第 ${String(number)} 章已经存在：${path}`)
    }
    const data: Record<string, unknown> = {
      id: path.split('/').pop()?.replace(/\.md$/, '') ?? '',
      volume: spec.volume,
      number,
      title: spec.title,
      status: 'draft' satisfies ChapterStatus,
      targetWords: spec.targetWords ?? 3000,
      ...(spec.pov === undefined ? {} : { pov: spec.pov }),
      beats: spec.beats ?? [],
      summary: spec.summary ?? '',
      characters: spec.characters ?? [],
      locations: spec.locations ?? [],
      refs: spec.refs ?? [],
      tags: [],
    }
    await this.writeChapter(scope, path, data, '', spec.source ?? { kind: 'manual' })
    return summarizeChapter(path, serializeDocument(data, ''))
  }

  /**
   * Load any editable document — a chapter, a setting card, or an outline.
   * @param scope - project root and session.
   * @param path - storage-relative path inside one of the content trees.
   * @returns the parsed document.
   * @throws {NovelError} `novel/not-a-document` outside the whitelist, `novel/not-found` when absent.
   */
  async readDocument(scope: NovelScope, path: string): Promise<LoadedDocument> {
    const relative = this.documentPath(path)
    const target = await this.target(scope, relative)
    const info = await this.ctx.fs.stat(target)
    if (info === undefined || info.type !== 'file') {
      throw new NovelError('novel/not-found', `文件不存在：${relative}`)
    }
    const text = await this.ctx.fs.readText(target)
    try {
      const { data, body } = parseDocument(text)
      return { path: relative, data, body, version: info.version }
    } catch (error) {
      throw new NovelError('novel/parse-error', `${relative} 的 frontmatter 不是合法 YAML：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Write any editable document, replacing the file wholesale.
   * @param scope - project root and session.
   * @param path - storage-relative path inside one of the content trees.
   * @param data - frontmatter data.
   * @param body - everything after the frontmatter.
   * @param source - what produced the change, recorded with the version.
   * @returns the write result.
   */
  async writeDocument(
    scope: NovelScope,
    path: string,
    data: Record<string, unknown>,
    body: string,
    source: HistorySource = { kind: 'manual' },
  ): Promise<WrittenDocument> {
    const relative = this.documentPath(path)
    const outcome = await this.write(
      scope,
      relative,
      serializeDocument(this.stampWordCount(relative, data, body), body),
      source,
    )
    return {
      path: relative,
      operation: outcome.operation,
      version: outcome.version,
      before: outcome.before,
      after: outcome.after,
      ...(outcome.warning === undefined ? {} : { warning: outcome.warning }),
    }
  }

  /**
   * A document's versions, newest first, without either full text.
   *
   * The list is capped because the files are read to build it: fifty versions of
   * a three-thousand-character chapter is under half a megabyte, five hundred is
   * not. The filenames are ISO-derived, so "the newest N" is a suffix of the
   * directory listing and no file outside the cap is ever opened.
   * @param scope - project root and session.
   * @param path - storage-relative document path.
   * @param limit - how many versions to return, newest first.
   * @returns one summary per version.
   * @throws {NovelError} `novel/not-a-document` outside the whitelist.
   */
  async history(scope: NovelScope, path: string, limit = 50): Promise<HistorySummary[]> {
    const relative = this.documentPath(path)
    const dir = historyDirOf(relative)
    const files = (await this.list(scope, dir))
      .filter(entry => entry.type === 'file' && entry.name.endsWith('.json'))
      .map(entry => entry.name)
      // Sorted here rather than trusting the backend's order: the collision
      // suffix does not sort the way time does (see `compareHistoryFiles`), and
      // getting this wrong drops the *newest* version of a same-millisecond pair.
      .sort(compareHistoryFiles)
    const summaries: HistorySummary[] = []
    for (const name of files.slice(Math.max(0, files.length - Math.max(limit, 1))).reverse()) {
      const stored = await this.readHistoryFile(scope, `${dir}/${name}`, relative)
      if (stored === undefined) continue
      summaries.push({
        at: stored.at,
        action: stored.action,
        source: stored.source,
        beforeBytes: stored.before.length,
        afterBytes: stored.after.length,
      })
    }
    return summaries
  }

  /**
   * One version, with both texts, for the diff.
   *
   * The filename is derived from the timestamp rather than searched for, which
   * is only sound because {@link freeHistoryStamp} makes timestamps unique — the
   * property that also makes a rollback target unambiguous.
   * @param scope - project root and session.
   * @param path - storage-relative document path.
   * @param at - the timestamp the version was recorded under.
   * @returns the version, or undefined when it is not in the record.
   */
  async historyEntry(scope: NovelScope, path: string, at: string): Promise<HistoryEntry | undefined> {
    const relative = this.documentPath(path)
    return await this.readHistoryFile(scope, historyFileOf(relative, at), relative)
  }

  /**
   * Put one version back, exactly as it was stored.
   *
   * The stored `after` is written **verbatim** rather than re-serialized from
   * parsed frontmatter: this version was itself produced by a normal save, so it
   * already carries a correct `wordCount` and the author's key order, and
   * "roll back to this version" should mean exactly that, not "something
   * equivalent". The rollback is recorded like any other change, so it can be
   * rolled back in turn.
   * @param scope - project root and session.
   * @param path - storage-relative document path.
   * @param at - the timestamp of the version to restore.
   * @returns the restored document, as the editor loads it.
   * @throws {NovelError} `novel/not-found` when that version is not in the record.
   */
  async revert(scope: NovelScope, path: string, at: string): Promise<LoadedDocument> {
    const relative = this.documentPath(path)
    const entry = await this.historyEntry(scope, relative, at)
    if (entry === undefined) {
      throw new NovelError('novel/not-found', `修改记录里没有这一版：${relative} @ ${at}`)
    }
    await this.write(scope, relative, entry.after, { kind: 'revert', from: at })
    return await this.readDocument(scope, relative)
  }

  /**
   * Read one stored version, tolerantly.
   * @param scope - project root and session.
   * @param file - storage-relative path of the history file.
   * @param path - the document the entry belongs to.
   * @returns the entry, or undefined when the file is missing or unusable.
   */
  private async readHistoryFile(
    scope: NovelScope,
    file: string,
    path: string,
  ): Promise<HistoryEntry | undefined> {
    const text = await this.read(scope, file)
    if (text === undefined) return undefined
    try {
      return parseHistoryEntry(JSON.parse(text), path)
    } catch {
      return undefined
    }
  }

  /**
   * Create one setting card with its type's section skeleton.
   * @param scope - project root and session.
   * @param type - card type.
   * @param id - slug id; the filename.
   * @param name - display name.
   * @returns the created card's summary.
   * @throws {NovelError} `novel/bad-request` for an invalid or taken id.
   */
  async createCard(scope: NovelScope, type: CardType, id: string, name: string): Promise<CardSummary> {
    if (!isSlug(id)) {
      throw new NovelError('novel/bad-request', `卡 id 只能用小写字母、数字与连字符（现在：${id}）`)
    }
    const path = cardPath(type, id)
    if ((await this.read(scope, path)) !== undefined) {
      throw new NovelError('novel/conflict', `这张卡已经存在：${path}`)
    }
    const data: Record<string, unknown> = {
      id,
      type,
      ...(type === 'thread' ? { title: name, status: 'planted' } : { name }),
      tags: [],
    }
    await this.writeDocument(scope, path, data, `\n${cardSections(type)}`)
    return summarizeCard(path, serializeDocument(data, ''), []) as CardSummary
  }

  /**
   * Read the settings library: every card, grouped, plus the two single-file pages.
   *
   * The reverse links ("which chapters use this card") come from the same chapter
   * scan the tree uses, because the format keeps references one-way and this
   * derived view is the only place the other direction exists.
   * @param scope - project root and session.
   * @returns the grouped cards, both pages, and the archive counts.
   */
  async library(scope: NovelScope): Promise<SettingsLibrary> {
    const chapters = await this.scanChapters(scope)
    const index = referenceIndex(chapters)
    const cards = (await this.scanCardDocs(scope, index)).map(entry => entry.summary)
    const pages: SettingsPage[] = []
    for (const [path, title] of [[WORLD_FILE, '世界观'], [TIMELINE_FILE, '时间线']] as const) {
      const text = await this.read(scope, path)
      pages.push({
        path,
        exists: text !== undefined,
        title,
        gist: text === undefined ? '' : firstContentLine(text),
      })
    }
    return {
      groups: groupCards(cards),
      pages,
      total: cards.length,
      archived: cards.filter(card => card.archived).length,
    }
  }

  /**
   * Read every setting card's frontmatter **and** body in one pass.
   *
   * The card's `appearsIn` list is the one part of a card summary that is **not**
   * derived from the card: it comes from the chapters that name it. It is
   * therefore applied here, on top of the cached value, rather than derived
   * inside the scan — a value cached under a card's own freshness token must not
   * depend on any other file.
   * @param scope - project root and session.
   * @param index - the reverse index for the cards' `appearsIn` lists.
   * @returns one entry per card, in scan order.
   */
  private async scanCardDocs(
    scope: NovelScope,
    index: ReadonlyMap<string, string[]>,
  ): Promise<{ summary: CardSummary, data: Record<string, unknown>, body: string }[]> {
    const requests: ScanRequest[] = []
    for (const type of CARD_TYPES) {
      const dir = `settings/${CARD_DIRS[type]}`
      requests.push(...await this.requestsIn(
        scope,
        dir,
        name => name.endsWith('.md') && isCardPath(`${dir}/${name}`),
        `${dir}/`,
      ))
    }
    const scanned = await this.cache.scan(
      scope.root,
      'cards',
      this.scanSource(scope),
      requests,
      ({ path, data, body }) => summarizeParsedCard(path, data, body),
    )
    return scanned.flatMap((entry: ScannedFile<CardSummary | undefined>) => entry.value === undefined
      ? []
      : [{
        summary: { ...entry.value, appearsIn: [...(index.get(entry.value.id) ?? [])] },
        data: entry.data,
        body: entry.body,
      }])
  }

  /**
   * Read everything a search looks at: chapters, setting cards, and the loose
   * documents (world, timeline, the outlines, the voice guide).
   *
   * The corpus objects themselves are rebuilt per query — a few hundred small
   * objects, cheap to make and impossible to get stale — on top of parses that
   * are cached against each file's freshness token (`cache.ts`). A million-word
   * book therefore pays for its file reads once, and one token comparison per
   * file per query after that.
   * @param scope - project root and session.
   * @returns one document per searchable file.
   */
  async searchCorpus(scope: NovelScope): Promise<SearchDoc[]> {
    const docs: SearchDoc[] = []
    const chapters = await this.scanChapterTexts(scope)
    for (const { summary, body } of chapters) {
      docs.push({
        kind: 'chapter',
        path: summary.path,
        id: summary.id,
        title: summary.title,
        label: `第 ${String(summary.number)} 章`,
        number: summary.number,
        volume: summary.volume,
        archived: summary.archived,
        aliases: [],
        tags: [],
        summary: summary.summary,
        beats: summary.beats,
        characters: summary.characters,
        locations: summary.locations,
        refs: summary.refs,
        ...(summary.pov === undefined ? {} : { pov: summary.pov }),
        body,
      })
    }

    const index = referenceIndex(chapters.map(entry => entry.summary))
    for (const { summary, data, body } of await this.scanCardDocs(scope, index)) {
      docs.push({
        kind: 'card',
        path: summary.path,
        id: summary.id,
        title: summary.name,
        label: CARD_LABELS[summary.type],
        archived: summary.archived,
        cardType: summary.type,
        name: summary.name,
        aliases: summary.aliases,
        tags: summary.tags,
        summary: summary.gist,
        beats: summary.thread === undefined ? [] : threadChaptersOf(summary.thread),
        characters: [],
        locations: [],
        refs: [],
        ...(summary.firstAppear === undefined ? {} : { firstAppear: summary.firstAppear }),
        ...(summary.thread === undefined ? {} : { thread: summary.thread }),
        body,
      })
    }

    for (const page of await this.searchPages(scope)) docs.push(page)
    return docs
  }

  /**
   * Search the project and answer the query.
   * @param scope - project root and session.
   * @param query - what the author typed.
   * @param limit - how many hits to return.
   * @returns the deterministic answer, the ranked hits, and the counts.
   */
  async search(scope: NovelScope, query: string, limit = 40): Promise<SearchResult> {
    return searchDocs(await this.searchCorpus(scope), query, limit)
  }

  /**
   * How one loose document presents itself in a search result — and, for a
   * volume outline, which volume it belongs to and what the author named it.
   *
   * The two facts share one derive function on purpose. The scan cache stores one
   * value per file path, so scanning the same file twice under two shapes would
   * make whichever ran last the answer for both readers (see `cache.ts`).
   * @param path - storage-relative path.
   * @param data - the file's frontmatter.
   * @returns its title and label, or undefined when it is not a loose page.
   */
  private pageOf(path: string, data: Record<string, unknown>): PageInfo | undefined {
    if (path === WORLD_FILE) return { title: '世界观', label: '设定文档' }
    if (path === TIMELINE_FILE) return { title: '时间线', label: '设定文档' }
    if (path === `${OUTLINE_DIR}/book.md`) return { title: '全书主线', label: '大纲' }
    if (path === STYLE_GUIDE_FILE) return { title: '文风规则', label: '文风' }
    const prefix = `${OUTLINE_DIR}/volumes/`
    if (!path.startsWith(prefix)) return undefined
    const name = path.slice(prefix.length)
    const matched = /^v(\d+)\.md$/.exec(name)
    if (matched?.[1] === undefined) return undefined
    const volume = Number(matched[1])
    const title = stringOf(data.title)
    return {
      title: `第 ${String(volume)} 卷卷纲`,
      label: '大纲',
      volume,
      ...(title === undefined ? {} : { volumeTitle: title }),
    }
  }

  /**
   * Read the loose documents a search looks at besides chapters and cards.
   *
   * A setting is often explained in `world.md` rather than in a card, and a
   * volume's outline is where a plan was written down, so both belong in the
   * corpus. Style samples do not: they are the author's own prose, kept as a
   * voice anchor, and matching them would fill the result list with fiction.
   *
   * Unlike chapters and cards these are a small fixed set plus one file per
   * volume, so the scan is cheap either way — but it goes through the same cache
   * so the whole corpus is built from one consistent view of the project.
   * @param scope - project root and session.
   * @returns one entry per existing page.
   */
  private async scanPages(scope: NovelScope): Promise<ScannedFile<PageInfo>[]> {
    const requests: ScanRequest[] = [
      { path: WORLD_FILE },
      { path: TIMELINE_FILE },
      { path: `${OUTLINE_DIR}/book.md` },
      { path: STYLE_GUIDE_FILE },
    ]
    requests.push(...await this.requestsIn(scope, `${OUTLINE_DIR}/volumes`, name => name.endsWith('.md'), `${OUTLINE_DIR}/volumes/`))
    return await this.cache.scan(
      scope.root,
      'pages',
      this.scanSource(scope),
      requests,
      ({ path, data }) => this.pageOf(path, data) ?? { title: path, label: '设定文档' },
    )
  }

  /**
   * Which volumes exist, from the outline directory alone.
   *
   * A volume outline is the only trace a planned-but-unwritten volume leaves, and
   * its frontmatter `title` is where its name lives (format §4.11). Volumes are
   * also derived from `chapters/vNN/`; {@link mergeVolumes} is what unites the two.
   * @param scope - project root and session.
   * @returns one entry per volume outline that exists.
   */
  private async scanVolumeOutlines(scope: NovelScope): Promise<VolumeOutline[]> {
    const outlines: VolumeOutline[] = []
    for (const entry of await this.scanPages(scope)) {
      const { volume, volumeTitle } = entry.value
      if (volume === undefined) continue
      outlines.push({ volume, ...(volumeTitle === undefined ? {} : { title: volumeTitle }) })
    }
    return outlines
  }

  /**
   * The loose documents as search documents.
   *
   * The body is the **whole file**, frontmatter included, exactly as it was
   * before this scan was cached: a page's frontmatter is part of what an author
   * would expect a search to find in it, and quietly narrowing that would be a
   * behaviour change smuggled in under a performance one.
   * @param scope - project root and session.
   * @returns one document per existing page.
   */
  private async searchPages(scope: NovelScope): Promise<SearchDoc[]> {
    return (await this.scanPages(scope)).map(entry => ({
      kind: 'page' as const,
      path: entry.path,
      id: entry.path,
      title: entry.value.title,
      label: entry.value.label,
      archived: false,
      aliases: [],
      tags: [],
      summary: firstContentLine(entry.text),
      beats: [],
      characters: [],
      locations: [],
      refs: [],
      body: entry.text,
    }))
  }

  /**
   * Build the consistency-check corpus from the same scan the search uses.
   *
   * The rules need three things the search corpus does not carry: a chapter's
   * *declared* `id` (before the filename fallback), a card's `relations`, and
   * the loose pages' raw bodies. Everything else is mapped from the same read,
   * so a check and a search can never disagree about what the project contains.
   * @param scope - project root and session.
   * @returns the parsed project, as the rules see it.
   */
  async checkCorpus(scope: NovelScope): Promise<CheckCorpus> {
    const scanned = await this.scanChapterTexts(scope)
    const chapters: CheckChapter[] = scanned.map(({ summary, data, body }) => {
      const declaredId = stringOf(data.id)
      const targetWords = typeof summary.targetWords === 'number' ? summary.targetWords : undefined
      return {
        path: summary.path,
        fileId: identityOfPath(summary.path)?.id ?? summary.id,
        ...(declaredId === undefined ? {} : { declaredId }),
        title: summary.title,
        volume: summary.volume,
        number: summary.number,
        status: summary.status,
        ...(summary.pov === undefined ? {} : { pov: summary.pov }),
        characters: summary.characters,
        locations: summary.locations,
        refs: summary.refs,
        contextChapters: summary.contextChapters,
        ...(targetWords === undefined ? {} : { targetWords }),
        wordCount: summary.wordCount,
        archived: summary.archived,
        body,
      }
    })

    const index = referenceIndex(scanned.map(entry => entry.summary))
    const cards: CheckCard[] = []
    for (const { summary, data } of await this.scanCardDocs(scope, index)) {
      const relations: CheckRelation[] = []
      if (Array.isArray(data.relations)) {
        for (const entry of data.relations) {
          if (typeof entry !== 'object' || entry === null) continue
          const record = entry as Record<string, unknown>
          const to = stringOf(record.to)
          if (to === undefined) continue
          relations.push({ to, kind: stringOf(record.kind) ?? '' })
        }
      }
      cards.push({
        path: summary.path,
        id: summary.id,
        type: summary.type,
        name: summary.name,
        aliases: summary.aliases,
        archived: summary.archived,
        ...(summary.firstAppear === undefined ? {} : { firstAppear: summary.firstAppear }),
        relations,
        ...(summary.thread === undefined ? {} : { thread: summary.thread }),
      })
    }

    const pages: CheckPage[] = (await this.searchPages(scope)).map(doc => ({
      path: doc.path,
      title: doc.title,
      body: doc.body,
    }))
    return { chapters, cards, pages }
  }

  /**
   * Read the author's "ignore this finding" decisions.
   *
   * A corrupt or absent file loses the decisions, never the panel: an ignore list
   * is a convenience, and failing a check because its ignore file is unreadable
   * would be the tail wagging the dog.
   * @param scope - project root and session.
   * @returns the stored ignore keys.
   */
  async checkIgnores(scope: NovelScope): Promise<string[]> {
    const text = await this.read(scope, CHECK_IGNORE_FILE)
    if (text === undefined) return []
    try {
      const parsed: unknown = JSON.parse(text)
      const list = Array.isArray(parsed) ? parsed : (parsed as { ignored?: unknown } | null)?.ignored
      if (!Array.isArray(list)) return []
      return [...new Set(list.filter((entry): entry is string => typeof entry === 'string' && entry !== ''))]
    } catch {
      return []
    }
  }

  /**
   * Record or drop one ignore decision.
   * @param scope - project root and session.
   * @param key - the issue key to ignore or un-ignore.
   * @param ignored - true to ignore it, false to bring it back.
   * @returns the new ignore list and the report it produces.
   */
  async setCheckIgnore(
    scope: NovelScope,
    key: string,
    ignored: boolean,
  ): Promise<{ ignored: string[], report: CheckReport }> {
    const current = await this.checkIgnores(scope)
    const next = [...new Set(ignored ? [...current, key] : current.filter(entry => entry !== key))].sort()
    // Written even when the list empties, so the file always states the current
    // decision rather than leaving a stale key behind.
    await this.write(scope, CHECK_IGNORE_FILE, `${JSON.stringify({ ignored: next }, null, 2)}\n`)
    return { ignored: next, report: await this.check(scope) }
  }

  /**
   * Run the deterministic consistency checks.
   * @param scope - project root and session.
   * @returns the report the panel renders.
   */
  async check(scope: NovelScope): Promise<CheckReport> {
    return checkProject(await this.checkCorpus(scope), await this.checkIgnores(scope))
  }

  /**
   * Run the checks and record the report under `.novel/runs/`.
   *
   * Written on request rather than on every run: `.novel/runs/` is committed
   * (format S6), and a report per button press would bury the AI task records it
   * sits beside.
   * @param scope - project root and session.
   * @returns the storage-relative path written.
   */
  async saveCheckReport(scope: NovelScope): Promise<string> {
    const report = await this.check(scope)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const path = `${MACHINE_DIR}/runs/${stamp}-consistency.json`
    await this.write(scope, path, `${JSON.stringify({ ...report, at: new Date().toISOString() }, null, 2)}\n`)
    return path
  }

  /**
   * Render an export of the book without writing anything.
   *
   * The panel needs the text twice for two different reasons — a preview of what
   * is about to be exported, and a download of the same bytes the export would
   * write — and neither of them should create a file, so rendering and writing
   * are two calls rather than one.
   * @param scope - project root and session.
   * @param request - format, scope, and the selection that scope needs.
   * @returns the rendered content and the name it would be written under.
   * @throws {NovelError} `novel/bad-request` when there is nothing to export.
   */
  async exportBook(scope: NovelScope, request: ExportRequest): Promise<ExportPlan> {
    const meta = await this.projectMeta(scope)
    const chapters = (await this.scanChapterTexts(scope)).map(entry => ({
      path: entry.summary.path,
      volume: entry.summary.volume,
      number: entry.summary.number,
      title: entry.summary.title,
      body: entry.body,
      archived: entry.summary.archived,
    }))
    const volumes = (await this.scanVolumeOutlines(scope))
      .map(outline => ({
        volume: outline.volume,
        ...(outline.title === undefined ? {} : { title: outline.title }),
      }))
    try {
      return renderExport(
        {
          title: meta.title,
          ...(meta.genre === undefined ? {} : { genre: meta.genre }),
          chapters,
          volumes,
        },
        request,
      )
    } catch (error) {
      // `book-export` is a pure module and cannot import `NovelError` from here
      // without a cycle, so the one failure it raises is translated at this seam.
      if (error instanceof ExportError) throw new NovelError('novel/bad-request', error.message)
      throw error
    }
  }

  /**
   * Write an export under `exports/`.
   *
   * Deliberately **not** recorded in the modification record: an export is a
   * derived product, not an edit of an author's document (format §1, §5), and a
   * version entry per export would bury the changes it was taken from.
   * @param scope - project root and session.
   * @param request - format, scope, and the selection that scope needs.
   * @returns the storage-relative path written, with the export's statistics.
   * @throws {NovelError} `novel/bad-request` when there is nothing to export.
   */
  async saveExport(
    scope: NovelScope,
    request: ExportRequest,
  ): Promise<{ path: string, chapters: number, words: number, bytes: number, fileName: string }> {
    const plan = await this.exportBook(scope, request)
    const path = `${EXPORTS_DIR}/${plan.fileName}`
    await this.write(scope, path, plan.text)
    return {
      path,
      chapters: plan.chapters,
      words: plan.words,
      bytes: plan.text.length,
      fileName: plan.fileName,
    }
  }

  /**
   * List a directory inside the project.
   * @param scope - project root and session.
   * @param path - storage-relative directory path; empty selects the root.
   * @returns the children; an absent directory comes back as `exists: false`.
   */
  async listDirectory(scope: NovelScope, path: string): Promise<DirListing> {
    const relative = normalizeRelative(path)
    const target = await this.target(scope, relative)
    const info = await this.ctx.fs.stat(target)
    const exists = info !== undefined && info.type === 'directory'
    const entries = exists ? await this.ctx.fs.listDir(target) : []
    return {
      path: relative,
      exists,
      entries: entries.map(entry => ({
        name: entry.name,
        type: entry.type,
        path: relative === '' ? entry.name : `${relative}/${entry.name}`,
      })),
    }
  }

  /**
   * Normalize and validate a document path against the editable whitelist.
   * @param path - caller-supplied storage-relative path.
   * @returns the normalized path.
   * @throws {NovelError} `novel/not-a-document` when the path is outside the whitelist.
   */
  private documentPath(path: string): string {
    const relative = normalizeRelative(path)
    if (!isDocumentPath(relative)) {
      throw new NovelError('novel/not-a-document', `"${path}" 不是可编辑的文档（只允许 chapters/ settings/ outline/ style/ 下的 .md）`)
    }
    return relative
  }

  /**
   * Keep a chapter's derived `wordCount` in step with its body.
   *
   * The format document lists `wordCount` as tool-maintained and "not hand
   * written", so every write stamps it — including a beats-only save from the
   * outline view, which edits the same file through the document channel. If
   * only the prose path stamped it, editing beats would leave a stale count
   * behind and the field would quietly become a lie.
   * @param relative - normalized storage-relative path.
   * @param data - frontmatter data about to be written.
   * @param body - the body about to be written.
   * @returns the frontmatter to serialize.
   */
  private stampWordCount(
    relative: string,
    data: Record<string, unknown>,
    body: string,
  ): Record<string, unknown> {
    if (!isChapterPath(relative)) return data
    return { ...data, wordCount: countWords(body) }
  }

  /**
   * Create the project skeleton, never overwriting an existing file.
   * @param scope - project root and session.
   * @param title - book title.
   * @returns the paths created and the paths left alone.
   */
  async scaffold(scope: NovelScope, title: string): Promise<{ created: string[], skipped: string[] }> {
    const created: string[] = []
    const skipped: string[] = []
    for (const file of scaffoldFiles(title)) {
      const existing = await this.read(scope, file.path)
      if (existing !== undefined) {
        skipped.push(file.path)
        continue
      }
      await this.write(scope, file.path, file.content)
      created.push(file.path)
    }
    return { created, skipped }
  }

  /**
   * Record one AI task run under `.novel/runs/`.
   *
   * The record is the audit trail the task model promises: which files were
   * assembled into the prompt, the prompt itself, and what came back. It is
   * written after the fact and never gates the task.
   * @param scope - project root and session.
   * @param run - task name and the assembled inputs, prompt, and output.
   * @returns the storage-relative path written.
   */
  async writeRun(scope: NovelScope, run: NovelRunRecord): Promise<string> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const path = `${MACHINE_DIR}/runs/${stamp}-${run.task}.json`
    await this.write(scope, path, `${JSON.stringify({ ...run, at: new Date().toISOString() }, null, 2)}\n`)
    return path
  }
}

/** One recorded AI task run. */
export interface NovelRunRecord {
  /** Task name, e.g. `continue`. */
  task: string
  /** Storage-relative paths assembled into the prompt, with the reason each was read. */
  inputs: { path: string, reason: string }[]
  /** The prompt sent to the model. */
  prompt: string
  /** The model's full output. */
  output: string
  /** Terminal reason reported by the session, when the run settled. */
  reason?: string
  /** Chapter the run was performed against. */
  chapter?: string
}
