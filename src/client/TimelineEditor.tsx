/**
 * The timeline's row editor.
 *
 * The timeline's format is **a table** — 叙事序 / 故事时间 / 事件 / 章节 (format
 * §4.5) — and the consistency checks parse that table to report 倒序 and
 * references to chapters that do not exist. Editing it as one blob of Markdown
 * was the last surface in the panel that made the author do the machine's job,
 * and it is also why 世界观 and 时间线 looked like the same page: they were the
 * same form.
 *
 * Three rules shape this component:
 *
 * 1. **The body stays the single source of truth.** Every edit goes through
 *    {@link renderTimeline} and lands in the document buffer the parent already
 *    owns, so saving, the dirty flag and M7's history all work unchanged.
 * 2. **Half-typed input must survive.** A `章节` cell is converted to ids when it
 *    is written, so deriving the inputs back out of the body would erase "c00"
 *    the moment it is typed. The drafts therefore live in state, and are
 *    re-derived only when the body changes from *outside* (the author switched
 *    documents, or a rollback rewrote the file).
 * 3. **Raw text stays available.** A table editor that cannot be escaped is worse
 *    than no editor: pasting a table from elsewhere, or writing a note under it,
 *    is a legitimate thing to do — hence 「编辑原文」. It is also where a locate
 *    request lands, because selecting a sentence needs a real textarea.
 *
 * @module dsh-ai-novel-copilot/client/TimelineEditor
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { ChapterSummary } from '../novel/project.ts'
import { moveTimelineRow, parseTimeline, renderTimeline } from '../novel/timeline.ts'
import { button, caption, controlRow, input, metaLine, row, textarea, type PanelEnv } from './ui.ts'

/** One row while it is being edited: the cells as text, not as parsed values. */
interface DraftRow {
  time: string
  event: string
  chapters: string
}

/** Props for the timeline editor. */
export interface TimelineEditorProps {
  /** Shared panel environment, for the busy flag. */
  env: PanelEnv
  /** The timeline document's body, as it currently stands. */
  body: string
  /** Every chapter, so a row can pick an id and the picker can show what it is. */
  chapters: readonly ChapterSummary[]
  /** Replace the body. The parent owns it; this writes through the ordinary save path. */
  onChange(body: string): void
  /** A locate request from M7; switches to raw text so a sentence can be selected. */
  locate?: { quote: string, token: number }
  /**
   * The textarea the parent selects quotes in (only mounted in raw mode).
   *
   * Typed as React's own `RefObject` rather than `RefObject<T | null>` so it can
   * be handed straight to the `ref` prop; the parent's `useRef<T | null>` is
   * assignable to it, and `useQuoteLocate` reads `current` either way.
   */
  textareaRef?: RefObject<HTMLTextAreaElement>
}

/** The chapter ids a cell mentions. */
function idsOf(text: string): string[] {
  return [...text.matchAll(/c\d{3,}/g)].map(match => match[0])
}

/** The editable form of every row in a body. */
function draftsOf(body: string): DraftRow[] {
  return parseTimeline(body).rows.map(row => ({
    time: row.time,
    event: row.event,
    chapters: row.chapters.join('、'),
  }))
}

/**
 * The timeline editor.
 * @param props - environment, the body, the chapters, and the write-back hook.
 */
export function TimelineEditor({ env, body, chapters, onChange, locate, textareaRef }: TimelineEditorProps) {
  const [drafts, setDrafts] = useState<DraftRow[]>(() => draftsOf(body))
  /** The body this component last wrote, so its own echo does not reset the drafts. */
  const writtenRef = useRef(body)
  const [raw, setRaw] = useState(false)

  useEffect(() => {
    if (writtenRef.current === body) return
    writtenRef.current = body
    setDrafts(draftsOf(body))
  }, [body])

  // A locate request (M7's "点一行定位" on a timeline version) needs the textarea
  // to exist: rows mode has none.
  const seenLocate = useRef(locate?.token)
  useEffect(() => {
    if (locate === undefined || locate.token === seenLocate.current) return
    seenLocate.current = locate.token
    setRaw(true)
  }, [locate])

  /** Write rows back into the body, and keep the drafts authoritative while typing. */
  const commit = useCallback((next: DraftRow[]) => {
    setDrafts(next)
    const nextBody = renderTimeline(body, next.map(row => ({
      time: row.time,
      event: row.event,
      chapters: idsOf(row.chapters),
    })))
    writtenRef.current = nextBody
    onChange(nextBody)
  }, [body, onChange])

  const timeline = useMemo(() => parseTimeline(body), [body])
  const chapterById = useMemo(() => new Map(chapters.map(chapter => [chapter.id, chapter])), [chapters])

  const edit = useCallback((index: number, patch: Partial<DraftRow>) => {
    commit(drafts.map((draft, at) => (at === index ? { ...draft, ...patch } : draft)))
  }, [commit, drafts])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0, flex: '1 1 auto' }}>
      <div style={controlRow}>
        <span style={caption}>
          时间线：{String(drafts.length)} 行 · 叙事序按行号自动排（↑↓ 改顺序）
          {timeline.found ? '' : ' · 这一页还没有表格，改一行就会自动建出来'}
        </span>
        <span style={row}>
          <button type="button" style={button} disabled={env.busy}
            onClick={() => { commit([...drafts, { time: '', event: '', chapters: '' }]) }}>
            + 加一行
          </button>
          <button type="button" style={button} onClick={() => { setRaw(value => !value) }}>
            {raw ? '回到表格' : '编辑原文'}
          </button>
        </span>
      </div>

      {raw
        ? (
          <textarea
            ref={textareaRef}
            style={textarea}
            value={body}
            placeholder={'# 时间线\n\n| 叙事序 | 故事时间 | 事件 | 章节 |\n|---|---|---|---|\n| 1 | 元启三年·春 | 陈默被逐出家族 | c0001 |\n'}
            onChange={event => {
              writtenRef.current = event.target.value
              onChange(event.target.value)
            }}
          />
        )
        : (
          <div style={{ overflow: 'auto', flex: '1 1 auto', minHeight: 160 }}>
            {drafts.length === 0 && (
              <div style={metaLine}>还没有行。点「+ 加一行」开始，或者切到「编辑原文」贴一张现成的表。</div>
            )}
            {drafts.map((draft, index) => {
              const ids = idsOf(draft.chapters)
              const unknown = ids.filter(id => !chapterById.has(id))
              return (
                <div key={index} style={{ ...row, flexWrap: 'nowrap', marginTop: 4 }}>
                  <span style={{ ...caption, width: 22, textAlign: 'right' }}>{String(index + 1)}</span>
                  <input
                    style={{ ...input, width: 120 }}
                    value={draft.time}
                    placeholder="故事时间"
                    onChange={event => { edit(index, { time: event.target.value }) }}
                  />
                  <input
                    style={{ ...input, flex: '1 1 140px' }}
                    value={draft.event}
                    placeholder="事件"
                    onChange={event => { edit(index, { event: event.target.value }) }}
                  />
                  <input
                    style={{
                      ...input,
                      width: 120,
                      ...(unknown.length === 0 ? {} : { borderColor: '#d9534f' }),
                    }}
                    list="novel-timeline-chapters"
                    value={draft.chapters}
                    placeholder="章节 id（c0001、c0002）"
                    title={unknown.length === 0
                      ? '这一行指向的章节；多个用、分开'
                      : `这几个 id 没有对应的章节文件：${unknown.join('、')}`}
                    onChange={event => { edit(index, { chapters: event.target.value }) }}
                  />
                  <button type="button" style={{ ...button, padding: '1px 6px' }}
                    title="上移一行" disabled={env.busy || index === 0}
                    onClick={() => { commit(moveTimelineRow(drafts, index, -1)) }}>
                    ↑
                  </button>
                  <button type="button" style={{ ...button, padding: '1px 6px' }}
                    title="下移一行" disabled={env.busy || index === drafts.length - 1}
                    onClick={() => { commit(moveTimelineRow(drafts, index, 1)) }}>
                    ↓
                  </button>
                  <button type="button" style={{ ...button, padding: '1px 6px' }}
                    title="删掉这一行" disabled={env.busy}
                    onClick={() => { commit(drafts.filter((_, at) => at !== index)) }}>
                    删
                  </button>
                </div>
              )
            })}
            {/* A datalist rather than a select: the id is still typed (several per
                cell are allowed), but the chapters that exist are one click away. */}
            <datalist id="novel-timeline-chapters">
              {chapters.map(chapter => (
                <option key={chapter.path} value={chapter.id}>
                  第 {String(chapter.number)} 章 {chapter.title}
                </option>
              ))}
            </datalist>
          </div>
        )}

      <div style={metaLine}>
        这张表就是「检查」读的那一份（引用不存在的章 → timeline-ref；某行的章比上一行更早 → timeline-order）。
        {timeline.rows.some(row => row.chapters.length > 1)
          ? ' 一格可以写多章，用、分开。'
          : ''}
        {timeline.found ? '' : ' 没有表格时，检查不会对时间线发表意见。'}
      </div>
    </div>
  )
}
