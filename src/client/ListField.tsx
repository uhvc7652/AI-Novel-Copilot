/**
 * A comma-separated list field that does not eat the commas.
 *
 * The old fields were plain text inputs whose value *was* the parsed list:
 *
 * ```tsx
 * value={listText(data, 'tags')}                       // ['a','b'] → "a, b"
 * onChange={event => patch({ tags: toList(event.target.value) })}
 * ```
 *
 * Type a comma and the round trip removes it — `"a,"` parses to `['a']`, which
 * renders back as `"a"` — so a list of two could never be typed (the author hit
 * exactly this: 「角色的标签里无法输入逗号」). The fix is to keep the **raw text**
 * while the field is being edited and to parse it only when the author leaves it.
 *
 * Blur is the commit point, and that is safe on purpose: `mousedown` on a button
 * blurs the input before its `click` handler runs, so pressing 保存 commits the
 * field being typed in before the write happens. Enter commits too, for the
 * keyboard path.
 *
 * The same bug lived in every comma-separated field in the panel — aliases,
 * tags, a chapter's 出场角色/地点 — which is why this is one component rather than
 * four fixes.
 *
 * @module dsh-ai-novel-copilot/client/ListField
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { splitListText } from '../novel/cards.ts'

/** Props for a list field. */
export interface ListFieldProps {
  /** The stored labels. */
  value: readonly string[]
  /** Store new labels. Called on blur and on Enter, not on every keystroke. */
  onChange(labels: string[]): void
  /** Placeholder text; say how the items are separated. */
  placeholder?: string
  /** Inline style, usually the panel's `input` plus a width. */
  style?: CSSProperties
  /** A `<datalist>` id offering the values that exist elsewhere. */
  list?: string
  /** Whether typing is disabled. */
  disabled?: boolean
  /** Tooltip. */
  title?: string
}

/** How labels are joined for display: the separator an author would type. */
const SEPARATOR = ', '

/**
 * A comma-separated list input.
 * @param props - the labels, the commit callback, and the input's presentation.
 */
export function ListField({ value, onChange, placeholder, style, list, disabled, title }: ListFieldProps) {
  const shown = value.join(SEPARATOR)
  const [draft, setDraft] = useState(shown)
  /** The text this component last committed, so its own echo does not reset the draft. */
  const committedRef = useRef(shown)

  // Re-derive only when the stored value changes from *outside* (another card was
  // opened, a rollback rewrote the file). While the author is typing, `value` is
  // whatever they last committed and the draft is ahead of it — deliberately.
  useEffect(() => {
    if (committedRef.current === shown) return
    committedRef.current = shown
    setDraft(shown)
  }, [shown])

  const commit = useCallback(() => {
    const next = splitListText(draft)
    committedRef.current = next.join(SEPARATOR)
    onChange(next)
  }, [draft, onChange])

  return (
    <input
      style={style}
      value={draft}
      placeholder={placeholder}
      disabled={disabled === true}
      {...(title === undefined ? {} : { title })}
      {...(list === undefined ? {} : { list })}
      onChange={event => { setDraft(event.target.value) }}
      onBlur={commit}
      onKeyDown={event => { if (event.key === 'Enter') commit() }}
    />
  )
}
