/**
 * The findings a model reported, rendered as a report the author can check.
 *
 * This is the display half of M6's model layer: `tasks.ts` assembles the prompt,
 * `issues.ts` parses the reply, and this file lays the result out so that every
 * finding shows **the sentence it objects to** and **what it conflicts with**
 * next to each other. An issue without either is dropped at parse time, so there
 * is nothing here that cannot be verified against the text — which is the whole
 * point of the layer (§8: an inconsistent report is a report nobody reads).
 *
 * Requirement §4 M4 asks for a problem list whose entries can be clicked to
 * locate the passage, so a finding that quotes something gets a 定位到正文 button
 * whenever the caller can act on it. That is what turns the list from something
 * to read into something to work through.
 *
 * It is a separate component, exported through `__views`, so the render check
 * can feed it findings instead of only exercising the empty state.
 *
 * @module dsh-ai-novel-copilot/client/IssueList
 */
import { MODEL_SEVERITY_LABELS, type ModelIssue, type ModelIssueSeverity } from './issues.ts'
import { button, caption, controlRow, metaLine, row } from './ui.ts'

/** Props for the finding list. */
export interface ModelIssueListProps {
  /** Findings to draw, most serious first. */
  issues: readonly ModelIssue[]
  /** Why nothing could be read out of the reply, when nothing could. */
  error?: string
  /**
   * Put the cursor on a quoted passage in the open chapter.
   *
   * Omitted when there is nothing to locate into: a report about a file the
   * editor does not hold gets no button, rather than a button that does nothing.
   */
  onLocate?(quote: string): void
}

/** The order severities are shown in. */
const SEVERITIES: readonly ModelIssueSeverity[] = ['error', 'warn', 'info']

/** What the caption says when the model did not say where it found the problem. */
const RULE_FALLBACK = '（模型没有说明位置）'

/**
 * The finding list.
 * @param props - the findings, the parse error, and the locate action when there is one.
 */
export function ModelIssueList({ issues, error, onLocate }: ModelIssueListProps) {
  if (issues.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {error !== undefined && <div style={metaLine}>{error}</div>}
        {error === undefined && (
          <div style={metaLine}>
            模型没有报出问题。这只说明它没在这次给它的材料里看出问题，不等于稿子没问题。
          </div>
        )}
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {error !== undefined && <div style={metaLine}>{error}</div>}
      {SEVERITIES.map(severity => {
        const items = issues.filter(issue => issue.severity === severity)
        if (items.length === 0) return null
        return (
          <div key={severity} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={metaLine}>{MODEL_SEVERITY_LABELS[severity]} · {String(items.length)}</div>
            {items.map((issue, index) => (
              <div
                key={`${severity}-${String(index)}-${issue.quote}`}
                style={{
                  paddingLeft: 6,
                  borderLeft: `2px solid color-mix(in srgb, currentColor ${
                    severity === 'error' ? '70%' : severity === 'warn' ? '40%' : '20%'
                  }, transparent)`,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3,
                }}
              >
                <div style={controlRow}>
                  <span style={caption}>{issue.where === '' ? RULE_FALLBACK : issue.where}</span>
                  {onLocate !== undefined && issue.quote !== '' && (
                    <button
                      type="button"
                      style={{ ...button, padding: '1px 6px' }}
                      title="在正文里选中这句话"
                      onClick={() => { onLocate(issue.quote) }}
                    >
                      定位到正文
                    </button>
                  )}
                </div>
                {issue.quote === '' ? null : (
                  <div style={{ fontSize: 12, lineHeight: 1.7, fontStyle: 'italic', wordBreak: 'break-word' }}>
                    「{issue.quote}」
                  </div>
                )}
                {issue.basis === '' ? null : <div style={{ fontSize: 11, lineHeight: 1.7 }}>依据：{issue.basis}</div>}
                {issue.suggestion === '' ? null : (
                  <div style={metaLine}>建议：{issue.suggestion}</div>
                )}
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}
