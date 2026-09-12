/**
 * Document layer: the chapter file format.
 *
 * A chapter is one Markdown file whose leading YAML frontmatter carries the
 * machine facts and whose body carries the prose. The split is the whole point
 * of the format: the editor owns the body, tasks own the frontmatter, and a
 * human can read and diff either without tooling.
 *
 * @module dsh-ai-novel-copilot/novel/document
 */
import { dump, load } from 'js-yaml'

/** Leading frontmatter block, including its closing fence and the blank line after it. */
const FRONTMATTER_BLOCK = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n)?/

/** A parsed chapter file. */
export interface ParsedDocument {
  /** Frontmatter data; an empty object when the file has no block. */
  data: Record<string, unknown>
  /** Prose after the frontmatter, verbatim. */
  body: string
}

/**
 * Split a chapter file into frontmatter data and body.
 *
 * A file with no frontmatter is all body: hand-written Markdown must be
 * readable by the editor rather than rejected for missing metadata.
 * @param text - the whole file.
 * @returns the parsed document.
 * @throws when a frontmatter block exists but is not valid YAML.
 */
export function parseDocument(text: string): ParsedDocument {
  const match = FRONTMATTER_BLOCK.exec(text)
  if (match === null) return { data: {}, body: text }
  const loaded: unknown = load(match[1] ?? '')
  const data = typeof loaded === 'object' && loaded !== null && !Array.isArray(loaded)
    ? loaded as Record<string, unknown>
    : {}
  return { data, body: text.slice(match[0].length) }
}

/**
 * Render a chapter file from frontmatter data and a body.
 * @param data - frontmatter data to serialize.
 * @param body - prose to write after the block.
 * @returns the whole file, frontmatter first.
 */
export function serializeDocument(data: Record<string, unknown>, body: string): string {
  const yaml = dump(data, { lineWidth: 120, noRefs: true, sortKeys: true }).trimEnd()
  return `---\n${yaml}\n---\n\n${body.replace(/^\n+/, '')}`
}

/**
 * Parse a plain YAML data file — one with no frontmatter fences.
 *
 * `novel.yaml` is a data file, not a Markdown document with metadata: feeding it
 * to {@link parseDocument} finds no fence, returns an empty object, and silently
 * discards every field. It gets its own reader so that mistake cannot recur.
 * @param text - the file as stored.
 * @returns the parsed mapping.
 * @throws when the text is not valid YAML or is not a mapping.
 */
export function parseYamlData(text: string): Record<string, unknown> {
  const loaded: unknown = load(text)
  if (loaded === null || loaded === undefined) return {}
  if (typeof loaded !== 'object' || Array.isArray(loaded)) {
    throw new Error('顶层不是 YAML 映射')
  }
  return loaded as Record<string, unknown>
}

/**
 * Render a plain YAML data file, with no frontmatter fences.
 *
 * `sortKeys` is off deliberately: a data file an author may hand-edit keeps the
 * order it was written in, so changing one field does not reshuffle the rest.
 * @param data - the mapping to serialize.
 * @returns the file text.
 */
export function serializeYamlData(data: Record<string, unknown>): string {
  return `${dump(data, { lineWidth: 120, noRefs: true, sortKeys: false }).trimEnd()}\n`
}
