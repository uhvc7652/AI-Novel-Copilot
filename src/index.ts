/**
 * Host half of AI-Novel-Copilot.
 *
 * The plugin owns no state of its own: it wires the filesystem-backed novel
 * operations to a small set of `/api/novel/*` Fetch routes that the browser
 * panel calls. Reads and writes both go through `ctx.fs` with the calling
 * session's sandbox policy, so an author's file policy applies to the panel
 * exactly as it applies to the agent's own tools.
 *
 * @module dsh-ai-novel-copilot
 */
import { NOVEL_ROUTES, ROUTE_PING, createHandlers } from './novel/http.ts'
import { NovelIo } from './novel/io.ts'
import { loadRecents, rememberRecent } from './novel/recents.ts'
import { runState, startWritingRun } from './novel/writing.ts'

/** Cordis plugin name. */
export const name = 'ai-novel-copilot'

/**
 * Host services this plugin reads.
 *
 * `agents` is declared because the writing run creates and prompts its own
 * agent: cordis refuses `ctx.agents` on a context that did not inject it
 * ("cannot get property \"agents\" without inject").
 *
 * `sessionController` is deliberately **not** here any more: the writing child
 * is a subagent session, and the Session API refuses to drive one by its plain
 * id (`session/agent-busy`), so the run talks to the child's own Agent instead.
 */
export const inject = ['connection', 'fs', 'sandboxPolicy', 'sessions', 'agents']

/** Subdirectory a session's workspace gets by default. */
const DEFAULT_SUBDIR = 'novel'

/**
 * The project root the panel should offer first.
 *
 * A session's own workspace is the only root guaranteed writable under
 * `workspace-write`, so `<session cwd>/novel` is the default; `DSH_NOVEL_ROOT`
 * overrides it for deployments that keep novels elsewhere.
 * @param ctx - host context.
 * @param sessionId - session the request came from, when known.
 * @returns an absolute default root.
 */
function defaultRootFor(ctx: any, sessionId: string | undefined): string {
  const configured = process.env.DSH_NOVEL_ROOT
  if (configured !== undefined && configured !== '') return configured
  const cwd = sessionId === undefined ? undefined : ctx.sessions?.get?.(sessionId)?.header?.cwd
  const base = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
  return `${base.replace(/[\\/]+$/, '')}/${DEFAULT_SUBDIR}`
}

/**
 * Cordis plugin body: build the IO half and claim the panel's routes.
 * @param ctx - host context carrying connection, fs, sandboxPolicy, and sessions.
 */
export function apply(ctx: any): void {
  const io = new NovelIo(ctx)
  const handlers = createHandlers({
    io,
    defaultRoot: defaultRootFor(ctx, undefined),
    startWritingRun: (sessionId, prompt, label) => startWritingRun(ctx, sessionId, prompt, label),
    runState,
    // The panel's memory of opened projects lives on disk rather than in the
    // browser's per-origin storage; see `novel/recents.ts` for why.
    loadRecents: () => loadRecents(),
    rememberRecent: entry => rememberRecent(entry),
  })

  // Ping is the one route whose answer depends on the caller, so it is wrapped
  // instead of using the shared handler table.
  const ping = async (request: Request): Promise<Response> => {
    if (request.method === 'HEAD') return new Response(null, { status: 200 })
    const sessionId = new URL(request.url).searchParams.get('sessionId') ?? undefined
    return Response.json(
      { ok: true, name, defaultRoot: defaultRootFor(ctx, sessionId), routes: NOVEL_ROUTES },
      { headers: { 'cache-control': 'no-store' } },
    )
  }

  for (const path of NOVEL_ROUTES) {
    const handler = path === ROUTE_PING ? ping : handlers[path]
    ctx.effect(
      () => ctx.connection.fetch.register({
        path,
        methods: ['GET', 'HEAD', 'POST'],
        // Buffered, deliberately. The route's body mode is one value for every
        // method it owns, and the streaming bridge attaches a request body
        // unconditionally — which makes an ordinary bodyless GET throw while
        // the Fetch `Request` is constructed, surfacing as an unexplained 400.
        // Buffering is not a compromise here: the carrier's buffered cap is
        // 300 MiB, far above any chapter.
        requestBody: 'buffered',
        fetch: handler,
      }),
      `ai-novel-copilot: route ${path}`,
    )
  }
}
