/**
 * The writing agent: an isolated model turn that answers as a novelist.
 *
 * The first executor prompted the session the panel was open in. That session is
 * the one the author talks to the *coding* agent in, so the answer came from a
 * coding agent — the run records hold its chat replies rather than prose — and
 * every click inserted a novel prompt into that conversation. This module is the
 * replacement: each task gets its own agent, its own empty history, and a system
 * prompt that is **only** the writing instruction.
 *
 * Two properties make that possible without importing a single DSH package (this
 * plugin lives outside the monorepo, so Node cannot resolve them):
 *
 * - `ctx.agents.create` takes plain options and a `setup` callback; everything
 *   registered on the scoped context exists before the first prompt assembly.
 * - `systemPrompt.section({ complete: true })` replaces the assembled system
 *   prompt outright, so the deployment's coding instructions do not leak in.
 *
 * ## The child is a one-shot *subagent* session (P2 follow-up, 2026-09-11)
 *
 * P1 created this child with `meta: {}` and no `cwd`, on the assumption that a
 * cwd-less session stays out of the author's session list. That assumption is
 * false, and it produced a real bug: the host announces every `session/created`
 * as `api-session/added`, and the browser's tree hides exactly one thing — a
 * session whose header says `origin: 'subagent'`
 * (`client/ui-workspace/src/client/tree.ts`, `sessionVisible`). So every task
 * added a row to the author's sidebar for a session that, having no `cwd`, could
 * not be opened either: selecting it failed with `session/not-found`
 * ("历史加载失败：session \"novel-…\" not found").
 *
 * The child is therefore created as what it actually is — a one-shot subagent
 * child of the author's session, the way DSH's own in-process driver does it
 * (`packages/subagent/subagent-in-process-driver/src/index.ts`):
 *
 * - `meta.origin = 'subagent'` plus `parentSession` classify it, so it is hidden
 *   from the session list and reached through its parent instead;
 * - a `subagent/descriptor` event appended inside the child's *initial turn*
 *   gives it a durable identity, so its record reads as a child rather than as
 *   corruption. This is best-effort: a deployment whose hook contract differs
 *   still gets a hidden child, only without the catalog row;
 * - the prompt is delivered through the child's own `followup`, because the
 *   Session API deliberately refuses to drive a subagent session by its plain id
 *   (`session/agent-busy`).
 *
 * @module dsh-ai-novel-copilot/novel/writing
 */
import { randomUUID } from 'node:crypto'

/** The system prompt a writing agent runs under, and nothing else. */
export const WRITER_SYSTEM_PROMPT = [
  '你是一位中文长篇网络小说的写手，正在替作者续写与打磨正文。',
  '',
  '规则：',
  '- 只输出正文本身。不要解释、不要评论、不要标题、不要编号、不要总结句、不要征询意见。',
  '- 严格遵守使用者给出的【文风规则】；没有给出时，采用第三人称限知、短句为主、白描优先的网文笔法。',
  '- 严格遵守【本章要点】；没有给出时，顺着已有正文自然推进，不新增未铺垫的重大设定或人物。',
  '- 与已有正文在人物称呼、视角、时态、语气上保持一致。',
  '- 不要复述已有内容，不要重复上一句的意思。',
].join('\n')

/**
 * Version of the `subagent/descriptor` payload this plugin writes.
 *
 * DSH validates the payload against its complete declared schema and ignores an
 * unknown version, so a version bump downgrades this child to "unclassified"
 * (still hidden, no catalog row) rather than corrupting anything.
 */
const SUBAGENT_DESCRIPTOR_VERSION = 3

/** Session event the durable child identity rides on. */
const DESCRIPTOR_EVENT = 'subagent/descriptor'

/** Provider name recorded in the child's descriptor: this plugin, as the establisher. */
const WRITER_PROVIDER = 'novel-copilot'

/** How deep a writing child sits below the author's session. */
const WRITER_DEPTH = 1

/** One streaming run, as the panel polls it. */
export interface WritingRun {
  /** Text produced so far. */
  text: string
  /** Whether the turn has ended. */
  done: boolean
  /** Terminal reason reported by the session. */
  reason?: string
  /** Failure text, when the run could not complete. */
  error?: string
}

/** One identified user message, in the shape the Agent inbox accepts. */
export interface WriterMessage {
  /** Fresh stable message identity. */
  id: string
  /** Always a user turn: this is the task prompt. */
  role: 'user'
  /** Exactly the prompt text, as one content block. */
  content: { type: 'text', text: string }[]
  /** Provenance the session log records. */
  source: { kind: 'user' }
}

/** The durable identity of a writing child, as the `subagent/descriptor` event carries it. */
export interface WriterDescriptor {
  /** Descriptor format version. */
  version: number
  /** A writing run answers one prompt and stops. */
  mode: 'one-shot'
  /** Who established the child. */
  provider: string
  /** Short label the catalog lists the child under, when the caller named one. */
  label?: string
}

/** Freeze a value and everything reachable from it. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

/**
 * Build the message that carries one task prompt.
 *
 * `createUserMessage` lives in `@deepseek-ai/dsh-llm`, which this plugin cannot
 * resolve, so the value is built here. The shape is four fields and frozen, and
 * `spike/format-check.mjs` asserts both — this is the one place where a small
 * amount of duplicated knowledge buys the whole "no imports" property.
 * @param text - the assembled prompt.
 * @returns the frozen message to hand to the child's inbox.
 */
export function writerMessage(text: string): WriterMessage {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

/**
 * Build the durable identity of one writing child.
 * @param label - short task label the catalog shows, when the caller named one.
 * @returns the descriptor payload.
 */
export function writerDescriptor(label: string | undefined): WriterDescriptor {
  return {
    version: SUBAGENT_DESCRIPTOR_VERSION,
    mode: 'one-shot',
    provider: WRITER_PROVIDER,
    ...(label === undefined || label === '' ? {} : { label }),
  }
}

/** The slice of a live Agent this module drives. */
export interface WritingAgent {
  session: {
    id: string
    /** Append one durable session event. */
    append(type: string, data: unknown): unknown
  }
  /** Queue one ordinary follow-up turn and wake the driver. */
  followup(message: WriterMessage): void
}

/** The host services the writing agent needs. */
export interface WritingContext {
  agents: {
    create(options: Record<string, unknown>): Promise<{ agent: WritingAgent, dispose(): Promise<void> }>
    get(sessionId: string): {
      options?: { provider?: string, model?: string, reasoningEffort?: string }
      session?: { header?: { cwd?: string } }
    } | undefined
  }
  on(event: string, listener: (...args: any[]) => void): unknown
  logger?: { warn(message: unknown): void, info?(message: unknown): void }
}

/** How long one writing turn may take before it is abandoned. */
const RUN_TIMEOUT_MS = 5 * 60 * 1000

/** Live runs by id, read by the streaming route. */
const RUNS = new Map<string, WritingRun>()
/** Subscribers woken whenever a run's text or terminal state changes. */
const WAITERS = new Map<string, Set<() => void>>()

/** Read one run's current state. */
export function runState(runId: string): WritingRun | undefined {
  return RUNS.get(runId)
}

/**
 * Wait until a run changes or finishes.
 * @param runId - the run to observe.
 * @returns a promise resolved on the next change.
 */
export function nextRunChange(runId: string): Promise<void> {
  return new Promise((resolve) => {
    const set = WAITERS.get(runId) ?? new Set<() => void>()
    WAITERS.set(runId, set)
    set.add(() => {
      set.delete(resolve as unknown as () => void)
      resolve()
    })
  })
}

/** Wake every subscriber of one run. */
function notify(runId: string): void {
  for (const waiter of WAITERS.get(runId) ?? []) waiter()
}

/** Drop a finished run's bookkeeping. */
function retire(runId: string): void {
  WAITERS.delete(runId)
  // The state object stays readable for a while so a late poll still sees the
  // terminal text instead of an empty run.
  setTimeout(() => { RUNS.delete(runId) }, 60_000)
}

/** The model route a new writing agent should use, taken from the calling session. */
function routeOf(ctx: WritingContext, sessionId: string): Record<string, unknown> {
  const options = ctx.agents.get(sessionId)?.options
  if (options?.provider === undefined || options.model === undefined) return {}
  return {
    provider: options.provider,
    model: options.model,
    ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
  }
}

/**
 * The creation metadata that makes the child a hidden one-shot subagent.
 *
 * `origin` is the field the browser's session tree filters on, and
 * `parentSession` is what its record is addressed through; `cwd` mirrors the
 * author's own workspace so the child's session record stays coherent even
 * though it runs no file tools of its own.
 * @param ctx - host context.
 * @param sessionId - the author's session, which becomes the child's parent.
 * @returns the `meta` for `ctx.agents.create`.
 */
function childMeta(ctx: WritingContext, sessionId: string): Record<string, unknown> {
  const cwd = ctx.agents.get(sessionId)?.session?.header?.cwd
  return {
    ...(typeof cwd === 'string' && cwd !== '' ? { cwd } : {}),
    parentSession: sessionId,
    isSeeded: false,
    origin: 'subagent',
    delegationDepth: WRITER_DEPTH,
  }
}

/**
 * Start one writing run.
 *
 * Returns as soon as the run exists; the caller streams it by id. The returned
 * id is also the run's cancellation handle.
 * @param ctx - host context carrying agents and the session registry.
 * @param sessionId - the session whose model route is reused, and whose sandbox
 *   policy the caller already applied when assembling the prompt.
 * @param prompt - the fully assembled prompt; this module adds nothing to it.
 * @param label - short task label recorded on the child's durable identity.
 * @returns the run id.
 */
export function startWritingRun(
  ctx: WritingContext,
  sessionId: string,
  prompt: string,
  label?: string,
): string {
  const runId = randomUUID()
  const state: WritingRun = { text: '', done: false }
  RUNS.set(runId, state)
  void execute(ctx, runId, sessionId, prompt, label)
  return runId
}

/**
 * Run one task to completion, updating the run's state as text arrives.
 * @param ctx - host context.
 * @param runId - the run's identity.
 * @param sessionId - session whose model route is reused.
 * @param prompt - the assembled prompt.
 * @param label - short task label recorded on the child's durable identity.
 */
async function execute(
  ctx: WritingContext,
  runId: string,
  sessionId: string,
  prompt: string,
  label?: string,
): Promise<void> {
  const state = RUNS.get(runId)
  if (state === undefined) return
  const childId = `novel-${randomUUID()}`
  let handle: { agent: WritingAgent, dispose(): Promise<void> } | undefined
  let settled = false
  let marked = false

  /** Close the run once. */
  const settle = (patch: Partial<WritingRun>): void => {
    if (settled) return
    settled = true
    Object.assign(state, patch, { done: true })
    notify(runId)
    retire(runId)
    void handle?.dispose().catch(() => {})
  }

  /**
   * Record the child's durable subagent identity, once.
   *
   * Called from two independent places — the child's own pre-step hook and the
   * first streamed chunk — because both are inside the initial turn and either
   * may be the one that exists in a given deployment.
   */
  const markChild = (): void => {
    const agent = handle?.agent
    if (marked || agent === undefined) return
    marked = true
    try {
      agent.session.append(DESCRIPTOR_EVENT, writerDescriptor(label))
    } catch (error) {
      ctx.logger?.warn?.(`novel-copilot: writing agent descriptor was not recorded: ${String(error)}`)
    }
  }

  const timer = setTimeout(() => {
    settle({ error: `生成超过 ${String(RUN_TIMEOUT_MS / 60000)} 分钟仍未结束，已放弃` })
  }, RUN_TIMEOUT_MS)

  // Subscribe before prompting so the first chunk is never missed.
  ctx.on('agent/assistant-stream', (payload: { agent?: { session?: { id?: string } }, frame?: any }) => {
    if (settled) return
    if (payload?.agent?.session?.id !== childId) return
    const frame = payload.frame
    if (frame?.type !== 'chunk' || frame.chunk?.type !== 'text-delta') return
    if (typeof frame.chunk.text !== 'string' || frame.chunk.text === '') return
    // The first chunk is proof that the initial turn is open, which is the one
    // window the descriptor belongs in — so this doubles as the fallback for a
    // deployment whose pre-step hook contract differs from the one below.
    markChild()
    state.text += frame.chunk.text
    notify(runId)
  })

  ctx.on('session/event', (session: { id?: string }, event: { type?: string, data?: { reason?: unknown } }) => {
    if (settled) return
    if (session?.id !== childId || event?.type !== 'turn/end') return
    clearTimeout(timer)
    settle({ reason: reasonOf(event.data?.reason) })
  })

  try {
    handle = await ctx.agents.create({
      sessionId: childId,
      meta: childMeta(ctx, sessionId),
      agentOptions: routeOf(ctx, sessionId),
      setup: (agentCtx: any) => {
        // `complete` makes this the whole system prompt: without it the
        // deployment's coding instructions would still be assembled around it.
        agentCtx.systemPrompt.section({
          name: 'novel-copilot/writer',
          order: 0,
          complete: true,
          text: WRITER_SYSTEM_PROMPT,
        })
        // A prose turn has no business calling tools.
        agentCtx.tools.restrict({ allow: [] })
        // The canonical placement for the durable identity: inside the child's
        // initial turn and before its first request. Guarded, because a changed
        // hook contract must cost the catalog row, never the task.
        try {
          agentCtx.on('agent/pre-step', async (_payload: unknown, next: () => Promise<{ kind?: string }>) => {
            const decision = await next()
            if (decision?.kind === 'enter') markChild()
            return decision
          })
        } catch (error) {
          ctx.logger?.warn?.(`novel-copilot: writing agent descriptor hook was refused: ${String(error)}`)
        }
      },
    })
  } catch (error) {
    clearTimeout(timer)
    settle({ error: `无法创建写作 agent：${error instanceof Error ? error.message : String(error)}` })
    return
  }

  if (settled) return

  try {
    // Delivered through the child itself: the Session API refuses to drive a
    // subagent session by its plain id (`session/agent-busy`), which is exactly
    // the classification that keeps it out of the author's session list.
    handle.agent.followup(writerMessage(prompt))
  } catch (error) {
    clearTimeout(timer)
    settle({ error: `写作 agent 拒绝了这个请求：${error instanceof Error ? error.message : String(error)}` })
  }
}

/** Read the terminal reason out of a `turn/end` payload. */
function reasonOf(reason: unknown): string {
  if (typeof reason === 'object' && reason !== null) {
    const kind = (reason as { kind?: unknown }).kind
    if (typeof kind === 'string') return kind
  }
  return typeof reason === 'string' ? reason : 'completed'
}
