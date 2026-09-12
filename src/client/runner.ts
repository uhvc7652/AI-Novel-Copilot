/**
 * Task execution, from the panel's side.
 *
 * A run happens entirely on the host: the panel posts the assembled prompt, gets
 * a run id, and reads back the accumulating text until it settles. Nothing here
 * touches the author's own session — that was the first executor's mistake, and
 * it made a coding agent answer novel prompts inside the author's chat.
 *
 * Progress is read by polling rather than a server-sent-event stream. A 250 ms
 * interval is a few hundred milliseconds away from live, and after the
 * streaming-correlation bug this replaced, an accumulating buffer that a late
 * reader can still read *in full* is the property worth having.
 *
 * @module dsh-ai-novel-copilot/client/runner
 */
import * as api from './api.ts'

/** What a running task reports back to the panel. */
export interface RunCallbacks {
  /** Text arrived since the last read. */
  onDelta(text: string): void
  /** The turn ended; `reason` is the session's own terminal reason. */
  onSettle(reason: string): void
  /** The run could not start or failed on the host. */
  onError(message: string): void
}

/** A handle to a task that is running. */
export interface RunHandle {
  /** Stop reading. The host run still finishes or times out on its own. */
  cancel(): void
}

/** How often the panel asks the host for more text. */
const POLL_INTERVAL_MS = 250

/**
 * Terminal reasons that mean the turn failed rather than finished.
 *
 * `error` is what the session reports when the model call itself failed — an
 * unreachable provider, a rejected key, a spent quota. The run then ends with no
 * text, and a reader that only looks for failure *text* treats that as a
 * finished generation: the author presses a task button and gets "生成完成"
 * followed by nothing at all. So the reason is a failure here, and its message
 * says what the absence of text means. (Found by running the M6 model check on
 * an instance whose model route was not configured — the panel showed
 * 「0 条」 and an empty 原始输出 rather than the real cause.)
 * @param reason - the session's terminal reason.
 * @returns true when the turn ended in failure.
 */
export function isFailedReason(reason: string | undefined): boolean {
  return reason === 'error'
}

/**
 * Start a task and read its text back as it accumulates.
 * @param sessionId - session whose model route the writing agent reuses.
 * @param prompt - the fully assembled prompt.
 * @param label - short task label the child's durable identity carries.
 * @param callbacks - progress, settlement, and failure sinks.
 * @returns a handle that stops reading.
 */
export function startRun(
  sessionId: string,
  prompt: string,
  label: string,
  callbacks: RunCallbacks,
): RunHandle {
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const fail = (error: unknown): void => {
    callbacks.onError(error instanceof Error ? error.message : String(error))
  }

  void (async () => {
    let runId: string
    try {
      runId = await api.startTask(sessionId, prompt, label)
    } catch (error) {
      fail(error)
      return
    }

    let sent = 0
    const tick = async (): Promise<void> => {
      if (cancelled) return
      let run: api.WritingRunState
      try {
        run = await api.readTask(runId)
      } catch (error) {
        fail(error)
        return
      }
      if (cancelled) return
      if (run.text.length > sent) {
        callbacks.onDelta(run.text.slice(sent))
        sent = run.text.length
      }
      if (run.done) {
        if (run.error !== undefined && run.error !== '') callbacks.onError(run.error)
        else if (isFailedReason(run.reason)) {
          callbacks.onError(
            '模型这一轮没有正常结束（会话报 error）：检查模型与凭据，或稍后重试。'
            + (run.text === '' ? '这一轮没有留下任何输出。' : '已产出的部分在下面的原始输出里。'),
          )
        } else callbacks.onSettle(run.reason ?? 'completed')
        return
      }
      timer = setTimeout(() => { void tick() }, POLL_INTERVAL_MS)
    }
    await tick()
  })()

  return {
    cancel: () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    },
  }
}
