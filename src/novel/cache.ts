/**
 * The incremental read-through cache behind every whole-project scan.
 *
 * `06` §2.1 and `07` §5 both recorded the same deliberate trade: the search
 * corpus and the check corpus were rebuilt from disk on every request, because
 * that is what makes "the answer comes from what is on disk right now" true.
 * Both named P5 as where that becomes incremental. This is that layer.
 *
 * ## What it caches, and what it never caches
 *
 * It caches **bytes and the parse of those bytes** — a file's text, its parsed
 * frontmatter, its body, and a value derived from that file alone. It never
 * caches a verdict about the project: every scan still lists the directories and
 * compares each file's freshness token with the one it parsed, so a chapter
 * rewritten by an outside editor is re-read on the very next request. The only
 * thing that is not re-read is a file whose token is byte-for-byte the same one
 * it had when it was parsed, which is the same guarantee `dsh-fs-local`'s own
 * guarded writes rest on (`dev:ino:size:mtimeNs:ctimeNs` — a token that changes
 * on every write, including two writes inside one millisecond).
 *
 * A backend that reports no version is handled by **not caching**: when neither
 * the directory listing nor a stat can produce a token, the file is re-read
 * every time. Degrading to the old behaviour is the honest failure; serving a
 * parse whose freshness cannot be checked would be the dishonest one.
 *
 * ## Why two caches and not one index file
 *
 * `03` §5 names `.novel/index.json` as a derived, non-committed cache. This
 * layer is in the host process's memory instead, and `03` now says so: the
 * lifetime of a plugin instance is a host process, the cold scan of a million
 * words is a quarter of a second paid once, and a multi-megabyte JSON rewritten
 * on every chapter save would cost more than it saves — while adding a second
 * copy of the truth that can be stale on disk in a way nothing notices.
 * @module dsh-ai-novel-copilot/novel/cache
 */
import { parseDocument } from './document.ts'

/** One file to scan, with a token the directory listing already supplied. */
export interface ScanRequest {
  /** Storage-relative path. */
  path: string
  /** Freshness token from the listing, when the backend reported one. */
  version?: string
}

/** The two filesystem reads a scan needs. */
export interface ScanSource {
  /** The freshness token for one file, or undefined when it cannot be read. */
  version(relative: string): Promise<string | undefined>
  /** One file's text, or undefined when it is gone. */
  read(relative: string): Promise<string | undefined>
}

/**
 * Derive a value from one file's own content.
 *
 * The contract matters: this must depend on nothing but the file it is handed.
 * A card's reverse links depend on *other* files, so they are applied by the
 * caller after the scan, not derived here — a value cached under a token that
 * only covers its own file would otherwise go stale when a neighbour changes.
 * @param file - the path, parsed frontmatter, body, and whole text.
 * @returns the value to cache alongside the parse.
 */
export type Derive<T> = (file: {
  path: string
  data: Record<string, unknown>
  body: string
  text: string
}) => T

/** One scanned file: the parse, and the value derived from it. */
export interface ScannedFile<T> {
  /** Storage-relative path. */
  path: string
  /**
   * The token this parse is valid for.
   *
   * **Absent** when the backend reported no token anywhere. Such a file is
   * always handed back and never kept: without a token there is nothing to check
   * the cached parse against on the next scan.
   */
  version?: string
  /** Whole file text, as stored. */
  text: string
  /** Parsed frontmatter. */
  data: Record<string, unknown>
  /** Prose after the frontmatter. */
  body: string
  /** The value derived from this file alone. */
  value: T
}

/** One project's cache. */
interface Book {
  /** Every parsed file, by path. */
  files: Map<string, ScannedFile<unknown>>
  /** Which paths each scan group saw last time, so deletions can be pruned. */
  groups: Map<string, Set<string>>
}

/**
 * The parsed-file cache, one instance per host process.
 *
 * Grouping is what makes pruning safe: chapters, cards, and loose pages are
 * scanned by separate calls, so each call only drops entries *within its own
 * group* — otherwise scanning the cards would evict every chapter.
 */
export class ProjectCache {
  private readonly books = new Map<string, Book>()

  /**
   * Scan a group of files, reusing the parse of every file whose token is unchanged.
   * @param root - absolute project root; the cache key.
   * @param group - which scan this is, e.g. `chapters`; the pruning scope.
   * @param source - the filesystem reads.
   * @param requests - the files to scan, in output order.
   * @param derive - derives the cached value from one file's own content.
   * @returns one entry per file still present, in request order.
   */
  async scan<T>(
    root: string,
    group: string,
    source: ScanSource,
    requests: readonly ScanRequest[],
    derive: Derive<T>,
  ): Promise<ScannedFile<T>[]> {
    const book = this.book(root)
    const seen = new Set<string>()
    const out: ScannedFile<T>[] = []

    for (const request of requests) {
      if (seen.has(request.path)) continue
      seen.add(request.path)
      const known = book.files.get(request.path) as ScannedFile<T> | undefined

      // The listing's token is free; a stat is the fallback for a backend whose
      // listing carries none.
      let version = request.version
      if (known !== undefined && version !== undefined && known.version === version) {
        out.push(known)
        continue
      }
      if (version === undefined) version = await source.version(request.path)
      if (known !== undefined && version !== undefined && known.version === version) {
        out.push(known)
        continue
      }

      // Read either way: a file whose freshness cannot be checked still has to
      // be answered from, it just must not be remembered.
      const text = await source.read(request.path)
      if (text === undefined) {
        book.files.delete(request.path)
        continue
      }
      const { data, body } = parseDocument(text)
      const entry: ScannedFile<T> = {
        path: request.path,
        ...(version === undefined ? {} : { version }),
        text,
        data,
        body,
        value: derive({ path: request.path, data, body, text }),
      }
      if (version === undefined) book.files.delete(request.path)
      else book.files.set(request.path, entry as ScannedFile<unknown>)
      out.push(entry)
    }

    const previous = book.groups.get(group)
    if (previous !== undefined) {
      for (const path of previous) if (!seen.has(path)) book.files.delete(path)
    }
    book.groups.set(group, seen)
    return out
  }

  /**
   * Forget one file, so the next scan re-reads it even if its token did not move.
   *
   * Called after this plugin's own writes: the token *does* move on a real
   * backend, but a write the panel just performed is not something to re-derive
   * from a token at all when the file is known to have changed.
   * @param root - absolute project root.
   * @param path - storage-relative path that was written.
   */
  invalidate(root: string, path: string): void {
    this.books.get(root)?.files.delete(path)
  }

  /** @param root - absolute project root. @returns that project's book, created on first use. */
  private book(root: string): Book {
    const existing = this.books.get(root)
    if (existing !== undefined) return existing
    const created: Book = { files: new Map(), groups: new Map() }
    this.books.set(root, created)
    return created
  }
}
