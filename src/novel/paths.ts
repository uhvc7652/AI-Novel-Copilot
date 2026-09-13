/**
 * Path and identity rules, with no dependencies.
 *
 * These are format rules shared by the host and the browser panel: the host
 * derives identity while scanning, and the panel derives volume and card paths
 * while assembling a prompt or a create request. Keeping them here rather than
 * in `project.ts` is what lets the browser bundle use them without inheriting
 * the host's YAML dependency.
 *
 * @module dsh-ai-novel-copilot/novel/paths
 */

/** Directory holding chapter files. */
export const CHAPTERS_DIR = 'chapters'

/** Machine-data directory; safe to delete and rebuild. */
export const MACHINE_DIR = '.novel'

/** Directory holding setting cards and the world/timeline files. */
export const SETTINGS_DIR = 'settings'

/** Directory holding the book outline and the volume outlines. */
export const OUTLINE_DIR = 'outline'

/** Directory holding the voice guide and the style samples. */
export const STYLE_DIR = 'style'

/**
 * Directory holding exported manuscripts (format §1: derived, not in git).
 *
 * It is deliberately **not** part of {@link isDocumentPath}: an export is a
 * product, not an editable document, so it has no editor surface and no entry in
 * the modification record. Re-running an export writes a new file (the name
 * carries a timestamp) rather than replacing one the author may still be reading.
 */
export const EXPORTS_DIR = 'exports'

/** Zero-padded volume directory name for a volume number. */
export function volumeDir(volume: number): string {
  return `v${String(volume).padStart(2, '0')}`
}

/**
 * The directory under `settings/` for each card type.
 *
 * A card's type is its directory, not a lookup table in code: adding a type is
 * adding an entry here plus a `type` value, exactly as the format document's
 * extension rule promises.
 */
export const CARD_DIRS = {
  character: 'characters',
  location: 'locations',
  item: 'items',
  faction: 'factions',
  lore: 'lore',
  thread: 'threads',
} as const

/** One setting-card type. */
export type CardType = keyof typeof CARD_DIRS

/** Every card type, in display order. */
export const CARD_TYPES = Object.keys(CARD_DIRS) as CardType[]

/**
 * Human-readable label for a card type, for the panel's group headings.
 *
 * 「设定」 is the generic one (`lore`): whatever is true of the book but is not a
 * person, a place, a thing or a faction — a cultivation ladder, a magic system,
 * a term, a rule of the world. It exists so that material like 「每个流派的境界
 * 阶梯」 has somewhere to live that is neither the world overview (which the
 * model check reads whole) nor a card type it does not fit.
 */
export const CARD_LABELS: Record<CardType, string> = {
  character: '角色',
  location: '地点',
  item: '物品',
  faction: '势力',
  lore: '设定',
  thread: '伏笔',
}

/** The world overview, a single file rather than a card. */
export const WORLD_FILE = `${SETTINGS_DIR}/world.md`

/** The timeline, a single file rather than a card. */
export const TIMELINE_FILE = `${SETTINGS_DIR}/timeline.md`

/** The book outline: main line, selling point, volume structure. */
export const BOOK_OUTLINE_FILE = `${OUTLINE_DIR}/book.md`

/** The voice rules; a plain Markdown file with no frontmatter requirement. */
export const STYLE_GUIDE_FILE = `${STYLE_DIR}/style-guide.md`

/** Storage-relative path of a volume's outline. */
export function volumeOutlinePath(volume: number): string {
  return `${OUTLINE_DIR}/volumes/${volumeDir(volume)}.md`
}

/**
 * Whether a string is usable as a card id.
 *
 * The format fixes ids to lowercase ASCII slugs (`chen-mo`, `qingshi-town`),
 * because the id is the filename and the path must survive every filesystem.
 * A Chinese display name belongs in the card's `name` field, never in the path.
 * @param value - the candidate id.
 * @returns true when it is a valid slug.
 */
export function isSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(value) && value.length <= 64
}

/**
 * Storage-relative path for one setting card.
 * @param type - card type.
 * @param id - slug id.
 * @returns the path the card is stored at.
 */
export function cardPath(type: CardType, id: string): string {
  return `${SETTINGS_DIR}/${CARD_DIRS[type]}/${id}.md`
}

/**
 * The card id a storage-relative path encodes.
 * @param path - storage-relative path.
 * @returns the id, or undefined when the path is not a card path.
 */
export function cardIdOfPath(path: string): string | undefined {
  const match = /^settings\/[a-z]+\/([^/]+)\.md$/.exec(path)
  return match?.[1]
}

/**
 * The card type a storage-relative path encodes.
 * @param path - storage-relative path.
 * @returns the type, or undefined when the directory is not a card directory.
 */
export function cardTypeOfPath(path: string): CardType | undefined {
  const match = /^settings\/([a-z]+)\/[^/]+\.md$/.exec(path)
  const dir = match?.[1]
  if (dir === undefined) return undefined
  const found = CARD_TYPES.find(type => CARD_DIRS[type] === dir)
  return found
}

/**
 * Whether a storage-relative path is a setting card.
 * @param path - storage-relative path.
 * @returns true for `settings/<cardDir>/<id>.md`.
 */
export function isCardPath(path: string): boolean {
  return cardTypeOfPath(path) !== undefined && cardIdOfPath(path) !== undefined
}

/**
 * The chapter id a storage-relative path encodes (format §3.1).
 *
 * The browser needs this whenever it has to name a chapter in a reference — a
 * thread's `plantedIn`/`payoffIn` holds ids, not paths — and it cannot import
 * `project.ts` for it: that module pulls in the YAML parser, which has no
 * business in the client bundle.
 * @param path - storage-relative path.
 * @returns the id, or undefined when the path is not a chapter path.
 */
export function chapterIdOfPath(path: string): string | undefined {
  return /^chapters\/[^/]+\/([^/]+)\.md$/.exec(path)?.[1]
}

/**
 * Whether a storage-relative path is one of the single-file settings pages.
 * @param path - storage-relative path.
 * @returns true for `settings/world.md` and `settings/timeline.md`.
 */
export function isSettingsPage(path: string): boolean {
  return path === WORLD_FILE || path === TIMELINE_FILE
}

/**
 * Whether a storage-relative path is a frontmatter document this plugin edits.
 *
 * One whitelist for every editable document — chapters, setting cards, outlines,
 * the voice guide — so the panel's document channel cannot be pointed at
 * `novel.yaml`, `.novel/`, or anything else outside the four content trees.
 * @param path - storage-relative path.
 * @returns true when the path is an editable Markdown document.
 */
export function isDocumentPath(path: string): boolean {
  if (!path.endsWith('.md')) return false
  return [CHAPTERS_DIR, SETTINGS_DIR, OUTLINE_DIR, STYLE_DIR].some(dir => path.startsWith(`${dir}/`))
}

/** Directory holding every document's modification history. */
export const HISTORY_DIR = `${MACHINE_DIR}/history`

/**
 * The next free id for a thread card.
 *
 * The panel generates these when the author records a foreshadowing from the
 * editor: there they are naming a *foreshadowing*, not a file, and asking for a
 * slug would be asking them to do the machine's job.
 *
 * The `th-` prefix rather than `fs-` on purpose — `03` §4.4's example thread id
 * and the location-card examples are both `fs-NNN`, and two trees sharing a
 * prefix in the same document is how a reader starts confusing them.
 *
 * Only ids of the same shape count, so a hand-written `mirror-origin` neither
 * blocks nor advances the sequence.
 * @param existing - every thread id already in the project.
 * @returns an unused id, zero-padded to three digits.
 */
export function nextThreadId(existing: readonly string[]): string {
  let highest = 0
  for (const id of existing) {
    const match = /^th-(\d+)$/.exec(id)
    if (match?.[1] !== undefined) highest = Math.max(highest, Number(match[1]))
  }
  return `th-${String(highest + 1).padStart(3, '0')}`
}

/**
 * The history directory for one document.
 *
 * The requirement names `.novel/history/<章节 id>/<时间戳>.json`, and this keeps
 * that shape while widening "章节 id" to "the document's path without `.md`".
 * Two reasons, both structural rather than cosmetic:
 *
 * 1. M7 records every editable document, not only chapters — a card, a volume
 *    outline, and `style/style-guide.md` are all saved by the same panel channel
 *    and all deserve an undo.
 * 2. A chapter id and a card id are both plain slugs (`c0001`, `chen-mo`), so
 *    keying by id alone would let two different documents share one history
 *    directory the first time an author names a card `c0001`.
 * @param path - storage-relative document path.
 * @returns the directory holding that document's versions.
 */
export function historyDirOf(path: string): string {
  return `${HISTORY_DIR}/${path.replace(/\.md$/, '')}`
}

/**
 * The filename stem for one version.
 *
 * Colons are illegal in Windows filenames and both colons and dots read badly in
 * a directory listing, so an ISO timestamp loses them; `.novel/runs/` has used
 * the same shape since P1. Milliseconds are kept: two saves in the same second
 * are ordinary, two in the same millisecond are not, and the writer still guards
 * against the latter rather than trusting the clock.
 * @param at - the ISO timestamp the version is recorded under.
 * @returns a filename-safe stem.
 */
export function historyStamp(at: string): string {
  return at.replace(/[:.]/g, '-')
}

/**
 * Order two history filenames oldest first.
 *
 * **Filenames do not sort correctly on their own**, which is not obvious and is
 * why this exists: if two saves ever shared a millisecond, the second would get
 * a `-2` suffix and `…-123Z-2.json` sorts *before* `…-123Z.json`, because `-` is
 * below `.`. The list takes the newest N by filename, so a naive ordering would
 * drop the newer of such a pair and keep the older — a silently missing version,
 * which is the one failure this record must not have.
 *
 * The fix is upstream of this comparator ({@link freeHistoryStamp} keeps the
 * timestamps themselves unique, so no suffix is ever needed), but the ordering
 * rule is stated here rather than left implicit: the list must sort by something
 * that means time, and the base stamp does — an ISO timestamp compared as
 * characters is already chronological, since every field but the year is
 * zero-padded.
 * @param left - one history filename.
 * @param right - the other.
 * @returns negative when `left` is older.
 */
export function compareHistoryFiles(left: string, right: string): number {
  const split = (name: string): { base: string, ordinal: number } => {
    const stem = name.endsWith('.json') ? name.slice(0, -'.json'.length) : name
    // The base stamp always ends with `Z`, so a trailing `-<digits>` can only be
    // a collision ordinal from an older version of this file's writer.
    const match = /-(\d+)$/.exec(stem)
    if (match === null || match.index === undefined) return { base: stem, ordinal: 1 }
    return { base: stem.slice(0, match.index), ordinal: Number(match[1]) }
  }
  const a = split(left)
  const b = split(right)
  if (a.base !== b.base) return a.base < b.base ? -1 : 1
  return a.ordinal - b.ordinal
}

/** The history file one version of one document lives in. */
export function historyFileOf(path: string, at: string): string {
  return `${historyDirOf(path)}/${historyStamp(at)}.json`
}

/**
 * The first timestamp at or after `at` that no version already uses.
 *
 * A version's identity **is** its timestamp: the panel names one to read and to
 * roll back to, so two versions sharing a timestamp are not merely untidy, they
 * are unreachable — the lookup finds whichever the directory happened to list
 * first, which in testing meant a rollback restoring the wrong version.
 *
 * So uniqueness is established here rather than patched at the filename. The
 * cost is that a second version recorded inside the same millisecond is stamped
 * one millisecond later than the clock said, which is a rounding of a derived
 * value rather than a fact about the author's text.
 * @param taken - the filenames already present in the document's history directory.
 * @param at - the ISO timestamp to start from.
 * @returns a free ISO timestamp, or undefined when a thousand consecutive milliseconds are all taken.
 */
export function freeHistoryStamp(taken: ReadonlySet<string>, at: string): string | undefined {
  let ms = Date.parse(at)
  if (!Number.isFinite(ms)) return undefined
  for (let step = 0; step < 1000; step += 1) {
    const candidate = new Date(ms).toISOString()
    if (!taken.has(`${historyStamp(candidate)}.json`)) return candidate
    ms += 1
  }
  return undefined
}
