/**
 * The task bar: run one named task, watch it stream, and decide what to do with
 * the result.
 *
 * Every task in this plugin goes through here, because the decisions are the
 * same three regardless of what produced the text: what was fed in (shown
 * before the result is trusted), whether the author accepts it, and where it
 * goes. Only the last part differs, and it differs by the task's declared
 * `apply` — prose lands in a chapter buffer, a `doc` result in a document
 * buffer, a `plan` becomes a list the author confirms chapter by chapter.
 *
 * Nothing here writes to disk. Adopting edits a buffer; the ordinary save path
 * is what put bytes on disk, for AI output exactly as for a typed word (D9).
 *
 * @module dsh-ai-novel-copilot/client/TaskBar
 */
import { useCallback, useRef, useState } from 'react'
import { countWords } from '../novel/words.ts'
import * as api from './api.ts'
import { ModelIssueList } from './IssueList.tsx'
import { parseIssues, type IssueParseResult } from './issues.ts'
import { parsePlan, type PlanChapter } from './plan.ts'
import { startRun, type RunHandle } from './runner.ts'
import { assemble, type AssembledTask, type TaskContext, type TaskDefinition, type TaskInput } from './tasks.ts'
import { box, button, caption, checkLine, controlRow, metaLine, previewBox, previewText, row, type PanelEnv } from './ui.ts'

/** A finished generation waiting for the author's decision. */
interface Preview {
  /** Task that produced it. */
  label: string
  /** What the output is. */
  apply: 'append-body' | 'replace-body' | 'write-document'
  /** The file a `write-document` result belongs to. */
  target?: string
  /** Generated text. */
  text: string
  /** The assembly the prompt was built from. */
  inputs: TaskInput[]
}

/** A parsed plan waiting for the author to choose chapters from it. */
interface PlanState {
  /** Chapters the model proposed. */
  chapters: PlanChapter[]
  /** Which ones the author ticked. */
  selected: boolean[]
  /** Why nothing could be proposed, when nothing could. */
  error?: string
}

/**
 * A finished model check, waiting to be read.
 *
 * There is no decision to make — a report *is* the product — so it keeps its own
 * assembly list (to answer "what did it read?") instead of borrowing the
 * preview's, which exists to feed an 采纳 button this output does not have.
 */
interface IssueState {
  /** What the model reported, parsed. */
  result: IssueParseResult
  /** The files the prompt was assembled from. */
  inputs: TaskInput[]
  /** Task label, for the header line. */
  label: string
}

/** Props for one task bar. */
export interface TaskBarProps {
  /** Shared panel environment: notes, busy, session, root. */
  env: PanelEnv
  /** The tasks to offer, in button order. */
  tasks: readonly TaskDefinition[]
  /** Built per run, so the assembly always sees the current tree. */
  context(): TaskContext
  /** Volume new chapters from a plan are appended to. */
  volume: number
  /** Take a prose result into the chapter editor buffer. */
  onProse(text: string, apply: 'append' | 'replace', label: string): void
  /** Take a document result into the matching outline buffer. */
  onDocument(target: string, text: string, label: string): void
  /** Create the chapters the author accepted. */
  onCreateChapters(chapters: readonly PlanChapter[], volume: number): void
  /**
   * Put the cursor on a quoted passage, for a report whose findings point into
   * the text. Omitted when the surface showing the report has no editor behind it.
   */
  onLocate?(quote: string): void
  /** Disable the bar while something else owns the panel. */
  disabled?: boolean
}

/** Map a task's declared apply onto the preview's own vocabulary. */
function previewApply(apply: AssembledTask['apply']): Preview['apply'] {
  if (apply === 'write-document') return 'write-document'
  return apply === 'append-body' ? 'append-body' : 'replace-body'
}

/**
 * The task bar.
 * @param props - tasks, context builder, and the three result sinks.
 */
export function TaskBar({
  env,
  tasks,
  context,
  volume,
  onProse,
  onDocument,
  onCreateChapters,
  onLocate,
  disabled = false,
}: TaskBarProps) {
  const [running, setRunning] = useState(false)
  const [stream, setStream] = useState('')
  const [preview, setPreview] = useState<Preview>()
  const [plan, setPlan] = useState<PlanState>()
  const [issues, setIssues] = useState<IssueState>()
  /** Accumulates the stream outside React state so settlement reads the full text. */
  const streamRef = useRef('')
  const runRef = useRef<RunHandle | undefined>(undefined)

  const reset = useCallback(() => {
    setStream('')
    setPreview(undefined)
    setPlan(undefined)
    setIssues(undefined)
    streamRef.current = ''
  }, [])

  /**
   * Run one task.
   *
   * The prompt is assembled first so the input list is real before the model is
   * asked anything, and the result is settled by the host run rather than by
   * watching the author's own conversation — the mistake P1 had to undo.
   */
  const onRun = useCallback((task: TaskDefinition) => {
    void env.run(`任务「${task.label}」`, async () => {
      const taskContext = context()
      const assembled = await assemble(task, taskContext)
      reset()
      setRunning(true)
      return await new Promise<string>((resolve) => {
        runRef.current = startRun(env.sessionId, assembled.prompt, assembled.label, {
          onDelta: (chunk) => {
            streamRef.current += chunk
            setStream(streamRef.current)
          },
          onSettle: (reason) => {
            setRunning(false)
            runRef.current = undefined
            const text = streamRef.current
            if (assembled.kind === 'plan') {
              const parsed = parsePlan(text)
              setPlan({
                chapters: parsed.chapters,
                selected: parsed.chapters.map(() => true),
                ...(parsed.error === undefined ? {} : { error: parsed.error }),
              })
            } else if (assembled.kind === 'issues') {
              setIssues({ result: parseIssues(text), inputs: assembled.inputs, label: task.label })
            } else {
              setPreview({
                label: task.label,
                apply: previewApply(assembled.apply),
                ...(assembled.target === undefined ? {} : { target: assembled.target }),
                text,
                inputs: assembled.inputs,
              })
            }
            // The run record is an audit trail; failing to write it never fails the task.
            void api.writeRun(env.sessionId, env.root, {
              task: assembled.id,
              inputs: assembled.inputs,
              prompt: assembled.prompt,
              output: text,
              reason,
              ...(taskContext.chapter === undefined ? {} : { chapter: taskContext.chapter.path }),
            }).catch(() => {})
            resolve(`「${task.label}」完成（${reason}），${String(countWords(text))} 字`)
          },
          onError: (message) => {
            setRunning(false)
            runRef.current = undefined
            resolve(`「${task.label}」失败：${message}`)
          },
        })
      })
    })
  }, [context, env, reset])

  const onCancel = useCallback(() => {
    runRef.current?.cancel()
    runRef.current = undefined
    setRunning(false)
    env.note('已停止接收生成结果')
  }, [env])

  /** Hand the finished result to whichever buffer owns it. */
  const onAdopt = useCallback(() => {
    if (preview === undefined) return
    if (preview.apply === 'write-document' && preview.target !== undefined) {
      onDocument(preview.target, preview.text, preview.label)
    } else {
      onProse(preview.text, preview.apply === 'append-body' ? 'append' : 'replace', preview.label)
    }
    reset()
  }, [onDocument, onProse, preview, reset])

  /** Create the chapters the author left ticked. */
  const onCreate = useCallback(() => {
    if (plan === undefined) return
    const chosen = plan.chapters.filter((_, index) => plan.selected[index] === true)
    if (chosen.length === 0) {
      env.note('一个章节都没勾选')
      return
    }
    onCreateChapters(chosen, volume)
    reset()
  }, [env, onCreateChapters, plan, reset, volume])

  const chosenCount = plan === undefined ? 0 : plan.selected.filter(Boolean).length

  return (
    <>
      <div style={row}>
        {tasks.map(task => (
          <button
            key={task.id}
            type="button"
            style={button}
            title={task.hint}
            disabled={disabled || env.busy || running}
            onClick={() => { onRun(task) }}
          >
            {task.label}
          </button>
        ))}
        {running && <button type="button" style={button} onClick={onCancel}>停止</button>}
      </div>

      {(running || preview !== undefined || plan !== undefined || issues !== undefined) && (
        <div style={previewBox}>
          <div style={controlRow}>
            <span style={caption}>
              {running
                ? '生成中…'
                : issues !== undefined
                  ? `模型检查「${issues.label}」：${String(issues.result.issues.length)} 条`
                  : plan !== undefined
                    ? `拆章结果：${String(plan.chapters.length)} 章（已勾选 ${String(chosenCount)}）`
                    : `预览「${preview?.label ?? ''}」· ${String(countWords(preview?.text ?? ''))} 字`}
            </span>
          </div>

          {issues !== undefined
            ? (
              running
                ? <pre style={previewText}>{stream}</pre>
                : <ModelIssueList
                    issues={issues.result.issues}
                    {...(issues.result.error === undefined ? {} : { error: issues.result.error })}
                    {...(onLocate === undefined ? {} : { onLocate })}
                  />
            )
            : plan === undefined
              ? <pre style={previewText}>{running ? stream : (preview?.text ?? '')}</pre>
              : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {plan.error === undefined ? null : <div>{plan.error}</div>}
                  {plan.chapters.map((chapter, index) => (
                    <label
                      key={`${chapter.title}-${String(index)}`}
                      style={{ ...checkLine, alignItems: 'flex-start' }}
                    >
                      <input
                        type="checkbox"
                        checked={plan.selected[index] === true}
                        onChange={event => {
                          const next = [...plan.selected]
                          next[index] = event.target.checked
                          setPlan({ ...plan, selected: next })
                        }}
                      />
                      <span>
                        <strong>{chapter.title}</strong>
                        {chapter.summary === undefined ? '' : ` · ${chapter.summary}`}
                        {chapter.beats.length === 0 ? '' : (
                          <span style={metaLine}>{chapter.beats.map(beat => `· ${beat}`).join(' ')}</span>
                        )}
                      </span>
                    </label>
                  ))}
                </div>
              )}

          {/* A report has no decision to make, but it does have an assembly to
              answer for: "what did it actually read?" is the same question the
              prose preview answers with this list. */}
          {(preview !== undefined || issues !== undefined) && (
            <details style={metaLine}>
              <summary>
                这次喂了什么（{String((preview?.inputs ?? issues?.inputs ?? []).length)} 个文件）
              </summary>
              {(preview?.inputs ?? issues?.inputs ?? []).map(item => (
                <div key={item.path}>{item.path} — {item.reason}</div>
              ))}
            </details>
          )}
          {(plan !== undefined && plan.error === undefined
            || (issues !== undefined && issues.result.error !== undefined)) && (
            <div style={box}>
              <details style={metaLine}>
                <summary>原始输出</summary>
                <pre style={previewText}>{stream}</pre>
              </details>
            </div>
          )}

          {/* The decision comes last: the author reads the prose, and the button
              to accept it is the next thing under the cursor. */}
          {(preview !== undefined || (plan !== undefined && plan.chapters.length > 0) || issues !== undefined) && (
            <div style={{ ...row, justifyContent: 'flex-end' }}>
              {preview !== undefined && (
                <>
                  <button type="button" style={button} onClick={reset}>放弃</button>
                  <button type="button" style={button} onClick={onAdopt}>采纳</button>
                </>
              )}
              {plan !== undefined && plan.chapters.length > 0 && (
                <>
                  <button type="button" style={button} onClick={reset}>放弃</button>
                  <button type="button" style={button} onClick={onCreate}>
                    建章（{String(chosenCount)}）
                  </button>
                </>
              )}
              {issues !== undefined && (
                // Nothing to adopt: the findings are the product, and the run
                // record under `.novel/runs/` was already written on settlement.
                <button type="button" style={button} onClick={reset}>清空</button>
              )}
            </div>
          )}
        </div>
      )}
    </>
  )
}
