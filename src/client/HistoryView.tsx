/**
 * The modification record surface: what changed, in lines, and how to go back
 * (M7).
 *
 * The requirement's boundary is what shapes the screen. Git already holds
 * **file-level** history — one commit per save — so this view exists for the
 * question git answers badly: *what did that 「润色本章」 run actually do to this
 * paragraph?* Hence a line diff rather than a list of timestamps, and hence the
 * host computing the diff (`src/novel/history.ts`) instead of the browser.
 *
 * ## Why Ctrl+Z lives in this view and not in the editor
 *
 * The requirement asks for rollback on `Ctrl+Z`, and binding it to the body
 * `textarea` would be a straight downgrade: the author presses Ctrl+Z while
 * typing to take back a sentence, and native undo does exactly that today. A
 * document-level rollback on the same keys would silently throw away every
 * keystroke since the last save — destroying work in the name of undoing it.
 *
 * So the shortcut is bound **here**, where the editor is not on screen and there
 * is nothing else for Ctrl+Z to mean: it rolls back to the previous recorded
 * version, after a confirmation that names it. The editor keeps its own undo.
 * See `11` §2.4 for this deviation and what is left for P5's shortcut pass.
 *
 * @module dsh-ai-novel-copilot/client/HistoryView
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  diffRows,
  type DiffLine,
  type HistoryAction,
  type HistoryEntry,
  type HistorySource,
  type HistorySummary,
} from '../novel/history.ts'
import type { LoadedDocument } from '../novel/io.ts'
import * as api from './api.ts'
import { box, button, caption, controlRow, listRow, metaLine, row, type PanelEnv } from './ui.ts'

/** Props for the history view. */
export interface HistoryViewProps {
  /** Shared panel environment. */
  env: PanelEnv
  /** The document to show versions of; undefined when nothing is open. */
  path?: string
  /** What to call that document on screen. */
  title: string
  /** Whether this view is the one on screen, which is when Ctrl+Z belongs to it. */
  active: boolean
  /** Whether the editor holds changes that are not saved yet. */
  dirty: boolean
  /** Take a restored document back into the editor. */
  onRestored(document: LoadedDocument): void
  /** Select a passage in the prose editor and scroll to it. */
  onLocate(text: string): void
}

/** How the record names each kind of change. */
const ACTION_LABEL: Record<HistoryAction, string> = {
  create: '新建',
  update: '修改',
  archive: '存档',
  restore: '恢复',
  revert: '回滚',
}

/** How the record names what produced a version. */
function sourceLabel(source: HistorySource): string {
  if (source.kind === 'task') return `任务「${source.label}」`
  if (source.kind === 'revert') return '回滚'
  return '手写'
}

/** The colour a diff line is drawn in, by kind. */
const LINE_STYLE: Record<DiffLine['kind'], string> = {
  same: 'transparent',
  add: 'color-mix(in srgb, #2e7d32 22%, transparent)',
  remove: 'color-mix(in srgb, #c62828 20%, transparent)',
}

/** One version with both texts and its diff, as the detail pane shows it. */
type OpenedVersion = HistoryEntry & { diff: DiffLine[] }

/**
 * The modification-record view.
 * @param props - environment, the open document, and the two callbacks back into the panel.
 */
export function HistoryView({ env, path, title, active, dirty, onRestored, onLocate }: HistoryViewProps) {
  const [entries, setEntries] = useState<HistorySummary[]>([])
  const [selected, setSelected] = useState<string>()
  const [entry, setEntry] = useState<OpenedVersion>()
  const [expanded, setExpanded] = useState(false)

  const load = useCallback(async () => {
    if (path === undefined) {
      setEntries([])
      setSelected(undefined)
      setEntry(undefined)
      return
    }
    const found = await api.readHistory(env.sessionId, env.root, path)
    setEntries(found)
    // Select the newest by default: the question an author almost always has is
    // "what did the thing I just did change".
    setSelected(current => found.some(item => item.at === current) ? current : found[0]?.at)
  }, [env.root, env.sessionId, path])

  /**
   * Load the list when this view becomes the one on screen, not on mount.
   *
   * Keyed on `active` for two reasons: the panel keeps every section mounted and
   * merely hides it, so a mount-time load would run before the author has ever
   * opened the tab; and a save does not change `path`, so a load keyed on the
   * document alone would show a list that is missing the version just written —
   * which is precisely the version an author opens this tab to look at.
   */
  useEffect(() => {
    if (!active) return
    void load().catch(() => { setEntries([]) })
  }, [active, load])

  useEffect(() => {
    if (path === undefined || selected === undefined) {
      setEntry(undefined)
      return
    }
    let live = true
    void api.readHistoryEntry(env.sessionId, env.root, path, selected)
      .then(found => { if (live) setEntry(found) })
      .catch(() => { if (live) setEntry(undefined) })
    return () => { live = false }
  }, [env.root, env.sessionId, path, selected])

  const rows = useMemo(() => diffRows(entry?.diff ?? [], expanded), [entry, expanded])

  const rollback = useCallback((target: HistorySummary) => {
    if (path === undefined) return
    const when = new Date(target.at).toLocaleString()
    const go = globalThis.confirm(
      `回滚《${title}》到 ${when}（${ACTION_LABEL[target.action]}）？\n`
      + (dirty ? '编辑器里还没保存的修改会一起丢掉。\n' : '')
      + '这次回滚本身也会记进修改记录，可以再滚回来。',
    )
    if (!go) return
    void env.run('回滚', async () => {
      const restored = await api.revertHistory(env.sessionId, env.root, path, target.at)
      onRestored(restored)
      await load()
      return `已回滚到 ${when} 的版本（${String(restored.body.length)} 字节）`
    })
  }, [dirty, env, load, onRestored, path, title])

  /**
   * Bind Ctrl+Z to "one version back" while this view is the one on screen.
   *
   * The guard is on the focused element as well as on `active`: the prose
   * `textarea` stays in the DOM (hidden) in every view, and a document-level
   * shortcut that fires while an author is typing is exactly the failure this
   * binding exists to avoid.
   */
  useEffect(() => {
    if (!active) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return
      if (event.key.toLowerCase() !== 'z') return
      const focused = document.activeElement
      if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) return
      const previous = entries[1]
      event.preventDefault()
      if (previous === undefined) {
        env.note('这一章只有一版，没有上一版可以回滚')
        return
      }
      rollback(previous)
    }
    globalThis.addEventListener('keydown', onKey)
    return () => { globalThis.removeEventListener('keydown', onKey) }
  }, [active, entries, env, rollback])

  if (path === undefined) {
    return <div style={metaLine}>先打开一章或一张卡，这里会显示它的修改记录。</div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
      <div style={controlRow}>
        <span style={caption}>
          {title} · {entries.length === 0 ? '还没有记录' : `${String(entries.length)} 版`}
        </span>
        <span style={row}>
          <button type="button" style={button} disabled={env.busy || entries[1] === undefined}
            title="等价于在这个页签里按 Ctrl+Z"
            onClick={() => { const previous = entries[1]; if (previous !== undefined) rollback(previous) }}>
            回滚到上一版
          </button>
          <button type="button" style={button} disabled={env.busy}
            onClick={() => { void env.run('刷新修改记录', async () => { await load(); return '修改记录已刷新' }) }}>
            刷新
          </button>
        </span>
      </div>

      {entries.length === 0
        ? <div style={metaLine}>这个文件还没有被面板保存过。保存一次之后，每一版都会留在这里。</div>
        : (
          <div style={box}>
            {entries.map((item, index) => {
              const chosen = item.at === selected
              const label = ACTION_LABEL[item.action]
              const size = item.beforeBytes === 0
                ? `${String(item.afterBytes)} 字节`
                : `${String(item.beforeBytes)} → ${String(item.afterBytes)} 字节`
              return (
                <button key={item.at} type="button" onClick={() => { setSelected(item.at) }}
                  style={{ ...listRow, fontWeight: chosen ? 600 : 400, background: chosen ? 'color-mix(in srgb, currentColor 12%, transparent)' : 'transparent' }}>
                  <span>{index === 0 ? '最新 · ' : ''}{new Date(item.at).toLocaleString()} · {label}</span>
                  <span style={caption}>{sourceLabel(item.source)} · {size}</span>
                </button>
              )
            })}
          </div>
        )}

      {entry === undefined
        ? (entries.length > 0 ? <div style={metaLine}>选一版看它改了什么。</div> : null)
        : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0 }}>
            <div style={controlRow}>
              <span style={caption}>
                {new Date(entry.at).toLocaleString()} · {ACTION_LABEL[entry.action]} · {sourceLabel(entry.source)}
              </span>
              <span style={row}>
                <label style={{ ...caption, display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                  <input type="checkbox" checked={expanded} onChange={event => { setExpanded(event.target.checked) }} />
                  展开未改动的行
                </label>
                <button type="button" style={button} disabled={env.busy}
                  onClick={() => {
                    const chosen = entries.find(item => item.at === entry.at)
                    if (chosen !== undefined) rollback(chosen)
                  }}>
                  回滚到这一版
                </button>
              </span>
            </div>
            <div style={{ ...box, maxHeight: 320, fontSize: 12, lineHeight: 1.6, fontFamily: 'monospace' }}>
              {rows.map((item, index) => item.kind === 'gap'
                ? <div key={`gap-${String(index)}`} style={{ ...metaLine, marginTop: 0, padding: '1px 6px' }}>…… 还有 {item.count} 行未改动 ……</div>
                : (
                  <button
                    key={`${item.line.kind}-${String(item.line.line)}-${String(index)}`}
                    type="button"
                    title={item.line.text.trim() === '' ? '空行，没有可定位的正文' : '在正文里定位这一行'}
                    disabled={item.line.text.trim() === ''}
                    onClick={() => { onLocate(item.line.text) }}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      font: 'inherit',
                      border: 'none',
                      borderRadius: 2,
                      padding: '0 6px',
                      cursor: item.line.text.trim() === '' ? 'default' : 'pointer',
                      color: 'inherit',
                      background: LINE_STYLE[item.line.kind],
                    }}>
                    <span style={caption}>{item.line.kind === 'add' ? '+' : item.line.kind === 'remove' ? '−' : ' '}</span>
                    {item.line.text === '' ? ' ' : item.line.text}
                  </button>
                ))}
            </div>
            <div style={metaLine}>点一行会在正文里选中它。回滚会记成一次新的修改，可以再滚回来。</div>
          </div>
        )}
    </div>
  )
}
