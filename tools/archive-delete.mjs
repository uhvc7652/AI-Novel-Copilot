/**
 * Delete every archived document in a novel project.
 *
 * The panel cannot do this and never will (`ctx.fs` has no delete primitive — see
 * `tools/archived-lib.mjs`), so this is the author's own tool: it runs in the
 * author's terminal, with the author's permissions, on the author's files.
 *
 * **Dry run by default.** Without `--apply` it prints exactly what it would
 * remove, plus which live documents still name each id — because deleting a card
 * that a chapter references turns those references into `missing-ref` errors, and
 * deleting an archived chapter leaves a `chapter-gap` behind. Those are the
 * checks doing their job, but you should know before, not after.
 *
 * ```
 * node --experimental-transform-types tools/archive-delete.mjs <novel-root>
 * node --experimental-transform-types tools/archive-delete.mjs <novel-root> --apply
 * ```
 *
 * @module tools/archive-delete
 */
import { unlink } from 'node:fs/promises'
import { relative } from 'node:path'
import {
  askText,
  askYesNo,
  describe,
  heading,
  interactive,
  novelRoot,
  parseFlags,
  referencesTo,
  scanArchived,
  scanChapters,
} from './archived-lib.mjs'

const { root: given, apply } = parseFlags(process.argv.slice(2))

try {
  // No argument at all is the double-click case: ask for the folder rather than
  // refusing with a usage line. `.cmd` wrappers make this reachable.
  const chosen = given === undefined
    ? await askText('小说工程目录（直接回车 = ./novel）：', 'novel')
    : given
  const root = await novelRoot(chosen)
  const files = await scanArchived(root)
  heading(`工程：${root}`)

  if (files.length === 0) {
    console.log('没有已存档（archived: true）的文件。没有可删的东西。')
    process.exit(0)
  }

  const ids = new Set(files.map(file => file.id))
  const referenced = await referencesTo(root, ids, new Set(files.map(file => file.abs)))
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0)
  const chapters = await scanChapters(root)
  const going = new Set(files.map(file => file.rel))

  heading(`已存档的文件：${String(files.length)} 个 · ${String(bytes)} 字节`)
  for (const file of files) {
    console.log(`  ${describe(file)}`)
    const users = referenced.get(file.id) ?? []
    if (users.length > 0) {
      console.log(`    ⚠ 这些文件的 frontmatter 提到了 ${file.id}：${users.join('、')}`)
      console.log('      删掉后「检查」会把它们报成断链：章节引用卡是 missing-ref，伏笔字段与时间线是 thread-ref / timeline-ref，firstAppear 是 firstappear-mismatch。')
    }
    // A gap only opens when something still ranks *after* the number being freed:
    // 1..最高之间没有人占的号才算洞，所以删掉最后一章不会报缺号。比较要在**全书**
    // 范围内做——章号是全书连续的（`03` §3.1），第二卷的章号接着第一卷往下排，
    // 所以「本卷里后面没有章」不等于「没人占着更大的号」。
    const mine = chapters.find(chapter => chapter.rel === file.rel)
    if (mine !== undefined) {
      const behind = chapters.filter(chapter =>
        !going.has(chapter.rel) && chapter.number > mine.number)
      if (behind.length > 0) {
        console.log(`    ⚠ 章号 ${String(mine.number)} 后面还有 ${String(behind.length)} 章（按全书算）`)
        console.log(`      删掉后「检查」会报第 ${String(mine.number)} 章缺号（chapter-gap）——那是它在说这个号没人占了。`)
      }
    }
  }

  heading('仍然可以从这些地方找回内容')
  console.log(`  · .novel/history/<文档路径>/ —— 面板保存过的每一版全文都在（按 rel 路径分目录）`)
  console.log('  · git —— 如果你提交过')
  console.log('  （本脚本只删工作区里的文件，不碰 .novel/ 与 exports/）')

  if (!apply) {
    heading('这是预演。确认无误后加 --apply 才会真的删。')
    console.log(`  node --experimental-transform-types tools/archive-delete.mjs ${JSON.stringify(chosen)} --apply`)
    // At a terminal, offer to go on from here (that is the double-click path);
    // with no terminal, stop — a piped run must not delete on its own.
    if (!interactive() || !await askYesNo('现在真的删除这些文件吗？')) {
      console.log('没有删除任何东西。')
      process.exit(0)
    }
    heading('按你的确认继续：真的删除')
  }

  heading('删除中…')
  let removed = 0
  for (const file of files) {
    try {
      await unlink(file.abs)
      removed += 1
      console.log(`  已删除 ${relative(root, file.abs).split('\\').join('/')}`)
    } catch (error) {
      console.log(`  删除失败 ${file.rel}：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  heading(`完成：删除 ${String(removed)} / ${String(files.length)} 个文件。`)
  console.log('下次进「检查」时，如果看到 missing-ref 或 chapter-gap，那正是在报这些文件曾经占着的位置。')
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
