/**
 * Model-check parsing: what the "let the model read this chapter against the
 * setting cards" task produces.
 *
 * Requirement §4 M6's second layer asks for a structured issue list —
 * `severity` / where in the chapter / the conflicting evidence / a suggestion —
 * and a language model is asked for JSON, which is the shape it gets wrong most
 * often. So the parse is deliberately forgiving, the same way `plan.ts` is: the
 * array is pulled out of fences and surrounding chatter, severity is accepted in
 * either language and either case, and an entry with nothing to check against is
 * dropped rather than rendered as an empty row.
 *
 * One rule is stricter than in `plan.ts`: **an issue must carry a quote or a
 * basis.** A finding the author cannot verify is worse than no finding — that is
 * the whole risk M6 is warned about (§8) — so a bare `{"severity":"error"}` is
 * discarded instead of shown.
 *
 * @module dsh-ai-novel-copilot/client/issues
 */

/** How serious one model-reported issue is. */
export type ModelIssueSeverity = 'error' | 'warn' | 'info'

/** Human-readable severity names, matching the deterministic report's. */
export const MODEL_SEVERITY_LABELS: Record<ModelIssueSeverity, string> = {
  error: '错误',
  warn: '警告',
  info: '提示',
}

/** One issue the model reported. */
export interface ModelIssue {
  severity: ModelIssueSeverity
  /** Where in the chapter, in the model's words (`第 3 段`, `陈默第一次开口`). */
  where: string
  /** The sentence the model is objecting to, copied from the chapter. */
  quote: string
  /** What it conflicts with — a card field, a hard constraint, an earlier chapter. */
  basis: string
  /** What to do about it. */
  suggestion: string
}

/** The outcome of reading an issue list out of a model reply. */
export interface IssueParseResult {
  /** Issues that parsed, most serious first. */
  issues: ModelIssue[]
  /** Why nothing parsed, when nothing did. */
  error?: string
}

/** Severity words a model may answer with, mapped onto the three levels. */
const SEVERITY_WORDS: Record<string, ModelIssueSeverity> = {
  error: 'error',
  err: 'error',
  high: 'error',
  critical: 'error',
  错误: 'error',
  严重: 'error',
  高: 'error',
  warn: 'warn',
  warning: 'warn',
  medium: 'warn',
  警告: 'warn',
  中: 'warn',
  info: 'info',
  note: 'info',
  low: 'info',
  提示: 'info',
  低: 'info',
}

/** Read one field as text, accepting a number where a string was expected. */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** Map a model's severity word onto the three levels, defaulting to a warning. */
function severityOf(value: unknown): ModelIssueSeverity {
  const word = textOf(value).toLowerCase()
  return SEVERITY_WORDS[word] ?? SEVERITY_WORDS[word.replace(/[^\p{L}]/gu, '')] ?? 'warn'
}

/**
 * Pull a JSON array out of a model reply.
 * @param text - the raw model output.
 * @returns the array, or undefined when none could be read.
 */
function extractArray(text: string): unknown[] | undefined {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end <= start) return undefined
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1))
    return Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** The key two issues with the same objection share, used to drop duplicates. */
function identityOf(issue: ModelIssue): string {
  return `${issue.severity}|${issue.quote.replace(/\s+/g, '')}|${issue.basis.replace(/\s+/g, '')}`
}

/**
 * Parse a model's issue list.
 * @param text - the raw model output.
 * @returns the issues, most serious first, and an error sentence when none parsed.
 */
export function parseIssues(text: string): IssueParseResult {
  const array = extractArray(text)
  if (array === undefined) {
    return { issues: [], error: '输出里没有可解析的 JSON 数组' }
  }
  const issues: ModelIssue[] = []
  const seen = new Set<string>()
  for (const entry of array) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const raw = entry as Record<string, unknown>
    const issue: ModelIssue = {
      severity: severityOf(raw.severity),
      where: textOf(raw.where) || textOf(raw.location) || textOf(raw.position),
      quote: textOf(raw.quote) || textOf(raw.text) || textOf(raw.evidence),
      basis: textOf(raw.basis) || textOf(raw.reason) || textOf(raw.conflict),
      suggestion: textOf(raw.suggestion) || textOf(raw.fix) || textOf(raw.advice),
    }
    // Nothing to verify: no sentence and no citation is not a finding.
    if (issue.quote === '' && issue.basis === '') continue
    const identity = identityOf(issue)
    if (seen.has(identity)) continue
    seen.add(identity)
    issues.push(issue)
  }
  if (issues.length === 0 && array.length > 0) {
    return { issues: [], error: `JSON 里有 ${String(array.length)} 条，但没有一条带 quote 或 basis（无法核对的结论不展示）` }
  }
  const rank: Record<ModelIssueSeverity, number> = { error: 0, warn: 1, info: 2 }
  issues.sort((left, right) => rank[left.severity] - rank[right.severity])
  return { issues }
}
