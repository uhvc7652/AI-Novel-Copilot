/**
 * Project layer: the on-disk layout of one novel and the pure derivations over
 * it. Nothing here touches a context, a filesystem, or the network — the IO
 * half lives in `io.ts`, so the format rules stay testable on their own.
 *
 * Layout (one directory per novel):
 *
 * ```
 * novel.yaml                    project metadata
 * chapters/v01/c0001.md         one file per chapter
 * settings/                     world, characters, locations, items, factions, lore
 * settings/lore/                generic worldbuilding cards (a ladder, a system, a rule)
 * outline/book.md               book line and volume structure
 * outline/volumes/v01.md        volume outline and chapter beats
 * style/style-guide.md          voice rules
 * .novel/                       machine data (runs, cache); rebuildable
 * ```
 *
 * A chapter's filename carries its identity (`c0001` = volume 1, chapter 1) so
 * that inserting a chapter later never renumbers anybody's references; the
 * display number lives in frontmatter where a human can change it.
 *
 * @module dsh-ai-novel-copilot/novel/project
 */
import { parseDocument } from './document.ts'
import { roleLabels } from './cards.ts'
import {
  CARD_DIRS,
  CARD_LABELS,
  CARD_TYPES,
  CHAPTERS_DIR,
  MACHINE_DIR,
  cardIdOfPath,
  cardTypeOfPath,
  volumeDir,
  volumeOutlinePath,
  volumeOutlineSkeleton,
  type CardType,
} from './paths.ts'
import { countWords } from './words.ts'

// Re-exported so the project layer stays the single import host code needs.
export { CHAPTERS_DIR, MACHINE_DIR, volumeDir }
export { CARD_DIRS, CARD_LABELS, CARD_TYPES, type CardType }

/** Project metadata file at the novel root. */
export const PROJECT_FILE = 'novel.yaml'

/** Chapter publication state. */
export type ChapterStatus = 'draft' | 'revised' | 'final'

/** One chapter as the tree shows it: metadata plus the measured body length. */
export interface ChapterSummary {
  /** Storage-relative path, e.g. `chapters/v01/c0001.md`. */
  path: string
  /** Stable identity derived from the filename, e.g. `c0001`. */
  id: string
  /** Volume number derived from the directory, e.g. `1`. */
  volume: number
  /** Chapter number shown to the reader. */
  number: number
  /** Chapter title as the tree lists it. */
  title: string
  /** Publication state. */
  status: ChapterStatus
  /** Target length in words, when the outline set one. */
  targetWords?: number
  /** Measured body length. */
  wordCount: number
  /**
   * The chapter's outline beats (format S1: `beats` lives in chapter
   * frontmatter, so the plan and the prose share one file).
   */
  beats: string[]
  /** One-line summary; the first layer of retrieval, and what a later chapter's prompt reads. */
  summary: string
  /** Point-of-view character id, when set. */
  pov?: string
  /** Character card ids this chapter features. */
  characters: string[]
  /** Location card ids this chapter uses. */
  locations: string[]
  /**
   * Ids of the generic `lore` cards this chapter is written against.
   *
   * The worldbuilding a chapter depends on that is neither a person nor a place:
   * a cultivation ladder, a magic system, a rule. They reach the chapter-writing
   * task exactly as `characters` do, which is why "start a chapter, reference the
   * setting" works without touching `characters` (whose meaning is read literally
   * by `pov-unlisted` and by retrieval's "who appears in which chapter").
   */
  refs: string[]
  /**
   * Ids of the chapters this one is written against (format §3.2).
   *
   * The author attaches them by hand in the prose surface (「参考章节」), the way
   * cards are attached: a chapter whose setup happens three chapters back is
   * material the generator must see, and "the immediately previous chapter" is
   * only the default guess at what that is. Every writing task reads the **full
   * text** of each id, which is why the field is capped by the author's own
   * judgement and not by the assembler.
   *
   * Unlike `refs` this is not part of the scaffold, so an old chapter simply has
   * no key — the same shape `pov` uses.
   */
  contextChapters: string[]
  /**
   * Whether the author retired this chapter.
   *
   * The panel's "delete" is archive, for the same reason cards archive: the
   * filesystem seam has no delete primitive at all (`ctx.fs` offers resolve,
   * stat, list, read, write and edit — nothing that removes), and the sandbox
   * policy is the author's own statement about their files. An archived chapter
   * keeps its id and its number, so nothing renumbers, and it can come back.
   */
  archived: boolean
}

/** One volume and its chapters, in display order. */
export interface VolumeSummary {
  /** Volume directory name, e.g. `v01`. */
  dir: string
  /** Volume number derived from the directory name. */
  volume: number
  /**
   * The volume's name, from its outline's frontmatter `title` (format §4.11).
   *
   * Absent when the author has not named the volume: 「第 N 卷」 is then the whole
   * label, and inventing one here would put a name into every prompt and every
   * export that the author never wrote.
   */
  title?: string
  /** Chapters in this volume, ascending by number. */
  chapters: ChapterSummary[]
}

/** One volume as the outline directory reports it. */
export interface VolumeOutline {
  /** Volume number the filename encodes, e.g. `v02` → 2. */
  volume: number
  /** The outline's frontmatter `title`, when it has one. */
  title?: string
}

/** Everything the panel needs to draw the project tree. */
export interface ProjectSnapshot {
  /** Book title. */
  title: string
  /** Genre label, when set. */
  genre?: string
  /** Target total length in words, when set. */
  targetWords?: number
  /**
   * Volumes in ascending order.
   *
   * Archived chapters are included, each carrying its `archived` flag: the tree
   * hides them by default, and only the panel decides what "hide" means.
   */
  volumes: VolumeSummary[]
  /** Number of *live* chapters across every volume. */
  chapterCount: number
  /** Total measured words in live chapters. */
  wordCount: number
  /** How many chapters are archived; excluded from the two counts above. */
  archivedCount: number
  /** Measured words sitting in archived chapters. */
  archivedWords: number
}

/** One file the scaffolder writes. */
export interface ScaffoldFile {
  /** Storage-relative path. */
  path: string
  /** Full file content. */
  content: string
}

/** Zero-padded chapter id for a chapter number. */
export function chapterId(number: number): string {
  return `c${String(number).padStart(4, '0')}`
}

/**
 * Storage-relative path for one chapter.
 * @param volume - volume number.
 * @param number - chapter number.
 * @returns the path the chapter is stored at.
 */
export function chapterPath(volume: number, number: number): string {
  return `${CHAPTERS_DIR}/${volumeDir(volume)}/${chapterId(number)}.md`
}

/**
 * Whether a storage-relative path is a chapter file this project owns.
 * @param path - storage-relative path.
 * @returns true for `chapters/**` Markdown files.
 */
export function isChapterPath(path: string): boolean {
  return path.startsWith(`${CHAPTERS_DIR}/`) && path.endsWith('.md')
}

/** Identity a chapter path encodes, or undefined when it encodes none. */
interface ChapterIdentity {
  volume: number
  number: number
  id: string
}

/**
 * Read the volume and chapter numbers out of a chapter path.
 *
 * The frontmatter is authoritative for display, but a hand-created file with no
 * frontmatter must still appear in the tree, so the path is the fallback source
 * of identity.
 * @param path - storage-relative chapter path.
 * @returns the encoded identity, or undefined when the path does not encode one.
 */
export function identityOfPath(path: string): ChapterIdentity | undefined {
  const match = /^chapters\/v(\d+)\/(c\d+)\.md$/.exec(path)
  if (match === null) return undefined
  const volume = Number(match[1])
  const id = match[2] ?? ''
  const number = Number(id.slice(1))
  if (!Number.isFinite(volume) || !Number.isFinite(number)) return undefined
  return { volume, number, id }
}

/** Read a string field, falling back when absent or blank. */
function stringField(data: Record<string, unknown>, key: string, fallback: string): string {
  const value = data[key]
  return typeof value === 'string' && value.trim() !== '' ? value : fallback
}

/** Read a numeric field, or undefined when absent or not a finite number. */
function numberField(data: Record<string, unknown>, key: string): number | undefined {
  const value = data[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

/**
 * Read a short scalar as display text.
 *
 * `stringField` is for fields the format writes as strings; `age` and `gender`
 * are things an author writes however they like (`age: 19`, `sex: 男`,
 * `gender: 十九岁`), and a number arriving where text was expected must still
 * reach the panel and the prompt rather than silently vanishing.
 * @param data - frontmatter data.
 * @param key - field name.
 * @returns the text, or undefined when the field is absent or blank.
 */
function textField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  if (typeof value === 'string') return value.trim() === '' ? undefined : value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

/** Read a status field, defaulting to `draft` for anything unrecognized. */
function statusField(data: Record<string, unknown>): ChapterStatus {
  const value = data.status
  return value === 'revised' || value === 'final' ? value : 'draft'
}

/**
 * Read a list-of-strings field, dropping blank and non-string entries.
 *
 * Frontmatter is hand-editable, so a scalar where a list was expected (`pov:
 * chen-mo` is a string field, but nothing stops an author writing it as a list)
 * must not break the scan.
 * @param data - frontmatter data.
 * @param key - field name.
 * @returns the entries, or an empty array.
 */
function stringArrayField(data: Record<string, unknown>, key: string): string[] {
  const value = data[key]
  if (typeof value === 'string') return value.trim() === '' ? [] : [value.trim()]
  if (!Array.isArray(value)) return []
  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map(entry => entry.trim())
    .filter(entry => entry !== '')
}

/**
 * Summarize one chapter file for the project tree.
 * @param path - storage-relative chapter path.
 * @param text - the whole file, as stored.
 * @returns the summary the tree lists.
 */
export function summarizeChapter(path: string, text: string): ChapterSummary {
  const { data, body } = parseDocument(text)
  return summarizeParsedChapter(path, data, body)
}

/**
 * Summarize an already-parsed chapter.
 *
 * Split from {@link summarizeChapter} so a caller that needs the prose too — the
 * search scan, which indexes bodies as well as frontmatter — parses each file
 * once instead of twice.
 * @param path - storage-relative chapter path.
 * @param data - the file's frontmatter, already parsed.
 * @param body - the file's prose.
 * @returns the summary the tree lists.
 */
export function summarizeParsedChapter(
  path: string,
  data: Record<string, unknown>,
  body: string,
): ChapterSummary {
  const identity = identityOfPath(path)
  const number = numberField(data, 'number') ?? identity?.number ?? 0
  const targetWords = numberField(data, 'targetWords')
  const pov = stringField(data, 'pov', '')
  return {
    path,
    id: stringField(data, 'id', identity?.id ?? chapterId(number)),
    volume: numberField(data, 'volume') ?? identity?.volume ?? 0,
    number,
    title: stringField(data, 'title', `第 ${String(number)} 章`),
    status: statusField(data),
    ...(targetWords === undefined ? {} : { targetWords }),
    wordCount: countWords(body),
    beats: stringArrayField(data, 'beats'),
    summary: stringField(data, 'summary', ''),
    ...(pov === '' ? {} : { pov }),
    characters: stringArrayField(data, 'characters'),
    locations: stringArrayField(data, 'locations'),
    refs: stringArrayField(data, 'refs'),
    contextChapters: stringArrayField(data, 'contextChapters'),
    archived: data.archived === true,
  }
}

/**
 * Which chapters reference each setting card.
 *
 * The format keeps references one-way — a chapter names card ids, a card never
 * lists its chapters — so this derived view is the only place the reverse
 * direction exists. It is rebuilt on every scan rather than stored, because a
 * stored copy would be a second truth that can disagree with the first.
 *
 * `contextChapters` is deliberately **not** indexed here: those ids name
 * chapters, not cards, and the id spaces are separate — a chapter id that
 * happens to equal a card id would otherwise make that card claim an appearance
 * in a chapter that never mentioned it.
 * @param chapters - scanned chapter summaries.
 * @returns card id → chapter ids, in chapter order.
 */
export function referenceIndex(chapters: readonly ChapterSummary[]): Map<string, string[]> {
  const index = new Map<string, string[]>()
  const add = (cardId: string, chapterId: string): void => {
    const bucket = index.get(cardId)
    if (bucket === undefined) index.set(cardId, [chapterId])
    else if (!bucket.includes(chapterId)) bucket.push(chapterId)
  }
  for (const chapter of chapters) {
    if (chapter.pov !== undefined) add(chapter.pov, chapter.id)
    for (const id of chapter.characters) add(id, chapter.id)
    for (const id of chapter.locations) add(id, chapter.id)
    for (const id of chapter.refs) add(id, chapter.id)
  }
  return index
}

/**
 * Group chapter summaries into volumes, each sorted by chapter number.
 * @param chapters - summaries in any order.
 * @returns volumes ascending by number.
 */
export function groupVolumes(chapters: readonly ChapterSummary[]): VolumeSummary[] {
  const byVolume = new Map<number, ChapterSummary[]>()
  for (const chapter of chapters) {
    const bucket = byVolume.get(chapter.volume)
    if (bucket === undefined) byVolume.set(chapter.volume, [chapter])
    else bucket.push(chapter)
  }
  return [...byVolume.entries()]
    .sort(([left], [right]) => left - right)
    .map(([volume, items]) => ({
      dir: volumeDir(volume),
      volume,
      chapters: [...items].sort((left, right) => left.number - right.number),
    }))
}

/**
 * The book's volumes, from both sources that can create one.
 *
 * **A volume exists when its outline file does, not only when it has chapters.**
 * That is the whole point of being able to plan ahead: the author lays out 第二卷
 * (its 卷目标, 卷冲突, 卷末状态) before writing a word of it, and every surface
 * that offers a volume — the outline page, the chapter tree, the export scope, a
 * task's 「本卷」 — has to be able to see it in the meantime. Deriving volumes from
 * `chapters/vNN/` alone, which is what the tree used to do, made a planned volume
 * invisible until its first chapter existed, and there was no way to create that
 * chapter *into* it either.
 *
 * The chapter side wins when both know about a volume; only the name comes from
 * the outline.
 * @param chapters - every chapter summary, archived ones included.
 * @param outlines - every volume outline that exists on disk.
 * @returns volumes ascending by number, each carrying its chapters and its name.
 */
export function mergeVolumes(
  chapters: readonly ChapterSummary[],
  outlines: readonly VolumeOutline[],
): VolumeSummary[] {
  const merged = new Map<number, VolumeSummary>()
  for (const volume of groupVolumes(chapters)) {
    merged.set(volume.volume, volume)
  }
  for (const outline of outlines) {
    const existing = merged.get(outline.volume)
    if (existing === undefined) {
      merged.set(outline.volume, {
        dir: volumeDir(outline.volume),
        volume: outline.volume,
        ...(outline.title === undefined ? {} : { title: outline.title }),
        chapters: [],
      })
    } else if (outline.title !== undefined) {
      existing.title = outline.title
    }
  }
  return [...merged.values()].sort((left, right) => left.volume - right.volume)
}

/**
 * Total measured words across a project.
 * @param volumes - grouped chapters.
 * @returns the sum of every chapter's word count.
 */
export function totalWords(volumes: readonly VolumeSummary[]): number {
  return volumes.reduce(
    (sum, volume) => sum + volume.chapters.reduce((inner, chapter) => inner + chapter.wordCount, 0),
    0,
  )
}

/**
 * The next free chapter number — **for the whole book**, not for one volume.
 *
 * Chapter numbers run continuously across volumes (format §3.1): 第三卷第一章 is
 * 第 3 章 when the first two volumes hold two chapters. That is what keeps a
 * chapter's id (`c0003`, derived from its number) unique, and ids are what every
 * reference in the project points at — a per-volume restart would mint a second
 * `c0001` in 第二卷 and make 伏笔's `plantedIn`, the timeline and 参考章节 ambiguous
 * about which chapter they mean.
 *
 * Archived chapters count: they keep their number (format §4.6), so the number
 * they hold is not free.
 * @param volumes - every volume, chapters included, outlines included.
 * @returns one past the highest chapter number in the book, or 1.
 */
export function nextChapterNumber(volumes: readonly VolumeSummary[]): number {
  const numbers = volumes.flatMap(volume => volume.chapters.map(chapter => chapter.number))
  return numbers.length === 0 ? 1 : Math.max(...numbers) + 1
}

/**
 * A foreshadowing thread's life, as its card records it.
 *
 * **The card is the single truth.** Chapter frontmatter deliberately does not
 * list the threads it plants (format §3.2), so this is the only place the answer
 * exists; every consumer — the retrieval answer, the consistency rules, the
 * panel's thread surface — reads it from here rather than keeping its own copy.
 * That is why there is one shape and not two: `search.ts` used to declare its own
 * `SearchThreadLifecycle` with the same fields, which is exactly the second truth
 * the format forbids, and it is where a new field would have been forgotten.
 */
export interface ThreadRecord {
  /** `planted` | `reinforced` | `paid` | `abandoned`, or empty when unset. */
  status: string
  /** Chapter id the thread was planted in. */
  plantedIn?: string
  /**
   * The sentence that plants it, so the panel can put the cursor on it.
   *
   * A quote rather than a character offset on purpose: an offset is invalidated
   * by every edit above it, while a quote survives edits elsewhere in the
   * chapter and, when the author rewrites that very sentence, fails *visibly*
   * (the panel says it could not find it) instead of silently pointing at
   * whatever now occupies those characters.
   */
  plantedQuote?: string
  /** Chapters that reinforce it. */
  reinforcedIn: string[]
  /** Where the author plans to pay it off; may be prose (`第一卷末`). */
  plannedPayoff?: string
  /** Chapters that actually pay it off. */
  payoffIn: string[]
  /** The sentence that pays it off (same reasoning as {@link plantedQuote}). */
  payoffQuote?: string
}

/** One setting card as the library lists it. */
export interface CardSummary {
  /** Storage-relative path, e.g. `settings/characters/chen-mo.md`. */
  path: string
  /** Stable identity derived from the filename. */
  id: string
  /** Card type, derived from the directory. */
  type: CardType
  /** Display name (`name`, or a thread's `title`, or the id). */
  name: string
  /** Alternative names, used for retrieval and conflict detection. */
  aliases: string[]
  /**
   * Free-form role labels (a character's `role`, a faction's stance…).
   *
   * The field holds **one label or a list of labels** (format §4.3): a character
   * can be 「主角」and「前朝皇子」at once. The summary joins them with `、`, which is
   * also how they reach a prompt.
   */
  role?: string
  /**
   * A character's age, as written.
   *
   * Text rather than a number because the format's `age: 19` is a convention, not
   * a rule: `十九` and `19` are both things an author writes, and a card whose age
   * vanished on the way to the panel would be a field nobody could trust.
   */
  age?: string
  /**
   * A character's gender (format §4.3), as written.
   *
   * The model gets this — see `cardFacts` in `client/tasks.ts` — because it is
   * exactly the kind of fact a generator gets wrong on its own.
   */
  gender?: string
  /**
   * The card's `status` field, verbatim: a thread's lifecycle
   * (`planted`/`reinforced`/`paid`/`abandoned`), empty otherwise.
   */
  status: string
  /**
   * Whether the author retired this card.
   *
   * A separate field rather than a `status` value on purpose: a thread's
   * `status` is its lifecycle, and overloading one field with two meanings is
   * how a format starts lying. Archiving is also the whole of "delete" here —
   * `ctx.fs` has no unlink, and the sandbox seam is the only door to disk.
   */
  archived: boolean
  /** Free-form tags. */
  tags: string[]
  /** First chapter the card names, when set. */
  firstAppear?: string
  /** Chapters that reference this card, derived from chapter frontmatter. */
  appearsIn: string[]
  /** The thread's life, for a thread card; absent for every other type. */
  thread?: ThreadRecord
  /** First non-empty body line, as a one-line gist for the list. */
  gist: string
}

/** One type's worth of cards, as the library groups them. */
export interface CardGroup {
  /** Card type. */
  type: CardType
  /** Human-readable group label. */
  label: string
  /** Directory name under `settings/`. */
  dir: string
  /** Cards of this type, active first, each in scan order. */
  cards: CardSummary[]
}

/**
 * The first line of a body that actually says something.
 *
 * Headings are skipped rather than returned: every card starts with the same
 * section headings (`## 外貌`, `## 性格`), so a gist that read "外貌" would be
 * identical on every card and worth nothing.
 * @param body - everything after the frontmatter.
 * @returns the first content line, trimmed to a list-friendly length.
 */
function gistOf(body: string): string {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const plain = line.replace(/^[ \t]*[-*+][ \t]*/, '').trim()
    if (plain === '') continue
    return plain.length > 80 ? `${plain.slice(0, 80)}…` : plain
  }
  return ''
}

/**
 * Summarize one setting card for the library list.
 * @param path - storage-relative card path.
 * @param text - the whole file, as stored.
 * @param appearsIn - chapters derived to reference this card.
 * @returns the summary the library lists.
 */
export function summarizeCard(path: string, text: string, appearsIn: readonly string[]): CardSummary | undefined {
  const { data, body } = parseDocument(text)
  const summary = summarizeParsedCard(path, data, body)
  return summary === undefined ? undefined : { ...summary, appearsIn: [...appearsIn] }
}

/**
 * Summarize an already-parsed setting card, without its reverse links.
 *
 * Split from {@link summarizeCard} for the same reason {@link summarizeParsedChapter}
 * was split from {@link summarizeChapter}: the project scan reads and parses every
 * card anyway, and re-parsing each file to summarize it would pay the YAML cost
 * twice. `appearsIn` is deliberately **not** part of the result — it is derived
 * from the chapters, not from the card, so it belongs to whoever built the
 * reverse index and must be applied on top.
 * @param path - storage-relative card path.
 * @param data - the card's frontmatter, already parsed.
 * @param body - the card's body.
 * @returns the card's own summary, or undefined when the path is not a card.
 */
export function summarizeParsedCard(
  path: string,
  data: Record<string, unknown>,
  body: string,
): CardSummary | undefined {
  const type = cardTypeOfPath(path)
  const id = cardIdOfPath(path)
  if (type === undefined || id === undefined) return undefined
  const role = roleLabels(data.role).join('、')
  const firstAppear = stringField(data, 'firstAppear', '')
  const name = stringField(data, 'name', stringField(data, 'title', id))
  const age = textField(data, 'age')
  const gender = textField(data, 'gender')
  return {
    path,
    id,
    type,
    name,
    aliases: stringArrayField(data, 'aliases'),
    ...(role === '' ? {} : { role }),
    ...(age === undefined ? {} : { age }),
    ...(gender === undefined ? {} : { gender }),
    status: stringField(data, 'status', ''),
    archived: data.archived === true,
    tags: stringArrayField(data, 'tags'),
    ...(firstAppear === '' ? {} : { firstAppear }),
    appearsIn: [],
    ...(type === 'thread' ? { thread: readThread(data) } : {}),
    gist: gistOf(body),
  }
}

/**
 * Read a thread card's life out of its frontmatter.
 *
 * Absent fields stay absent rather than becoming empty strings: "no plan for the
 * payoff yet" and "the plan is the empty string" are different facts, and the
 * consistency rules (`checks.ts`) depend on telling them apart — a
 * `plannedPayoff` written as prose is not judged at all, while a missing one
 * simply means nobody has planned it.
 * @param data - the card's frontmatter.
 * @returns the thread's record, with every field the format defines.
 */
export function readThread(data: Record<string, unknown>): ThreadRecord {
  const plantedIn = stringField(data, 'plantedIn', '')
  const plantedQuote = stringField(data, 'plantedQuote', '')
  const plannedPayoff = stringField(data, 'plannedPayoff', '')
  const payoffQuote = stringField(data, 'payoffQuote', '')
  return {
    status: stringField(data, 'status', ''),
    ...(plantedIn === '' ? {} : { plantedIn }),
    ...(plantedQuote === '' ? {} : { plantedQuote }),
    reinforcedIn: stringArrayField(data, 'reinforcedIn'),
    ...(plannedPayoff === '' ? {} : { plannedPayoff }),
    payoffIn: stringArrayField(data, 'payoffIn'),
    ...(payoffQuote === '' ? {} : { payoffQuote }),
  }
}

/**
 * The chapters a thread's record names, in lifecycle order.
 *
 * Derived rather than stored: it is the same three fields the record already
 * carries, and a stored copy is how a summary starts disagreeing with the card
 * it summarises. Used to rank a thread in retrieval (its chapters read as its
 * outline).
 * @param thread - the thread's record.
 * @returns the chapter ids, planted first.
 */
export function threadChaptersOf(thread: ThreadRecord): string[] {
  return [
    ...(thread.plantedIn === undefined ? [] : [thread.plantedIn]),
    ...thread.reinforcedIn,
    ...thread.payoffIn,
  ].filter((entry, index, all) => entry !== '' && all.indexOf(entry) === index)
}

/**
 * Group cards by type, in the format's display order, dropping empty groups.
 * @param cards - summaries in any order.
 * @returns one group per non-empty type.
 */
export function groupCards(cards: readonly CardSummary[]): CardGroup[] {
  return CARD_TYPES
    .map(type => ({
      type,
      label: CARD_LABELS[type],
      dir: CARD_DIRS[type],
      cards: cards
        .filter(card => card.type === type)
        .sort((left, right) => {
          if (left.archived !== right.archived) return left.archived ? 1 : -1
          return left.name.localeCompare(right.name, 'zh-Hans-CN')
        }),
    }))
    .filter(group => group.cards.length > 0)
}

/**
 * The files a new project starts life with.
 *
 * Every one is a readable Markdown skeleton rather than an empty file: the
 * author's first move is to edit prose, not to invent a structure.
 * @param title - book title.
 * @returns files to write, in creation order.
 */
export function scaffoldFiles(title: string): ScaffoldFile[] {
  const first = chapterPath(1, 1)
  return [
    {
      path: PROJECT_FILE,
      content: [
        `title: ${JSON.stringify(title)}`,
        'genre: 中文长篇网文',
        'targetWords: 1000000',
        'currentVolume: 1',
        '',
      ].join('\n'),
    },
    {
      path: 'settings/world.md',
      content: [
        '---',
        'type: world',
        `title: ${JSON.stringify(`${title}·世界观`)}`,
        '---',
        '',
        '## 一句话设定',
        '## 力量体系',
        '## 地理与社会',
        '## 不可违背的设定（硬约束）',
        '',
      ].join('\n'),
    },
    {
      path: 'outline/book.md',
      content: [
        `# ${title}·全书主线`,
        '',
        '## 核心卖点',
        '## 主角弧光',
        '## 卷结构',
        '',
      ].join('\n'),
    },
    {
      path: volumeOutlinePath(1),
      // The same skeleton the panel's 「新建卷」 writes (`paths.ts`): a project
      // scaffolded today and a volume added tomorrow must look alike.
      content: volumeOutlineSkeleton(1),
    },
    {
      path: 'style/style-guide.md',
      content: [
        '# 文风规则',
        '',
        '- 人称与叙述距离：',
        '- 句长与节奏：',
        '- 禁用词与 AI 味清单：',
        '',
      ].join('\n'),
    },
    {
      path: first,
      content: [
        '---',
        'id: c0001',
        'volume: 1',
        'number: 1',
        'title: 第一章',
        'status: draft',
        'targetWords: 3000',
        'beats: []',
        'summary: ""',
        'characters: []',
        'locations: []',
        'refs: []',
        'tags: []',
        '---',
        '',
        '',
      ].join('\n'),
    },
  ]
}
