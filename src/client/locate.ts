/**
 * Putting the cursor on a quoted passage.
 *
 * Two surfaces need this — "定位到正文" from a model finding (M4) and from a
 * diff line in the modification record (M7) — and three editors have to serve it:
 * the prose buffer, a setting card's body, and an outline. The DOM half is four
 * lines; the part worth having in one place is the **offset arithmetic**, because
 * it is the part that quietly goes wrong.
 *
 * **The finder itself moved to `novel/quote.ts`** when M6 grew a rule about
 * foreshadowing sentences that can no longer be found: the host now asks the same
 * question, and two implementations of "the same sentence" would let the report
 * call a quote stale while the button beside it selects the line. It is
 * re-exported here so every existing importer keeps working, and so a reader of
 * this module still sees `findQuote` as part of the locating story.
 *
 * @module dsh-ai-novel-copilot/client/locate
 */
import { useEffect, useRef, type RefObject } from 'react'
import { findQuote, lineNumberOf, lineAt } from '../novel/quote.ts'

export { findQuote, lineAt } from '../novel/quote.ts'

/** A request to select a passage, identified by a token so the same quote can be asked for twice. */
export interface LocateRequest {
  /** The passage to find. */
  quote: string
  /** A fresh value per request; the editors act only on tokens they have not seen. */
  token: number
}

/** Where a quote was found in a body, or why it was not. */
export type { QuoteMatch } from '../novel/quote.ts'

/**
 * What the author is pointing at in an editor.
 *
 * Recording a foreshadowing from the middle of a chapter needs an answer to
 * "which sentence?" that the author did not have to think about. A selection is
 * that answer when there is one; failing that, the line the cursor is on is the
 * one they were last typing in, which is almost always what they meant. Never
 * the whole body: a quote that long would match nothing and locate nowhere.
 *
 * The element is described structurally rather than as a `HTMLTextAreaElement`
 * so the decision can be tested without a DOM.
 * @param element - the editor, or null when it is not mounted.
 * @param body - the text in that editor.
 * @returns the passage to record, or an empty string when there is nothing to point at.
 */
export function pointedText(
  element: { selectionStart: number, selectionEnd: number } | null,
  body: string,
): string {
  if (element === null) return ''
  if (element.selectionEnd > element.selectionStart) {
    return body.slice(element.selectionStart, element.selectionEnd).trim()
  }
  return lineAt(body, element.selectionStart)
}

/**
 * Select a quoted passage in a textarea, once the editor is on screen.
 *
 * The token guard lives here rather than in each view: it is what stops a
 * re-render from re-selecting a passage (and stealing focus) while the author is
 * reading the finding that pointed at it.
 * @param ref - the textarea to select in.
 * @param request - the passage to select, or undefined.
 * @param body - the text currently in that textarea.
 * @param onNote - reports the outcome on the panel's one status line.
 */
export function useQuoteLocate(
  ref: RefObject<HTMLTextAreaElement | null>,
  request: LocateRequest | undefined,
  body: string,
  onNote: (message: string) => void,
): void {
  const seen = useRef(0)
  useEffect(() => {
    if (request === undefined || seen.current === request.token) return
    seen.current = request.token
    const element = ref.current
    if (element === null) return
    const match = findQuote(body, request.quote)
    const shown = request.quote.trim().slice(0, 24)
    if (match.kind === 'missing') {
      onNote(`没能在正文里找到这句话（可能已被改写）：「${shown}${request.quote.trim().length > 24 ? '…' : ''}」`)
      return
    }
    element.focus()
    element.setSelectionRange(match.start, match.end)
    const line = lineNumberOf(body, match.start)
    const lines = Math.max(1, body.split('\n').length)
    element.scrollTop = Math.max(0, (line - 3) * (element.scrollHeight / lines))
    onNote(`已定位到正文第 ${String(line)} 行：「${shown}${request.quote.trim().length > 24 ? '…' : ''}」`)
  }, [body, onNote, ref, request])
}
