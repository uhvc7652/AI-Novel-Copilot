/**
 * Deterministic retrieval — the M5 layer.
 *
 * Requirement §4 M5 asks three questions — 「某人上次出场在哪」「某物品第一次出现
 * 是哪章」「某设定在哪解释过」 — to be answered with a chapter location plus the
 * original snippet, and D11 fixes the method: structural reverse lookup over
 * frontmatter (`pov`/`characters`/`locations`), the `summary` index, and keyword
 * search with aliases expanded. No vectors, no model, no network.
 *
 * This module is the whole engine, and it imports nothing but the
 * dependency-free path rules, so the host scans with it and the browser could
 * too. Two things are deliberately explicit:
 *
 * 1. **Every answer says where it came from.** A fact here has exactly three
 *    possible sources — the card's own fields, chapter frontmatter, or a literal
 *    string match in prose — and when they disagree the disagreement is
 *    *reported*, not silently resolved. A card whose `firstAppear` no longer
 *    matches the earliest chapter that names it is a finding, not a tie to
 *    break by preference.
 * 2. **There is no segmenter.** Chinese is not space-separated and a word
 *    segmenter is a dependency this plugin does not take, so a run like
 *    「半块青铜镜」 is matched by overlapping 2–4 character n-grams, longest
 *    first. That is approximate by construction, which is exactly why a hit
 *    always carries the snippet it matched: the author sees the evidence rather
 *    than trusting the rank.
 *
 * @module dsh-ai-novel-copilot/novel/search
 */
import { CARD_LABELS, type CardType } from './paths.ts'
import { isRetiredCard } from './cards.ts'
import type { ThreadRecord } from './project.ts'

/** What a searched document is. */
export type SearchDocKind = 'chapter' | 'card' | 'page'

/**
 * One document the search scans.
 *
 * Chapters, cards and loose documents (world, timeline, outlines, the voice
 * guide) are flattened into this one shape so the ranking and the answers do not
 * care which tree a file lives in. Fields a kind does not have stay empty rather
 * than absent, because every matcher would otherwise need its own guard.
 */
export interface SearchDoc {
  /** Which tree the document came from. */
  kind: SearchDocKind
  /** Storage-relative path; also the jump target the panel uses. */
  path: string
  /** Chapter id (`c0001`) or card id (`chen-mo`); the path for a loose document. */
  id: string
  /** Display title. */
  title: string
  /** Short category the panel shows before the title (`第 3 章`, `角色`, `大纲`). */
  label: string
  /** Chapter number, when it is a chapter. */
  number?: number
  /** Volume number, when it is a chapter. */
  volume?: number
  /** Whether the author retired it. */
  archived: boolean
  /** Card type, when it is a card. */
  cardType?: CardType
  /** Card display name. */
  name?: string
  /** Alternative names, expanded into the query before matching. */
  aliases: string[]
  /** Free-form tags a card carries. */
  tags: string[]
  /** First chapter a card claims (`firstAppear`), when set. */
  firstAppear?: string
  /** Chapter summary, or a card's one-line gist. */
  summary: string
  /** Chapter beats, or a thread card's lifecycle chapters (by id). */
  beats: string[]
  /** Chapter frontmatter character ids. */
  characters: string[]
  /** Chapter frontmatter location ids. */
  locations: string[]
  /** Chapter frontmatter `refs`: the generic setting cards it is written against. */
  refs: string[]
  /** Chapter point-of-view character id. */
  pov?: string
  /** A thread card's life, when the document is one. */
  thread?: ThreadRecord
  /** The prose (or card body) the keyword pass reads. */
  body: string
}

/** Why a document matched. */
export type SearchReason =
  | 'card' | 'alias' | 'tag'
  | 'characters' | 'locations' | 'refs' | 'pov'
  | 'title' | 'summary' | 'beats' | 'body'

/** Human-readable labels for {@link SearchReason}. */
export const REASON_LABELS: Record<SearchReason, string> = {
  card: '就是这张卡',
  alias: '命中别名',
  tag: '命中标签',
  characters: '出场角色登记',
  locations: '地点登记',
  refs: '本章引用的设定',
  pov: '视角人物',
  title: '标题',
  summary: '摘要',
  beats: '章纲',
  body: '正文',
}

/** What shape of question the query is asking. */
export type SearchAnswerKind =
  | 'last-appearance'
  | 'first-appearance'
  | 'appearances'
  | 'explained-in'
  | 'thread'

/** A setting card the query named, after the aliases were expanded. */
export interface SearchEntity {
  /** Card id. */
  id: string
  /** Card type. */
  type: CardType
  /** Display name. */
  name: string
  /** Alternative names. */
  aliases: string[]
  /** Storage-relative card path; the panel's jump target. */
  path: string
  /** Whether the card is archived. */
  archived: boolean
  /** First chapter the card claims, when set. */
  firstAppear?: string
  /** The word in the query that named this card. */
  matched: string
  /** Whether that word was the id, the name, or an alias. */
  via: 'id' | 'name' | 'alias'
}

/** A passage of prose around a match, with the matched ranges kept. */
export interface SearchSnippet {
  /** The passage, whitespace collapsed. */
  text: string
  /** Matched ranges inside {@link text}, as `[start, end)`. */
  ranges: [number, number][]
  /** Where the passage starts in the document's body. */
  offset: number
}

/** One document that matched. */
export interface SearchHit {
  kind: SearchDocKind
  path: string
  id: string
  title: string
  label: string
  number?: number
  volume?: number
  archived: boolean
  /** Ranking score; only comparable within one query. */
  score: number
  /** Every reason this document matched, in a stable order. */
  reasons: SearchReason[]
  /** The best passage, when the match reached the prose. */
  snippet?: SearchSnippet
  /** How many times the query's terms occur in the body. */
  occurrences: number
}

/** A deterministic answer to the question shape the query asked. */
export interface SearchAnswer {
  /** Which question shape was answered. */
  kind: SearchAnswerKind
  /** The answer itself, ready to read. */
  text: string
  /** Storage-relative paths the answer points at, in story order. */
  chapters: string[]
  /** The card the answer is about, when the query named one. */
  entity?: SearchEntity
  /** Where each fact came from, one line each. */
  evidence: string[]
}

/** Everything one search returns. */
export interface SearchResult {
  /** The query as typed. */
  query: string
  /** Terms actually searched for, after the question words were dropped. */
  terms: string[]
  /** Cards the query named, longest match first. */
  entities: SearchEntity[]
  /** The answer, when the query resolved to something answerable. */
  answer?: SearchAnswer
  /** Ranked matches, limited. */
  hits: SearchHit[]
  /** How many documents matched, by kind — before the limit was applied. */
  counts: { chapters: number, cards: number, pages: number }
  /** How many documents the corpus held. */
  scanned: number
  /** True when the query carried nothing to search for. */
  empty: boolean
}

/**
 * Words that ask a question rather than name something.
 *
 * They are removed before terms are built, because 「在哪」「出场」 would otherwise
 * match every chapter that happens to contain those characters — the opposite of
 * narrowing. Entity resolution runs on the *original* query, so a name that
 * contains one of these words still resolves.
 */
const INTENT_WORDS = [
  '最后一次出现', '最后一次出场', '第一次出场', '第一次出现',
  '上一次出现', '最近一次出现', '最后一次', '最近一次', '上一次',
  '第一次', '首次', '初次', '最早', '最先',
  '上次', '最近', '最新', '最后',
  '出现过', '出场过', '提到过', '解释过', '说明过', '交代过', '介绍过',
  '出现', '出场', '登场', '提到', '提及', '说起',
  '在哪一章', '在哪一节', '在哪一段', '在哪几章', '在哪些章', '在哪章', '在第几章',
  '是哪章', '哪一章', '哪几章', '哪些章', '哪一节', '哪一段', '哪章', '在哪', '哪里', '哪儿',
  '什么时候', '哪年',
  '解释', '说明', '交代', '介绍', '设定', '出处', '来源',
  '几次', '哪些', '多少', '是谁', '什么', '请问', '帮我', '查一下',
  '吗', '呢',
].sort((left, right) => right.length - left.length)

/**
 * Characters that carry no topic on their own.
 *
 * A run left as a single one of these — the 「了」 that survives stripping
 * 「出现了」 — matches half the book, so it is dropped instead of searched for.
 * Longer runs are kept whole even when they begin or end with one of these:
 * trimming 「不」 off a query for 「不周山」 costs a real word to remove a stray
 * 「在」, and entity names are matched in full elsewhere anyway.
 */
const STOP_CHARS = new Set('的了过是在和与也就都很才又而被把从对到有为个之其且'.split(''))

/** The question shape a raw query is asking, before any entity is known. */
function intentOf(raw: string): SearchAnswerKind | undefined {
  const appearance = /(出现|出场|登场|提到|提及|说起)/
  if (/(第一次|首次|初次|最早|最先)/.test(raw) && appearance.test(raw)) return 'first-appearance'
  if (/(上次|最后|最近|最新)/.test(raw) && appearance.test(raw)) return 'last-appearance'
  if (/(几次|哪些章|哪几章|多少章)/.test(raw)) return 'appearances'
  if (/(在哪|哪里|哪儿|哪一章)/.test(raw) && /(解释|说明|交代|介绍|设定)/.test(raw)) return 'explained-in'
  if (/(伏笔|回收|埋了|埋下)/.test(raw)) return 'thread'
  return undefined
}

/** Remove the question words, leaving what the author is actually asking about. */
export function stripIntent(query: string): string {
  let text = query
  for (const word of INTENT_WORDS) {
    if (text.includes(word)) text = text.split(word).join(' ')
  }
  return text
}

/**
 * The terms a query is searched by.
 *
 * A Han run is kept whole (up to 12 characters) because the n-gram matcher
 * expands it further; a Latin or numeric run is kept from two characters, since
 * a single letter matches everywhere. A run that reduces to one topic-less
 * character is dropped — see {@link STOP_CHARS}.
 * @param query - the raw query.
 * @returns the distinct terms, longest first.
 */
export function queryTerms(query: string): string[] {
  const terms: string[] = []
  for (const raw of stripIntent(query).split(/[^\p{L}\p{N}-]+/u)) {
    const run = raw.trim()
    if (run === '') continue
    if (/^[\p{Script=Han}]+$/u.test(run)) {
      if (run.length === 1 && STOP_CHARS.has(run)) continue
      terms.push(run.length > 12 ? run.slice(0, 12) : run)
    } else if (run.length >= 2) terms.push(run)
  }
  return [...new Set(terms)].sort((left, right) => right.length - left.length).slice(0, 8)
}

/**
 * Whether a search doc is a card the author retired — deleted, or an abandoned thread.
 * @param doc - one corpus document.
 * @returns true when the card is out of the working set.
 */
function retiredDoc(doc: SearchDoc): boolean {
  if (doc.kind !== 'card' || doc.cardType === undefined) return false
  return isRetiredCard({
    type: doc.cardType,
    archived: doc.archived,
    ...(doc.thread === undefined ? {} : { thread: doc.thread }),
  })
}

/**
 * Resolve the cards a query names, by id, display name or alias.
 * @param docs - the corpus.
 * @param query - the raw query.
 * @returns the matched cards, the longest matched word first.
 */
export function resolveEntities(docs: readonly SearchDoc[], query: string): SearchEntity[] {
  const lower = query.toLowerCase()
  const found = new Map<string, SearchEntity>()
  for (const doc of docs) {
    if (doc.kind !== 'card' || doc.cardType === undefined) continue
    // A retired card is not an entity: a deleted card, or a thread the author
    // abandoned. This is the other half of "an abandoned line frees its name" —
    // the collision rule can only stay quiet if resolution agrees, otherwise the
    // author gets two cards answering to one name with one of them silently
    // winning (`novel/cards.ts`). The card's *text* stays searchable; it just
    // stops being an answer about the book.
    if (retiredDoc(doc)) continue
    const candidates: { word: string, via: SearchEntity['via'] }[] = [
      { word: doc.id, via: 'id' },
      ...(doc.name === undefined || doc.name === doc.id ? [] : [{ word: doc.name, via: 'name' as const }]),
      ...doc.aliases.filter(alias => alias !== doc.name).map(alias => ({ word: alias, via: 'alias' as const })),
    ]
    let best: { word: string, via: SearchEntity['via'] } | undefined
    for (const candidate of candidates) {
      const word = candidate.word.trim()
      // A one-character alias would match half the language; ids and names of a
      // single character are the author's own business and are still matched.
      if (word === '' || (word.length < 2 && candidate.via === 'alias')) continue
      if (!lower.includes(word.toLowerCase())) continue
      if (best === undefined || word.length > best.word.length) best = { word, via: candidate.via }
    }
    if (best === undefined) continue
    found.set(doc.id, {
      id: doc.id,
      type: doc.cardType,
      name: doc.name ?? doc.id,
      aliases: [...doc.aliases],
      path: doc.path,
      archived: doc.archived,
      ...(doc.firstAppear === undefined ? {} : { firstAppear: doc.firstAppear }),
      matched: best.word,
      via: best.via,
    })
  }
  return [...found.values()].sort((left, right) =>
    right.matched.length - left.matched.length
    || left.name.localeCompare(right.name, 'zh-Hans-CN'))
}

/** Merge overlapping or touching ranges, in order. */
function mergeRanges(ranges: readonly [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((left, right) => left[0] - right[0] || left[1] - right[1])
  const merged: [number, number][] = []
  for (const [start, end] of sorted) {
    const last = merged.at(-1)
    if (last !== undefined && start <= last[1]) {
      if (end > last[1]) last[1] = end
      continue
    }
    merged.push([start, end])
  }
  return merged
}

/** One document's keyword match. */
interface TextMatch {
  /** Weighted score; longer matches are worth more than many short ones. */
  score: number
  /** Earliest match position, or -1. */
  first: number
  /** Matched ranges, merged. */
  ranges: [number, number][]
  /** How many times the query's terms occur. */
  occurrences: number
}

/**
 * Match a text against the query's terms.
 *
 * Han runs are walked n-gram by n-gram (4, 3, 2 characters, longest first at
 * each position) so partially different phrasing still matches; everything else
 * is an exact, case-insensitive substring search.
 * @param text - the text to search.
 * @param terms - the query's terms.
 * @returns the score, the earliest position, and the matched ranges.
 */
function matchText(text: string, terms: readonly string[]): TextMatch {
  const lower = text.toLowerCase()
  let score = 0
  let first = -1
  let occurrences = 0
  const ranges: [number, number][] = []
  const note = (at: number, end: number): void => {
    if (first < 0 || at < first) first = at
    ranges.push([at, end])
  }
  for (const term of terms) {
    const needle = term.toLowerCase()
    if (/^[\p{Script=Han}]+$/u.test(term) && needle.length >= 2) {
      const widest = Math.min(4, needle.length)
      for (let index = 0; index + 1 < needle.length; index += 1) {
        for (let size = Math.min(widest, needle.length - index); size >= 2; size -= 1) {
          const at = lower.indexOf(needle.slice(index, index + size))
          if (at < 0) continue
          score += size * size
          occurrences += 1
          note(at, at + size)
          break
        }
      }
      continue
    }
    const at = lower.indexOf(needle)
    if (at < 0) continue
    let count = 0
    let cursor = at
    while (cursor >= 0) {
      count += 1
      cursor = lower.indexOf(needle, cursor + needle.length)
    }
    score += needle.length * needle.length * count
    occurrences += count
    note(at, at + needle.length)
  }
  // A long chapter must not outrank a precise hit just by being long.
  return { score: Math.min(score, 600), first, ranges: mergeRanges(ranges), occurrences }
}

/** How much prose a snippet shows on either side of the match. */
const SNIPPET_BEFORE = 60
/** How much prose a snippet shows after the match. */
const SNIPPET_AFTER = 100

/**
 * Cut a readable passage around a match, keeping the matched ranges addressable.
 *
 * Whitespace is collapsed in the plain parts only, and the output offset of each
 * match is tracked as the pieces are appended — collapsing the whole slice first
 * would shift every range and make the panel highlight the wrong characters.
 * @param body - the document's prose.
 * @param at - the match position to centre on.
 * @param ranges - every matched range in the body.
 * @returns the snippet, or undefined when there is nothing to show.
 */
function snippetOf(
  body: string,
  at: number,
  ranges: readonly [number, number][],
): SearchSnippet | undefined {
  if (at < 0 || body.trim() === '') return undefined
  const start = Math.max(0, at - SNIPPET_BEFORE)
  const end = Math.min(body.length, at + SNIPPET_AFTER)
  const inside = mergeRanges(ranges
    .filter(([from, to]) => to > start && from < end)
    .map(([from, to]) => [Math.max(from, start), Math.min(to, end)] as [number, number]))
  let text = ''
  const offset = start
  const clipped: [number, number][] = []
  const append = (piece: string): void => { text += piece }
  let cursor = start
  for (const [from, to] of inside) {
    const plain = body.slice(cursor, from).replace(/\s+/g, ' ')
    append(cursor === start ? (start > 0 ? `…${plain.trimStart()}` : plain.trimStart()) : plain)
    const markStart = text.length
    append(body.slice(from, to))
    clipped.push([markStart, text.length])
    cursor = to
  }
  const tail = body.slice(cursor, end).replace(/\s+/g, ' ')
  append(end < body.length ? `${tail.trimEnd()}…` : tail.trimEnd())
  if (text.trim() === '' || text.trim() === '…') return undefined
  return { text, ranges: clipped, offset }
}

/** Story order: volume, then chapter number, then path. */
function byStory(left: SearchDoc, right: SearchDoc): number {
  return (left.volume ?? 0) - (right.volume ?? 0)
    || (left.number ?? 0) - (right.number ?? 0)
    || left.path.localeCompare(right.path)
}

/** `第 3 章《巡夜人》`, or just the title for a document that is not a chapter. */
function chapterLabel(doc: SearchDoc): string {
  return doc.number === undefined ? doc.title : `第 ${String(doc.number)} 章《${doc.title}》`
}

/** A card's type label, for an answer sentence. */
function typeLabel(entity: SearchEntity): string {
  return CARD_LABELS[entity.type]
}

/** Render a chapter list, compressing it once it stops being readable. */
function chapterList(docs: readonly SearchDoc[], limit = 8): string {
  const shown = docs.slice(0, limit).map(doc => `第 ${String(doc.number ?? 0)} 章`)
  return docs.length > limit ? `${shown.join('、')}…（共 ${String(docs.length)} 章）` : shown.join('、')
}

/** The chapters whose frontmatter registers an entity, in story order. */
function chaptersNaming(entity: SearchEntity, chapters: readonly SearchDoc[]): SearchDoc[] {
  return chapters.filter(doc =>
    doc.characters.includes(entity.id)
    || doc.locations.includes(entity.id)
    || doc.refs.includes(entity.id)
    || doc.pov === entity.id)
}

/** The chapters whose prose mentions an entity by name or alias. */
function chaptersMentioning(entity: SearchEntity, chapters: readonly SearchDoc[]): SearchDoc[] {
  const words = [entity.name, ...entity.aliases].filter(word => word.trim() !== '').map(word => word.toLowerCase())
  return chapters.filter(doc => {
    const lower = doc.body.toLowerCase()
    return words.some(word => lower.includes(word))
  })
}

/** Which frontmatter fields registered an entity in one chapter. */
function refFields(entity: SearchEntity, doc: SearchDoc): SearchReason[] {
  const fields: SearchReason[] = []
  if (doc.pov === entity.id) fields.push('pov')
  if (doc.characters.includes(entity.id)) fields.push('characters')
  if (doc.locations.includes(entity.id)) fields.push('locations')
  if (doc.refs.includes(entity.id)) fields.push('refs')
  return fields
}

/**
 * Build the deterministic answer for one question shape.
 *
 * The sibling of {@link searchDocs} rather than a private helper only because it
 * is worth reading on its own: this is where "the answer" is decided, and every
 * branch states its source.
 */
function buildAnswer(
  intent: SearchAnswerKind,
  entity: SearchEntity,
  card: SearchDoc,
  chapters: readonly SearchDoc[],
): SearchAnswer {
  const named = chaptersNaming(entity, chapters)
  const mentioned = chaptersMentioning(entity, chapters)
  const evidence: string[] = []
  const about = `${typeLabel(entity)}「${entity.name}」`

  if (entity.type === 'thread' && card.thread !== undefined) {
    const thread = card.thread
    const at = (id: string | undefined): SearchDoc | undefined =>
      id === undefined ? undefined : chapters.find(doc => doc.id === id || doc.path === id)
    const planted = at(thread.plantedIn)
    const paid = thread.payoffIn.map(at).filter((doc): doc is SearchDoc => doc !== undefined)
    const reinforced = thread.reinforcedIn.map(at).filter((doc): doc is SearchDoc => doc !== undefined)
    const parts = [`伏笔「${entity.name}」：${thread.status === '' ? '状态未填' : thread.status}。`]
    parts.push(planted === undefined
      ? `埋点：${thread.plantedIn ?? '未记'}${thread.plantedIn !== undefined && planted === undefined ? '（工程里没有这一章）' : ''}。`
      : `埋于 ${chapterLabel(planted)}。`)
    if (thread.reinforcedIn.length > 0) {
      parts.push(reinforced.length > 0
        ? `强化于 ${reinforced.map(doc => `第 ${String(doc.number ?? 0)} 章`).join('、')}。`
        : `强化章节 ${thread.reinforcedIn.join('、')} 在工程里找不到。`)
    }
    if (thread.plannedPayoff !== undefined) parts.push(`计划回收：${thread.plannedPayoff}。`)
    parts.push(paid.length > 0
      ? `已回收于 ${paid.map(doc => `第 ${String(doc.number ?? 0)} 章`).join('、')}。`
      : `尚未回收${thread.payoffIn.length > 0 ? `（payoffIn 写着 ${thread.payoffIn.join('、')}，但没有对应章节）` : ''}。`)
    evidence.push(`${card.path} · 伏笔卡：status=${thread.status === '' ? '（空）' : thread.status}`
      + `${thread.plantedIn === undefined ? '' : `, plantedIn=${thread.plantedIn}`}`
      + `${thread.payoffIn.length === 0 ? '' : `, payoffIn=${thread.payoffIn.join('/')}`}`)
    return { kind: 'thread', text: parts.join(''), chapters: [], entity, evidence }
  }

  if (entity.type !== 'thread') evidence.push(`${card.path} · 卡片 frontmatter（${typeLabel(entity)}）`)

  const firstOf = named[0] ?? mentioned[0]
  const lastOf = named.at(-1) ?? mentioned.at(-1)
  const fromFrontmatter = named.length > 0

  if (intent === 'first-appearance' || intent === 'last-appearance') {
    const wanted = intent === 'first-appearance' ? firstOf : lastOf
    if (wanted === undefined) {
      return {
        kind: intent,
        text: `${about}在章节 frontmatter 和正文里都没有出场记录。`,
        chapters: [],
        entity,
        evidence,
      }
    }
    const position = intent === 'first-appearance' ? '第一次' : '最近一次'
    const source = fromFrontmatter
      ? `按章节 frontmatter 的出场登记`
      : `章节 frontmatter 里没有登记它，只在正文里被提到`
    const lines = [`${about}${position}出场：${chapterLabel(wanted)}（${source}）。`]
    // An archived chapter keeps its place in the answer — the author may be about
    // to restore it, and the hit list has always marked archived matches — but a
    // sentence that says "最近一次出场：第 7 章" without saying the chapter was
    // withdrawn reads as a claim about the current book. So it says so.
    if (wanted.archived) {
      lines.push(`注意：${chapterLabel(wanted)}已经存档（不在书稿里，也不参与任务装配），上面这个位置来自被撤出的那一章。`)
      evidence.push(`${wanted.path} · archived: true`)
    }
    if (named.length > 1) lines.push(`全书共 ${String(named.length)} 章登记了它：${chapterList(named)}。`)
    else if (named.length === 1) lines.push('全书只有这一章登记了它。')
    if (!fromFrontmatter && mentioned.length > 0) {
      lines.push(`正文另有 ${String(mentioned.length)} 章提到过它。`)
    }
    evidence.push(fromFrontmatter
      ? `${wanted.path} · frontmatter ${refFields(entity, wanted).join('/')} 含 ${entity.id}`
      : `${wanted.path} · 正文提到「${entity.name}」`)
    if (intent === 'first-appearance') {
      if (entity.firstAppear !== undefined && entity.firstAppear !== wanted.id) {
        const declared = chapters.find(doc => doc.id === entity.firstAppear)
        lines.push(declared === undefined
          ? `注意：卡片里写着 firstAppear: ${entity.firstAppear}，工程里没有这一章。`
          : `注意：卡片里写着 firstAppear: ${entity.firstAppear}（${chapterLabel(declared)}），与最早的出场登记不一致。`)
        evidence.push(`${card.path} · firstAppear: ${entity.firstAppear}`)
      } else if (entity.firstAppear !== undefined) {
        lines.push(`（卡片里写着 firstAppear: ${entity.firstAppear}，与最早的出场登记一致。）`)
        evidence.push(`${card.path} · firstAppear: ${entity.firstAppear}（与最早的出场登记一致）`)
      }
    }
    return {
      kind: intent,
      text: lines.join(''),
      chapters: [wanted.path],
      entity,
      evidence: evidence.slice(0, 4),
    }
  }

  if (intent === 'explained-in') {
    const lines = [`${about}的设定卡：${card.path}。`]
    if (mentioned.length > 0) {
      lines.push(`正文里最早提到它的是 ${chapterLabel(mentioned[0] as SearchDoc)}`
        + `${mentioned.length > 1 ? `，另有 ${String(mentioned.length - 1)} 章提到过` : ''}。`)
      evidence.push(`${(mentioned[0] as SearchDoc).path} · 正文提到「${entity.name}」`)
    } else {
      lines.push('正文里还没有提到过它。')
    }
    if (entity.firstAppear !== undefined) lines.push(`卡片登记的首次出场：${entity.firstAppear}。`)
    return {
      kind: 'explained-in',
      text: lines.join(''),
      chapters: mentioned.slice(0, 8).map(doc => doc.path),
      entity,
      evidence: evidence.slice(0, 4),
    }
  }

  // The default for a bare name: where does it show up at all.
  const lines = [named.length === 0
    ? `${about}：章节 frontmatter 里没有出场登记`
    : `${about}：${String(named.length)} 章的出场登记里有它（${chapterList(named)}）`]
  if (mentioned.length > 0) lines.push(`；正文提到它的有 ${String(mentioned.length)} 章。`)
  else lines.push('；正文没有直接提到过它。')
  if (!fromFrontmatter && mentioned.length > 0) {
    lines.push(' 它只出现在正文里，没有登记进任何章节的 frontmatter。')
    evidence.push(`${(mentioned[0] as SearchDoc).path} · 正文提到「${entity.name}」`)
  } else if (named[0] !== undefined) {
    evidence.push(`${named[0].path} · frontmatter ${refFields(entity, named[0]).join('/')} 含 ${entity.id}`)
  }
  return {
    kind: 'appearances',
    text: lines.join(''),
    chapters: (named.length === 0 ? mentioned : named).slice(0, 8).map(doc => doc.path),
    entity,
    evidence: evidence.slice(0, 4),
  }
}

/**
 * Search a corpus and answer the query deterministically.
 * @param docs - every document to scan.
 * @param query - the raw query.
 * @param limit - how many hits to return; the counts still report every match.
 * @returns the answer, the ranked hits, and what was actually searched.
 */
export function searchDocs(
  docs: readonly SearchDoc[],
  query: string,
  limit = 40,
): SearchResult {
  const chapters = docs.filter(doc => doc.kind === 'chapter').sort(byStory)
  const entities = resolveEntities(docs, query)
  const terms = [...new Set([
    ...entities.map(entity => entity.matched),
    ...queryTerms(query),
  ])].slice(0, 8)

  const empty = terms.length === 0 && entities.length === 0
  const counts = { chapters: 0, cards: 0, pages: 0 }
  const hits: SearchHit[] = []

  if (!empty) {
    for (const doc of docs) {
      const reasons: SearchReason[] = []
      let score = 0
      let snippet: SearchSnippet | undefined
      let occurrences = 0

      // 1. Structural: the query named a card and this chapter registers it.
      const naming = entities.filter(entity => refFields(entity, doc).length > 0)
      for (const entity of naming) {
        // The field that registered it **is** the reason, and `refFields` is also
        // what the answer sentence cites — one reader, so a hit cannot be
        // described by a field it did not actually match on.
        const field = refFields(entity, doc)[0]
        if (field !== undefined) reasons.push(field)
        score += 100
      }

      // 2. The card the query named, as a document in its own right.
      for (const entity of entities) {
        if (doc.path !== entity.path) continue
        reasons.push(entity.via === 'alias' ? 'alias' : 'card')
        score += 130
      }

      // 3. Text: title, summary, beats, then the prose.
      for (const [reason, text, weight] of [
        ['title', doc.title, 40],
        ['summary', doc.summary, 25],
        ['beats', doc.beats.join('\n'), 20],
      ] as const) {
        if (text.trim() === '') continue
        const match = matchText(text, terms)
        if (match.score <= 0) continue
        reasons.push(reason)
        score += weight + match.score
        occurrences += match.occurrences
      }
      for (const tag of doc.tags) {
        if (matchText(tag, terms).score > 0) {
          reasons.push('tag')
          score += 30
        }
      }
      const body = matchText(doc.body, terms)
      if (body.score > 0) {
        reasons.push('body')
        score += body.score
        occurrences += body.occurrences
        snippet = snippetOf(doc.body, body.first, body.ranges)
      }

      if (score <= 0) continue
      counts[doc.kind === 'chapter' ? 'chapters' : doc.kind === 'card' ? 'cards' : 'pages'] += 1
      hits.push({
        kind: doc.kind,
        path: doc.path,
        id: doc.id,
        title: doc.title,
        label: doc.label,
        ...(doc.number === undefined ? {} : { number: doc.number }),
        ...(doc.volume === undefined ? {} : { volume: doc.volume }),
        archived: doc.archived,
        score,
        reasons: [...new Set(reasons)],
        ...(snippet === undefined ? {} : { snippet }),
        occurrences,
      })
    }
  }

  const kindOrder: Record<SearchDocKind, number> = { chapter: 0, card: 1, page: 2 }
  hits.sort((left, right) =>
    right.score - left.score
    || kindOrder[left.kind] - kindOrder[right.kind]
    || (left.volume ?? 0) - (right.volume ?? 0)
    || (left.number ?? 0) - (right.number ?? 0)
    || left.path.localeCompare(right.path))

  let answer: SearchAnswer | undefined
  const primary = entities[0]
  if (primary !== undefined) {
    const card = docs.find(doc => doc.path === primary.path)
    if (card !== undefined) {
      const intent = intentOf(query)
      const kind: SearchAnswerKind = primary.type === 'thread'
        ? 'thread'
        : intent ?? 'appearances'
      answer = buildAnswer(kind, primary, card, chapters)
    }
  }

  // A question about something that is not a card — 「青铜镜第一次出现是哪章」,
  // where the mirror lives in prose rather than in a setting card — is still
  // answerable: the ranking already knows which chapters carry the words, so the
  // answer points at the earliest (or latest) of them and says plainly that the
  // source was a keyword hit, not a frontmatter registration.
  if (answer === undefined && terms.length > 0) {
    const intent = intentOf(query)
    if (intent === 'first-appearance' || intent === 'last-appearance') {
      const hitPaths = new Set(hits.map(hit => hit.path))
      const hitChapters = chapters.filter(doc => hitPaths.has(doc.path))
      const wanted = intent === 'first-appearance' ? hitChapters[0] : hitChapters.at(-1)
      if (wanted !== undefined) {
        const position = intent === 'first-appearance' ? '第一次' : '最近一次'
        answer = {
          kind: intent,
          text: `「${terms[0] as string}」${position}出现：${chapterLabel(wanted)}`
            + '（按正文/摘要/章纲的关键词命中，不是 frontmatter 的出场登记）'
            + (hitChapters.length > 1 ? `；全书另有 ${String(hitChapters.length - 1)} 章命中。` : '。'),
          chapters: [wanted.path],
          evidence: [`${wanted.path} · 关键词命中「${terms[0] as string}」`],
        }
      }
    }
  }

  return {
    query,
    terms,
    entities,
    ...(answer === undefined ? {} : { answer }),
    hits: hits.slice(0, limit),
    counts,
    scanned: docs.length,
    empty,
  }
}
