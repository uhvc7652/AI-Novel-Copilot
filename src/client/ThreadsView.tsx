/**
 * The foreshadowing surface: every thread's life on one page, with a way back to
 * both ends of it.
 *
 * The format already had the fields for this (`03` §4.4: `plantedIn`,
 * `reinforcedIn`, `plannedPayoff`, `payoffIn`, `status`), and M6 already had the
 * rules that catch a thread whose status and record disagree — but the panel
 * exposed **none** of them. Recording a foreshadowing meant hand-editing YAML in
 * a card you had to find first, and there was no way to get from the record back
 * to the sentence that planted it. This view is that missing half.
 *
 * It writes two things and reads everything:
 *
 * - **放弃 / 恢复** — a lifecycle change with no location attached, so it belongs
 *   here. Collecting a thread does *not* belong here: it happens where the payoff
 *   is written, in the prose editor, because that is the only place the sentence
 *   can be picked up. See `Panel`'s 「在这里回收」.
 * - Nothing else. The card's body — 埋点方式 / 读者应有的疑问 / 回收设计 — is the
 *   author's prose, and the panel does not write into it.
 *
 * @module dsh-ai-novel-copilot/client/ThreadsView
 */
import { useCallback, useMemo, useState } from 'react'
import type { CardSummary, ChapterSummary } from '../novel/project.ts'
import * as api from './api.ts'
import { box, button, caption, controlRow, listRow, metaLine, row, THREAD_STATUS_LABEL, type PanelEnv } from './ui.ts'

/** Props for the foreshadowing view. */
export interface ThreadsViewProps {
  /** Shared panel environment. */
  env: PanelEnv
  /**
   * Every thread card in the project — **live ones only**.
   *
   * A deleted (archived) thread is not listed here: deleting is how the author
   * says "this line is not part of the book any more", and a list that keeps
   * showing it is a list they stop trusting. The count of what was left out
   * arrives as {@link ThreadsViewProps.archived} so the surface can say so.
   */
  threads: readonly CardSummary[]
  /** How many thread cards are archived (deleted), for the one line that says where they went. */
  archived?: number
  /** Every chapter, so an id can be shown as 「第 N 章」 and jumped to. */
  chapters: readonly ChapterSummary[]
  /** Open a chapter, optionally putting the cursor on a quoted sentence. */
  onJump(path: string, quote?: string): void
  /** Open a card in the settings surface. */
  onOpenCard(path: string): void
  /** Re-read the library after a lifecycle change. */
  onReload(): Promise<void>
  /** Whether a chapter is open, which is what a collection would be recorded against. */
  openChapter?: string
}

/** The lifecycle states that mean "this thread is still open". */
const OPEN_STATUS = ['', 'planted', 'reinforced']

/** One section of the list: what the author is meant to do about these. */
interface Group {
  key: string
  title: string
  hint: string
  threads: CardSummary[]
}

/**
 * Split the threads into the three things an author actually asks.
 * @param threads - every thread card.
 * @returns the groups, in the order they matter.
 */
function groupThreads(threads: readonly CardSummary[]): Group[] {
  const open: CardSummary[] = []
  const paid: CardSummary[] = []
  const dropped: CardSummary[] = []
  for (const thread of threads) {
    const status = thread.thread?.status ?? ''
    if (status === 'paid') paid.push(thread)
    else if (status === 'abandoned') dropped.push(thread)
    else open.push(thread)
  }
  const byName = (left: CardSummary, right: CardSummary): number => left.name.localeCompare(right.name, 'zh-Hans-CN')
  return [
    { key: 'open', title: '未回收', hint: '埋下了还没收的线。这是这个页面存在的理由。', threads: open.sort(byName) },
    { key: 'paid', title: '已回收', hint: '已经收口的线，留着备查。', threads: paid.sort(byName) },
    { key: 'dropped', title: '已废弃', hint: '决定不要的线：它的名字不再占用，也可以随时恢复。', threads: dropped.sort(byName) },
  ].filter(group => group.threads.length > 0)
}

/**
 * The foreshadowing view.
 * @param props - environment, the threads, the chapters, and the three callbacks.
 */
export function ThreadsView({ env, threads, archived, chapters, onJump, onOpenCard, onReload, openChapter }: ThreadsViewProps) {
  /** Which group the author folded away; the open ones start unfolded. */
  const [folded, setFolded] = useState<readonly string[]>(['paid', 'dropped'])

  /** Chapter id → the chapter, so an id can become a label and a jump target. */
  const byId = useMemo(() => new Map(chapters.map(chapter => [chapter.id, chapter])), [chapters])

  const groups = useMemo(() => groupThreads(threads), [threads])
  const openCount = groups.find(group => group.key === 'open')?.threads.length ?? 0

  /**
   * Rewrite one thread card's lifecycle fields.
   *
   * Read-modify-write on purpose: `writeDocument` replaces the whole file, and
   * the card's body (the author's 埋点方式 / 回收设计 prose) must survive a status
   * change. A stale read is not a risk worth guarding against here — the panel is
   * the only writer, and the library it just showed came from the same file.
   */
  const setStatus = useCallback((card: CardSummary, status: string, nextPayoff?: string[]) => {
    void env.run(status === 'abandoned' ? `放弃「${card.name}」` : `恢复「${card.name}」`, async () => {
      const loaded = await api.readDocument(env.sessionId, env.root, card.path)
      const data: Record<string, unknown> = { ...loaded.data, status }
      if (nextPayoff !== undefined) data.payoffIn = nextPayoff
      // Clearing a stale quote is part of restoring a thread: a `payoffQuote`
      // left behind by a collection that is being undone would send 「跳到回收」
      // looking for a sentence on a page that no longer claims it.
      if (status !== 'paid') delete data.payoffQuote
      await api.writeDocument(env.sessionId, env.root, card.path, data, loaded.body)
      await onReload()
      return status === 'abandoned'
        ? `「${card.name}」已标为废弃：它不再算未回收，伏笔卡本身留着`
        : `「${card.name}」已恢复为未回收`
    })
  }, [env, onReload])

  const label = useCallback((id: string | undefined): string => {
    if (id === undefined || id === '') return ''
    const chapter = byId.get(id)
    if (chapter === undefined) return `${id}（工程里没有这一章）`
    return `第 ${String(chapter.number)} 章${chapter.title === '' ? '' : ` · ${chapter.title}`}`
  }, [byId])

  if (threads.length === 0) {
    return (
      <div style={metaLine}>
        还没有伏笔。在正文页把光标放到埋点那一句上，点「记为伏笔」——之后这里会列出它、
        埋在哪一句、收了没有，以及怎么跳回去。
        {(archived ?? 0) > 0 && `（另有 ${String(archived)} 条已删除的伏笔：在「设定」页勾「显示已存档」能看到并恢复。）`}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={controlRow}>
        <span style={caption}>
          共 {String(threads.length)} 条 · 未回收 <strong>{String(openCount)}</strong> 条
          {(archived ?? 0) === 0 ? '' : ` · 已删除 ${String(archived)} 条`}
          {openChapter === undefined ? '' : ` · 当前章可以回收`}
        </span>
        <button type="button" style={button} disabled={env.busy} onClick={() => { void onReload() }}>刷新</button>
      </div>
      {(archived ?? 0) > 0 && (
        <div style={metaLine}>
          已删除（存档）的伏笔不在这里，也不参与一致性检查；在「设定」页勾「显示已存档」能看到它并恢复，
          恢复之后它会重新出现在这一页。
        </div>
      )}

      {groups.map(group => (
        <div key={group.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <button
            type="button"
            style={{ ...listRow, fontWeight: 600 }}
            onClick={() => { setFolded(current => current.includes(group.key) ? current.filter(key => key !== group.key) : [...current, group.key]) }}
          >
            <span>{folded.includes(group.key) ? '▸' : '▾'} {group.title} · {String(group.threads.length)}</span>
            <span style={caption}>{group.hint}</span>
          </button>

          {!folded.includes(group.key) && (
            <div style={box}>
              {group.threads.map(thread => {
                const record = thread.thread
                const planted = record?.plantedIn
                const payoff = record?.payoffIn[0]
                const plantedChapter = planted === undefined ? undefined : byId.get(planted)
                const payoffChapter = payoff === undefined ? undefined : byId.get(payoff)
                return (
                  <div key={thread.path} style={{ padding: '4px 2px', borderTop: '1px solid color-mix(in srgb, currentColor 12%, transparent)' }}>
                    <div style={{ ...row, justifyContent: 'space-between' }}>
                      <span>
                        {thread.name}
                        <span style={caption}> · {record?.status === '' || record?.status === undefined ? '状态未填' : THREAD_STATUS_LABEL[record.status] ?? record.status}</span>
                      </span>
                      <span style={row}>
                        <button type="button" style={{ ...button, padding: '1px 6px' }} disabled={env.busy}
                          onClick={() => { onOpenCard(thread.path) }}>
                          打开卡片
                        </button>
                        {group.key === 'open'
                          ? (
                            <button type="button" style={{ ...button, padding: '1px 6px' }} disabled={env.busy}
                              title="这条线不要了。它不再算未回收，但记录留着"
                              onClick={() => { setStatus(thread, 'abandoned') }}>
                              放弃
                            </button>
                          )
                          : (
                            <button type="button" style={{ ...button, padding: '1px 6px' }} disabled={env.busy}
                              title="放回未回收。已记录的回收章节会一并清掉"
                              onClick={() => { setStatus(thread, 'planted', []) }}>
                              恢复
                            </button>
                          )}
                      </span>
                    </div>

                    <div style={{ ...row, fontSize: 11, gap: 6 }}>
                      <span style={caption}>埋点</span>
                      {plantedChapter === undefined
                        ? <span style={caption}>{planted === undefined ? '未记在哪一章' : label(planted)}</span>
                        : (
                          <button type="button" style={{ ...button, padding: '0 6px' }}
                            title={record?.plantedQuote === undefined ? '打开这一章' : '打开这一章并选中埋点那句'}
                            disabled={env.busy}
                            onClick={() => { onJump(plantedChapter.path, record?.plantedQuote) }}>
                            ↖ {label(planted)}
                          </button>
                        )}
                      {record?.plantedQuote === undefined
                        ? <span style={caption}>（没记原句）</span>
                        : <span style={{ ...caption, fontStyle: 'italic' }}>「{record.plantedQuote}」</span>}
                    </div>

                    <div style={{ ...row, fontSize: 11, gap: 6 }}>
                      <span style={caption}>回收</span>
                      {payoffChapter === undefined
                        ? (
                          <span style={caption}>
                            {group.key === 'paid'
                              ? '状态写着已回收，但没有可用章节'
                              : record?.plannedPayoff === undefined ? '还没收' : `还没收 · 计划 ${record.plannedPayoff}`}
                          </span>
                        )
                        : (
                          <button type="button" style={{ ...button, padding: '0 6px' }}
                            title={record?.payoffQuote === undefined ? '打开这一章' : '打开这一章并选中回收那句'}
                            disabled={env.busy}
                            onClick={() => { onJump(payoffChapter.path, record?.payoffQuote) }}>
                            ↘ {label(payoff)}
                          </button>
                        )}
                      {payoffChapter !== undefined && record?.payoffQuote === undefined && <span style={caption}>（没记原句）</span>}
                      {payoffChapter !== undefined && record?.payoffQuote !== undefined
                        && <span style={{ ...caption, fontStyle: 'italic' }}>「{record.payoffQuote}」</span>}
                      {payoffChapter === undefined && group.key !== 'paid' && record?.plannedPayoff !== undefined && <span style={caption}>· {record.plannedPayoff}</span>}
                      {plantedChapter !== undefined && group.key !== 'open' && (record?.payoffIn.length ?? 0) > 1
                        && <span style={caption}>· 另有 {String((record?.payoffIn.length ?? 1) - 1)} 章</span>}
                    </div>

                    {record?.reinforcedIn !== undefined && record.reinforcedIn.length > 0 && (
                      <div style={{ ...row, fontSize: 11, gap: 6 }}>
                        <span style={caption}>强化</span>
                        <span style={caption}>{record.reinforcedIn.map(id => label(id)).join('、')}</span>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      ))}

      <div style={metaLine}>
        回收在正文页做：把光标放到回收那句上，点「在这里回收」，面板会把章节与原句一起记进这条伏笔
        （`status` 与 `payoffIn` 一起写，所以检查页那条「状态与记录不一致」不会因为这里出错）。
      </div>
    </div>
  )
}
