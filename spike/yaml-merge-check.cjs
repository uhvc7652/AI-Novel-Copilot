/**
 * Checks that a metadata rename preserves every other field in `novel.yaml`.
 *
 * The panel edits one field at a time, so a round-trip that dropped
 * `currentVolume` or stringified `targetWords` would quietly damage the file.
 * This runs the same js-yaml round trip `writeMeta` performs.
 */
const yaml = require('E:/GameProject/AI-Novel-Copilot/node_modules/js-yaml')

const original = 'title: "测试之书"\ngenre: 中文长篇网文\ntargetWords: 1000000\ncurrentVolume: 1\n'
const data = yaml.load(original)
console.log('parsed:', JSON.stringify(data))
data.title = '青铜镜'
const out = yaml.dump(data, { lineWidth: 120, noRefs: true, sortKeys: true })
console.log('--- written back ---')
process.stdout.write(out)

const back = yaml.load(out)
const checks = [
  ['title', '青铜镜'],
  ['genre', '中文长篇网文'],
  ['targetWords', 1000000],
  ['currentVolume', 1],
]
let bad = 0
for (const [key, expected] of checks) {
  const ok = back[key] === expected
  if (!ok) bad += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${key} = ${JSON.stringify(back[key])} (期望 ${JSON.stringify(expected)})`)
}
console.log(bad === 0 ? 'RESULT: PASS — 只改标题，其它字段与类型全部保留' : 'RESULT: FAIL')
process.exit(bad === 0 ? 0 : 1)
