/**
 * HTTP layer: the panel's data channel.
 *
 * DSH's Fetch routes are **exact paths** (no prefixes) and cover only
 * `GET`/`HEAD`/`POST`, so this API is shaped around that: reads are `GET` with
 * query parameters, every mutation is a `POST` with a JSON body. Requests
 * arrive on the shared `/api` channel, which means the physical carrier has
 * already applied its authentication and host/origin trust fence before a
 * handler runs — none of that is re-implemented here.
 *
 * Bodies arrive buffered and are parsed by hand rather than through the shared
 * JSON-RPC dispatch, which is what keeps a chapter payload free of any RPC
 * envelope.
 *
 * @module dsh-ai-novel-copilot/novel/http
 */
import { diffLines, type HistorySource } from './history.ts'
import {
  NovelError,
  type LoadedChapter,
  type LoadedDocument,
  type NewChapterSpec,
  type NovelIo,
  type NovelRunRecord,
  type NovelScope,
} from './io.ts'
import type { CardType, ProjectSnapshot } from './project.ts'
import { CARD_TYPES } from './project.ts'
import type { WritingRun } from './writing.ts'

/** Absolute route paths this plugin owns. */
export const ROUTE_PING = '/api/novel/ping'
export const ROUTE_PROJECT = '/api/novel/project'
export const ROUTE_CHAPTER = '/api/novel/chapter'
export const ROUTE_DOC = '/api/novel/doc'
export const ROUTE_DIR = '/api/novel/dir'
export const ROUTE_CARDS = '/api/novel/cards'
export const ROUTE_SEARCH = '/api/novel/search'
export const ROUTE_CHECKS = '/api/novel/checks'
/** M7's modification record: list versions, read one, roll back to one. */
export const ROUTE_HISTORY = '/api/novel/history'
export const ROUTE_TEXT = '/api/novel/text'
export const ROUTE_META = '/api/novel/meta'
export const ROUTE_RUN = '/api/novel/run'
export const ROUTE_TASK = '/api/novel/task'

/** Every route path, in registration order. */
export const NOVEL_ROUTES = [
  ROUTE_PING,
  ROUTE_PROJECT,
  ROUTE_CHAPTER,
  ROUTE_DOC,
  ROUTE_DIR,
  ROUTE_CARDS,
  ROUTE_SEARCH,
  ROUTE_CHECKS,
  ROUTE_HISTORY,
  ROUTE_TEXT,
  ROUTE_META,
  ROUTE_RUN,
  ROUTE_TASK,
] as const

/** One route path this plugin owns. */
export type NovelRoute = (typeof NOVEL_ROUTES)[number]

/** The Fetch route shape the host's connection registry accepts. */
export interface FetchRoute {
  path: string
  methods: readonly ('GET' | 'HEAD' | 'POST')[]
  requestBody: 'buffered' | 'streaming'
  fetch: (request: Request) => Promise<Response>
}

/** JSON response helper. */
function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** A failed response carrying a stable code. */
function failure(status: number, code: string, message: string): Response {
  return json(status, { ok: false, error: { code, message } })
}

/**
 * Map a thrown error onto a status and a stable code.
 *
 * Host filesystem failures arrive as `FsError` with their own `FS_*` codes; a
 * sandbox refusal is one of those, so it is recognized by code rather than by
 * matching a message.
 * @param error - the thrown value.
 * @returns the response to send.
 */
function toFailure(error: unknown): Response {
  if (error instanceof NovelError) {
    const status = error.code === 'novel/outside-project'
      ? 403
      : error.code === 'novel/not-found'
        ? 404
        : error.code === 'novel/parse-error' ? 422 : 400
    return failure(status, error.code, error.message)
  }
  const code = typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : ''
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'FS_STALE_VERSION') return failure(409, code, message)
  if (code === 'FS_NOT_OBSERVED') return failure(404, code, message)
  if (/SANDBOX|PERMISSION|DENIED|READONLY|READ_ONLY|EACCES|EPERM/.test(code)) {
    return failure(403, code === '' ? 'novel/denied' : code, message)
  }
  return failure(500, code === '' ? 'novel/internal' : code, message)
}

/** Read a required query parameter. */
function requireParam(url: URL, name: string): string {
  const value = url.searchParams.get(name)
  if (value === null || value === '') throw new NovelError('novel/bad-request', `缺少参数 ${name}`)
  return value
}

/**
 * Read a card type out of a parsed body, refusing anything the format does not define.
 * @param value - the raw field.
 * @returns the card type.
 */
function requireCardType(value: unknown): CardType {
  const found = CARD_TYPES.find(type => type === value)
  if (found === undefined) {
    throw new NovelError('novel/bad-request', `未知的卡片类型：${String(value)}（可用：${CARD_TYPES.join('/')}）`)
  }
  return found
}

/** Build the scope every IO call needs from the request. */
function scopeOf(url: URL): NovelScope {
  return {
    root: requireParam(url, 'root'),
    sessionId: requireParam(url, 'sessionId'),
  }
}

/**
 * Read the `source` a write should be recorded under.
 *
 * Only the panel sends this, and only when it is saving text a task produced:
 * the modification record (M7) is how an author tells "I wrote this" from
 * "润色本章 wrote this". Anything unrecognised is treated as a manual save rather
 * than rejected — a save must never fail because its label was odd.
 * @param body - the parsed request body.
 * @returns the source to record.
 */
function sourceOf(body: Record<string, unknown>): HistorySource {
  const raw = body.source
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { kind: 'manual' }
  const record = raw as Record<string, unknown>
  if (record.kind === 'task' && typeof record.label === 'string' && record.label.trim() !== '') {
    return { kind: 'task', label: record.label.trim() }
  }
  return { kind: 'manual' }
}

/** Read an optional positive integer query parameter. */
function optionalCount(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name)
  if (raw === null || raw === '') return undefined
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : undefined
}

/** Parse a JSON request body. */
async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text()
  if (text.trim() === '') return {}
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new NovelError('novel/bad-request', '请求体必须是一个 JSON 对象')
    }
    return value as Record<string, unknown>
  } catch (error) {
    if (error instanceof NovelError) throw error
    throw new NovelError('novel/bad-request', `请求体不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Read a required string field from a parsed body. */
function requireField(body: Record<string, unknown>, name: string): string {
  const value = body[name]
  if (typeof value !== 'string' || value === '') {
    throw new NovelError('novel/bad-request', `缺少字段 ${name}`)
  }
  return value
}

/**
 * Read an optional list-of-strings field.
 * @param value - the raw field.
 * @returns the non-blank entries, or undefined when the field is not a list.
 */
function stringArray(value: unknown): string[] | undefined {
  if (typeof value === 'string') return value.trim() === '' ? [] : [value]
  if (!Array.isArray(value)) return undefined
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => entry.trim())
    .filter(entry => entry !== '')
}

/** The handlers this plugin serves, keyed by route path. */
export type NovelHandlers = Readonly<Record<NovelRoute, (request: Request) => Promise<Response>>>

/** What the handlers need from the host, injected so this module stays free of it. */
export interface HandlerDeps {
  /** Filesystem-backed novel operations. */
  io: NovelIo
  /** Project root a bare session defaults to. */
  defaultRoot: string
  /**
   * Begin one writing run against an isolated agent.
   * @param sessionId - session whose model route is reused.
   * @param prompt - the fully assembled prompt.
   * @param label - short task label recorded on the child's durable identity.
   * @returns the run id to poll.
   */
  startWritingRun(sessionId: string, prompt: string, label?: string): string
  /**
   * Read one run's current state.
   * @param runId - the run to read.
   * @returns its state, or undefined for an unknown run.
   */
  runState(runId: string): WritingRun | undefined
}

/**
 * Build every route handler.
 * @param deps - the IO half, the default root, and the writing-run hooks.
 * @returns one handler per route path.
 */
export function createHandlers(deps: HandlerDeps): NovelHandlers {
  const { io, defaultRoot } = deps
  const ping = async (request: Request): Promise<Response> => {
    if (request.method === 'HEAD') return new Response(null, { status: 200 })
    return json(200, {
      ok: true,
      name: 'dsh-ai-novel-copilot',
      defaultRoot,
      routes: NOVEL_ROUTES,
    })
  }

  const project = async (request: Request): Promise<Response> => {
    try {
      if (request.method === 'GET') {
        const url = new URL(request.url)
        const scope = scopeOf(url)
        return json(200, { ok: true, project: await io.snapshot(scope) })
      }
      const body = await readJson(request)
      const scope: NovelScope = {
        root: requireField(body, 'root'),
        sessionId: requireField(body, 'sessionId'),
      }
      const title = typeof body.title === 'string' && body.title !== '' ? body.title : '未命名小说'
      const result = await io.scaffold(scope, title)
      const snapshot: ProjectSnapshot = await io.snapshot(scope)
      return json(200, { ok: true, ...result, project: snapshot })
    } catch (error) {
      return toFailure(error)
    }
  }

  const chapter = async (request: Request): Promise<Response> => {
    try {
      if (request.method === 'GET') {
        const url = new URL(request.url)
        const scope = scopeOf(url)
        const loaded: LoadedChapter = await io.readChapter(scope, requireParam(url, 'path'))
        return json(200, { ok: true, chapter: loaded })
      }
      const body = await readJson(request)
      const scope: NovelScope = {
        root: requireField(body, 'root'),
        sessionId: requireField(body, 'sessionId'),
      }
      const create = body.create
      if (typeof create === 'object' && create !== null) {
        const raw = create as Record<string, unknown>
        const spec: NewChapterSpec = {
          volume: typeof raw.volume === 'number' && Number.isFinite(raw.volume) ? raw.volume : 1,
          title: typeof raw.title === 'string' && raw.title !== '' ? raw.title : '新章节',
        }
        // A plan hands over the outline it just produced: beats per chapter, the
        // characters the outline named, and a summary — all of them optional,
        // so each is copied only when the caller actually sent one.
        const beats = stringArray(raw.beats)
        if (beats !== undefined) spec.beats = beats
        const characters = stringArray(raw.characters)
        if (characters !== undefined) spec.characters = characters
        const locations = stringArray(raw.locations)
        if (locations !== undefined) spec.locations = locations
        if (typeof raw.summary === 'string') spec.summary = raw.summary
        if (typeof raw.pov === 'string' && raw.pov !== '') spec.pov = raw.pov
        if (typeof raw.number === 'number' && Number.isFinite(raw.number)) spec.number = raw.number
        if (typeof raw.targetWords === 'number' && Number.isFinite(raw.targetWords)) {
          spec.targetWords = raw.targetWords
        }
        const created = await io.createChapter(scope, spec)
        return json(200, { ok: true, created })
      }
      const path = requireField(body, 'path')
      const data = typeof body.data === 'object' && body.data !== null && !Array.isArray(body.data)
        ? body.data as Record<string, unknown>
        : {}
      const text = typeof body.body === 'string' ? body.body : ''
      const written = await io.writeChapter(scope, path, data, text, sourceOf(body))
      return json(200, { ok: true, written })
    } catch (error) {
      return toFailure(error)
    }
  }

  /**
   * The document channel: one read/write pair for every editable Markdown file.
   *
   * Chapters, setting cards, and outlines are the same shape — frontmatter plus
   * body — so they share one route instead of one per kind. The host owns the
   * whitelist (`chapters/ settings/ outline/ style/`), which is why the panel
   * can pass a path straight through without a second guard of its own.
   */
  const doc = async (request: Request): Promise<Response> => {
    try {
      if (request.method === 'GET') {
        const url = new URL(request.url)
        const scope = scopeOf(url)
        const loaded: LoadedDocument = await io.readDocument(scope, requireParam(url, 'path'))
        return json(200, { ok: true, document: loaded })
      }
      const body = await readJson(request)
      const scope: NovelScope = {
        root: requireField(body, 'root'),
        sessionId: requireField(body, 'sessionId'),
      }
      const createCard = body.createCard
      if (typeof createCard === 'object' && createCard !== null) {
        const raw = createCard as Record<string, unknown>
        const created = await io.createCard(
          scope,
          requireCardType(raw.type),
          requireField(raw, 'id'),
          typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : requireField(raw, 'id'),
        )
        return json(200, { ok: true, created })
      }
      const path = requireField(body, 'path')
      const data = typeof body.data === 'object' && body.data !== null && !Array.isArray(body.data)
        ? body.data as Record<string, unknown>
        : {}
      const text = typeof body.body === 'string' ? body.body : ''
      return json(200, { ok: true, written: await io.writeDocument(scope, path, data, text, sourceOf(body)) })
    } catch (error) {
      return toFailure(error)
    }
  }

  const dir = async (request: Request): Promise<Response> => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return failure(405, 'novel/method', '目录列举只接受 GET')
      }
      const url = new URL(request.url)
      const scope = scopeOf(url)
      const listing = await io.listDirectory(scope, url.searchParams.get('path') ?? '')
      if (request.method === 'HEAD') return new Response(null, { status: listing.exists ? 200 : 404 })
      return json(200, { ok: true, listing })
    } catch (error) {
      return toFailure(error)
    }
  }

  const cards = async (request: Request): Promise<Response> => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return failure(405, 'novel/method', '设定库只接受 GET')
      }
      const scope = scopeOf(new URL(request.url))
      const library = await io.library(scope)
      if (request.method === 'HEAD') return new Response(null, { status: 200 })
      return json(200, { ok: true, library })
    } catch (error) {
      return toFailure(error)
    }
  }

  /**
   * The retrieval channel: M5's deterministic search and Q&A.
   *
   * A read, so a `GET` with the query in `q`. A blank query is answered with an
   * empty result rather than an error: the panel's box starts blank, and "you
   * have not asked anything yet" is not a failure.
   */
  const search = async (request: Request): Promise<Response> => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return failure(405, 'novel/method', '检索只接受 GET')
      }
      const url = new URL(request.url)
      const scope = scopeOf(url)
      const limit = Number(url.searchParams.get('limit') ?? '')
      const result = await io.search(
        scope,
        url.searchParams.get('q') ?? '',
        Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 40,
      )
      if (request.method === 'HEAD') return new Response(null, { status: 200 })
      return json(200, { ok: true, result })
    } catch (error) {
      return toFailure(error)
    }
  }

  /**
   * The consistency-check channel: M6's deterministic rules.
   *
   * A `GET` runs them — they are bookkeeping over the project, so there is
   * nothing to stream and nothing to poll — and a `POST` carries the two
   * decisions only the author can make: ignore one finding, or write the report
   * down under `.novel/runs/`.
   */
  const checks = async (request: Request): Promise<Response> => {
    try {
      if (request.method === 'GET' || request.method === 'HEAD') {
        const report = await io.check(scopeOf(new URL(request.url)))
        if (request.method === 'HEAD') return new Response(null, { status: 200 })
        return json(200, { ok: true, report })
      }
      const body = await readJson(request)
      const scope: NovelScope = {
        root: requireField(body, 'root'),
        sessionId: requireField(body, 'sessionId'),
      }
      const action = requireField(body, 'action')
      if (action === 'save') {
        return json(200, { ok: true, path: await io.saveCheckReport(scope) })
      }
      if (action === 'ignore' || action === 'unignore') {
        const result = await io.setCheckIgnore(scope, requireField(body, 'key'), action === 'ignore')
        return json(200, { ok: true, ignored: result.ignored, report: result.report })
      }
      throw new NovelError('novel/bad-request', `未知的检查动作：${action}（可用：ignore / unignore / save）`)
    } catch (error) {
      return toFailure(error)
    }
  }

  /**
   * The modification record: M7's line-level history.
   *
   * A `GET` without `at` lists the versions, a `GET` with `at` returns one
   * version with both texts **and its diff** — computing the diff on the host
   * keeps the one interesting decision (what counts as a change) in a module the
   * checks can exercise without a browser — and a `POST` puts one version back.
   *
   * A rollback goes through the ordinary document write, so it is recorded like
   * any other change and can be rolled back in turn.
   */
  const history = async (request: Request): Promise<Response> => {
    try {
      if (request.method === 'GET' || request.method === 'HEAD') {
        const url = new URL(request.url)
        const scope = scopeOf(url)
        const path = requireParam(url, 'path')
        const at = url.searchParams.get('at')
        if (request.method === 'HEAD') return new Response(null, { status: 200 })
        if (at === null || at === '') {
          const limit = optionalCount(url, 'limit')
          return json(200, {
            ok: true,
            history: { path, entries: await io.history(scope, path, limit === undefined ? 50 : limit) },
          })
        }
        const entry = await io.historyEntry(scope, path, at)
        if (entry === undefined) {
          throw new NovelError('novel/not-found', `修改记录里没有这一版：${path} @ ${at}`)
        }
        return json(200, { ok: true, entry: { ...entry, diff: diffLines(entry.before, entry.after) } })
      }
      const body = await readJson(request)
      const scope: NovelScope = {
        root: requireField(body, 'root'),
        sessionId: requireField(body, 'sessionId'),
      }
      const action = requireField(body, 'action')
      if (action !== 'revert') {
        throw new NovelError('novel/bad-request', `未知的修改记录动作：${action}（可用：revert）`)
      }
      const document = await io.revert(scope, requireField(body, 'path'), requireField(body, 'at'))
      return json(200, { ok: true, document })
    } catch (error) {
      return toFailure(error)
    }
  }

  const run = async (request: Request): Promise<Response> => {
    try {
      if (request.method !== 'POST') return failure(405, 'novel/method', '任务记录只接受 POST')
      const body = await readJson(request)
      const scope: NovelScope = {
        root: requireField(body, 'root'),
        sessionId: requireField(body, 'sessionId'),
      }
      const record: NovelRunRecord = {
        task: requireField(body, 'task'),
        inputs: Array.isArray(body.inputs)
          ? (body.inputs as { path?: unknown, reason?: unknown }[])
              .map(entry => ({
                path: typeof entry.path === 'string' ? entry.path : '',
                reason: typeof entry.reason === 'string' ? entry.reason : '',
              }))
          : [],
        prompt: typeof body.prompt === 'string' ? body.prompt : '',
        output: typeof body.output === 'string' ? body.output : '',
        ...(typeof body.reason === 'string' && body.reason !== '' ? { reason: body.reason } : {}),
        ...(typeof body.chapter === 'string' && body.chapter !== '' ? { chapter: body.chapter } : {}),
      }
      const path = await io.writeRun(scope, record)
      return json(200, { ok: true, path })
    } catch (error) {
      return toFailure(error)
    }
  }

  const text = async (request: Request): Promise<Response> => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return failure(405, 'novel/method', '文本读取只接受 GET')
      }
      const url = new URL(request.url)
      const scope = scopeOf(url)
      const path = requireParam(url, 'path')
      const value = await io.read(scope, path)
      if (request.method === 'HEAD') return new Response(null, { status: value === undefined ? 404 : 200 })
      return json(200, { ok: true, path, exists: value !== undefined, text: value ?? '' })
    } catch (error) {
      return toFailure(error)
    }
  }

  const meta = async (request: Request): Promise<Response> => {
    try {
      if (request.method !== 'POST') return failure(405, 'novel/method', '元数据写入只接受 POST')
      const body = await readJson(request)
      const scope: NovelScope = {
        root: requireField(body, 'root'),
        sessionId: requireField(body, 'sessionId'),
      }
      const patch: { title?: string, genre?: string, targetWords?: number } = {}
      if (typeof body.title === 'string' && body.title.trim() !== '') patch.title = body.title.trim()
      if (typeof body.genre === 'string') patch.genre = body.genre
      if (typeof body.targetWords === 'number' && Number.isFinite(body.targetWords)) {
        patch.targetWords = body.targetWords
      }
      return json(200, { ok: true, project: await io.writeMeta(scope, patch) })
    } catch (error) {
      return toFailure(error)
    }
  }

  const task = async (request: Request): Promise<Response> => {
    try {
      if (request.method === 'GET') {
        const runId = requireParam(new URL(request.url), 'runId')
        const run = deps.runState(runId)
        if (run === undefined) throw new NovelError('novel/not-found', `没有这个生成任务：${runId}`)
        return json(200, { ok: true, run })
      }
      const body = await readJson(request)
      return json(200, {
        ok: true,
        runId: deps.startWritingRun(
          requireField(body, 'sessionId'),
          requireField(body, 'prompt'),
          typeof body.label === 'string' && body.label !== '' ? body.label : undefined,
        ),
      })
    } catch (error) {
      return toFailure(error)
    }
  }

  return {
    [ROUTE_PING]: ping,
    [ROUTE_PROJECT]: project,
    [ROUTE_CHAPTER]: chapter,
    [ROUTE_DOC]: doc,
    [ROUTE_DIR]: dir,
    [ROUTE_CARDS]: cards,
    [ROUTE_SEARCH]: search,
    [ROUTE_CHECKS]: checks,
    [ROUTE_HISTORY]: history,
    [ROUTE_TEXT]: text,
    [ROUTE_META]: meta,
    [ROUTE_RUN]: run,
    [ROUTE_TASK]: task,
  }
}
