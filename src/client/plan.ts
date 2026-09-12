/**
 * Chapter-plan parsing: what a "split the outline into chapters" task produces.
 *
 * A plan is the one task output that is not prose. The model is asked for a JSON
 * array — it is the shape a language model gets wrong most often, so the parse
 * is deliberately forgiving (fences, surrounding chatter, a bare `beats`
 * string) and every rejection comes back as a sentence the panel can show,
 * never as a thrown stack. The author sees the parsed list and confirms it
 * before a single chapter file is created.
 *
 * @module dsh-ai-novel-copilot/client/plan
 */

/** One chapter a plan proposes, before the author accepts it. */
export interface PlanChapter {
  /** Chapter title. */
  title: string
  /** What happens in the chapter, in order. */
  beats: string[]
  /** Character card ids the chapter features. */
  characters: string[]
  /** Location card ids the chapter uses. */
  locations: string[]
  /** One-line summary, when the model supplied one. */
  summary?: string
  /** Target length in words, when the model supplied one. */
  targetWords?: number
}

/** The outcome of reading a plan out of a model reply. */
export interface PlanParseResult {
  /** Chapters that parsed, in order. */
  chapters: PlanChapter[]
  /** Why nothing parsed, when nothing did. */
  error?: string
}

/** Read a list-of-strings field, accepting a lone string as a one-item list. */
function stringsOf(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() === '' ? [] : [value.trim()]
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => entry.trim())
    .filter(entry => entry !== '')
}

/**
 * Pull a JSON array out of a model reply.
 *
 * Everything outside the outermost brackets is dropped first, because a model
 * that was told "only JSON" still often wraps it in a fence or adds a sentence.
 * @param text - the raw model output.
 * @returns the parsed value, or undefined when no array could be read.
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

/**
 * Parse a chapter plan out of a model reply.
 * @param text - the raw model output.
 * @returns the chapters that parsed, and an error sentence when none did.
 */
export function parsePlan(text: string): PlanParseResult {
  const array = extractArray(text)
  if (array === undefined) {
    return { chapters: [], error: '输出里没有可解析的 JSON 数组' }
  }
  const chapters: PlanChapter[] = []
  for (const entry of array) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const raw = entry as Record<string, unknown>
    const title = typeof raw.title === 'string' ? raw.title.trim() : ''
    if (title === '') continue
    const summary = typeof raw.summary === 'string' ? raw.summary.trim() : ''
    const targetWords = typeof raw.targetWords === 'number' && Number.isFinite(raw.targetWords)
      ? raw.targetWords
      : undefined
    chapters.push({
      title,
      beats: stringsOf(raw.beats),
      characters: stringsOf(raw.characters),
      locations: stringsOf(raw.locations),
      ...(summary === '' ? {} : { summary }),
      ...(targetWords === undefined ? {} : { targetWords }),
    })
  }
  if (chapters.length === 0) {
    return { chapters: [], error: 'JSON 里没有一条带 title 的章节' }
  }
  return { chapters }
}
