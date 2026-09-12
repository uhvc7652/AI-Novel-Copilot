/**
 * Putting the cursor on a quoted passage.
 *
 * Two surfaces need this — "定位到正文" from a model finding (M4) and from a
 * diff line in the modification record (M7) — and three editors have to serve it:
 * the prose buffer, a setting card's body, and an outline. The DOM half is four
 * lines; the part worth having in one place is the **offset arithmetic**, because
 * it is the part that quietly goes wrong.
 *
 * A model that quotes from memory drops a punctuation mark or a line break, so an
 * exact match falls back to a whitespace-insensitive one — and translating the
 * offset found in the flattened text back into the real one means walking the
 * original character by character, counting only what the flattening kept. Get
 * that wrong and the panel selects the wrong sentence, which reads as "the model
 * quoted something that isn't there".
 *
 * @module dsh-ai-novel-copilot/client/locate
 */
import { useEffect, useRef, type RefObject } from 'react'

/** A request to select a passage, identified by a token so the same quote can be asked for twice. */
export interface LocateRequest {
  /** The passage to find. */
  quote: string
  /** A fresh value per request; the editors act only on tokens they have not seen. */
  token: number
}

/** Where a quote was found in a body, or why it was not. */
export type QuoteMatch =
  | { kind: 'found', start: number, end: number, exact: boolean }
  | { kind: 'missing' }

/**
 * Characters the loose fallback pretends are not there.
 *
 * Whitespace alone is not enough, and the original M4 code said so in its own
 * comment ("a model that quotes from memory drops a punctuation mark or a line
 * break") while only stripping whitespace. A quote of 「陈默握紧了那半块青铜镜
 * 指节发白」 against a body that has a comma between those clauses found
 * *nothing*, which is the failure this fallback exists to prevent.
 */
const LOOSE_IGNORED = /[\s\p{P}]/u

/** Strip everything the loose fallback ignores. */
function flatten(text: string): string {
  return text.replace(/[\s\p{P}]/gu, '')
}

/**
 * The index in `text` of its `n`-th kept character, counting from zero.
 * @param text - the text to walk.
 * @param n - which kept character to locate.
 * @returns that character's index, or `text.length` when there is no such character.
 */
function keptAt(text: string, n: number): number {
  let seen = 0
  for (let cursor = 0; cursor < text.length; cursor += 1) {
    if (LOOSE_IGNORED.test(text.charAt(cursor))) continue
    if (seen === n) return cursor
    seen += 1
  }
  return text.length
}

/**
 * Find a quoted passage in a body, tolerating whitespace and punctuation differences.
 * @param body - the text to search.
 * @param quote - the passage to find.
 * @returns the character range, whether the match was exact, or `missing`.
 */
export function findQuote(body: string, quote: string): QuoteMatch {
  const needle = quote.trim()
  if (needle === '') return { kind: 'missing' }
  const exact = body.indexOf(needle)
  if (exact >= 0) return { kind: 'found', start: exact, end: exact + needle.length, exact: true }

  const flat = flatten(body)
  const flatNeedle = flatten(needle)
  if (flatNeedle === '') return { kind: 'missing' }
  const at = flat.indexOf(flatNeedle)
  if (at < 0) return { kind: 'missing' }
  // Both ends are located by walking the original text, never by adding the
  // quote's length to the start: the quote and the passage it matches differ in
  // exactly the characters that were ignored, so their lengths differ too, and
  // adding would leave the selection short of the sentence it should highlight.
  return {
    kind: 'found',
    start: keptAt(body, at),
    end: Math.min(body.length, keptAt(body, at + flatNeedle.length - 1) + 1),
    exact: false,
  }
}

/**
 * The line of `body` containing `index`, trimmed.
 * @param body - the text.
 * @param index - a character offset into it.
 * @returns that line, without surrounding whitespace.
 */
export function lineAt(body: string, index: number): string {
  const at = Math.max(0, Math.min(index, body.length))
  const start = body.lastIndexOf('\n', Math.max(0, at - 1)) + 1
  const end = body.indexOf('\n', at)
  return body.slice(start, end < 0 ? body.length : end).trim()
}

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
    const line = body.slice(0, match.start).split('\n').length
    const lines = Math.max(1, body.split('\n').length)
    element.scrollTop = Math.max(0, (line - 3) * (element.scrollHeight / lines))
    onNote(`已定位到正文第 ${String(line)} 行：「${shown}${request.quote.trim().length > 24 ? '…' : ''}」`)
  }, [body, onNote, ref, request])
}
