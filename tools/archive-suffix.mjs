/**
 * Rename archived documents so the plugin stops reading them, and put them back.
 *
 * A retired file that still ends in `.md` is still a document: the host scans
 * `chapters/vNN/*.md` by extension and cards by `settings/<type>/<id>.md`, so
 * `c0009.md` archived is *still* parsed — it is just a chapter the tree hides. The
 * suffix therefore goes **after the extension**:
 *
 * ```
 * chapters/v01/c0009.md   →   chapters/v01/c0009.md.archived
 * ```
 *
 * which makes it invisible to every scan (nothing ends in `.md` any more) while
 * keeping the text where it was, sorted next to its neighbours, and trivially
 * reversible. `c0009.archived.md` would *not* work: the scan would pick it up as
 * a chapter whose id is `c0009.archived`, and the checks would immediately report
 * it as `id-mismatch` against the `id: c0009` in its own frontmatter.
 *
 * ```
 * node --experimental-transform-types tools/archive-suffix.mjs <novel-root>
 * node --experimental-transform-types tools/archive-suffix.mjs <novel-root> --apply
 * node --experimental-transform-types tools/archive-suffix.mjs <novel-root> --restore --apply
 * ```
 *
 * `--suffix <text>` changes the marker (default `.archived`); a suffix that still
 * ends in `.md` is refused, because it would not do what this command is for.
 *
 * @module tools/archive-suffix
 */
import { readFile, rename, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { parseDocument } from '../src/novel/document.ts'
import { isDocumentPath } from '../src/novel/paths.ts'
import {
  DOC_TREES,
  askText,
  askYesNo,
  describe,
  heading,
  interactive,
  isArchivedData,
  novelRoot,
  parseFlags,
  restoredName,
  scanArchived,
  suffixedName,
  suffixProblem,
  walkFiles,
} from './archived-lib.mjs'

const { root: given, apply, suffix, restore } = parseFlags(process.argv.slice(2))

/**
 * Every file that currently carries the suffix and would be a document again
 * without it — the restore side's candidate list.
 *
 * Walks the four document trees only: `--restore` is not a general un-suffix
 * tool, and `.novel/history/` is full of json that has nothing to do with it.
 * @param {string} root - absolute project root.
 * @param {string} marker - the suffix to strip.
 * @returns {Promise<{rel: string, abs: string, back: string, archived: boolean}[]>} the files to restore.
 */
async function scanSuffixed(root, marker) {
  const found = []
  for (const tree of DOC_TREES) {
    for (const abs of await walkFiles(join(root, tree))) {
      if (!abs.endsWith(marker)) continue
      const rel = relative(root, abs).split('\\').join('/')
      const back = restoredName(rel, marker)
      // Only names that are documents under one of the four content trees come
      // back.
      if (back === undefined || !isDocumentPath(back)) continue
      const data = await readFile(abs, 'utf8').then(
        text => { try { return parseDocument(text).data } catch { return undefined } },
        () => undefined,
      )
      if (data === undefined) continue
      found.push({ rel, abs, back, archived: isArchivedData(data) })
    }
  }
  return found.sort((left, right) => left.rel.localeCompare(right.rel))
}

try {
  const chosen = given === undefined
    ? await askText('小说工程目录（直接回车 = ./novel）：', 'novel')
    : given
  const root = await novelRoot(chosen)
  heading(`工程：${root}`)

  if (suffixProblem(suffix) !== undefined) {
    throw new Error(suffixProblem(suffix))
  }

  if (restore) {
    const files = await scanSuffixed(root, suffix)
    if (files.length === 0) {
      console.log(`没有找到以「${suffix}」结尾、且去掉之后是合法文档的文件。`)
      process.exit(0)
    }
    heading(`要改回名字的文件：${String(files.length)} 个`)
    for (const file of files) {
      console.log(`  ${file.rel}${file.archived ? '（frontmatter 仍是 archived: true）' : ''} → ${file.back}`)
    }
    if (!apply) {
      heading('这是预演。加 --restore --apply 才会真的改名回去（frontmatter 不动：要恢复进面板，还得清掉 archived）。')
      if (!interactive() || !await askYesNo('现在真的改名回去吗？')) {
        console.log('没有改任何名字。')
        process.exit(0)
      }
      heading('按你的确认继续：真的改名回去')
    }
    heading('改名中…')
    let moved = 0
    for (const file of files) {
      const target = file.abs.slice(0, -suffix.length)
      const taken = await stat(target).catch(() => undefined)
      if (taken !== undefined) {
        console.log(`  跳过 ${file.rel}：${file.back} 已经存在`)
        continue
      }
      try {
        await rename(file.abs, target)
        moved += 1
        console.log(`  已改回 ${file.rel} → ${file.back}`)
      } catch (error) {
        console.log(`  改名失败 ${file.rel}：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    heading(`完成：${String(moved)} / ${String(files.length)} 个文件改回了原名。`)
    console.log('注意：改回名字只是让它重新成为文档——要不要重新进面板，取决于 frontmatter 里的 archived。')
    process.exit(0)
  }

  const files = await scanArchived(root)
  if (files.length === 0) {
    console.log('没有已存档（archived: true）的文件。没有要改名的东西。')
    process.exit(0)
  }

  heading(`要加后缀「${suffix}」的已存档文件：${String(files.length)} 个`)
  for (const file of files) {
    const target = suffixedName(file.rel.split('/').pop() ?? file.rel, suffix)
    console.log(`  ${describe(file)}`)
    console.log(`    → ${file.rel.replace(/[^/]+$/, target ?? '')}`)
  }

  if (!apply) {
    heading('这是预演。加 --apply 才会真的改名。')
    console.log(`  node --experimental-transform-types tools/archive-suffix.mjs ${JSON.stringify(chosen)} --apply`)
    console.log('  改完之后这些文件对插件完全不存在（不扫描、不进统计、不进检查）；')
    console.log('  frontmatter 里的 archived: true 不动，所以 --restore 之后它们还是存档状态。')
    if (!interactive() || !await askYesNo('现在真的改名吗？')) {
      console.log('没有改任何名字。')
      process.exit(0)
    }
    heading('按你的确认继续：真的改名')
  }

  heading('改名中…')
  let moved = 0
  for (const file of files) {
    const target = suffixedName(file.abs, suffix)
    if (target === undefined) continue
    const taken = await stat(target).catch(() => undefined)
    if (taken !== undefined) {
      console.log(`  跳过 ${file.rel}：${target.split('\\').pop()} 已经存在`)
      continue
    }
    try {
      await rename(file.abs, target)
      moved += 1
      console.log(`  已改名 ${file.rel} → ${target.slice(root.length + 1).split('\\').join('/')}`)
    } catch (error) {
      console.log(`  改名失败 ${file.rel}：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  heading(`完成：${String(moved)} / ${String(files.length)} 个文件加了后缀。`)
  console.log(`要还原：node --experimental-transform-types tools/archive-suffix.mjs ${JSON.stringify(given)} --restore --apply`)
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
