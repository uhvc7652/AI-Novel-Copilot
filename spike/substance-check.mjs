/**
 * Checks the substance filter against the real scaffold text.
 *
 * The regexes are replicated here because the filter is bundle-internal and the
 * point of this check is the regex behaviour on actual template content, not the
 * wiring around it. Keep in sync with `substanceOf` in `src/client/tasks.ts`.
 */
function substanceOf(text) {
  return text
    .replace(/^---[\s\S]*?\n---[ \t]*\r?\n?/, '')
    .replace(/^[ \t]*#{1,6}[ \t].*$/gm, '')
    .replace(/^[ \t]*[-*+][ \t]*[^：:\n]*[：:][ \t]*$/gm, '')
    .replace(/^[ \t]*[-*+][ \t]*$/gm, '')
    .replace(/\s+/g, '')
}

const cases = [
  ['空的世界观模板', '---\ntype: world\ntitle: "x·世界观"\n---\n\n## 一句话设定\n## 力量体系\n## 地理与社会\n## 不可违背的设定（硬约束）\n', false],
  ['空的卷纲模板', '# 第一卷\n\n## 卷目标\n## 卷冲突\n## 卷末状态\n', false],
  ['空的文风规则模板', '# 文风规则\n\n- 人称与叙述距离：\n- 句长与节奏：\n- 禁用词与 AI 味清单：\n', false],
  ['填过的文风规则', '# 文风规则\n\n- 人称与叙述距离：第三人称限知，紧贴主角\n- 句长与节奏：短句为主\n', true],
  ['填过的卷纲', '# 第一卷\n\n## 卷目标\n陈默在青石镇立足，并发现青铜镜的第一层秘密。\n', true],
]

let failed = 0
for (const [label, text, expected] of cases) {
  const actual = substanceOf(text).length > 0
  const ok = actual === expected
  if (!ok) failed += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: 有实质内容=${String(actual)}（期望 ${String(expected)}）`)
}
console.log(failed === 0 ? '\nRESULT: PASS — 空模板会被跳过，填过的会被采用' : `\nRESULT: FAIL — ${String(failed)} 例不符`)
process.exit(failed === 0 ? 0 : 1)
