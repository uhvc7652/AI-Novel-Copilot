/**
 * The retrieval surface: ask a question about the book, get an answer with its
 * sources, and jump to the passage that produced it (M5).
 *
 * Two halves, and the order matters. The **answer** comes from
 * `src/novel/search.ts` running on the host — structural reverse lookup over
 * chapter frontmatter, the summary index, and keyword search with aliases
 * expanded — so it works with no model, no key, and no network. The **hits**
 * below it are the evidence: every one carries the snippet it matched, because a
 * ranking without its evidence is a claim the author cannot check.
 *
 * Nothing here writes, and nothing here is generated: what the author reads is
 * derived from the files on disk at the moment they asked.
 *
 * @module dsh-ai-novel-copilot/client/SearchView
 */
import { useCallback, useState } from 'react'
import type { ChapterSummary } from '../novel/project.ts'
import { REASON_LABELS, type SearchResult, type SearchSnippet } from '../novel/search.ts'
import * as api from './api.ts'
import { box, button, caption, controlRow, input, metaLine, row, type PanelEnv } from './ui.ts'

/** Props for the retrieval view. */
export interface SearchViewProps {
  /** Shared panel environment. */
  env: PanelEnv
  /** Every chapter, so an id in an answer can be shown as a chapter. */
  chapters: readonly ChapterSummary[]
  /** Open a chapter in the prose view. */
  onOpenChapter(path: string): void
  /** Switch to the settings view with this card open. */
  onOpenCard(path: string): void
}

/** The example questions, shown while the box is empty. */
const EXAMPLES = [
  '陈默上次出场在哪',
  '青铜镜第一次出现是哪章',
  '青石镇在哪一章解释过',
]

/** Split a snippet into plain and matched pieces, keeping the matches visible. */
function snippetPieces(snippet: SearchSnippet) {
  const pieces: { text: string, mark: boolean }[] = []
  let cursor = 0
  for (const [start, end] of snippet.ranges) {
    if (start > cursor) pieces.push({ text: snippet.text.slice(cursor, start), mark: false })
    pieces.push({ text: snippet.text.slice(start, end), mark: true })
    cursor = end
  }
  pieces.push({ text: snippet.text.slice(cursor), mark: false })
  return pieces
}

/**
 * The retrieval view.
 * @param props - environment, the project's chapters and cards, and the two jumps.
 */
export function SearchView({ env, chapters, onOpenChapter, onOpenCard }: SearchViewProps) {
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<SearchResult>()

  const byPath = new Map(chapters.map(chapter => [chapter.path, chapter]))

  const onSearch = useCallback(() => {
    const asked = query.trim()
    if (asked === '') return
    void env.run('检索', async () => {
      const found = await api.search(env.sessionId, env.root, asked)
      setResult(found)
      if (found.empty) return `「${asked}」里没有可检索的词`
      const total = found.counts.chapters + found.counts.cards + found.counts.pages
      if (total === 0) return `「${asked}」没有命中：扫了 ${String(found.scanned)} 个文件`
      return `命中 ${String(total)} 处（章节 ${String(found.counts.chapters)} / 设定卡 `
        + `${String(found.counts.cards)} / 文档 ${String(found.counts.pages)}）`
    })
  }, [env, query])

  /** Where a hit goes when clicked: a chapter, or the settings view. */
  const openHit = useCallback((kind: string, path: string) => {
    if (kind === 'chapter') onOpenChapter(path)
    else onOpenCard(path)
  }, [onOpenCard, onOpenChapter])

  const label = (path: string, fallback: string): string => {
    const chapter = byPath.get(path)
    if (chapter !== undefined) return `第 ${String(chapter.number)} 章`
    return fallback
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
      <div style={row}>
        <input
          style={{ ...input, flex: '1 1 180px' }}
          value={query}
          placeholder="问一句，或搜一个名字：陈默上次出场在哪 / 青铜镜第一次出现 / 某设定在哪解释过"
          onChange={event => { setQuery(event.target.value) }}
          onKeyDown={event => { if (event.key === 'Enter') onSearch() }}
        />
        <button type="button" style={button} disabled={env.busy || query.trim() === ''} onClick={onSearch}>
          检索
        </button>
        <button
          type="button"
          style={button}
          disabled={env.busy || result === undefined}
          onClick={() => { setResult(undefined) }}
        >
          清空
        </button>
      </div>

      {result === undefined
        ? (
          <div style={metaLine}>
            确定性检索：读章节 frontmatter 的出场登记、摘要、章纲与正文，不调模型、不建向量库。
            试试「{EXAMPLES[0]}」或「{EXAMPLES[1]}」。
          </div>
        )
        : (
          <>
            {result.entities.length > 0 && (
              <div style={{ ...row, fontSize: 11 }}>
                <span style={caption}>识别到：</span>
                {result.entities.map(entity => (
                  <button
                    key={entity.id}
                    type="button"
                    style={{ ...button, padding: '1px 6px' }}
                    title={`${entity.path}（${entity.via === 'alias' ? `别名「${entity.matched}」` : entity.matched}）`}
                    disabled={env.busy}
                    onClick={() => { onOpenCard(entity.path) }}
                  >
                    {entity.name}
                    <span style={caption}>{entity.aliases.length === 0 ? '' : ` · ${entity.aliases.join('/')}`}</span>
                  </button>
                ))}
              </div>
            )}

            {result.answer !== undefined && (
              <div style={box}>
                <div>{result.answer.text}</div>
                {result.answer.chapters.length > 0 && (
                  <div style={{ ...row, marginTop: 4 }}>
                    {result.answer.chapters.map(path => (
                      <button
                        key={path}
                        type="button"
                        style={{ ...button, padding: '1px 6px' }}
                        disabled={env.busy}
                        onClick={() => { onOpenChapter(path) }}
                      >
                        {label(path, path)}
                      </button>
                    ))}
                  </div>
                )}
                {result.answer.evidence.length > 0 && (
                  <details style={metaLine}>
                    <summary>依据（{String(result.answer.evidence.length)} 条）</summary>
                    {result.answer.evidence.map(line => <div key={line}>{line}</div>)}
                  </details>
                )}
              </div>
            )}

            <div style={{ ...box, maxHeight: 360 }}>
              {result.empty && (
                <div style={metaLine}>
                  这句话里没有可检索的词。换成一个人名、地名或物件名试试，比如「{EXAMPLES[2]}」。
                </div>
              )}
              {!result.empty && result.hits.length === 0 && (
                <div style={metaLine}>
                  没有命中。检索只看这些词：{result.terms.map(term => `「${term}」`).join('、')}
                  ——换一个说法，或者确认它确实已经写进工程。
                </div>
              )}
              {result.hits.map(hit => (
                <div key={hit.path} style={{ marginTop: 8, opacity: hit.archived ? 0.55 : 1 }}>
                  <div style={controlRow}>
                    <span>
                      <strong>{hit.label}</strong> {hit.title}
                      <span style={caption}>
                        {' · '}{hit.reasons.map(reason => REASON_LABELS[reason]).join('、')}
                        {hit.archived ? ' · 已存档' : ''}
                      </span>
                    </span>
                    <button
                      type="button"
                      style={{ ...button, padding: '1px 6px' }}
                      title={hit.path}
                      disabled={env.busy}
                      onClick={() => { openHit(hit.kind, hit.path) }}
                    >
                      {hit.kind === 'chapter' ? '跳到正文' : '打开'}
                    </button>
                  </div>
                  {hit.snippet !== undefined && (
                    <div style={{ fontSize: 11, lineHeight: 1.7, marginTop: 2, wordBreak: 'break-word' }}>
                      {snippetPieces(hit.snippet).map((piece, index) => (
                        piece.mark
                          ? (
                            <span
                              key={index}
                              style={{
                                background: 'color-mix(in srgb, currentColor 18%, transparent)',
                                borderRadius: 2,
                              }}
                            >
                              {piece.text}
                            </span>
                          )
                          : <span key={index}>{piece.text}</span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div style={metaLine}>
              扫描 {String(result.scanned)} 个文件 · 章节命中 {String(result.counts.chapters)} ·
              设定卡 {String(result.counts.cards)} · 文档 {String(result.counts.pages)}
              {result.hits.length < result.counts.chapters + result.counts.cards + result.counts.pages
                ? `（只列出前 ${String(result.hits.length)} 条）`
                : ''}
            </div>
          </>
        )}
    </div>
  )
}
