/**
 * Browser-side client for the plugin's own `/api/novel/*` routes.
 *
 * Every call is a same-origin fetch on DSH's shared `/api` channel, which
 * already carries authentication and the host/origin trust fence, so no token
 * handling lives here.
 *
 * @module dsh-ai-novel-copilot/client/api
 */
import type {
  DirListing,
  LoadedChapter,
  LoadedDocument,
  NewChapterSpec,
  SettingsLibrary,
  WrittenChapter,
  WrittenDocument,
} from '../novel/io.ts'
import type { CardSummary, ChapterSummary, ProjectSnapshot } from '../novel/project.ts'
import type { DiffLine, HistoryEntry, HistorySource, HistorySummary } from '../novel/history.ts'
import type { SearchResult } from '../novel/search.ts'
import type { CheckReport } from '../novel/checks.ts'

/** Route prefix owned by this plugin's host half. */
const BASE = '/api/novel'

/** A failure the host reported with a stable code. */
export interface NovelApiFailure {
  code: string
  message: string
}

/** What the ping route answers. */
export interface PingResult {
  name: string
  defaultRoot: string
  /** Every route path the *running* host half has registered. */
  routes?: string[]
}

/** Envelope every route answers with. */
interface Envelope {
  ok?: boolean
  error?: NovelApiFailure
}

/**
 * Explain a response that is not this plugin's JSON envelope.
 *
 * Every `/api/novel/*` answer is JSON, failures included, so a body that is not
 * JSON did not come from this host half at all — in practice a 404 from the
 * carrier, which means the *route* is missing from the running host rather than
 * the data being missing. That is a build-versus-process question, so the message
 * names the route and reports what the running host half says about its own route
 * table (part of `ping`'s answer) instead of a bare status the author cannot act
 * on. `probe` is false for that diagnostic call itself, so a host which lacks
 * `ping` too cannot send this into a loop.
 * @param path - the request path, with its query.
 * @param status - the HTTP status.
 * @param probe - whether asking `ping` for its route table is still allowed.
 * @returns the message to throw.
 */
async function describeNonJson(path: string, status: number, probe: boolean): Promise<string> {
  const route = path.split('?')[0] ?? path
  if (status !== 404 || !probe) return `host 返回了非 JSON 响应（HTTP ${String(status)}）`
  try {
    const info = await call<PingResult & Envelope>(`${BASE}/ping`, undefined, false)
    const routes = info.routes ?? []
    const has = routes.includes(route)
    return `host 里没有这个路由：${route}（HTTP 404）。运行中的 host 半报告了 ${String(routes.length)} 条路由`
      + `${has ? '，其中包含它——那是它注册失败了' : '，里面没有它'}；host 半的代码随进程加载`
      + '（配置热重载只重载 cordis.patch.yml，不替换插件模块），重建后要有一个新进程才会出现新路由。'
  } catch {
    return `host 里没有这个路由：${route}（HTTP 404）。`
  }
}

/**
 * Perform one call and unwrap the envelope, turning a reported failure into a
 * thrown error carrying its code.
 * @param path - route path with query.
 * @param init - fetch options.
 * @param probe - whether a non-JSON answer may ask `ping` for its route table.
 * @returns the unwrapped payload.
 */
async function call<T extends Envelope>(path: string, init?: RequestInit, probe = true): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, { credentials: 'include', ...init })
  } catch (error) {
    // A transport failure is not an HTTP failure: nothing answered at all. The
    // browser's own text for it (`Failed to fetch`) names neither the host nor
    // anything the author can do, and this is the message an author sees when a
    // dev instance was restarted under an open page — the single most common way
    // to meet it. So it says which route went unanswered and what to try.
    const route = path.split('?')[0] ?? path
    const why = error instanceof Error ? error.message : String(error)
    const offline = new Error(
      `没能连上 DSH host：${route} 没有得到任何响应。`
      + `如果这个实例刚重启或已经关掉，刷新页面后再试；还不行就看 host 进程是否还在跑。（${why}）`,
    )
    offline.name = 'novel/offline'
    throw offline
  }
  let value: T
  try {
    value = await response.json() as T
  } catch {
    throw new Error(await describeNonJson(path, response.status, probe))
  }
  if (value.ok !== true) {
    const failure = value.error
    const error = new Error(failure?.message ?? `请求失败（HTTP ${String(response.status)}）`)
    error.name = failure?.code ?? 'novel/unknown'
    throw error
  }
  return value
}

/**
 * The stable code worth printing beside a failure, when there is one.
 *
 * Two families of code reach the panel and neither is something the author can
 * act on by itself, but both say *which layer* refused: the host half's own
 * `novel/*` (this plugin's rules) and the filesystem's `FS_*` (the sandbox and
 * the version guard — `FS_PERMISSION_DENIED` and `FS_STALE_VERSION` are the two
 * an author actually meets). Everything else is an ordinary JavaScript error
 * name (`TypeError`, `Error`) which means nothing to whoever reads the status
 * line, so it is not printed.
 *
 * The rule lives here, next to {@link call}, because this is where a thrown
 * error gets its `name` from the host's `error.code`; the panel only formats it.
 * @param error - whatever was thrown.
 * @returns the code, or undefined when there is nothing worth printing.
 */
export function errorCodeOf(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  // The fallback this module assigns when the host sent no code at all.
  if (error.name === 'novel/unknown') return undefined
  return /^(?:novel\/|FS_)/.test(error.name) ? error.name : undefined
}

/** JSON POST body helper. */
function post(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  }
}

/**
 * Probe the host route and learn the offered default project root.
 * @param sessionId - session to resolve the default against.
 * @returns the ping payload.
 */
export async function ping(sessionId: string | undefined): Promise<PingResult> {
  const query = sessionId === undefined ? '' : `?sessionId=${encodeURIComponent(sessionId)}`
  return await call<PingResult & Envelope>(`${BASE}/ping${query}`)
}

/**
 * Read the project tree.
 * @param sessionId - session whose sandbox policy applies.
 * @param root - absolute project root.
 * @returns the snapshot.
 */
export async function openProject(sessionId: string, root: string): Promise<ProjectSnapshot> {
  const query = `?sessionId=${encodeURIComponent(sessionId)}&root=${encodeURIComponent(root)}`
  const value = await call<Envelope & { project: ProjectSnapshot }>(`${BASE}/project${query}`)
  return value.project
}

/**
 * Create the project skeleton, leaving existing files untouched.
 * @param sessionId - session whose sandbox policy applies.
 * @param root - absolute project root.
 * @param title - book title.
 * @returns the created and skipped paths.
 */
export async function createProject(
  sessionId: string,
  root: string,
  title: string,
): Promise<{ created: string[], skipped: string[] }> {
  const value = await call<Envelope & { created: string[], skipped: string[] }>(
    `${BASE}/project`,
    post({ sessionId, root, title }),
  )
  return { created: value.created, skipped: value.skipped }
}

/**
 * Load one chapter.
 * @param sessionId - session whose sandbox policy applies.
 * @param root - absolute project root.
 * @param path - storage-relative chapter path.
 * @returns the parsed chapter.
 */
export async function readChapter(
  sessionId: string,
  root: string,
  path: string,
): Promise<LoadedChapter> {
  const query = `?sessionId=${encodeURIComponent(sessionId)}&root=${encodeURIComponent(root)}`
    + `&path=${encodeURIComponent(path)}`
  const value = await call<Envelope & { chapter: LoadedChapter }>(`${BASE}/chapter${query}`)
  return value.chapter
}

/**
 * Replace one chapter's file.
 * @param sessionId - session whose sandbox policy applies.
 * @param root - absolute project root.
 * @param path - storage-relative chapter path.
 * @param data - frontmatter data.
 * @param body - prose.
 * @returns the write result.
 */
export async function writeChapter(
  sessionId: string,
  root: string,
  path: string,
  data: Record<string, unknown>,
  body: string,
  source?: HistorySource,
): Promise<WrittenChapter> {
  const value = await call<Envelope & { written: WrittenChapter }>(
    `${BASE}/chapter`,
    post({ sessionId, root, path, data, body, ...(source === undefined ? {} : { source }) }),
  )
  return value.written
}

/**
 * Append a chapter to a volume.
 *
 * The spec is the whole frontmatter the caller already knows: when a plan was
 * just approved, that means the outline it produced — beats, the characters it
 * named, a summary — rather than a bare title.
 * @param sessionId - session whose sandbox policy applies.
 * @param root - absolute project root.
 * @param spec - volume, title, and optional outline fields.
 * @returns the created chapter's summary.
 */
export async function createChapter(
  sessionId: string,
  root: string,
  spec: NewChapterSpec,
): Promise<ChapterSummary> {
  const value = await call<Envelope & { created: ChapterSummary }>(
    `${BASE}/chapter`,
    post({ sessionId, root, create: spec }),
  )
  return value.created
}

/** Build the scope query every read-only route expects. */
function scopeQuery(sessionId: string, root: string, extra?: Record<string, string>): string {
  const params = new URLSearchParams({ sessionId, root, ...extra })
  return `?${params.toString()}`
}

/**
 * Read one editable document — a chapter, a setting card, or an outline.
 * @param sessionId - session whose sandbox policy applies.
 * @param root - absolute project root.
 * @param path - storage-relative path inside `chapters/ settings/ outline/ style/`.
 * @returns the parsed document.
 */
export async function readDocument(
  sessionId: string,
  root: string,
  path: string,
): Promise<LoadedDocument> {
  const value = await call<Envelope & { document: LoadedDocument }>(
    `${BASE}/doc${scopeQuery(sessionId, root, { path })}`,
  )
  return value.document
}

/**
 * Replace one editable document.
 * @param sessionId - session whose sandbox policy applies.
 * @param root - absolute project root.
 * @param path - storage-relative path inside the editable trees.
 * @param data - frontmatter data.
 * @param body - everything after the frontmatter.
 * @param source - what produced this text, recorded with the version (M7).
 * @returns the write result.
 */
export async function writeDocument(
  sessionId: string,
  root: string,
  path: string,
  data: Record<string, unknown>,
  body: string,
  source?: HistorySource,
): Promise<WrittenDocument> {
  const value = await call<Envelope & { written: WrittenDocument }>(
    `${BASE}/doc`,
    post({ sessionId, root, path, data, body, ...(source === undefined ? {} : { source }) }),
  )
  return value.written
}

/**
 * List one document's recorded versions, newest first.
 * @param sessionId - session whose sandbox policy applies.
 * @param root - absolute project root.
 * @param path - storage-relative document path.
 * @returns one summary per version, without either full text.
 */
export async function readHistory(
  sessionId: string,
  root: string,
  path: string,
): Promise<HistorySummary[]> {
  const value = await call<Envelope & { history: { path: string, entries: HistorySummary[] } }>(
    `${BASE}/history${scopeQuery(sessionId, root, { path })}`,
  )
  return value.history.entries
}

/**
 * Read one recorded version together with its line diff.
 * @param sessionId - session whose sandbox policy applies.
 * @param root - absolute project root.
 * @param path - storage-relative document path.
 * @param at - the timestamp identifying the version.
 * @returns the version and the host-computed diff.
 */
export async function readHistoryEntry(
  sessionId: string,
  root: string,
  path: string,
  at: string,
): Promise<HistoryEntry & { diff: DiffLine[] }> {
  const value = await call<Envelope & { entry: HistoryEntry & { diff: DiffLine[] } }>(
    `${BASE}/history${scopeQuery(sessionId, root, { path, at })}`,
  )
  return value.entry
}

/**
 * Put one recorded version back.
 *
 * The rollback is an ordinary document write on the host, so it lands in the
 * record as a version of its own — an author can undo the undo.
 * @param sessionId - session whose sandbox policy applies.
 * @param root - absolute project root.
 * @param path - storage-relative document path.
 * @param at - the timestamp of the version to restore.
 * @returns the restored document, as the editor loads it.
 */
export async function revertHistory(
  sessionId: string,
  root: string,
  path: string,
  at: string,
): Promise<LoadedDocument> {
  const value = await call<Envelope & { document: LoadedDocument }>(
    `${BASE}/history`,
    post({ sessionId, root, path, at, action: 'revert' }),
  )
  return value.document
}

/**
 * Create one setting card from the panel's "new card" form.
 * @param sessionId - session whose sandbox policy applies.
 * @param root - absolute project root.
 * @param type - card type.
 * @param id - slug id, which becomes the filename.
 * @param name - display name.
 * @returns the created card's summary.
 */
export async function createCard(
  sessionId: string,
  root: string,
  type: string,
  id: string,
  name: string,
): Promise<CardSummary> {
  const value = await call<Envelope & { created: CardSummary }>(
    `${BASE}/doc`,
    post({ sessionId, root, createCard: { type, id, name } }),
  )
  return value.created
}

/**
 * Read the settings library: cards grouped by type, with reverse links.
 * @param sessionId - session whose sandbox policy applies.
 * @param root - absolute project root.
 * @returns the grouped cards and the two single-file pages.
 */
export async function readCards(sessionId: string, root: string): Promise<SettingsLibrary> {
  const value = await call<Envelope & { library: SettingsLibrary }>(
    `${BASE}/cards${scopeQuery(sessionId, root)}`,
  )
  return value.library
}

/**
 * List one directory inside the project.
 *
 * Task assembly uses this to find the style samples: the panel cannot know which
 * samples an author has written, and a task that silently read none of them
 * would be a task that quietly stopped honouring the style rules.
 * @param sessionId - session whose sandbox policy applies.
 * @param root - absolute project root.
 * @param path - storage-relative directory path; empty selects the project root.
 * @returns the directory listing; an absent directory comes back as `exists: false`.
 */
export async function readDirectory(sessionId: string, root: string, path: string): Promise<DirListing> {
  const value = await call<Envelope & { listing: DirListing }>(
    `${BASE}/dir${scopeQuery(sessionId, root, { path })}`,
  )
  return value.listing
}

/**
 * Search the project — M5's deterministic retrieval.
 *
 * The whole scan happens on the host, once per query: the panel sends the words
 * and receives the answer, the ranked hits, and the snippets that justify them,
 * so the browser never has to read every chapter to answer a question about one.
 * @param sessionId - session whose sandbox policy applies.
 * @param root - absolute project root.
 * @param query - what the author typed.
 * @returns the answer, the hits, and what was scanned.
 */
export async function search(sessionId: string, root: string, query: string): Promise<SearchResult> {
  const value = await call<Envelope & { result: SearchResult }>(
    `${BASE}/search${scopeQuery(sessionId, root, { q: query })}`,
  )
  return value.result
}

/**
 * Run the deterministic consistency checks.
 *
 * No streaming and no polling: the rules read the project and answer, so one
 * request is the whole interaction.
 * @param sessionId - session whose sandbox policy applies.
 * @param root - absolute project root.
 * @returns the report, with the author's ignore decisions already applied.
 */
export async function checkProject(sessionId: string, root: string): Promise<CheckReport> {
  const value = await call<Envelope & { report: CheckReport }>(
    `${BASE}/checks${scopeQuery(sessionId, root)}`,
  )
  return value.report
}

/**
 * Ignore one finding, or bring it back.
 * @param sessionId - session whose sandbox policy applies.
 * @param root - absolute project root.
 * @param key - the finding's stable key.
 * @param ignored - true to ignore, false to un-ignore.
 * @returns the new ignore list and the report it produces.
 */
export async function setCheckIgnore(
  sessionId: string,
  root: string,
  key: string,
  ignored: boolean,
): Promise<{ ignored: string[], report: CheckReport }> {
  const value = await call<Envelope & { ignored: string[], report: CheckReport }>(
    `${BASE}/checks`,
    post({ sessionId, root, action: ignored ? 'ignore' : 'unignore', key }),
  )
  return { ignored: value.ignored, report: value.report }
}

/**
 * Write the current report down under `.novel/runs/`.
 * @param sessionId - session whose sandbox policy applies.
 * @param root - absolute project root.
 * @returns the storage-relative path written.
 */
export async function saveCheckReport(sessionId: string, root: string): Promise<string> {
  const value = await call<Envelope & { path: string }>(
    `${BASE}/checks`,
    post({ sessionId, root, action: 'save' }),
  )
  return value.path
}

/**
 * Read any text file inside the project.
 *
 * Task assembly needs the supporting files — the book metadata, the voice
 * guide, the volume outline — and treats a missing one as an absent input
 * rather than a failure, so absence is reported rather than thrown.
 * @param sessionId - session whose sandbox policy applies.
 * @param root - absolute project root.
 * @param path - storage-relative path.
 * @returns the text, or undefined when the file does not exist.
 */
export async function readText(
  sessionId: string,
  root: string,
  path: string,
): Promise<string | undefined> {
  const query = `?sessionId=${encodeURIComponent(sessionId)}&root=${encodeURIComponent(root)}`
    + `&path=${encodeURIComponent(path)}`
  const value = await call<Envelope & { exists: boolean, text: string }>(`${BASE}/text${query}`)
  return value.exists ? value.text : undefined
}

/** One recorded task run, as the panel submits it. */
export interface RunSubmission {
  /** Task id, used in the record's filename. */
  task: string
  /** Files assembled into the prompt. */
  inputs: { path: string, reason: string }[]
  /** The prompt sent. */
  prompt: string
  /** The model's full output. */
  output: string
  /** Terminal reason the session reported. */
  reason?: string
  /** Chapter the run was performed against. */
  chapter?: string
}

/**
 * Record a finished task run under `.novel/runs/`.
 * @param sessionId - session whose sandbox policy applies.
 * @param root - absolute project root.
 * @param run - the run to record.
 * @returns the storage-relative path written.
 */
export async function writeRun(sessionId: string, root: string, run: RunSubmission): Promise<string> {
  const value = await call<Envelope & { path: string }>(`${BASE}/run`, post({ sessionId, root, ...run }))
  return value.path
}

/** Which part of the book an export covers. */
export type ExportScope = 'book' | 'volume' | 'chapter'

/** What to export. */
export interface ExportSpec {
  format: 'md' | 'txt'
  scope: ExportScope
  /** Volume number, for `scope: 'volume'`. */
  volume?: number
  /** Chapter path, for `scope: 'chapter'`. */
  path?: string
}

/** A rendered export, as the host answers with it. */
export interface ExportPlan {
  /** The complete file content, or its opening when a head was asked for. */
  text: string
  /** Suggested filename, extension included. */
  fileName: string
  /** How many chapters it contains. */
  chapters: number
  /** Word count of the exported prose. */
  words: number
  /** `全书` / `第 1 卷` / `第 3 章`. */
  scopeLabel: string
  /** Character count of the **complete** export, not of `text`. */
  bytes: number
  /** Whether `text` is only the opening of the export. */
  truncated: boolean
}

/** Turn a spec into query parameters, omitting what the scope does not use. */
function exportQuery(spec: ExportSpec): Record<string, string> {
  return {
    format: spec.format,
    scope: spec.scope,
    ...(spec.volume === undefined ? {} : { volume: String(spec.volume) }),
    ...(spec.path === undefined ? {} : { path: spec.path }),
  }
}

/**
 * Render an export without writing it.
 *
 * Two callers, one route: the **preview** asks for `head` characters so opening
 * the tab on a million-word book does not download the book, and the **download**
 * asks for everything — it is the file the author is taking away, and it is the
 * same string the host's own `exports/` write contains, so the two cannot drift
 * apart.
 * @param sessionId - session whose sandbox policy applies.
 * @param root - absolute project root.
 * @param spec - format, scope, and selection.
 * @param head - return only the first this-many characters; omitted means the whole file.
 * @returns the rendered text and its statistics (always the whole export's).
 */
export async function readExport(
  sessionId: string,
  root: string,
  spec: ExportSpec,
  head?: number,
): Promise<ExportPlan> {
  const value = await call<Envelope & ExportPlan>(
    `${BASE}/export${scopeQuery(sessionId, root, {
      ...exportQuery(spec),
      ...(head === undefined ? {} : { head: String(head) }),
    })}`,
  )
  return {
    text: value.text,
    fileName: value.fileName,
    chapters: value.chapters,
    words: value.words,
    scopeLabel: value.scopeLabel,
    bytes: value.bytes,
    truncated: value.truncated === true,
  }
}

/** Where an export was written, and what went into it. */
export interface SavedExport {
  /** Storage-relative path under `exports/`. */
  path: string
  chapters: number
  words: number
  bytes: number
  fileName: string
}

/**
 * Write an export under `exports/`.
 * @param sessionId - session whose sandbox policy applies.
 * @param root - absolute project root.
 * @param spec - format, scope, and selection.
 * @returns the path written and the export's statistics.
 */
export async function writeExport(
  sessionId: string,
  root: string,
  spec: ExportSpec,
): Promise<SavedExport> {
  const value = await call<Envelope & SavedExport>(
    `${BASE}/export`,
    post({
      sessionId,
      root,
      format: spec.format,
      scope: spec.scope,
      ...(spec.volume === undefined ? {} : { volume: spec.volume }),
      ...(spec.path === undefined ? {} : { path: spec.path }),
    }),
  )
  return {
    path: value.path,
    chapters: value.chapters,
    words: value.words,
    bytes: value.bytes,
    fileName: value.fileName,
  }
}

/** Project metadata as the host reports it. */
export interface ProjectMeta {
  title: string
  genre?: string
  targetWords?: number
}

/**
 * Merge changes into `novel.yaml`.
 *
 * Only the fields passed are written; anything else in the file is preserved.
 * @param sessionId - session whose sandbox policy applies.
 * @param root - absolute project root.
 * @param patch - metadata fields to set.
 * @returns the metadata after the write.
 */
export async function writeMeta(
  sessionId: string,
  root: string,
  patch: { title?: string, genre?: string, targetWords?: number },
): Promise<ProjectMeta> {
  const value = await call<Envelope & { project: ProjectMeta }>(
    `${BASE}/meta`,
    post({ sessionId, root, ...patch }),
  )
  return value.project
}

/** One writing run as the host reports it. */
export interface WritingRunState {
  /** Text produced so far. */
  text: string
  /** Whether the turn has ended. */
  done: boolean
  /** Terminal reason, once it ended well. */
  reason?: string
  /** Failure text, when it did not. */
  error?: string
}

/**
 * Start a writing run against an isolated writing agent.
 * @param sessionId - session whose model route the agent reuses.
 * @param prompt - the fully assembled prompt.
 * @param label - short task label the child's durable identity carries.
 * @returns the run id to poll.
 */
export async function startTask(sessionId: string, prompt: string, label?: string): Promise<string> {
  const value = await call<Envelope & { runId: string }>(
    `${BASE}/task`,
    post({ sessionId, prompt, ...(label === undefined ? {} : { label }) }),
  )
  return value.runId
}

/**
 * Read a writing run's current state.
 * @param runId - the run to read.
 * @returns its accumulating text and terminal state.
 */
export async function readTask(runId: string): Promise<WritingRunState> {
  const value = await call<Envelope & { run: WritingRunState }>(
    `${BASE}/task?runId=${encodeURIComponent(runId)}`,
  )
  return value.run
}
