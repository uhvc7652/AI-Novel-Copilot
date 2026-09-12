/**
 * Shared panel vocabulary: the inline styles, the status labels, and the small
 * environment handle every view receives.
 *
 * Views are split per surface (prose, settings, outline) but they are one
 * product: a button that looks different in the outline view is a bug, and the
 * note line is a single channel. Putting the shared pieces here is what keeps
 * that true without a CSS pipeline — the bundle ships no stylesheet, so every
 * style is an object.
 *
 * @module dsh-ai-novel-copilot/client/ui
 */
import type { CSSProperties } from 'react'
import type { ChapterStatus } from '../novel/project.ts'

/** The outermost column of the panel body. */
export const wrap: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  height: '100%',
  boxSizing: 'border-box',
  padding: 10,
  fontSize: 13,
}

/** A horizontal group of controls. */
export const row: CSSProperties = { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }

/** A plain button. */
export const button: CSSProperties = { font: 'inherit', padding: '3px 10px', cursor: 'pointer' }

/** A text input. */
export const input: CSSProperties = { font: 'inherit', padding: '3px 6px', minWidth: 0 }

/** A scrollable bordered box, used for every list. */
export const box: CSSProperties = {
  border: '1px solid color-mix(in srgb, currentColor 25%, transparent)',
  borderRadius: 6,
  padding: 6,
  maxHeight: 220,
  overflow: 'auto',
}

/**
 * A small, dimmed line of secondary text.
 *
 * **Text only.** `opacity` is inherited, so wrapping a button, checkbox, or
 * select in this style dims the control too (see {@link controlRow}); the
 * panels' source check fails on a `metaLine` container that holds one.
 */
export const metaLine: CSSProperties = { fontSize: 11, opacity: 0.7, marginTop: 4 }

/** The generation preview area: what the model produced, before it is trusted. */
export const previewBox: CSSProperties = {
  border: '1px solid color-mix(in srgb, currentColor 25%, transparent)',
  borderRadius: 6,
  padding: 8,
  maxHeight: 260,
  overflow: 'auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
}

/** The preview's own text block. */
export const previewText: CSSProperties = {
  margin: 0,
  font: 'inherit',
  lineHeight: 1.7,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
}

/**
 * A caption beside live controls: layout, no dimming.
 *
 * `opacity` is inherited by every descendant, so a control placed inside a
 * {@link metaLine} container is dimmed along with the text — which is exactly how
 * the preview's 采纳/放弃 buttons came to look permanently disabled while working
 * fine. Rows that hold controls use this, and keep {@link metaLine} on the text.
 */
export const controlRow: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 8,
  fontSize: 11,
}

/** A checkbox and its caption, undimmed so the box itself stays legible. */
export const checkLine: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 11,
  cursor: 'pointer',
}

/** A caption that sits inside a {@link controlRow}. */
export const caption: CSSProperties = { opacity: 0.7 }

/** A list row that behaves as a button. */
export const listRow: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 8,
  width: '100%',
  textAlign: 'left',
  font: 'inherit',
  padding: '3px 6px',
  cursor: 'pointer',
  background: 'transparent',
  color: 'inherit',
  border: 'none',
  borderRadius: 4,
}

/** A multi-line editor. */
export const textarea: CSSProperties = {
  flex: '1 1 auto',
  minHeight: 160,
  font: 'inherit',
  lineHeight: 1.7,
  padding: 8,
  resize: 'vertical',
}

/** Human-readable chapter status labels. */
export const STATUS_LABEL: Record<ChapterStatus, string> = {
  draft: '草稿',
  revised: '已修',
  final: '定稿',
}

/** Human-readable labels for a thread card's lifecycle. */
export const THREAD_STATUS_LABEL: Record<string, string> = {
  planted: '已埋',
  reinforced: '已强化',
  paid: '已回收',
  abandoned: '已废弃',
}

/**
 * What every view needs from the panel that hosts it.
 *
 * The note line and the busy flag live in one place on purpose: two views each
 * reporting progress in their own corner would leave the author unsure which
 * one just spoke.
 */
export interface PanelEnv {
  /** Session every host call carries, for sandbox resolution. */
  sessionId: string
  /** Project root, already resolved. */
  root: string
  /** Whether an operation is in flight. */
  busy: boolean
  /** Run one operation with the shared busy/error surface. */
  run(label: string, operation: () => Promise<string>): Promise<void>
  /** Replace the status line without running anything. */
  note(text: string): void
}
