/**
 * The panel's project memory: which novels have been opened, most recent first.
 *
 * The panel used to remember only the *text* in the path box, so reopening the
 * tab gave back a string and the author still had to find the book again. This
 * module keeps the last few projects the author actually opened, so the panel
 * can return to the last one on mount and offer the others in one click.
 *
 * Storage is `localStorage`, which a restricted browser may refuse: every entry
 * point here takes an optional store and degrades to "no memory" rather than
 * throwing. The parsing is deliberately total — a hand-edited or truncated value
 * yields an empty list, never a broken panel.
 *
 * ## This is the cache, not the memory
 *
 * `localStorage` is keyed by page origin, and the panel is served on whatever
 * port DSH was started with — so the same book on a different port produced an
 * empty list. The authoritative copy is the host's file
 * (`novel/recents.ts`); what lives here is the copy that makes the first paint
 * instant and survives a host that cannot write. {@link mergeRecents} folds the
 * two together, and the panel shows that.
 *
 * @module dsh-ai-novel-copilot/client/projects
 */

/**
 * One project the author has opened.
 *
 * Re-exported from the shared, dependency-free module both halves read, so the
 * two cannot drift apart. It deliberately does **not** come from
 * `novel/recents.ts`: that module touches `node:fs`, and this file is bundled
 * for the browser (README lesson 8).
 */
export type { RecentProject } from '../novel/recents-key.ts'
import type { RecentProject } from '../novel/recents-key.ts'
import { RECENTS_LIMIT, projectKey } from '../novel/recents-key.ts'

/** Storage key holding the recent list. */
export const RECENTS_KEY = 'dsh-ai-novel-copilot.projects'

/** How many projects to remember — re-exported, so both halves cap the same. */
export { RECENTS_LIMIT }

/** The slice of Web Storage this module uses. */
export interface RecentStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * The browser's storage, or undefined when it refuses to be read.
 * @returns the storage, or undefined.
 */
export function browserStorage(): RecentStorage | undefined {
  try {
    return globalThis.localStorage ?? undefined
  } catch {
    // A blocked storage API is not worth failing the panel over.
    return undefined
  }
}

/**
 * Fold the host's list and the browser's cached list into the one to show.
 *
 * Neither side may win outright, and that is the whole point of the function:
 *
 * - **The host file is authoritative**, because it is the copy that does not
 *   depend on which port the panel was served from.
 * - **The browser's copy is still unioned in**, because it is the only thing
 *   that survives a host that cannot write its home directory, and it is what
 *   the panel shows before the host has answered.
 *
 * Duplicates are folded by `root`, keeping whichever side recorded it more
 * recently (so a rename is picked up from either side), and the result is capped
 * like every other write. A path is normalised before comparing for the same
 * reason as the host's dedupe: two spellings of one directory are one project.
 * @param host - the entries the host remembered.
 * @param browser - the entries the browser cached.
 * @param limit - how many entries to keep.
 * @returns the merged list, newest first.
 */
export function mergeRecents(
  host: readonly RecentProject[],
  browser: readonly RecentProject[],
  limit: number = RECENTS_LIMIT,
): RecentProject[] {
  const folded = new Map<string, RecentProject>()
  // The browser's list goes in first so that the host's entry of the same
  // project overwrites it only on `at` — not on iteration order, which would
  // make the outcome depend on which side was passed first.
  for (const entry of [...browser, ...host]) {
    const at = projectKey(entry.root)
    const current = folded.get(at)
    if (current === undefined || entry.at >= current.at) folded.set(at, entry)
  }
  return [...folded.values()].sort((left, right) => right.at - left.at).slice(0, limit)
}

/**
 * Whether a parsed value is a usable entry.
 */
function isRecent(value: unknown): value is RecentProject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return typeof entry.root === 'string' && entry.root !== ''
    && typeof entry.title === 'string'
    && typeof entry.at === 'number' && Number.isFinite(entry.at)
}

/**
 * Parse a stored recent list.
 * @param text - the raw stored value.
 * @returns the usable entries, newest first; an empty list for anything else.
 */
export function parseRecents(text: string | null | undefined): RecentProject[] {
  if (text === null || text === undefined || text === '') return []
  try {
    const value: unknown = JSON.parse(text)
    if (!Array.isArray(value)) return []
    return value
      .filter(isRecent)
      .map(entry => ({ root: entry.root, title: entry.title, at: entry.at }))
      .sort((left, right) => right.at - left.at)
  } catch {
    return []
  }
}

/**
 * Read the remembered projects.
 * @param target - storage to read; defaults to the browser's.
 * @returns the entries, newest first.
 */
export function loadRecents(target: RecentStorage | undefined = browserStorage()): RecentProject[] {
  if (target === undefined) return []
  try {
    return parseRecents(target.getItem(RECENTS_KEY))
  } catch {
    return []
  }
}

/**
 * Persist the remembered projects.
 * @param list - the entries to store.
 * @param target - storage to write; defaults to the browser's.
 */
export function saveRecents(list: readonly RecentProject[], target: RecentStorage | undefined = browserStorage()): void {
  if (target === undefined) return
  try {
    target.setItem(RECENTS_KEY, JSON.stringify(list))
  } catch {
    // A full or read-only store costs the memory, not the session.
  }
}

/**
 * Move one project to the front of the list.
 *
 * Dedupe is by root, not by title: a book that was renamed is the same project,
 * and keeping both would offer the author two doors to one room.
 * @param list - the current entries.
 * @param entry - the project just opened.
 * @param limit - how many entries to keep.
 * @returns the new list, newest first.
 */
export function rememberProject(
  list: readonly RecentProject[],
  entry: RecentProject,
  limit: number = RECENTS_LIMIT,
): RecentProject[] {
  return [entry, ...list.filter(item => item.root !== entry.root)].slice(0, limit)
}

/**
 * One-line label for a remembered project.
 * @param entry - the entry.
 * @returns the book title in brackets, falling back to the path.
 */
export function recentLabel(entry: RecentProject): string {
  return entry.title === '' ? entry.root : `《${entry.title}》`
}
