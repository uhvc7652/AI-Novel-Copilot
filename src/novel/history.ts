/**
 * The modification record: what changed, who changed it, and how to go back.
 *
 * The requirement's boundary is what shapes this module: **git is file-level
 * history** (one commit per save), so M7 is the *line-level* history the panel
 * itself can show and undo. That means two things have to exist and both are
 * here rather than in the UI:
 *
 * 1. **A line diff.** An author does not want to re-read a whole chapter to find
 *    what a "润色本章" run actually did. The diff is computed on the host so the
 *    interesting part (what counts as a change, how a rewrite is presented) is
 *    testable without a browser.
 * 2. **A version identity that survives a rewrite.** Every entry is a *state*
 *    (`after`), not only a delta, which is what makes rollback always safe: see
 *    the note on {@link rolledBack} below.
 *
 * ## Rolling back restores a version's `after`, never its `before`
 *
 * The obvious reading of "roll back to this entry" is "write its `before`", and
 * it is wrong in exactly one place: the entry for a **新建** has no meaningful
 * before (the file did not exist), so writing it back would produce an empty
 * file with no frontmatter — a corrupt document, and an unrecoverable one. Each
 * entry's `after` is a complete, valid document in every case, so that is what a
 * rollback writes. The `before` is kept for the diff.
 *
 * @module dsh-ai-novel-copilot/novel/history
 */

/** What produced one version. */
export type HistorySource =
  | { kind: 'manual' }
  | { kind: 'task', label: string }
  | { kind: 'revert', from: string }

/** What a version was, in the panel's words. */
export type HistoryAction = 'create' | 'update' | 'archive' | 'restore' | 'revert'

/** One stored version of one document. */
export interface HistoryEntry {
  /** ISO timestamp, also the file's name. */
  at: string
  /** Storage-relative path of the document this version belongs to. */
  path: string
  /** What happened. */
  action: HistoryAction
  /** What produced it. */
  source: HistorySource
  /** The whole file before the change; empty for a create. */
  before: string
  /** The whole file after the change. */
  after: string
}

/**
 * One version as the history list shows it, without either full text.
 *
 * Sizes are **bytes**, matching what the panel already reports after a save
 * ("9102 → 9210 字节"). A word count would be the more useful number and is not
 * here on purpose: computing it means parsing both texts of every listed
 * version, which is exactly the cost the list exists to avoid.
 */
export interface HistorySummary {
  at: string
  action: HistoryAction
  source: HistorySource
  /** Byte length before the change; 0 for a create. */
  beforeBytes: number
  /** Byte length after the change. */
  afterBytes: number
}

/** One line of a line-level diff. */
export interface DiffLine {
  /** `same` for context, `add` for a line only in the newer version. */
  kind: 'same' | 'add' | 'remove'
  /** The line's text, without its line ending. */
  text: string
  /**
   * 1-based line number **in the version this line belongs to**: `before` for
   * `same` and `remove`, `after` for `add`. A `same` line is in both, and the
   * number given is the one in `before`; the panel jumps by text, not by index,
   * because what it scrolls to is the current buffer.
   */
  line: number
}

/** How big a middle a diff will resolve exactly before falling back. */
const MAX_DIFF_CELLS = 4_000_000

/**
 * Split text into lines, keeping a trailing newline visible as a final empty
 * line so that adding or removing one is a change like any other.
 * @param text - the text to split.
 * @returns the lines, without line endings.
 */
export function splitLines(text: string): string[] {
  return text.split(/\r?\n/)
}

/**
 * The exact line diff of a middle section, or a coarse fallback when it is huge.
 * @param before - lines only in the older version.
 * @param after - lines only in the newer version.
 * @returns one op per line, in reading order.
 */
function diffMiddle(before: readonly string[], after: readonly string[]): { kind: 'same' | 'add' | 'remove', text: string }[] {
  const rows = before.length + 1
  const columns = after.length + 1
  if (rows * columns > MAX_DIFF_CELLS) {
    // A wholesale rewrite of an enormous document: the exact alignment is not
    // worth the memory, and "everything removed, then everything added" is the
    // honest description of what happened. The cap is deliberately high enough
    // that an ordinary chapter rewrite never reaches it (see the checks).
    return [
      ...before.map(text => ({ kind: 'remove' as const, text })),
      ...after.map(text => ({ kind: 'add' as const, text })),
    ]
  }
  // Length of the longest common subsequence of the two suffixes, so the walk
  // below can be a plain greedy descent.
  const table = new Uint32Array(rows * columns)
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i * columns + j] = before[i] === after[j]
        ? table[(i + 1) * columns + (j + 1)] + 1
        : Math.max(table[(i + 1) * columns + j], table[i * columns + (j + 1)])
    }
  }
  const ops: { kind: 'same' | 'add' | 'remove', text: string }[] = []
  let i = 0
  let j = 0
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      ops.push({ kind: 'same', text: before[i] })
      i += 1
      j += 1
    } else if (table[(i + 1) * columns + j] >= table[i * columns + (j + 1)]) {
      ops.push({ kind: 'remove', text: before[i] })
      i += 1
    } else {
      ops.push({ kind: 'add', text: after[j] })
      j += 1
    }
  }
  while (i < before.length) { ops.push({ kind: 'remove', text: before[i] }); i += 1 }
  while (j < after.length) { ops.push({ kind: 'add', text: after[j] }); j += 1 }
  return ops
}

/**
 * The line-level diff between two versions of a document.
 *
 * The common prefix and suffix are stripped first and re-attached untouched.
 * That is not only an optimisation: it keeps the reported line numbers of
 * unchanged lines honest, and it means the expensive part runs over the lines
 * that actually differ rather than over a whole chapter.
 * @param before - the older text; empty for a create.
 * @param after - the newer text.
 * @returns the diff, in reading order, with unchanged lines included as context.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  if (before === after) {
    return splitLines(after).map((text, index) => ({ kind: 'same' as const, text, line: index + 1 }))
  }
  const linesBefore = splitLines(before)
  const linesAfter = splitLines(after)
  // A create has no older text at all, and its phantom first empty line would
  // otherwise show up as a removed blank line in every history entry.
  if (before === '') {
    return linesAfter.map((text, index) => ({ kind: 'add' as const, text, line: index + 1 }))
  }

  let head = 0
  while (head < linesBefore.length && head < linesAfter.length && linesBefore[head] === linesAfter[head]) head += 1
  let tail = 0
  while (
    tail < linesBefore.length - head
    && tail < linesAfter.length - head
    && linesBefore[linesBefore.length - 1 - tail] === linesAfter[linesAfter.length - 1 - tail]
  ) tail += 1

  const out: DiffLine[] = []
  for (let index = 0; index < head; index += 1) {
    out.push({ kind: 'same', text: linesBefore[index] ?? '', line: index + 1 })
  }
  const middle = diffMiddle(
    linesBefore.slice(head, linesBefore.length - tail),
    linesAfter.slice(head, linesAfter.length - tail),
  )
  let beforeAt = head
  let afterAt = head
  for (const op of middle) {
    if (op.kind === 'remove') {
      out.push({ kind: 'remove', text: op.text, line: beforeAt + 1 })
      beforeAt += 1
    } else if (op.kind === 'add') {
      out.push({ kind: 'add', text: op.text, line: afterAt + 1 })
      afterAt += 1
    } else {
      out.push({ kind: 'same', text: op.text, line: beforeAt + 1 })
      beforeAt += 1
      afterAt += 1
    }
  }
  for (let index = 0; index < tail; index += 1) {
    out.push({ kind: 'same', text: linesBefore[linesBefore.length - tail + index] ?? '', line: linesBefore.length - tail + index + 1 })
  }
  return out
}

/**
 * Count the added and removed lines in a diff.
 * @param diff - the diff to count.
 * @returns how many lines were added and removed.
 */
export function diffCounts(diff: readonly DiffLine[]): { added: number, removed: number } {
  let added = 0
  let removed = 0
  for (const line of diff) {
    if (line.kind === 'add') added += 1
    else if (line.kind === 'remove') removed += 1
  }
  return { added, removed }
}

/** Unchanged lines kept on either side of a change before collapsing. */
export const DIFF_CONTEXT = 3

/** One row of a rendered diff: a line, or a collapsed run of unchanged ones. */
export type DiffRow = { kind: 'line', line: DiffLine } | { kind: 'gap', count: number }

/**
 * Collapse long runs of unchanged lines around the changes.
 *
 * A chapter's diff is mostly context, and a screenful of uninteresting lines is
 * how a change becomes invisible. Runs no longer than twice {@link DIFF_CONTEXT}
 * plus a marker are left alone: replacing three lines with a marker that says
 * "3 lines" would take as much room as it saves.
 *
 * This lives beside {@link diffLines} rather than in the view because "which
 * lines does the author actually see" is a decision with edges — a run at the
 * very start, a run at the very end, a run that is exactly the threshold — and
 * those are cheaper to pin down here than through a browser.
 * @param diff - the full diff.
 * @param expanded - when true, nothing is collapsed.
 * @returns the rows to render.
 */
export function diffRows(diff: readonly DiffLine[], expanded = false): DiffRow[] {
  if (expanded) return diff.map(line => ({ kind: 'line' as const, line }))
  const rows: DiffRow[] = []
  let index = 0
  while (index < diff.length) {
    if (diff[index].kind !== 'same') {
      rows.push({ kind: 'line', line: diff[index] })
      index += 1
      continue
    }
    let end = index
    while (end < diff.length && diff[end].kind === 'same') end += 1
    const run = end - index
    if (run <= DIFF_CONTEXT * 2 + 1) {
      for (let at = index; at < end; at += 1) rows.push({ kind: 'line', line: diff[at] })
    } else {
      for (let at = index; at < index + DIFF_CONTEXT; at += 1) rows.push({ kind: 'line', line: diff[at] })
      rows.push({ kind: 'gap', count: run - DIFF_CONTEXT * 2 })
      for (let at = end - DIFF_CONTEXT; at < end; at += 1) rows.push({ kind: 'line', line: diff[at] })
    }
    index = end
  }
  return rows
}

/**
 * Read one stored entry, tolerantly.
 *
 * The same posture as the ignore list (`03` §4.7) applies here: a history entry
 * is a convenience for the author, and one unreadable file must not take the
 * panel down with it. Anything that does not look like an entry is dropped, and
 * a missing `before`/`after` is treated as empty text rather than a crash — but
 * an entry that cannot say *when* it happened is not an entry at all.
 * @param raw - the parsed JSON, of unknown shape.
 * @param path - the document the entry is supposed to belong to.
 * @returns the entry, or undefined when the value is unusable.
 */
export function parseHistoryEntry(raw: unknown, path: string): HistoryEntry | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const at = typeof record.at === 'string' && record.at !== '' ? record.at : undefined
  if (at === undefined) return undefined
  const action: HistoryAction = record.action === 'create' || record.action === 'archive'
    || record.action === 'restore' || record.action === 'revert'
    ? record.action
    : 'update'
  return {
    at,
    path,
    action,
    source: parseSource(record.source),
    before: typeof record.before === 'string' ? record.before : '',
    after: typeof record.after === 'string' ? record.after : '',
  }
}

/**
 * Read a stored `source` field, falling back to "manual" rather than to nothing.
 *
 * A version whose provenance is unknown is still a version; the panel shows
 * 「手动」 for it, which is the one thing we can say for certain about a change
 * nobody recorded a task for.
 * @param raw - the stored value.
 * @returns the source.
 */
function parseSource(raw: unknown): HistorySource {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { kind: 'manual' }
  const record = raw as Record<string, unknown>
  if (record.kind === 'task' && typeof record.label === 'string' && record.label !== '') {
    return { kind: 'task', label: record.label }
  }
  if (record.kind === 'revert' && typeof record.from === 'string' && record.from !== '') {
    return { kind: 'revert', from: record.from }
  }
  return { kind: 'manual' }
}

/**
 * Decide what one write was, from the two texts it replaced and what wrote it.
 *
 * Archiving is this format's deletion (`03` §4.6), so an entry that flips
 * `archived` is reported as an archive or a restore rather than as a nameless
 * "update" — the requirement asks the record to cover 新增、删除、修改, and
 * 「删除了」 is exactly what an author needs to see in the list.
 *
 * A rollback takes precedence over all of it. It is a fact about *who wrote the
 * text*, not about the text: restoring an older version looks like an ordinary
 * edit to a content comparison, and reporting it as one would hide the single
 * most interesting line in the record.
 * @param before - the document before the write; empty when it did not exist.
 * @param after - the document after the write.
 * @param archivedBefore - whether the older version was archived.
 * @param archivedAfter - whether the newer version is archived.
 * @param source - what produced the write.
 * @returns the action to record.
 */
export function actionOf(
  before: string,
  after: string,
  archivedBefore: boolean,
  archivedAfter: boolean,
  source: HistorySource,
): HistoryAction {
  if (source.kind === 'revert') return 'revert'
  if (before === '') return 'create'
  if (archivedBefore !== archivedAfter) return archivedAfter ? 'archive' : 'restore'
  return 'update'
}
