/**
 * The consistency-check surface: M6's report, with its evidence and its jumps.
 *
 * Three things make a report usable rather than alarming, and all three are
 * visible here: every finding says **which two files disagree** (so it can be
 * verified in seconds), every finding **jumps** to the file that needs the edit,
 * and anything the author judges to be a false positive can be **ignored and
 * remembered** — the risk table in the requirements is explicit that inconsistent
 * warnings cost trust, so the answer is a decision the panel keeps, not a filter
 * the author re-applies every run.
 *
 * The rules live in `src/novel/checks.ts` and run on the host; the panel owns the
 * report. This file renders one, which is also what lets the render check feed it
 * a report instead of only ever exercising its empty state.
 *
 * @module dsh-ai-novel-copilot/client/ChecksView
 */
import { useState } from 'react'
import type { ChapterSummary } from '../novel/project.ts'
import {
  RULE_LABELS,
  SEVERITY_LABELS,
  type CheckIssue,
  type CheckReport,
  type CheckSeverity,
} from '../novel/checks.ts'
import { box, button, caption, controlRow, metaLine, row, type PanelEnv } from './ui.ts'

/** Props for the checks view. */
export interface ChecksViewProps {
  /** Shared panel environment. */
  env: PanelEnv
  /** The report to render, or undefined before the first run. */
  report?: CheckReport
  /** Every chapter, so a finding's path can be shown as a chapter. */
  chapters: readonly ChapterSummary[]
  /** Run the checks again. */
  onRun(): void
  /** Ignore a finding, or bring it back. */
  onIgnore(issue: CheckIssue, ignored: boolean): void
  /** Write the report under `.novel/runs/`. */
  onSave(): void
  /** Open a chapter in the prose view. */
  onOpenChapter(path: string): void
  /** Switch to the settings view with this file open. */
  onOpenCard(path: string): void
}

/** The order severities are shown in. */
const SEVERITIES: readonly CheckSeverity[] = ['error', 'warn', 'info']

/** Whether a finding's path is a chapter or something in `settings/`. */
function isChapterPath(path: string): boolean {
  return path.startsWith('chapters/')
}

/**
 * The checks view.
 * @param props - environment, the report, and the four actions.
 */
export function ChecksView({
  env,
  report,
  chapters,
  onRun,
  onIgnore,
  onSave,
  onOpenChapter,
  onOpenCard,
}: ChecksViewProps) {
  /** Whether the ignored findings are unfolded. Local: it is a view, not a decision. */
  const [showIgnored, setShowIgnored] = useState(false)
  const chapterByPath = new Map(chapters.map(chapter => [chapter.path, chapter]))

  const open = (path: string): void => {
    if (isChapterPath(path)) onOpenChapter(path)
    else onOpenCard(path)
  }

  const bySeverity = (severity: CheckSeverity): CheckIssue[] =>
    (report?.issues ?? []).filter(issue => issue.severity === severity)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
      <div style={controlRow}>
        <span style={caption}>
          确定性规则：引用不存在的 id、名字撞车、章号缺重、时间线倒序、伏笔未回收、字数偏离……不调模型。
        </span>
        <span style={row}>
          {report !== undefined && report.ignored.length > 0 && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={showIgnored}
                onChange={event => { setShowIgnored(event.target.checked) }}
              /> 已忽略 {String(report.ignored.length)}
            </label>
          )}
          <button type="button" style={button} disabled={env.busy} onClick={onRun}>重新检查</button>
          <button
            type="button"
            style={button}
            disabled={env.busy || report === undefined}
            title="写入 .novel/runs/，与 AI 任务留痕放在一起"
            onClick={onSave}
          >
            保存报告
          </button>
        </span>
      </div>

      <div style={metaLine}>
        {report === undefined
          ? '还没有检查过这一本。点「重新检查」跑一遍确定性规则。'
          : report.issues.length === 0
            ? `没有发现问题（扫了 ${String(report.scanned.chapters)} 章 · ${String(report.scanned.cards)} 张卡 · ${String(report.scanned.pages)} 个文档）`
            : `${String(report.counts.error)} 错误 · ${String(report.counts.warn)} 警告 · ${String(report.counts.info)} 提示`}
      </div>

      {report !== undefined && report.stale.length > 0 && (
        <div style={metaLine}>
          有 {String(report.stale.length)} 条忽略记录已经对不上任何问题（多半是已经修好了），
          它们不影响结论，也不会再出现。
        </div>
      )}

      <div style={{ ...box, maxHeight: 420 }}>
        {SEVERITIES.map(severity => {
          const items = bySeverity(severity)
          const ignoredItems = showIgnored
            ? (report?.ignored ?? []).filter(issue => issue.severity === severity)
            : []
          if (items.length === 0 && ignoredItems.length === 0) return null
          return (
            <div key={severity} style={{ marginTop: 8 }}>
              <div style={metaLine}>
                {SEVERITY_LABELS[severity]} · {String(items.length)}
                {ignoredItems.length === 0 ? '' : `（另有 ${String(ignoredItems.length)} 条已忽略）`}
              </div>
              {[...items, ...ignoredItems].map(issue => {
                const isIgnored = ignoredItems.includes(issue)
                return (
                  <div
                    key={issue.key}
                    style={{
                      marginTop: 6,
                      paddingLeft: 6,
                      borderLeft: `2px solid color-mix(in srgb, currentColor ${
                        severity === 'error' ? '70%' : severity === 'warn' ? '40%' : '20%'
                      }, transparent)`,
                      opacity: isIgnored ? 0.5 : 1,
                    }}
                  >
                    <div style={controlRow}>
                      <span>
                        {issue.title}
                        <span style={caption}> · {RULE_LABELS[issue.rule]}</span>
                      </span>
                      <span style={row}>
                        <button
                          type="button"
                          style={{ ...button, padding: '1px 6px' }}
                          title={issue.path}
                          disabled={env.busy}
                          onClick={() => { open(issue.path) }}
                        >
                          {isChapterPath(issue.path)
                            ? `跳到第 ${String(chapterByPath.get(issue.path)?.number ?? 0)} 章`
                            : '打开'}
                        </button>
                        <button
                          type="button"
                          style={{ ...button, padding: '1px 6px' }}
                          title={isIgnored ? '让它重新出现在待处理列表里' : '这条我认了，别再报它'}
                          disabled={env.busy}
                          onClick={() => { onIgnore(issue, !isIgnored) }}
                        >
                          {isIgnored ? '取消忽略' : '忽略'}
                        </button>
                      </span>
                    </div>
                    <div style={{ fontSize: 11, lineHeight: 1.7, marginTop: 2 }}>{issue.detail}</div>
                    <details style={metaLine}>
                      <summary>依据（{String(issue.evidence.length)} 条）</summary>
                      {issue.evidence.map(line => <div key={line}>{line}</div>)}
                    </details>
                  </div>
                )
              })}
            </div>
          )
        })}
        {report !== undefined && report.issues.length === 0 && (
          <div style={metaLine}>
            这一轮没有发现不一致。规则只查确定的东西，所以「没报」等于「这些规则没意见」，不等于稿子没问题。
          </div>
        )}
      </div>
    </div>
  )
}
