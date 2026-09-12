/**
 * Word counting, shared by the host and the browser panel.
 *
 * This module deliberately imports nothing: both halves count with the same
 * rule, and the browser bundle must not inherit the host's YAML dependency by
 * importing a counting helper.
 *
 * @module dsh-ai-novel-copilot/novel/words
 */

/** CJK ideographs, counted one per character — the convention Chinese prose is measured by. */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g

/** Latin and numeric runs, counted one per word. */
const LATIN_WORD = /[A-Za-z0-9]+/g

/**
 * Count a body the way a Chinese web-novel author counts it: one per CJK
 * character plus one per Latin or numeric word. Punctuation, whitespace, and
 * Markdown syntax contribute nothing.
 * @param text - prose to measure.
 * @returns the word count.
 */
export function countWords(text: string): number {
  return (text.match(CJK)?.length ?? 0) + (text.match(LATIN_WORD)?.length ?? 0)
}
