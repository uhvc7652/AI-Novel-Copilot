/**
 * 「本章引用的卡」: the one row that attaches setting cards to a chapter.
 *
 * It lives in its own component for two reasons.
 *
 * First, it is the surface the author uses to say "this chapter is written
 * against these cards", and the writing tasks ("按章纲写整章" 续写 / 改写 / 扩写 /
 * 润色) all read exactly the three frontmatter fields it writes — so it deserves
 * to be renderable and checkable on its own rather than buried in `Panel`.
 *
 * Second, **the list must never look like a card is missing.** It used to hide
 * cards that were already attached, which reads as "my new card did not show up"
 * the moment you go back to check — the author hit exactly that. Now every live
 * card is listed; the ones already attached are marked 「已引用」 and disabled. A
 * card that is genuinely absent from this list is absent from the library, and
 * the count and the 刷新 button beside it say so.
 *
 * @module dsh-ai-novel-copilot/client/ChapterCards
 */
import type { CardGroup, CardSummary } from '../novel/project.ts'
import type { ChapterRefField } from '../novel/cards.ts'
import { button, caption, controlRow, input, metaLine, row, type PanelEnv } from './ui.ts'

/** One card attached to the chapter, with the field it lives in. */
export interface AttachedCard {
  /** Card id. */
  id: string
  /** Which frontmatter field holds it. */
  field: ChapterRefField
  /** The card, when the library knows it. */
  card?: CardSummary
}

/** Props for the card row. */
export interface ChapterCardsProps {
  /** Shared panel environment (the busy flag gates every control here). */
  env: PanelEnv
  /** The settings library, grouped by type; undefined before the first read. */
  groups?: readonly CardGroup[]
  /** The cards this chapter already references. */
  attached: readonly AttachedCard[]
  /** Add one card to the chapter. */
  onAttach(id: string): void
  /** Remove one card from the chapter. */
  onDetach(id: string, field: ChapterRefField): void
  /** Re-read the library. */
  onRefresh(): void
  /** Why the library is not there (a failed read), when that happened. */
  note?: string
}

/**
 * The cards this chapter is written against, as chips, plus the picker.
 * @param props - environment, library, attachments, and the three handlers.
 */
export function ChapterCards({ env, groups, attached, onAttach, onDetach, onRefresh, note }: ChapterCardsProps) {
  const groupList = groups ?? []
  const total = groupList.reduce((sum, group) => sum + group.cards.filter(card => !card.archived).length, 0)
  const live = groupList.map(group => ({ ...group, cards: group.cards.filter(card => !card.archived) }))
    .filter(group => group.cards.length > 0)
  return (
    <div style={controlRow}>
      <span style={caption}>
        本章引用的卡
        {attached.length === 0 ? '（点右边挑一张，生成时会作为参考）' : ` · ${String(attached.length)} 张`}
      </span>
      <span style={{ ...row, flexWrap: 'wrap' }}>
        {attached.map(chip => (
          <button
            key={`${chip.field}:${chip.id}`}
            type="button"
            style={{ ...button, padding: '1px 6px', fontSize: 11 }}
            title={chip.card === undefined
              ? `${chip.id}：设定库里没有这张卡，「检查」会报 missing-ref\n点一下从本章移除`
              : `${chip.card.type} · ${chip.card.path}\n生成任务会带上它；点一下从本章移除`}
            disabled={env.busy}
            onClick={() => { onDetach(chip.id, chip.field) }}
          >
            {chip.card === undefined ? `${chip.id}？` : chip.card.name} ×
          </button>
        ))}
        <select
          style={input}
          value=""
          disabled={env.busy || groups === undefined}
          title="从设定库里挑一张卡，加进本章的引用（已引用的卡在列表里标着「已引用」）"
          onChange={event => {
            if (event.target.value !== '') onAttach(event.target.value)
          }}
        >
          <option value="">＋ 加卡…</option>
          {live.map(group => (
            <optgroup key={group.type} label={group.label}>
              {group.cards.map(card => {
                const isAttached = attached.some(chip => chip.id === card.id)
                return (
                  <option key={card.id} value={card.id} disabled={isAttached}>
                    {card.name}{isAttached ? '（已引用）' : ''}
                  </option>
                )
              })}
            </optgroup>
          ))}
        </select>
        <button
          type="button"
          style={{ ...button, padding: '1px 6px', fontSize: 11 }}
          title="重新读一遍设定库（在设定页新建了卡之后，这里也应该自己刷新）"
          disabled={env.busy}
          onClick={onRefresh}
        >
          刷新
        </button>
        <span style={caption}>
          {groups === undefined ? '设定库还没读出来' : `设定库 ${String(total)} 张`}
        </span>
        {/* 没有上限：这一行里的每一张都会进 prompt（`cardBlocks`）。 */}
        {attached.length === 0 ? null : (
          <span style={caption}>生成时会全部带上（{String(attached.length)} 张）</span>
        )}
      </span>
      {note === undefined ? null : <span style={metaLine}>{note}</span>}
    </div>
  )
}
