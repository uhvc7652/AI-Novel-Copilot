/**
 * 「参考章节」: the row that attaches other chapters to this one.
 *
 * It exists because the previous chapter is only the *default* guess at what a
 * chapter continues from. A chapter whose setup happened four chapters back, a
 * scene that pays off a thread planted in another volume, a chapter the author
 * rewrote and wants the new one to match — all of those are material the
 * generator has to read, and only the author knows which.
 *
 * It is a sibling of {@link ChapterCards} rather than part of it because the two
 * write different things: cards live in three frontmatter fields in the *card* id
 * space, chapters live in `contextChapters` in the *chapter* id space (format
 * §3.2). They do share one property, deliberately: the list never hides a chapter
 * that exists, and the count says how many the book has — a picker that quietly
 * drops entries is how "my new chapter is not in the list" became a bug report
 * three times over.
 *
 * A chip is rendered for **every** attached id, including one that resolves to an
 * archived chapter, to this chapter itself, or to nothing at all: the file says it
 * is attached, and a chip that vanished would hide the `context-ref` the author
 * has to fix. The tooltip says which of the four cases it is.
 *
 * @module dsh-ai-novel-copilot/client/ChapterContext
 */
import type { ChapterSummary, VolumeSummary } from '../novel/project.ts'
import { button, caption, controlRow, input, row, type PanelEnv } from './ui.ts'

/** Props for the 参考章节 row. */
export interface ChapterContextProps {
  /** Shared panel environment (the busy flag gates every control here). */
  env: PanelEnv
  /** The book's volumes, so the picker can group chapters the way the tree does. */
  volumes: readonly VolumeSummary[]
  /** The chapter being written: never offered, and never attached to itself. */
  openPath?: string
  /** The chapter ids the open chapter attaches. */
  attached: readonly string[]
  /** Attach one chapter by id. */
  onAttach(id: string): void
  /** Detach one chapter by id. */
  onDetach(id: string): void
}

/**
 * The chapters this chapter is written against, as chips, plus the picker.
 *
 * Archived chapters are out of the **picker**: an archived chapter is not story
 * material any more (format §4.6), so the tasks skip it, and offering it here
 * would be offering text the prompt will not carry.
 * @param props - environment, volumes, attachments, and the two handlers.
 */
export function ChapterContext({ env, volumes, openPath, attached, onAttach, onDetach }: ChapterContextProps) {
  const printed = (chapter: ChapterSummary): string => `第 ${String(chapter.number)} 章 ${chapter.title}`
  const everyChapter = volumes.flatMap(volume => volume.chapters)
  const byId = new Map(everyChapter.map(chapter => [chapter.id, chapter]))
  const options = volumes
    .map(volume => ({
      volume: volume.volume,
      ...(volume.title === undefined ? {} : { title: volume.title }),
      chapters: volume.chapters.filter(chapter => !chapter.archived && chapter.path !== openPath),
    }))
    .filter(group => group.chapters.length > 0)
  const total = options.reduce((sum, group) => sum + group.chapters.length, 0)
  return (
    <div style={controlRow}>
      <span style={caption}>
        参考章节
        {attached.length === 0
          ? '（上一章已经自动带上；想再带别的章就点右边）'
          : ` · ${String(attached.length)} 章`}
      </span>
      <span style={{ ...row, flexWrap: 'wrap' }}>
        {attached.map(id => {
          const chapter = byId.get(id)
          const why = chapter === undefined
            ? `${id}：工程里没有这一章（可能已被 tools/ 的脚本删掉），「检查」会报 context-ref`
            : chapter.archived
              ? `${printed(chapter)} 已存档：它不再是故事材料，生成时会跳过它`
              : chapter.path === openPath
                ? `${printed(chapter)} 就是本章：正文本来就会进 prompt，生成时会跳过这一条`
                : `${printed(chapter)} · ${chapter.path}\n生成任务会把它的全文交给模型`
          return (
            <button
              key={id}
              type="button"
              style={{ ...button, padding: '1px 6px', fontSize: 11 }}
              title={`${why}\n点一下从本章移除`}
              disabled={env.busy}
              onClick={() => { onDetach(id) }}
            >
              {chapter === undefined ? `${id}？` : chapter.title} ×
            </button>
          )
        })}
        <select
          style={input}
          value=""
          disabled={env.busy || total === 0}
          title="挑一章，把它的全文交给生成任务（已选的章在列表里标着「已引用」）"
          onChange={event => {
            if (event.target.value !== '') onAttach(event.target.value)
          }}
        >
          <option value="">＋ 加章节…</option>
          {options.map(group => (
            <optgroup
              key={group.volume}
              label={group.title === undefined || group.title.trim() === ''
                ? `第 ${String(group.volume)} 卷`
                : `第 ${String(group.volume)} 卷 · ${group.title}`}
            >
              {group.chapters.map(chapter => {
                const isAttached = attached.includes(chapter.id)
                return (
                  <option key={chapter.path} value={chapter.id} disabled={isAttached}>
                    {printed(chapter)}{isAttached ? '（已引用）' : ''}
                  </option>
                )
              })}
            </optgroup>
          ))}
        </select>
        <span style={caption}>
          {total === 0 ? '这本书还没有别的章' : `可选的章 ${String(total)} 章`}
        </span>
        {attached.length === 0 ? null : (
          <span style={caption}>生成时会带上它们的全文（{String(attached.length)} 章）</span>
        )}
      </span>
    </div>
  )
}
