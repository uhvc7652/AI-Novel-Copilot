/**
 * Format, IO and assembly checks for the P2 layers.
 *
 * These run against the **real modules** — `node --experimental-transform-types`
 * imports the same `.ts` files the bundle is built from — rather than against
 * copies of their regexes. `spike/substance-check.mjs` replicates a filter and
 * says so; that is acceptable for a regex whose behaviour is the thing under
 * test, and unacceptable for the rules that decide which file the panel may
 * write, what a card's identity is, and what a prompt actually contains.
 *
 * Three kinds of assertion live here:
 *
 * 1. **Pure rules** — paths, whitelist, slugs, index derivation, plan parsing.
 * 2. **Task assembly**, with a stubbed `fetch` serving canned project files, so
 *    the assertions are about the assembled prompt and its input list — the two
 *    things the author is shown before trusting a generation.
 * 3. **The host IO layer**, against an in-memory `ctx.fs` double: scaffolding,
 *    the document whitelist, `wordCount` stamping, card creation rules, chapter
 *    numbering and conflicts, the settings library and the project tree. None of
 *    that needs real bytes on disk, and until now only a live DSH instance
 *    exercised it.
 *
 * `--experimental-transform-types` rather than `--experimental-strip-types`:
 * strip-only mode rejects TypeScript parameter properties, which `NovelError`
 * and `NovelIo` use.
 *
 * Usage: node --experimental-transform-types spike/format-check.mjs
 */
import { isDocumentPath, isSlug, cardPath, cardTypeOfPath, cardIdOfPath, volumeOutlinePath, BOOK_OUTLINE_FILE } from '../src/novel/paths.ts'
import { summarizeChapter, summarizeCard, groupCards, referenceIndex, readThread, threadChaptersOf } from '../src/novel/project.ts'
import { parseDocument, serializeDocument } from '../src/novel/document.ts'
import { countWords } from '../src/novel/words.ts'
import { parsePlan } from '../src/client/plan.ts'
import { findQuote, lineAt, pointedText } from '../src/client/locate.ts'
import { OUTLINE_TASKS, CHAPTER_TASKS, CHECK_TASKS, assemble } from '../src/client/tasks.ts'
import { queryTerms, searchDocs, stripIntent } from '../src/novel/search.ts'
import { runChecks, checkProject } from '../src/novel/checks.ts'
import { actionOf, diffCounts, diffLines, diffRows, parseHistoryEntry, splitLines } from '../src/novel/history.ts'
import { historyDirOf, historyStamp, compareHistoryFiles, freeHistoryStamp, nextThreadId, chapterIdOfPath } from '../src/novel/paths.ts'
import { parseIssues } from '../src/client/issues.ts'

let failed = 0
let passed = 0

/**
 * Assert one expectation.
 * @param {string} label - what is being checked.
 * @param {boolean} ok - the result.
 * @param {string} detail - what was actually seen, for a failure.
 */
function check(label, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`PASS  ${label}`)
  } else {
    failed += 1
    console.log(`FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

console.log('--- 路径与身份规则 ---')
check('slug 接受 chen-mo / fs-003', isSlug('chen-mo') && isSlug('fs-003'))
check('slug 拒绝中文、大写、下划线、空串', !isSlug('陈默') && !isSlug('Chen-Mo') && !isSlug('chen_mo') && !isSlug(''))
check('卡路径由类型与 id 推出', cardPath('character', 'chen-mo') === 'settings/characters/chen-mo.md')
check('卡路径可反解类型与 id',
  cardTypeOfPath('settings/threads/fs-003.md') === 'thread' && cardIdOfPath('settings/threads/fs-003.md') === 'fs-003')
check('未知目录不算卡', cardTypeOfPath('settings/notes/x.md') === undefined)
check('文档白名单放行四棵树',
  ['chapters/v01/c0001.md', 'settings/world.md', 'outline/book.md', 'outline/volumes/v01.md', 'style/samples/a.md']
    .every(isDocumentPath))
check('文档白名单挡住 novel.yaml / .novel / 非 md / 逃逸',
  !isDocumentPath('novel.yaml')
  && !isDocumentPath('.novel/runs/x.json')
  && !isDocumentPath('settings/world.txt')
  && !isDocumentPath('../etc/hosts.md'))
check('卷纲路径与主线路径固定', volumeOutlinePath(2) === 'outline/volumes/v02.md' && BOOK_OUTLINE_FILE === 'outline/book.md')

console.log('\n--- 章节与反向索引 ---')
const chapterText = [
  '---',
  'id: c0001',
  'volume: 1',
  'number: 1',
  'title: 楔子·雨夜',
  'status: revised',
  'targetWords: 3000',
  'pov: chen-mo',
  'beats:',
  '  - 陈默在雨夜捡到半块青铜镜',
  '  - 被巡夜人撞见，仓皇逃走',
  'summary: 陈默捡到青铜镜。',
  'characters: [chen-mo, lao-zhou]',
  'locations: [qingshi-town]',
  '---',
  '',
  '雨下了一整夜。',
  '',
].join('\n')
const c1 = summarizeChapter('chapters/v01/c0001.md', chapterText)
check('章纲从 frontmatter 读出', c1.beats.length === 2 && c1.beats[1] === '被巡夜人撞见，仓皇逃走')
check('摘要与视角读出', c1.summary === '陈默捡到青铜镜。' && c1.pov === 'chen-mo')
check('引用列表读出', c1.characters.join() === 'chen-mo,lao-zhou' && c1.locations.join() === 'qingshi-town')
const c2 = summarizeChapter('chapters/v01/c0002.md', '---\nid: c0002\nnumber: 2\ncharacters: chen-mo\n---\n\n')
const index = referenceIndex([c1, c2])
check('反向索引把卡映射到章节',
  index.get('chen-mo')?.join() === 'c0001,c0002' && index.get('qingshi-town')?.join() === 'c0001')
check('手写无 frontmatter 的章也能进索引', summarizeChapter('chapters/v01/c0009.md', '只有正文').id === 'c0009')
const retired = summarizeChapter('chapters/v01/c0002.md', '---\nid: c0002\nnumber: 2\narchived: true\n---\n\n')
check('已存档的章被标记出来', retired.archived === true && c1.archived === false)
check('手写 archived: false 不算存档',
  summarizeChapter('chapters/v01/c0004.md', '---\narchived: false\n---\n\n').archived === false)

console.log('\n--- 设定卡 ---')
const card = summarizeCard('settings/characters/chen-mo.md', [
  '---',
  'id: chen-mo',
  'type: character',
  'name: 陈默',
  'aliases: [默哥, 陈小子]',
  'role: 主角',
  'tags: [剑修]',
  'firstAppear: c0001',
  '---',
  '',
  '## 外貌',
  '十九岁，瘦。',
  '',
].join('\n'), index.get('chen-mo') ?? [])
check('卡的类型来自目录，名字来自 frontmatter',
  card?.type === 'character' && card?.name === '陈默' && card?.id === 'chen-mo')
check('卡的反向链接接上章节', card?.appearsIn.join() === 'c0001,c0002')
check('卡的摘要取第一行正文', card?.gist === '十九岁，瘦。')
const archived = summarizeCard('settings/characters/lao-zhou.md', '---\nname: 老周\narchived: true\n---\n\n', [])
const grouped = groupCards([card, archived, { ...card, id: 'a', name: '阿' }].filter(Boolean))
check('已存档的卡排在最后', grouped[0].cards.at(-1)?.id === 'lao-zhou')
check('伏笔卡的 status 是生命周期而不是存档位',
  summarizeCard('settings/threads/fs-003.md', '---\ntitle: 青铜镜\nstatus: paid\n---\n\n', [])?.status === 'paid')

console.log('\n--- frontmatter 往返 ---')
const round = parseDocument(serializeDocument({ id: 'c0001', beats: ['甲', '乙'] }, '正文\n'))
check('序列化再解析不丢字段', round.data.id === 'c0001' && round.data.beats.join() === '甲,乙')
check('正文原样保留', round.body.trim() === '正文')

console.log('\n--- 拆章 JSON 解析 ---')
const fenced = parsePlan('好的，这是计划：\n```json\n[{"title":"第 2 章 巡夜人","beats":"撞见巡夜人","characters":["chen-mo"],"targetWords":3000}]\n```')
check('围栏与闲聊被剥掉，单条 beat 当列表', fenced.chapters.length === 1 && fenced.chapters[0].beats.join() === '撞见巡夜人')
check('数字字段解析', fenced.chapters[0].targetWords === 3000)
check('没有数组时报错而不是抛异常', parsePlan('我写不出来').error !== undefined)
check('没有 title 的条目被丢弃', parsePlan('[{"beats":["x"]}]').chapters.length === 0)

console.log('\n--- 模型检查的 JSON 解析（M6 模型层） ---')
const modelFenced = parseIssues([
  '好的，我读完了这一章：',
  '```json',
  '[{"severity":"高","location":"第 3 段","text":"陈默御剑而起","reason":"chen-mo 的卡写着尚未筑基","fix":"改成借青铜镜之力"}',
  ' ,{"severity":"info","where":"结尾","quote":"他笑了","basis":"","suggestion":""}]',
  '```',
].join('\n'))
check('围栏与闲聊被剥掉，字段别名（location/text/reason/fix）都能吃',
  modelFenced.issues.length === 2
  && modelFenced.issues[0].where === '第 3 段'
  && modelFenced.issues[0].quote === '陈默御剑而起'
  && modelFenced.issues[0].basis === 'chen-mo 的卡写着尚未筑基'
  && modelFenced.issues[0].suggestion === '改成借青铜镜之力')
check('中文严重度映射到三级（高 → error）', modelFenced.issues[0].severity === 'error')
check('按严重度排序（错误在前）', modelFenced.issues[0].severity === 'error' && modelFenced.issues[1].severity === 'info')
check('一条只有 quote、没有依据的也留下（作者能自己核对那句话）',
  modelFenced.issues.some(issue => issue.quote === '他笑了'))
check('没有 quote 也没有 basis 的条目被丢掉（无法核对的结论不展示）',
  parseIssues('[{"severity":"error","where":"随便"}]').issues.length === 0
  && parseIssues('[{"severity":"error","where":"随便"}]').error !== undefined)
check('同样的一句话不重复报', (() => {
  const twice = parseIssues(JSON.stringify([
    { severity: 'warn', quote: '他握紧青铜镜。', basis: '卡里说镜子已碎' },
    { severity: 'warn', quote: '他握紧青铜镜。 ', basis: '卡里说镜子已碎' },
  ]))
  return twice.issues.length === 1
})())
check('模型说「没问题」（[]）是正常结果，不是错误', (() => {
  const none = parseIssues('[]')
  return none.issues.length === 0 && none.error === undefined
})())
check('输出不是 JSON 时给一句话而不是抛异常',
  parseIssues('这一章没问题').error !== undefined && parseIssues('这一章没问题').issues.length === 0)

console.log('\n--- 检索（M5：确定性检索与问答） ---')

/**
 * A hand-built corpus: three chapters, two cards and one loose document.
 *
 * The engine is pure and takes the corpus as data, so the interesting cases —
 * a card whose `firstAppear` disagrees with the chapters, an entity that is
 * only ever mentioned in prose, a thread that was never paid off — are cheaper
 * to state here than to arrange on disk.
 */
const searchChapter = (number, title, extra) => ({
  kind: 'chapter',
  path: `chapters/v01/c${String(number).padStart(4, '0')}.md`,
  id: `c${String(number).padStart(4, '0')}`,
  title,
  label: `第 ${String(number)} 章`,
  number,
  volume: 1,
  archived: false,
  aliases: [],
  tags: [],
  summary: '',
  beats: [],
  characters: [],
  locations: [],
  body: '',
  ...extra,
})
const CORPUS = [
  searchChapter(1, '楔子·雨夜', {
    pov: 'chen-mo',
    characters: ['chen-mo', 'lao-zhou'],
    locations: ['qingshi-town'],
    summary: '陈默捡到半块青铜镜。',
    beats: ['陈默在雨夜捡到半块青铜镜'],
    body: '雨下了一整夜。\n陈默把半块青铜镜攥在手心，指节发白。\n',
  }),
  searchChapter(2, '巡夜人', { body: '巡夜人敲响了门，没人应声。\n' }),
  searchChapter(3, '裂纹', {
    characters: ['chen-mo'],
    body: '陈默把青铜镜收进怀里，裂纹又深了一分。\n',
  }),
  {
    kind: 'card',
    path: 'settings/characters/chen-mo.md',
    id: 'chen-mo',
    title: '陈默',
    label: '角色',
    archived: false,
    cardType: 'character',
    name: '陈默',
    aliases: ['默哥'],
    tags: ['剑修'],
    summary: '十九岁的剑修',
    beats: [],
    characters: [],
    locations: [],
    firstAppear: 'c0001',
    body: '## 外貌\n十九岁，瘦。\n',
  },
  {
    kind: 'card',
    path: 'settings/threads/fs-003.md',
    id: 'fs-003',
    title: '青铜镜的来历',
    label: '伏笔',
    archived: false,
    cardType: 'thread',
    name: '青铜镜的来历',
    aliases: [],
    tags: [],
    summary: '半块镜子的来路',
    beats: ['c0001'],
    characters: [],
    locations: [],
    thread: { status: 'planted', plantedIn: 'c0001', reinforcedIn: [], payoffIn: [], plannedPayoff: '第一卷末' },
    body: '## 埋点方式\n雨夜。\n',
  },
  {
    kind: 'page',
    path: 'settings/world.md',
    id: 'settings/world.md',
    title: '世界观',
    label: '设定文档',
    archived: false,
    aliases: [],
    tags: [],
    summary: '灵气复苏',
    beats: [],
    characters: [],
    locations: [],
    body: '青石镇是灵气复苏的源头，青铜镜出自旧朝。\n',
  },
]

check('问句里的疑问词被剥掉，只留检索词',
  stripIntent('陈默上次出场在哪').trim() === '陈默' && queryTerms('陈默上次出场在哪').join() === '陈默')
check('多词查询按词切开，长词在前',
  queryTerms('青铜镜 陈默').join() === '青铜镜,陈默')
check('疑问短语整段剥掉，不留残字（「在哪一章」/「解释过」）',
  queryTerms('青石镇在哪一章解释过').join() === '青石镇')
check('只剩一个虚词的片段不当作检索词（「了」）',
  queryTerms('默哥出现了几次').join() === '默哥')
const lastAnswer = searchDocs(CORPUS, '陈默上次出场在哪')
check('「上次出场」用 frontmatter 的出场登记作答',
  lastAnswer.answer?.kind === 'last-appearance'
  && lastAnswer.answer.text.includes('第 3 章')
  && lastAnswer.answer.chapters.join() === 'chapters/v01/c0003.md')
check('答案带出全书出现次数与依据',
  lastAnswer.answer.text.includes('2 章登记') && lastAnswer.answer.evidence.length > 0)
check('只按名字也能答：出现在哪几章',
  searchDocs(CORPUS, '陈默').answer?.kind === 'appearances')
const firstAnswer = searchDocs(CORPUS, '陈默第一次出场')
check('「第一次出场」与卡片的 firstAppear 一致时明说一致',
  firstAnswer.answer?.kind === 'first-appearance'
  && firstAnswer.answer.text.includes('第 1 章')
  && firstAnswer.answer.text.includes('一致'))
const conflicting = CORPUS.map(doc =>
  doc.id === 'chen-mo' ? { ...doc, firstAppear: 'c0002' } : doc)
check('卡片 firstAppear 与最早的出场登记冲突时给出矛盾而不是替作者选一个',
  searchDocs(conflicting, '陈默第一次出场').answer.text.includes('不一致'))
check('别名展开成同一个实体',
  searchDocs(CORPUS, '默哥').entities[0]?.id === 'chen-mo'
  && searchDocs(CORPUS, '默哥').entities[0].via === 'alias')
check('别名查询也会去正文里找',
  searchDocs(CORPUS, '默哥').hits.some(hit => hit.path === 'chapters/v01/c0001.md'))
check('关键词命中正文并带出原文片段',
  searchDocs(CORPUS, '青铜镜').hits.some(hit =>
    hit.path === 'chapters/v01/c0003.md'
    && hit.reasons.includes('body')
    && hit.snippet !== undefined
    && hit.snippet.text.includes('青铜镜')
    && hit.snippet.ranges.length > 0
    && hit.snippet.ranges.every(([from, to]) => hit.snippet.text.slice(from, to).includes('青铜'))))
check('片段里的高亮位置在片段自己的坐标系里（不是正文坐标）',
  searchDocs(CORPUS, '青铜镜').hits
    .every(hit => hit.snippet === undefined || hit.snippet.ranges.every(([, to]) => to <= hit.snippet.text.length)))
check('正文里没有的说法不会因为分词而误命中',
  searchDocs(CORPUS, '月光').hits.length === 0)
check('命中的东西不是设定卡时，也按关键词给出「第一次出现」，并说明依据不是 frontmatter',
  (() => {
    const found = searchDocs(CORPUS, '青铜镜第一次出现是哪章')
    return found.answer?.kind === 'first-appearance'
      && found.answer.text.includes('关键词命中')
      && found.answer.chapters.join() === 'chapters/v01/c0001.md'
  })())
check('章纲也算命中理由', searchDocs(CORPUS, '半块青铜镜').hits
  .some(hit => hit.reasons.includes('beats')))
check('伏笔卡按生命周期作答，并指出尚未回收',
  searchDocs(CORPUS, '青铜镜的来历').answer?.kind === 'thread'
  && searchDocs(CORPUS, '青铜镜的来历').answer.text.includes('尚未回收'))
check('设定文档也在语料里（世界观文件）',
  searchDocs(CORPUS, '青石镇').hits.some(hit => hit.path === 'settings/world.md' && hit.kind === 'page'))
check('空查询不报错，只是没有可检索的词', searchDocs(CORPUS, '在哪').empty === true)
check('命中统计与扫描数如实报告',
  (() => {
    const found = searchDocs(CORPUS, '青石镇')
    return found.scanned === CORPUS.length
      && found.counts.chapters + found.counts.cards + found.counts.pages === found.hits.length
  })())
check('已存档的章仍可被检索到，但带着存档标记',
  searchDocs(CORPUS.map(doc => doc.kind === 'chapter' && doc.id === 'c0002' ? { ...doc, archived: true } : doc), '巡夜人')
    .hits.some(hit => hit.path === 'chapters/v01/c0002.md' && hit.archived))

console.log('\n--- 一致性检查（M6：确定性规则） ---')

/** One chapter of the check fixture. */
const checkChapter = (fileId, number, extra = {}) => ({
  path: `chapters/v01/${fileId}.md`,
  fileId,
  title: `第 ${String(number)} 章`,
  volume: 1,
  number,
  status: 'draft',
  characters: [],
  locations: [],
  wordCount: 0,
  archived: false,
  ...extra,
})
/** One card of the check fixture. */
const checkCard = (id, extra = {}) => ({
  path: `settings/characters/${id}.md`,
  id,
  type: 'character',
  name: id,
  aliases: [],
  archived: false,
  relations: [],
  ...extra,
})

/**
 * A corpus that trips every rule once, and — just as important — is *quiet*
 * where the rules must not fire: the hole at chapter 2 is held by an archived
 * chapter, and the thread whose payoff point is prose is not judged at all.
 */
const CHECK_CORPUS = {
  chapters: [
    // 60% under target, and it names a location that has no card.
    checkChapter('c0001', 1, {
      pov: 'chen-mo', characters: ['chen-mo'], locations: ['qingshi-town'],
      targetWords: 3000, wordCount: 1200,
    }),
    checkChapter('c0002', 2, { archived: true, title: '撤掉的一章' }),
    // pov not listed in characters.
    checkChapter('c0003', 3, { pov: 'lao-zhou', characters: ['chen-mo'], locations: ['old-town'] }),
    // declares another id, and leaves a hole at 4 by numbering 5.
    checkChapter('c0004', 5, { declaredId: 'c0009' }),
    // a third chapter 3 → duplicate number.
    checkChapter('c0005', 3),
  ],
  cards: [
    checkCard('chen-mo', {
      name: '陈默', aliases: ['默哥'], firstAppear: 'c0001',
      relations: [{ to: 'lao-zhou', kind: '师徒' }, { to: 'ghost', kind: '旧识' }],
    }),
    // same alias as chen-mo, and a firstAppear that disagrees with the earliest登记.
    checkCard('lao-zhou', { name: '老周', aliases: ['默哥'], firstAppear: 'c0002' }),
    // an alias that is another card's id.
    checkCard('ghost-2', { name: '幽灵', aliases: ['chen-mo'] }),
    checkCard('old-town', { type: 'location', name: '旧镇', archived: true }),
    {
      path: 'settings/threads/fs-003.md', id: 'fs-003', type: 'thread', name: '青铜镜的来历',
      aliases: [], archived: false, relations: [],
      thread: { status: 'planted', plantedIn: 'c0001', reinforcedIn: [], payoffIn: [], plannedPayoff: 'c0003' },
    },
    {
      path: 'settings/threads/fs-004.md', id: 'fs-004', type: 'thread', name: '说已回收却没回收',
      aliases: [], archived: false, relations: [],
      thread: { status: 'paid', plantedIn: 'c0001', reinforcedIn: [], payoffIn: [] },
    },
    {
      path: 'settings/threads/fs-005.md', id: 'fs-005', type: 'thread', name: '埋在不存在的章',
      aliases: [], archived: false, relations: [],
      thread: { status: 'planted', plantedIn: 'c9999', reinforcedIn: [], payoffIn: [] },
    },
    {
      path: 'settings/threads/fs-006.md', id: 'fs-006', type: 'thread', name: '计划点写成散文',
      aliases: [], archived: false, relations: [],
      thread: { status: 'planted', plantedIn: 'c0001', reinforcedIn: [], payoffIn: [], plannedPayoff: '第一卷末' },
    },
  ],
  pages: [{
    path: 'settings/timeline.md',
    title: '时间线',
    body: [
      '# 时间线',
      '',
      '| 叙事序 | 故事时间 | 事件 | 章节 |',
      '|---|---|---|---|',
      '| 1 | 春 | 逐出家族 | c0003 |',
      '| 2 | 夏 | 捡到镜子 | c0001 |',
      '| 3 | 秋 | 不存在的事 | c9999 |',
      '',
    ].join('\n'),
  }],
}

const checkIssues = runChecks(CHECK_CORPUS)
const findRule = rule => checkIssues.filter(issue => issue.rule === rule)
const has = (rule, path, detail) => findRule(rule).some(issue =>
  issue.path === path && (detail === undefined || `${issue.title}${issue.detail}`.includes(detail)))

check('引用不存在的卡：一条 issue，两处依据', (() => {
  const found = findRule('missing-ref')
  return found.length === 1
    && found[0].key === 'missing-ref:chapters/v01/c0001.md:qingshi-town'
    && found[0].severity === 'error'
    && found[0].evidence.length === 2
    && found[0].evidence[0].includes('c0001.md')
    && found[0].evidence[1].includes('settings/*/qingshi-town.md')
})())
check('设定卡的 relations 指向不存在的卡', has('card-ref', 'settings/characters/chen-mo.md', 'ghost'))
check('伏笔指向不存在的章节', has('thread-ref', 'settings/threads/fs-005.md', 'c9999'))
check('时间线指向不存在的章节', has('timeline-ref', 'settings/timeline.md', 'c9999'))
check('名字/别名撞车：两张卡各报一条', findRule('alias-clash').filter(issue => issue.severity === 'error').length === 2)
check('别名与另一张卡的 id 撞车另算一条', findRule('alias-clash').some(issue =>
  issue.severity === 'warn' && issue.path === 'settings/characters/ghost-2.md'))
check('章号重复（两个第 3 章）', has('chapter-number', 'chapters/v01/c0003.md', '两个第 3 章'))
check('章号缺号只报真正没人占的号：第 2 章归存档章，第 4 章才是洞', (() => {
  const gaps = findRule('chapter-gap')
  return gaps.length === 1 && gaps[0].key === 'chapter-gap:chapters/v01/c0004.md:v1:4'
    && gaps[0].path === 'chapters/v01/c0004.md'
})())
check('id 与文件名不一致', has('id-mismatch', 'chapters/v01/c0004.md', 'c0009'))
check('时间线倒序', has('timeline-order', 'settings/timeline.md', '倒序'))
check('伏笔计划回收点已过仍未回收', findRule('thread-unpaid').some(issue => issue.severity === 'warn' && issue.path === 'settings/threads/fs-003.md'))
check('伏笔写着已回收却没有回收章节', findRule('thread-unpaid').some(issue => issue.severity === 'error' && issue.path === 'settings/threads/fs-004.md'))
check('计划回收点写成散文（第一卷末）不下结论', !findRule('thread-unpaid').some(issue => issue.path === 'settings/threads/fs-006.md'))
check('视角人物没登记在 characters 里', has('pov-unlisted', 'chapters/v01/c0003.md', '视角人物'))
check('字数严重偏离目标', findRule('word-drift').length === 1 && findRule('word-drift')[0].severity === 'info')
check('firstAppear 与最早的出场登记不一致', has('firstappear-mismatch', 'settings/characters/lao-zhou.md', '不一致'))
check('live 章还在引用已存档的卡', findRule('archived-ref').some(issue =>
  issue.severity === 'info' && issue.path === 'chapters/v01/c0003.md' && issue.detail.includes('存档')))
check('每条 issue 的 key 都是 rule:path:target，且稳定可复现', (() => {
  const again = runChecks(CHECK_CORPUS).map(issue => issue.key)
  return checkIssues.every(issue => issue.key.startsWith(`${issue.rule}:`))
    && again.join() === checkIssues.map(issue => issue.key).join()
})())
check('报告按严重度排序（错误在最前）',
  checkIssues[0]?.severity === 'error'
  && checkIssues.findIndex(issue => issue.severity === 'warn') > checkIssues.map(issue => issue.severity).lastIndexOf('error'))

const checkReport = checkProject(CHECK_CORPUS, [
  'missing-ref:chapters/v01/c0001.md:qingshi-town',
  'word-drift:chapters/v01/c0001.md:3000',
  'gone:this:key',
])
check('忽略项移出待处理列表，但仍留在报告里', (() => {
  const ignoredKeys = new Set([
    'missing-ref:chapters/v01/c0001.md:qingshi-town',
    'word-drift:chapters/v01/c0001.md:3000',
  ])
  const expected = checkIssues.filter(issue => !ignoredKeys.has(issue.key))
  return checkReport.ignored.length === 2
    && checkReport.issues.length === expected.length
    && !checkReport.issues.some(issue => ignoredKeys.has(issue.key))
    && checkReport.counts.error === expected.filter(issue => issue.severity === 'error').length
    && checkReport.counts.warn === expected.filter(issue => issue.severity === 'warn').length
    && checkReport.counts.info === expected.filter(issue => issue.severity === 'info').length
})())
check('对不上任何 issue 的忽略记录被标为 stale', checkReport.stale.join() === 'gone:this:key')
check('报告如实报告扫描量与分类计数',
  checkReport.scanned.chapters === 5
  && checkReport.scanned.cards === 8
  && checkReport.scanned.pages === 1
  && checkReport.counts.error + checkReport.counts.warn + checkReport.counts.info === checkReport.issues.length)

console.log('\n--- 任务装配（stub fetch） ---')
const FILES = {
  'novel.yaml': 'title: 测试之书\n',
  'style/style-guide.md': '# 文风规则\n\n短句为主。\n',
  'style/samples/sample-a.md': '# 样本 A\n\n他抬头看了一眼天色，没说话。\n',
  'style/samples/sample-b.md': '# 样本 B\n\n雨小了。屋檐还在滴水。\n',
  'style/samples/sample-c.md': '# 样本 C\n\n她把碗推过去，说：吃。\n',
  'style/samples/sample-d.md': '# 样本 D\n\n这一份不该进 prompt（作者只该带三份样本）。\n',
  'outline/volumes/v01.md': '# 第一卷\n\n## 卷目标\n陈默在青石镇立足。\n',
  'outline/book.md': '# 全书主线\n\n## 核心卖点\n青铜镜的秘密。\n',
  'settings/world.md': '# 世界观\n\n## 不可违背的设定（硬约束）\n青铜镜出自旧朝，认主之后不可转赠。\n',
  'settings/characters/chen-mo.md': '---\nname: 陈默\n---\n\n## 性格\n沉默。\n',
  'chapters/v01/c0001.md': chapterText,
}
const requested = []
globalThis.fetch = async (url) => {
  const parsed = new URL(url, 'http://spike.local')
  const headers = { 'content-type': 'application/json' }
  // The directory channel: how a task learns which style samples exist.
  if (parsed.pathname.endsWith('/novel/dir')) {
    const dir = parsed.searchParams.get('path') ?? ''
    const names = Object.keys(FILES)
      .filter(file => file.startsWith(`${dir}/`))
      .map(file => file.slice(dir.length + 1))
      .filter(rest => !rest.includes('/'))
    return new Response(JSON.stringify({
      ok: true,
      listing: {
        path: dir,
        exists: names.length > 0,
        entries: names.map(name => ({ name, type: 'file', path: `${dir}/${name}` })),
      },
    }), { status: 200, headers })
  }
  const path = parsed.searchParams.get('path') ?? ''
  requested.push(path)
  const text = FILES[path]
  return new Response(JSON.stringify({ ok: true, path, exists: text !== undefined, text: text ?? '' }), {
    status: 200,
    headers,
  })
}
const ctx = {
  sessionId: 'spike-session',
  root: 'E:/spike-novel',
  meta: { title: '测试之书', genre: '中文长篇网文', targetWords: 1000000 },
  volumes: [{ dir: 'v01', volume: 1, chapters: [c1, c2] }],
  chapter: {
    path: 'chapters/v01/c0002.md',
    data: { number: 2, title: '第二章 巡夜人', targetWords: 3000, beats: ['陈默撞见巡夜人'], characters: ['chen-mo'], pov: 'chen-mo' },
    body: '他握紧青铜镜。',
    wordCount: 8,
    version: '',
  },
  volume: 1,
  cards: [card, archived].filter(Boolean),
}

const whole = await assemble(CHAPTER_TASKS[0], ctx)
check('整章任务读到章纲', whole.prompt.includes('陈默撞见巡夜人'))
check('整章任务读到上一章摘要与结尾',
  whole.prompt.includes('陈默捡到青铜镜。') && whole.prompt.includes('雨下了一整夜。'))
check('整章任务读到出场角色卡正文', whole.prompt.includes('沉默。') && whole.prompt.includes('## chen-mo'))
check('整章任务的输入清单列出每个文件',
  whole.inputs.some(item => item.path === 'outline/volumes/v01.md')
  && whole.inputs.some(item => item.path === 'style/style-guide.md')
  && whole.inputs.some(item => item.path === 'settings/characters/chen-mo.md'))
check('整章任务替换正文并声明目标字数', whole.apply === 'replace-body' && whole.prompt.includes('3000 字'))

const volumeTask = await assemble(OUTLINE_TASKS[0], ctx)
check('卷纲任务写明落盘目标', volumeTask.target === 'outline/volumes/v01.md' && volumeTask.apply === 'write-document')
check('卷纲任务读到主线与本卷已写章节',
  volumeTask.prompt.includes('青铜镜的秘密。') && volumeTask.prompt.includes('陈默捡到青铜镜。'))

const planTask = await assemble(OUTLINE_TASKS[2], ctx)
check('拆章任务要求纯 JSON', planTask.prompt.includes('只输出一个 JSON 数组'))
check('拆章任务带上可用设定 id', planTask.prompt.includes('chen-mo — 陈默') && !planTask.prompt.includes('lao-zhou — 老周'))
check('拆章任务避开已存档卡', !planTask.prompt.includes('老周'))
check('拆章任务是 plan 类型', planTask.kind === 'plan' && planTask.apply === 'chapter-plan')
check('读取失败不抛异常（不存在的文件被跳过）', !requested.includes('settings/locations/qingshi-town.md'))

// An archived chapter is withdrawn from the story, so tasks must not treat it as
// story material: not as the chapter a scene continues from, and not as a chapter
// that has already been planned.
const withdrawn = { ...c2, title: '第二章·被撤', summary: '这一章被撤了。', archived: true }
const c3 = {
  ...c1,
  path: 'chapters/v01/c0003.md',
  id: 'c0003',
  number: 3,
  title: '第三章 巡夜人',
  summary: '第三章发生的事。',
}
const latest = {
  path: c3.path,
  data: { number: 3, title: c3.title, targetWords: 3000, beats: ['接着往下写'] },
  body: '',
  wordCount: 0,
  version: '',
}
const ctx3 = {
  ...ctx,
  chapter: latest,
  volumes: [{ dir: 'v01', volume: 1, chapters: [c1, withdrawn, c3] }],
}
const wholeAfterWithdrawal = await assemble(CHAPTER_TASKS[0], ctx3)
check('续写时跳过已存档的上一章，锚定再上一章的真内容',
  wholeAfterWithdrawal.prompt.includes('陈默捡到青铜镜。') && wholeAfterWithdrawal.prompt.includes('雨下了一整夜。'))
check('续写时不会把已存档章节当成上一章',
  !wholeAfterWithdrawal.prompt.includes('这一章被撤了。'))
const planAfterWithdrawal = await assemble(OUTLINE_TASKS[2], ctx3)
check('拆章时已存档的章节不算「已有章节」',
  planAfterWithdrawal.prompt.includes('第三章 巡夜人') && !planAfterWithdrawal.prompt.includes('第二章·被撤'))

console.log('\n--- 模型检查的任务装配 ---')
/** The same context, with the rules layer having already reported one thing. */
const checkedCtx = {
  ...ctx,
  checks: {
    issues: [{
      key: 'missing-ref:chapters/v01/c0002.md:ghost',
      rule: 'missing-ref',
      severity: 'error',
      title: '第 2 章《第二章 巡夜人》 的 characters 指向不存在的卡「ghost」',
      detail: '…',
      path: 'chapters/v01/c0002.md',
      chapter: 'chapters/v01/c0002.md',
      evidence: [],
    }],
    ignored: [],
    stale: [],
    counts: { error: 1, warn: 0, info: 0 },
    scanned: { chapters: 1, cards: 1, pages: 1 },
  },
}
const modelCheck = await assemble(CHECK_TASKS[0], checkedCtx)
check('模型检查读到世界观硬约束', modelCheck.prompt.includes('青铜镜出自旧朝，认主之后不可转赠'))
check('模型检查读到本章设定卡正文与本章正文',
  modelCheck.prompt.includes('沉默。') && modelCheck.prompt.includes('他握紧青铜镜'))
check('模型检查要求逐字引用与依据，并明确不报文风问题',
  modelCheck.prompt.includes('逐字复制') && modelCheck.prompt.includes('不要报错别字'))
check('模型检查把规则已报的问题列出来让它不要重复',
  modelCheck.prompt.includes('不要重复') && modelCheck.prompt.includes('ghost'))
check('模型检查的输出类型是 issues + report（没有采纳动作）',
  modelCheck.kind === 'issues' && modelCheck.apply === 'report')
check('模型检查的输入清单如实列出读了哪些文件',
  modelCheck.inputs.some(item => item.path === 'settings/world.md')
  && modelCheck.inputs.some(item => item.path === checkedCtx.chapter.path)
  && modelCheck.inputs.some(item => item.path === '.novel（规则检查结果）'))
check('没有打开章节时模型检查明确拒绝',
  await (async () => {
    try {
      await assemble(CHECK_TASKS[0], { ...ctx, chapter: undefined })
      return false
    } catch (error) {
      return error.message.includes('先打开一章')
    }
  })())

console.log('\n--- P4 文风：样本装配与两个新任务 ---')
const polish = await assemble(CHAPTER_TASKS[4], ctx)
const styleCheck = await assemble(CHAPTER_TASKS[5], ctx)
const sampleInputs = polish.inputs.filter(item => item.path.startsWith('style/samples/'))
check('生成任务带上作者的风格样本（M4 原本只带了规则）',
  polish.prompt.includes('【风格样本（照着这个语感写）】')
  && polish.prompt.includes('他抬头看了一眼天色')
  && sampleInputs.length === 3)
check('样本有上限：第四份不进 prompt，也不进输入清单',
  !polish.prompt.includes('这一份不该进 prompt')
  && sampleInputs.every(item => !item.path.endsWith('sample-d.md'))
  && sampleInputs.every(item => item.reason.includes('风格样本')))
check('润色本章：replace-body，情节不变、逐条对照文风规则',
  polish.kind === 'prose' && polish.apply === 'replace-body'
  && polish.prompt.includes('情节、信息量、人物关系、场景顺序全部不变')
  && polish.prompt.includes('短句为主')
  && polish.prompt.includes('他握紧青铜镜'))
check('去 AI 味检查：issues 报告，且点名的毛病就是需求里那五类',
  styleCheck.kind === 'issues' && styleCheck.apply === 'report'
  && CHAPTER_TASKS[5].place === 'chapter'
  && ['口头禅', '排比', '总结句', '形容词', '对话腔调'].every(habit => styleCheck.prompt.includes(habit)))
check('去 AI 味检查要求逐字引用、给可直接替换的写法、并限制条数',
  styleCheck.prompt.includes('逐字复制') && styleCheck.prompt.includes('可以直接替换或删除')
  && styleCheck.prompt.includes('最多 12 条'))
check('去 AI 味检查把正文与文风规则都读进来',
  styleCheck.prompt.includes('他握紧青铜镜') && styleCheck.prompt.includes('短句为主'))
check('正文页的按钮顺序：写整章 / 续写 / 改写 / 扩写 / 润色 / 去 AI 味',
  CHAPTER_TASKS.map(task => task.label).join('/')
  === '按章纲写整章/续写/改写/扩写/润色本章/去 AI 味检查')

console.log('\n--- host IO 层（内存文件系统替身） ---')
const { NovelIo } = await import('../src/novel/io.ts')

/**
 * A minimal in-memory `ctx.fs` double.
 *
 * The host IO layer is where the project fence, the document whitelist, the
 * slug rules, and chapter numbering actually live, and until now nothing
 * exercised it except a live DSH instance. A filesystem double is enough for all
 * of that, because none of it depends on real bytes on disk.
 *
 * The two switches exist for the P5 scan cache, whose whole job is to decide
 * whether a file must be read again from its freshness token:
 *
 * - `listVersion` — whether a directory listing carries each child's token.
 *   `dsh-fs-local` does; the default here does not, which is what makes the
 *   default double exercise the stat fallback.
 * - `statVersion` — whether `stat` reports a token at all. A backend that
 *   reports none must be read every time rather than cached on faith.
 * @param options - which freshness information the double should report.
 * @returns the double, with a readable `reads` log for the cache checks.
 */
function memoryFs(options = {}) {
  const { listVersion = false, statVersion = true } = options
  const files = new Map()
  const versions = new Map()
  let counter = 0
  /** Every `readText` the IO layer asked for — the cache's unit of work. */
  const reads = { count: 0, paths: [] }
  /** Every `stat` the IO layer asked for — what a cache hit must not need. */
  const stats = { count: 0, paths: [] }
  const target = (key) => ({ targetKey: key, displayPath: key })
  const dirsOf = (key) => {
    const found = new Set()
    for (const path of files.keys()) {
      if (!path.startsWith(key === '' ? '' : `${key}/`)) continue
      const rest = path.slice(key === '' ? 0 : key.length + 1)
      const slash = rest.indexOf('/')
      if (slash > 0) found.add(`${key === '' ? '' : `${key}/`}${rest.slice(0, slash)}`)
    }
    return found
  }
  /** A key is a directory exactly when some file lives under it. */
  const isDir = (key) => [...files.keys()].some(path => path.startsWith(`${key}/`))
  const bump = (key) => {
    counter += 1
    versions.set(key, String(counter))
    return String(counter)
  }
  const infoOf = (key) => {
    if (files.has(key)) return statVersion ? { version: versions.get(key) ?? '0', type: 'file' } : { type: 'file' }
    if (isDir(key)) return statVersion ? { version: '0', type: 'directory' } : { type: 'directory' }
    return undefined
  }
  return {
    files,
    reads,
    stats,
    /** An edit made outside the panel: new bytes and a new freshness token. */
    touch(key, content) {
      files.set(key, content)
      bump(key)
    },
    async resolve(path) { return target(path.replace(/\\/g, '/').replace(/\/+$/, '')) },
    contains(parent, child) { return child.targetKey === parent.targetKey || child.targetKey.startsWith(`${parent.targetKey}/`) },
    async stat(t) {
      stats.count += 1
      stats.paths.push(t.targetKey)
      return infoOf(t.targetKey)
    },
    async readText(t) {
      reads.count += 1
      reads.paths.push(t.targetKey)
      const value = files.get(t.targetKey)
      if (value === undefined) throw Object.assign(new Error('FS_NOT_FOUND'), { code: 'FS_NOT_FOUND' })
      return value
    },
    async listDir(t) {
      const entries = []
      for (const key of dirsOf(t.targetKey)) {
        entries.push({ name: key.slice(t.targetKey.length + 1), type: 'directory', target: target(key) })
      }
      for (const key of files.keys()) {
        if (!key.startsWith(`${t.targetKey}/`)) continue
        const rest = key.slice(t.targetKey.length + 1)
        if (rest.includes('/')) continue
        entries.push({
          name: rest,
          type: 'file',
          target: target(key),
          ...(listVersion ? { version: versions.get(key) ?? '0' } : {}),
        })
      }
      return entries.sort((left, right) => left.name.localeCompare(right.name))
    },
    async writeText(t, content) {
      const before = files.get(t.targetKey) ?? null
      files.set(t.targetKey, content)
      return { operation: before === null ? 'create' : 'update', version: bump(t.targetKey), before, after: content }
    },
  }
}

const fs = memoryFs()
const scope = { root: '', sessionId: 'spike-session' }
const io = new NovelIo({
  fs,
  sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: '' }) },
  sessions: { get: () => undefined },
})

const scaffolded = await io.scaffold(scope, '测试之书')
check('脚手架写出工程骨架且不覆盖', scaffolded.created.length >= 5 && (await io.scaffold(scope, '改名')).created.length === 0)
check('novel.yaml 作为数据文件解析', (await io.projectMeta(scope)).title === '测试之书')

const written = await io.writeChapter(scope, 'chapters/v01/c0001.md', { id: 'c0001', number: 1, title: '楔子' }, '雨下了一整夜。')
const readBack = await io.readDocument(scope, 'chapters/v01/c0001.md')
check('章节写入时把 wordCount 盖进 frontmatter',
  readBack.data.wordCount === countWords('雨下了一整夜。') && written.wordCount === readBack.data.wordCount)

const beatsOnly = await io.writeDocument(scope, 'chapters/v01/c0001.md', readBack.data, '只改章纲不改正文。')
check('只改章纲时 wordCount 跟着正文走', beatsOnly.after.includes('wordCount: 8'))

let rejected = ''
try { await io.writeDocument(scope, 'novel.yaml', {}, '') } catch (error) { rejected = error.code }
check('文档通道拒绝 novel.yaml', rejected === 'novel/not-a-document')
rejected = ''
try { await io.readDocument(scope, '../etc/hosts.md') } catch (error) { rejected = error.code }
check('文档通道拒绝逃逸路径', rejected === 'novel/not-a-document' || rejected === 'novel/outside-project')

const created = await io.createCard(scope, 'character', 'chen-mo', '陈默')
check('新卡带 id/type/name 与分节骨架',
  created.id === 'chen-mo' && created.type === 'character' && created.name === '陈默'
  && (await io.readDocument(scope, 'settings/characters/chen-mo.md')).body.includes('## 外貌'))
rejected = ''
try { await io.createCard(scope, 'character', '陈默', '陈默') } catch (error) { rejected = error.code }
check('中文 id 被拒绝（路径必须跨平台安全）', rejected === 'novel/bad-request')
rejected = ''
try { await io.createCard(scope, 'character', 'chen-mo', '陈默') } catch (error) { rejected = error.code }
check('重名卡被拒绝', rejected === 'novel/conflict')

const second = await io.createChapter(scope, { volume: 1, title: '第二章', beats: ['要点'], characters: ['chen-mo'] })
const third = await io.createChapter(scope, { volume: 1, title: '第三章' })
check('建章自动编号且带上章纲',
  second.number === 2 && second.path === 'chapters/v01/c0002.md' && second.beats.join() === '要点'
  && third.number === 3)
rejected = ''
try { await io.createChapter(scope, { volume: 1, title: '撞号', number: 2 }) } catch (error) { rejected = error.code }
check('显式章号撞车时报冲突而不是覆盖', rejected === 'novel/conflict')

await io.writeDocument(scope, 'settings/characters/chen-mo.md', { id: 'chen-mo', type: 'character', name: '陈默', archived: true }, '')
const library = await io.library(scope)
check('设定库按类型分组、统计存档', library.groups[0].type === 'character' && library.total === 1 && library.archived === 1)
check('反向链接由章节派生', library.groups[0].cards[0].appearsIn.join() === 'c0002')
check('两个单文件页报告存在性',
  library.pages.find(page => page.path === 'settings/world.md')?.exists === true
  && library.pages.find(page => page.path === 'settings/timeline.md')?.exists === false)

const listing = await io.listDirectory(scope, 'settings/characters')
check('目录列举给出子路径', listing.exists && listing.entries.some(entry => entry.path === 'settings/characters/chen-mo.md'))
check('不存在的目录只是 exists:false', (await io.listDirectory(scope, 'settings/items')).exists === false)

const snapshot = await io.snapshot(scope)
// c0001's body was replaced by the beats-only write above, so its stamped
// wordCount must follow that body, not the one before it.
check('工程树带章纲、字数与卷结构',
  snapshot.chapterCount === 3
  && snapshot.volumes[0].chapters[1].beats.join() === '要点'
  && snapshot.volumes[0].chapters[0].wordCount === countWords('只改章纲不改正文。'),
  JSON.stringify({ count: snapshot.chapterCount, words: snapshot.volumes[0].chapters[0].wordCount }))
check('没有存档章时两个存档计数是 0', snapshot.archivedCount === 0 && snapshot.archivedWords === 0)

// "Delete" is archive: the chapter leaves the counts but keeps its place in the
// tree and its number, so nothing renumbers and the author can put it back.
await io.writeDocument(
  scope,
  'chapters/v01/c0002.md',
  { id: 'c0002', volume: 1, number: 2, title: '第二章', archived: true },
  '撤稿正文。',
)
const archivedSnapshot = await io.snapshot(scope)
check('已存档的章退出计数、但仍留在树里',
  archivedSnapshot.chapterCount === 2
  && archivedSnapshot.archivedCount === 1
  && archivedSnapshot.archivedWords === countWords('撤稿正文。')
  && archivedSnapshot.volumes[0].chapters.find(chapter => chapter.id === 'c0002')?.archived === true,
  JSON.stringify({ live: archivedSnapshot.chapterCount, archived: archivedSnapshot.archivedCount }))
check('存档不释放章号：下一章仍然是第 4 章',
  (await io.createChapter(scope, { volume: 1, title: '第四章' })).number === 4)

console.log('\n--- 检索（host 侧：一次扫描，读的是文件系统） ---')
await io.writeChapter(scope, 'chapters/v01/c0005.md', {
  id: 'c0005',
  volume: 1,
  number: 5,
  title: '第五章 裂纹',
  characters: ['chen-mo'],
}, '陈默把青铜镜举到灯下，镜面浮起一道裂纹。\n')
await io.writeDocument(scope, 'settings/world.md', { type: 'world', title: '世界观' }, '青石镇是灵气复苏的源头。\n')

const keywordSearch = await io.search(scope, '青铜镜')
check('io.search 一次扫描覆盖章节、设定卡与文档',
  keywordSearch.scanned >= 8 && keywordSearch.counts.chapters >= 1)
check('io.search 命中正文并给出可定位的片段',
  keywordSearch.hits.some(hit =>
    hit.path === 'chapters/v01/c0005.md'
    && (hit.snippet?.text ?? '').includes('青铜镜')))
check('io.search 读到单文件设定页（settings/world.md）',
  (await io.search(scope, '青石镇')).hits.some(hit => hit.path === 'settings/world.md' && hit.kind === 'page'))
const ioAnswer = await io.search(scope, '陈默上次出场在哪')
check('io.search 用真实章节的 frontmatter 作答并指向该章',
  ioAnswer.answer?.kind === 'last-appearance'
  && ioAnswer.answer.chapters.join() === 'chapters/v01/c0005.md'
  && ioAnswer.answer.text.includes('第 5 章'))
check('卡片被检索到时带上存档标记（不信"文件还在就等于在用"）',
  keywordSearch.hits.every(hit => hit.path !== 'settings/characters/chen-mo.md')
  || (await io.search(scope, '陈默')).hits.some(hit => hit.path === 'settings/characters/chen-mo.md' && hit.archived))

console.log('\n--- 一致性检查（host 侧：走文件系统与忽略项落盘） ---')
const hostReport = await io.check(scope)
check('io.check 扫章节、卡与文档，只在真有问题的章上开火', (() => {
  return hostReport.scanned.chapters === 5 && hostReport.scanned.cards === 1 && hostReport.scanned.pages === 4
    && hostReport.issues.length === 1
    && hostReport.issues[0].key === 'archived-ref:chapters/v01/c0005.md:chen-mo'
    && hostReport.issues[0].evidence.length === 2
})(), JSON.stringify(hostReport.issues.map(issue => issue.key)))

const ignoreKey = 'archived-ref:chapters/v01/c0005.md:chen-mo'
const afterIgnore = await io.setCheckIgnore(scope, ignoreKey, true)
check('忽略一条：它离开待处理列表、进了 ignored，并落到 .novel/checks.json',
  afterIgnore.report.issues.every(issue => issue.key !== ignoreKey)
  && afterIgnore.report.ignored.some(issue => issue.key === ignoreKey)
  && (await io.checkIgnores(scope)).join() === ignoreKey
  && fs.files.has('/.novel/checks.json'))
check('忽略决定只写这一个机器文件——不是 index.json（那是可重建缓存，不该存作者的决定）',
  // `.novel/history/` holds M7's modification record, which is a different thing
  // written by a different layer; what this asserts is that the ignore decision
  // itself has exactly one home, and that the rebuildable index file it was
  // originally specified to live in does not exist at all.
  [...fs.files.keys()].filter(key => key.startsWith('/.novel/') && !key.startsWith('/.novel/history/')).join()
    === '/.novel/checks.json'
  && !fs.files.has('/.novel/index.json'),
  [...fs.files.keys()].filter(key => key.startsWith('/.novel/')).join())
const afterRestore = await io.setCheckIgnore(scope, ignoreKey, false)
check('取消忽略：它回来了，忽略列表清空',
  afterRestore.report.issues.some(issue => issue.key === ignoreKey) && afterRestore.ignored.length === 0)
const savedReport = await io.saveCheckReport(scope)
check('报告写进 .novel/runs/，是合法 JSON 且与刚才的报告一致', (() => {
  if (!savedReport.startsWith('.novel/runs/') || !savedReport.endsWith('-consistency.json')) return false
  const stored = fs.files.get(`/${savedReport}`)
  if (stored === undefined) return false
  const parsed = JSON.parse(stored)
  return parsed.issues.length === afterRestore.report.issues.length && typeof parsed.at === 'string'
})())

console.log('\n--- 扫描缓存（P5：慢下来容易，慢下来还能答对才难） ---')

/**
 * A fresh IO layer over its own filesystem double.
 * @param fsDouble - the double to read through.
 * @param root - the project root the sandbox fences writes to.
 * @returns the IO layer.
 */
const cacheIoOf = (fsDouble, root) => new NovelIo({
  fs: fsDouble,
  sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: root }) },
  sessions: { get: () => undefined },
})

const cacheFs = memoryFs({ listVersion: true })
const cacheIo = cacheIoOf(cacheFs, 'cache-book')
const cacheScope = { root: 'cache-book', sessionId: 'cache-session' }
await cacheIo.scaffold(cacheScope, '缓存之书')
await cacheIo.writeChapter(cacheScope, 'chapters/v01/c0001.md',
  { id: 'c0001', volume: 1, number: 1, title: '第一章' }, '陈默走进青石巷，手里握着半块青铜镜。\n')
await cacheIo.writeChapter(cacheScope, 'chapters/v01/c0002.md',
  { id: 'c0002', volume: 1, number: 2, title: '第二章', characters: ['chen-mo'] }, '林晚在崖顶点燃了引魂灯。\n')
await cacheIo.createCard(cacheScope, 'character', 'chen-mo', '陈默')
await cacheIo.createCard(cacheScope, 'character', 'lin-wan', '林晚')

await cacheIo.search(cacheScope, '陈默')
const warmReads = cacheFs.reads.count
cacheFs.stats.paths.length = 0
await cacheIo.search(cacheScope, '陈默')
check('再检索一次：目录照旧列，正文一个字都不重读',
  cacheFs.reads.count === warmReads,
  `多读了 ${String(cacheFs.reads.count - warmReads)} 次：${cacheFs.reads.paths.slice(warmReads).join(', ')}`)
check('冷过一次之后，章节文件连 stat 都不用（令牌由目录列举免费给出）',
  cacheFs.stats.paths.every(path => !(path.endsWith('.md') && path.includes('/chapters/'))),
  cacheFs.stats.paths.filter(path => path.includes('/chapters/')).join(', '))

await cacheIo.writeChapter(cacheScope, 'chapters/v01/c0001.md',
  { id: 'c0001', volume: 1, number: 1, title: '第一章' }, '陈默走进青石巷，镜面裂了一道口子。\n')
check('面板刚保存的那一章，下一次检索就看得见',
  (await cacheIo.search(cacheScope, '镜面裂了一道口子')).hits.some(hit => hit.path === 'chapters/v01/c0001.md'))

cacheFs.touch('cache-book/chapters/v01/c0002.md',
  '---\nid: c0002\nvolume: 1\nnumber: 2\ntitle: 第二章\ncharacters: [lin-wan]\n---\n\n林晚在崖顶吹灭了灯。\n')
const outsideSearch = await cacheIo.search(cacheScope, '吹灭了灯')
check('面板之外改的文件（新令牌）也看得见',
  outsideSearch.hits.some(hit => hit.path === 'chapters/v01/c0002.md'))
check('旧正文不会因为缓存留在结果里',
  !(await cacheIo.search(cacheScope, '引魂灯')).hits.some(hit => hit.path === 'chapters/v01/c0002.md'))
const relinked = await cacheIo.library(cacheScope)
check('卡片的反向链接跟着章节走——卡片自己的令牌一动没动',
  (relinked.groups.flatMap(group => group.cards).find(card => card.id === 'chen-mo')?.appearsIn ?? ['?']).length === 0
  && relinked.groups.flatMap(group => group.cards).find(card => card.id === 'lin-wan')?.appearsIn.join() === 'c0002')

cacheFs.files.delete('cache-book/chapters/v01/c0001.md')
check('文件在面板外被删掉后，它不再出现在工程树里',
  (await cacheIo.snapshot(cacheScope)).chapterCount === 1)

// A backend that reports no version anywhere: the honest answer is to keep
// reading, not to cache against a token that cannot change.
const blindFs = memoryFs({ listVersion: false, statVersion: false })
const blindIo = cacheIoOf(blindFs, 'blind-book')
const blindScope = { root: 'blind-book', sessionId: 'blind-session' }
await blindIo.scaffold(blindScope, '无令牌之书')
await blindIo.writeChapter(blindScope, 'chapters/v01/c0001.md', { id: 'c0001', volume: 1, number: 1, title: '一' }, '陈默握剑。\n')
await blindIo.search(blindScope, '陈默')
const blindReads = blindFs.reads.count
check('后端不给版本号时宁可每次重读，也不凭"文件名没变"缓存',
  (await blindIo.search(blindScope, '陈默')).hits.length > 0 && blindFs.reads.count > blindReads)

// The same relative path in two projects must not answer with the other's text.
const twoFs = memoryFs({ listVersion: true })
const twoIo = cacheIoOf(twoFs, '')
const scopeA = { root: 'book-a', sessionId: 's' }
const scopeB = { root: 'book-b', sessionId: 's' }
await twoIo.scaffold(scopeA, 'A 书')
await twoIo.scaffold(scopeB, 'B 书')
await twoIo.writeChapter(scopeA, 'chapters/v01/c0001.md', { id: 'c0001', volume: 1, number: 1, title: '一' }, '甲书的独有句子：玄铁令。\n')
await twoIo.writeChapter(scopeB, 'chapters/v01/c0001.md', { id: 'c0001', volume: 1, number: 1, title: '一' }, '乙书的独有句子：血书。\n')
check('同名文件在两个工程之间不串（缓存按工程根分家）',
  (await twoIo.search(scopeA, '玄铁令')).hits.length > 0
  && (await twoIo.search(scopeA, '血书')).hits.length === 0
  && (await twoIo.search(scopeB, '血书')).hits.length > 0
  && (await twoIo.search(scopeB, '玄铁令')).hits.length === 0)


console.log('\n--- M7 修改记录：行级 diff ---')

/** A diff as one short string per line, for readable assertions. */
const shape = diff => diff.map(line => `${line.kind === 'same' ? '=' : line.kind === 'add' ? '+' : '-'}${line.text}`).join('|')

check('同一份文本：全是上下文，零增零删',
  shape(diffLines('甲\n乙', '甲\n乙')) === '=甲|=乙'
  && diffCounts(diffLines('甲\n乙', '甲\n乙')).added === 0)
check('新建（before 为空）不产生一行「删掉空行」',
  shape(diffLines('', '---\n甲\n---\n\n正文')) === '+---|+甲|+---|+|+正文',
  shape(diffLines('', '---\n甲\n---\n\n正文')))
check('中间插一行：只报一增，前后都还在',
  shape(diffLines('甲\n丙', '甲\n乙\n丙')) === '=甲|+乙|=丙',
  shape(diffLines('甲\n丙', '甲\n乙\n丙')))
check('删一行：只报一删',
  shape(diffLines('甲\n乙\n丙', '甲\n丙')) === '=甲|-乙|=丙',
  shape(diffLines('甲\n乙\n丙', '甲\n丙')))
check('改一行：一减一增，上下文不动',
  shape(diffLines('甲\n乙\n丙', '甲\n丁\n丙')) === '=甲|-乙|+丁|=丙',
  shape(diffLines('甲\n乙\n丙', '甲\n丁\n丙')))
check('末尾换行也是一次改动',
  diffCounts(diffLines('甲\n乙\n', '甲\n乙')).removed === 1)
const numbered = diffLines('甲\n乙\n丙', '甲\n丁\n丙')
check('行号：删的行报 before 的行号，增的行报 after 的行号',
  numbered.find(line => line.kind === 'remove').line === 2
  && numbered.find(line => line.kind === 'add').line === 2
  && numbered[0].line === 1 && numbered.at(-1).line === 3,
  JSON.stringify(numbered))

// Past the exact-diff cap the alignment is not worth the memory, and the honest
// description of a wholesale rewrite is "everything removed, everything added".
const hugeBefore = Array.from({ length: 2100 }, (_, index) => `旧 ${String(index)}`).join('\n')
const hugeAfter = Array.from({ length: 2100 }, (_, index) => `新 ${String(index)}`).join('\n')
const huge = diffCounts(diffLines(hugeBefore, hugeAfter))
check('整篇重写超过精确上限时退回粗粒度，且一行都不丢',
  huge.removed === 2100 && huge.added === 2100,
  JSON.stringify(huge))

// How the panel folds a diff for display: a chapter's diff is mostly context, so
// the question is which unchanged lines the author still sees.
const longRun = ['头', '改前', ...Array.from({ length: 40 }, (_, index) => `中间 ${String(index)}`), '改后', '尾']
const longDiff = diffLines(longRun.join('\n'), ['头', '改前', '换掉', ...longRun.slice(3)].join('\n'))
const collapsed = diffRows(longDiff)
const gaps = collapsed.filter(row => row.kind === 'gap')
check('长段未改动被折成一行提示，改动点仍然看得到',
  // 41 unchanged lines follow the change; six of them stay as context.
  gaps.length === 1 && gaps[0].count === 41 - 6
  && collapsed.filter(row => row.kind === 'line').length === collapsed.length - 1
  && shape(longDiff).includes('+换掉'),
  JSON.stringify(collapsed.map(row => row.kind === 'gap' ? `…${String(row.count)}…` : row.line.kind)))
check('折叠不丢行：显示的行数加上折起来的行数，等于 diff 的长度',
  collapsed.reduce((sum, row) => sum + (row.kind === 'gap' ? row.count : 1), 0) === longDiff.length)
check('展开时一条都不折', diffRows(longDiff, true).every(row => row.kind === 'line'))
const shortRun = diffRows(diffLines('甲\n乙\n丙', '甲\n丁\n丙'))
check('短段未改动不折（折了反而更占地方）', shortRun.length === 4 && shortRun.every(row => row.kind === 'line'))

console.log('\n--- 定位到正文：把一句话找回来 ---')
const locateBody = '第一段。\n\n陈默握紧了那半块青铜镜，\n指节发白。\n'
check('逐字命中时给出精确范围',
  (() => {
    const found = findQuote(locateBody, '握紧了那半块青铜镜')
    return found.kind === 'found' && found.exact
      && locateBody.slice(found.start, found.end) === '握紧了那半块青铜镜'
  })())
check('模型漏了标点或换行时，空白不敏感地找回来，且范围落在原文上',
  (() => {
    // What a model quotes from memory: the line break and the comma are gone.
    const found = findQuote(locateBody, '陈默握紧了那半块青铜镜指节发白')
    return found.kind === 'found' && !found.exact
      && locateBody.slice(found.start, found.end) === '陈默握紧了那半块青铜镜，\n指节发白'
  })(),
  JSON.stringify(findQuote(locateBody, '陈默握紧了那半块青铜镜指节发白')))
check('真的不在正文里就报找不到，不返回一个假位置',
  findQuote(locateBody, '林晚在崖顶吹灭了灯').kind === 'missing'
  && findQuote(locateBody, '   ').kind === 'missing')

console.log('\n--- 伏笔：记下来、读回来、跳回去 ---')
check('伏笔 id 自动生成：只数同形状的，跳过手写的与别的前缀',
  nextThreadId([]) === 'th-001'
  && nextThreadId(['th-001', 'th-007']) === 'th-008'
  && nextThreadId(['mirror-origin', 'fs-003']) === 'th-001'
  && nextThreadId(['th-009', 'th-100']) === 'th-101',
  `${nextThreadId([])} / ${nextThreadId(['th-009', 'th-100'])}`)
check('章节 id 从路径推出（浏览器也要用，所以它住在 paths.ts）',
  chapterIdOfPath('chapters/v01/c0001.md') === 'c0001'
  && chapterIdOfPath('settings/world.md') === undefined
  && chapterIdOfPath('chapters/v01/sub/c0001.md') === undefined)

const threadData = {
  status: 'planted',
  plantedIn: 'c0001',
  plantedQuote: '他握紧了那半块青铜镜',
  reinforcedIn: ['c0007'],
  plannedPayoff: '第一卷末',
  payoffIn: ['c0100'],
  payoffQuote: '镜面裂开，露出里面的旧刻痕',
}
const threadRecord = readThread(threadData)
check('伏笔卡的原句与生命周期都读得出来',
  threadRecord.plantedQuote === '他握紧了那半块青铜镜'
  && threadRecord.payoffQuote === '镜面裂开，露出里面的旧刻痕'
  && threadRecord.plannedPayoff === '第一卷末'
  && threadRecord.payoffIn.join() === 'c0100')
check('没写的字段保持「缺失」，不是空串（检查规则要靠这个区分「没填」和「填了空」）',
  readThread({ status: 'planted' }).plantedIn === undefined
  && readThread({ status: 'planted' }).plantedQuote === undefined
  && readThread({ status: 'planted' }).plannedPayoff === undefined
  && readThread({ status: 'planted' }).reinforcedIn.length === 0)
check('生命周期章节按 埋点→强化→回收 排，且去重',
  threadChaptersOf(threadRecord).join() === 'c0001,c0007,c0100'
  && threadChaptersOf(readThread({ plantedIn: 'c0001', reinforcedIn: ['c0001'], payoffIn: ['c0001'] })).join() === 'c0001')

// What the author is pointing at, without a DOM in the way.
const pointedBody = '第一行。\n第二行有铜镜。\n第三行。'
check('有选区时取选中的那段',
  pointedText({ selectionStart: 9, selectionEnd: 12 }, pointedBody) === '铜镜。',
  pointedText({ selectionStart: 9, selectionEnd: 12 }, pointedBody))
check('没有选区时取光标所在的那一行',
  pointedText({ selectionStart: 12, selectionEnd: 12 }, pointedBody) === '第二行有铜镜。'
  && pointedText({ selectionStart: 0, selectionEnd: 0 }, pointedBody) === '第一行。')
check('光标停在换行符上算它上面的那一行（视觉上它就在行尾）',
  pointedText({ selectionStart: 4, selectionEnd: 4 }, pointedBody) === '第一行。')
check('空行与没有编辑器时不编一个引文出来',
  pointedText({ selectionStart: 2, selectionEnd: 2 }, '甲\n\n乙') === ''
  && pointedText(null, pointedBody) === '')
check('行首行尾的偏移不越界', lineAt(pointedBody, 0) === '第一行。' && lineAt(pointedBody, 999) === '第三行。')

// The round trip the panel actually performs: a thread card written with both
// sentences must reach the summary the thread surface renders from.
const threadFs = memoryFs()
const threadIo = cacheIoOf(threadFs, 'thread-book')
const threadScope = { root: 'thread-book', sessionId: 'thread-session' }
await threadIo.scaffold(threadScope, '伏笔之书')
await threadIo.createCard(threadScope, 'thread', 'th-001', '半块青铜镜的来历')
await threadIo.writeDocument(threadScope, 'settings/threads/th-001.md', {
  id: 'th-001',
  type: 'thread',
  title: '半块青铜镜的来历',
  status: 'paid',
  plantedIn: 'c0001',
  plantedQuote: '他握紧了那半块青铜镜',
  reinforcedIn: ['c0001'],
  payoffIn: ['c0002'],
  payoffQuote: '镜面裂开，露出里面的旧刻痕',
}, '\n## 埋点方式\n\n第一章的那面镜子。\n')
const threadLibrary = await threadIo.library(threadScope)
const threadCard = threadLibrary.groups.flatMap(group => group.cards).find(card => card.id === 'th-001')
check('伏笔卡的原句一路走到面板拿到的摘要里（面板的伏笔页就是靠它跳转的）',
  threadCard?.thread?.plantedQuote === '他握紧了那半块青铜镜'
  && threadCard.thread.payoffQuote === '镜面裂开，露出里面的旧刻痕',
  JSON.stringify(threadCard?.thread))
check('状态与回收章一起读出来，顺序与去重都对',
  threadCard?.thread?.status === 'paid'
  && threadCard.thread.payoffIn.join() === 'c0002'
  && threadChaptersOf(threadCard.thread).join() === 'c0001,c0002')
check('非伏笔的卡没有伏笔记录（不给每种卡都塞一个空壳）',
  threadLibrary.groups.flatMap(group => group.cards).every(card => card.type === 'thread' || card.thread === undefined))

console.log('\n--- M7 修改记录：存储格式 ---')
check('历史目录按文档路径分家、去掉 .md',
  historyDirOf('chapters/v01/c0001.md') === '.novel/history/chapters/v01/c0001'
  && historyDirOf('settings/world.md') === '.novel/history/settings/world',
  historyDirOf('chapters/v01/c0001.md'))
check('时间戳文件名不含冒号（Windows 不允许）',
  historyStamp('2026-09-12T10:20:30.123Z') === '2026-09-12T10-20-30-123Z',
  historyStamp('2026-09-12T10:20:30.123Z'))
check('同毫秒的两版按写入先后排序，不按字典序（`-` 排在 `.` 前面）',
  compareHistoryFiles('2026-09-12T10-20-30-123Z.json', '2026-09-12T10-20-30-123Z-2.json') < 0
  && compareHistoryFiles('2026-09-12T10-20-30-123Z-2.json', '2026-09-12T10-20-30-124Z.json') < 0
  && compareHistoryFiles('2026-09-12T10-20-30-124Z.json', '2026-09-12T10-20-30-123Z.json') > 0
  && compareHistoryFiles('2026-09-12T10-20-30-123Z.json', '2026-09-12T10-20-30-123Z.json') === 0)
check('已占用的时间戳让位一毫秒（版本的身份就是时间戳，撞车就等于有一版够不着）',
  freeHistoryStamp(new Set(), '2026-09-12T10:00:00.000Z') === '2026-09-12T10:00:00.000Z'
  && freeHistoryStamp(new Set(['2026-09-12T10-00-00-000Z.json']), '2026-09-12T10:00:00.000Z') === '2026-09-12T10:00:00.001Z'
  && freeHistoryStamp(
    new Set(['2026-09-12T10-00-00-000Z.json', '2026-09-12T10-00-00-001Z.json', '2026-09-12T10-00-00-002Z.json']),
    '2026-09-12T10:00:00.000Z',
  ) === '2026-09-12T10:00:00.003Z'
  && freeHistoryStamp(new Set(), '不是时间') === undefined)
check('动作由两版内容判定：新建 / 存档 / 恢复 / 修改，而回滚优先于内容',
  actionOf('', 'x', false, false, { kind: 'manual' }) === 'create'
  && actionOf('x', 'x2', false, true, { kind: 'manual' }) === 'archive'
  && actionOf('x', 'x2', true, false, { kind: 'manual' }) === 'restore'
  && actionOf('x', 'x2', false, false, { kind: 'manual' }) === 'update'
  && actionOf('x', 'x2', false, false, { kind: 'revert', from: 'X' }) === 'revert')
check('条目解析：不是对象 / 没有时间戳的一律丢掉',
  parseHistoryEntry(null, 'a.md') === undefined
  && parseHistoryEntry([], 'a.md') === undefined
  && parseHistoryEntry({ before: 'x' }, 'a.md') === undefined)
check('条目解析：缺 before/after 当空文本，未知动作当「修改」',
  (() => {
    const entry = parseHistoryEntry({ at: 'T', action: '爆炸' }, 'a.md')
    return entry?.before === '' && entry.after === '' && entry.action === 'update' && entry.source.kind === 'manual'
  })())
check('条目解析：认得任务来源与回滚来源',
  parseHistoryEntry({ at: 'T', source: { kind: 'task', label: '润色本章' } }, 'a.md')?.source.label === '润色本章'
  && parseHistoryEntry({ at: 'T', source: { kind: 'revert', from: 'X' } }, 'a.md')?.source.kind === 'revert'
  && parseHistoryEntry({ at: 'T', source: { kind: '胡说' } }, 'a.md')?.source.kind === 'manual')

console.log('\n--- M7 修改记录：写入即记录、回滚即一次写入 ---')
const histFs = memoryFs()
const histIo = cacheIoOf(histFs, 'hist-book')
const histScope = { root: 'hist-book', sessionId: 'hist-session' }
await histIo.scaffold(histScope, '历史之书')
check('脚手架写下的文件本身也是「新建」版本（建工程也算一次新增）',
  (await histIo.history(histScope, 'chapters/v01/c0001.md'))[0]?.action === 'create')

// A chapter the scaffold did not write, so these assertions are about this test's
// own writes rather than about the fixture.
const chapterPathUnderTest = 'chapters/v01/c0002.md'
const chapter = { id: 'c0002', volume: 1, number: 2, title: '第二章' }

await histIo.writeChapter(histScope, chapterPathUnderTest, chapter, '第一版正文。\n')
let versions = await histIo.history(histScope, chapterPathUnderTest)
check('新建一章就留下一条记录，动作是「新建」', versions.length === 1 && versions[0].action === 'create',
  JSON.stringify(versions))

await histIo.writeChapter(histScope, chapterPathUnderTest, chapter, '第二版正文。\n', { kind: 'task', label: '润色本章' })
versions = await histIo.history(histScope, chapterPathUnderTest)
check('再存一次多一条，最新在前，并带上任务来源',
  versions.length === 2 && versions[0].source.kind === 'task' && versions[0].source.label === '润色本章',
  JSON.stringify(versions.map(entry => entry.source)))

await histIo.writeChapter(histScope, chapterPathUnderTest, chapter, '第二版正文。\n')
check('一字未改的保存不产生版本（记录里不该有「没区别」的条目）',
  (await histIo.history(histScope, chapterPathUnderTest)).length === 2)

const firstVersion = versions[1].at
const oneVersion = await histIo.historyEntry(histScope, chapterPathUnderTest, firstVersion)
check('取一版带两段全文，diff 能算出来',
  oneVersion?.before === '' && oneVersion.after.includes('第一版正文。')
  && diffCounts(diffLines(oneVersion.before, oneVersion.after)).added > 0)

const restored = await histIo.revert(histScope, chapterPathUnderTest, firstVersion)
check('回滚到第一版：正文换回去了', restored.body.trim() === '第一版正文。', restored.body.trim())
const afterRevert = await histIo.history(histScope, chapterPathUnderTest)
check('回滚本身也是一条版本（所以回滚可以再回滚）',
  afterRevert.length === 3 && afterRevert[0].action === 'revert' && afterRevert[0].source.kind === 'revert',
  JSON.stringify(afterRevert.map(entry => entry.action)))
check('回滚回滚：又回到第二版',
  (await histIo.revert(histScope, chapterPathUnderTest, versions[0].at)).body.trim() === '第二版正文。')

await histIo.writeChapter(histScope, chapterPathUnderTest, { ...chapter, archived: true }, '第二版正文。\n')
check('存档在记录里显示为「存档」，不是一个无名的「修改」',
  (await histIo.history(histScope, chapterPathUnderTest))[0].action === 'archive')

check('列表可以用 limit 限制条数（只读最近的，不读整段历史）',
  (await histIo.history(histScope, chapterPathUnderTest, 2)).length === 2)

let historyRejection = ''
try { await histIo.history(histScope, 'novel.yaml') } catch (error) { historyRejection = error.code }
check('修改记录只对可编辑文档开放', historyRejection === 'novel/not-a-document', historyRejection)
historyRejection = ''
try { await histIo.revert(histScope, chapterPathUnderTest, '1999-01-01T00:00:00.000Z') } catch (error) { historyRejection = error.code }
check('回滚到一个不存在的版本报 not-found', historyRejection === 'novel/not-found', historyRejection)

// The chapter's id and a card's id are both plain slugs, which is exactly why the
// history directory is keyed by path and not by id.
await histIo.createCard(histScope, 'character', 'c0002', '同名 id 的卡')
check('同名 id 的卡与章各有各的历史（这就是按路径分家的理由）',
  (await histIo.history(histScope, 'settings/characters/c0002.md')).length === 1
  && (await histIo.history(histScope, chapterPathUnderTest)).length === 5,
  `卡 ${String((await histIo.history(histScope, 'settings/characters/c0002.md')).length)} 条 / 章 ${String((await histIo.history(histScope, chapterPathUnderTest)).length)} 条`)

await histIo.writeMeta(histScope, { title: '改个名' })
const machineHistory = [...histFs.files.keys()].filter(key => key.startsWith('/.novel/history/'))
check('历史只记四棵内容树，不记 novel.yaml / .novel 自己的文件',
  machineHistory.every(key => /^\/\.novel\/history\/(chapters|settings|outline|style)\//.test(key)),
  machineHistory.filter(key => !/^\/\.novel\/history\/(chapters|settings|outline|style)\//.test(key)).join(', '))

console.log('\n--- 写作子会话（P2 修复：不再出现在作者会话列表里） ---')
const { writerMessage, writerDescriptor, startWritingRun, runState } = await import('../src/novel/writing.ts')

const message = writerMessage('只输出两个字：接通')
check('任务消息是 inbox 认的四字段',
  Object.keys(message).sort().join() === 'content,id,role,source'
  && message.role === 'user' && message.content[0].type === 'text'
  && message.content[0].text === '只输出两个字：接通' && message.source.kind === 'user')
check('任务消息被深冻结',
  Object.isFrozen(message) && Object.isFrozen(message.content) && Object.isFrozen(message.content[0]))
check('两个任务拿到不同消息 id', writerMessage('a').id !== writerMessage('a').id)

const descriptor = writerDescriptor('按章纲写整章')
check('子会话描述符是 DSH 当前的 one-shot 形状',
  descriptor.version === 3 && descriptor.mode === 'one-shot'
  && descriptor.provider === 'novel-copilot' && descriptor.label === '按章纲写整章')
check('描述符不带 label 时不写空字段', !Object.hasOwn(writerDescriptor(undefined), 'label'))
check('描述符字段集与 one-shot schema 一致（多一个字段 DSH 就判为损坏）',
  Object.keys(descriptor).every(key => ['version', 'mode', 'provider', 'label'].includes(key)))

/** A minimal host double for one writing run. */
function fakeWritingHost() {
  const listeners = new Map()
  const created = []
  const appended = []
  const followups = []
  const warnings = []
  const ctx = {
    agents: {
      async create(options) {
        created.push(options)
        return {
          agent: {
            session: {
              id: options.sessionId,
              append: (type, data) => { appended.push({ type, data }) },
            },
            followup: (value) => { followups.push(value) },
          },
          dispose: async () => {},
        }
      },
      get: () => ({ options: { provider: 'deepseek', model: 'chat' }, session: { header: { cwd: 'E:/book' } } }),
    },
    on: (event, listener) => {
      const bucket = listeners.get(event) ?? []
      bucket.push(listener)
      listeners.set(event, bucket)
    },
    logger: { warn: (value) => { warnings.push(String(value)) } },
  }
  return { ctx, created, appended, followups, warnings, listeners }
}

const tick = () => new Promise(resolve => { setTimeout(resolve, 0) })
const host = fakeWritingHost()
const runId = startWritingRun(host.ctx, 'session-author', '只输出两个字：接通', '续写')
await tick()

const options = host.created[0]
check('写作子会话被标记为 subagent 子会话（作者侧栏据此隐藏它）',
  options?.meta.origin === 'subagent' && options.meta.parentSession === 'session-author'
  && options.meta.delegationDepth === 1 && options.meta.isSeeded === false)
check('子会话沿用作者的 cwd，记录不再是"无 cwd 的孤儿"', options?.meta.cwd === 'E:/book')
check('模型路由仍然复用作者会话', options?.agentOptions.provider === 'deepseek' && options.agentOptions.model === 'chat')
check('提示词交给子会话自己的 followup（Session API 会拒绝按普通 id 驱动子代理）',
  host.followups.length === 1 && host.followups[0].content[0].text === '只输出两个字：接通')

// The setup callback runs inside the host's create transaction; drive it the
// way the factory does, then fire its pre-step hook as the first turn opens.
const hooks = []
const childAgent = { session: { id: options.sessionId, append: (type, data) => { host.appended.push({ type, data }) } } }
options.setup({
  systemPrompt: { section: () => {} },
  tools: { restrict: () => {} },
  on: (event, listener) => { hooks.push({ event, listener }) },
}, childAgent)
check('setup 注册了 pre-step 钩子（描述符要落在初始轮次里）', hooks.some(hook => hook.event === 'agent/pre-step'))
const preStep = hooks.find(hook => hook.event === 'agent/pre-step')
if (preStep !== undefined) await preStep.listener({}, async () => ({ kind: 'enter' }))
const first = host.appended[0]
check('描述符在初始轮次里落成一次，且带任务标签',
  host.appended.length === 1 && first?.type === 'subagent/descriptor'
  && first.data.mode === 'one-shot' && first.data.label === '续写')

// Stream and settle the run the way the host does.
for (const listener of host.listeners.get('agent/assistant-stream') ?? []) {
  listener({ agent: { session: { id: options.sessionId } }, frame: { type: 'chunk', chunk: { type: 'text-delta', text: '接通' } } })
}
for (const listener of host.listeners.get('session/event') ?? []) {
  listener({ id: options.sessionId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
}
const settledRun = runState(runId)
check('文本按 delta 累积、按 turn/end 结算',
  settledRun?.text === '接通' && settledRun.done === true && settledRun.reason === 'completed')
check('描述符不会重复落成', host.appended.length === 1)

console.log('\n--- 工程记忆（打开过的项目） ---')
const { parseRecents, rememberProject, recentLabel, loadRecents, saveRecents, RECENTS_KEY } = await import('../src/client/projects.ts')

const entry = (root, title, at) => ({ root, title, at })
check('记住的工程同路径去重、最新的排在最前',
  rememberProject([entry('/a', '甲', 1), entry('/b', '乙', 2)], entry('/a', '甲改名', 3))
    .map(item => `${item.root}:${item.title}`).join() === '/a:甲改名,/b:乙')
check('列表有上限，多的被挤掉',
  rememberProject(
    Array.from({ length: 8 }, (_, index) => entry(`/p${String(index)}`, 'x', index)),
    entry('/new', '新', 99),
  ).length === 8)
check('存储里损坏的值只丢记忆，不抛异常',
  parseRecents('{"not":"an array"}').length === 0
  && parseRecents('这不是 JSON').length === 0
  && parseRecents(undefined).length === 0
  && parseRecents('').length === 0)
check('混入的坏条目被丢掉、好的留下',
  parseRecents(JSON.stringify([
    { root: '/ok', title: '甲', at: 5 },
    { root: '', title: 'x', at: 1 },
    { root: '/no-at', title: 'x' },
    42,
  ])).map(item => item.root).join() === '/ok')
check('无序的存储值读出来是有序的',
  parseRecents(JSON.stringify([entry('/old', 'a', 1), entry('/new', 'b', 9)])).map(item => item.root).join() === '/new,/old')
check('标签优先用书名，没有书名回落到路径',
  recentLabel(entry('/a', '测试之书', 1)) === '《测试之书》' && recentLabel(entry('/a', '', 1)) === '/a')

/** A minimal Web Storage double. */
function memoryStorage() {
  const cell = new Map()
  return {
    cell,
    getItem: key => cell.get(key) ?? null,
    setItem: (key, value) => { cell.set(key, value) },
  }
}
const store = memoryStorage()
saveRecents([entry('/x', '乙', 2)], store)
check('写进去的能读回来', store.cell.has(RECENTS_KEY) && loadRecents(store).map(item => item.root).join() === '/x')
check('没有存储可用时静默降级', loadRecents(undefined).length === 0)
const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
check('存储抛异常时不炸面板', loadRecents(broken).length === 0 && saveRecents([], broken) === undefined)

// ---------------------------------------------------------------------------
// The 404 message. This is the one code path whose whole purpose is to be read
// when something is already wrong — the day it mattered, the panel said only
// "host 返回了非 JSON 响应（HTTP 404）" and that cost a round trip to diagnose
// (`06` §3.4). It asserts on a stubbed fetch here so it cannot rot.
console.log('\n--- 路由不在运行中的 host 里时，面板说什么 ---')
const api = await import('../src/client/api.ts')
const probed = []
globalThis.fetch = async (url) => {
  const path = String(url)
  probed.push(path)
  if (path.includes('/ping')) {
    return new Response(JSON.stringify({
      ok: true,
      name: 'dsh-ai-novel-copilot',
      defaultRoot: '/x',
      routes: ['/api/novel/ping', '/api/novel/cards'],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  // What a carrier answers for a path nobody registered: HTML, not our envelope.
  return new Response('<!doctype html><title>Not Found</title>', {
    status: 404,
    headers: { 'content-type': 'text/html' },
  })
}
let routeMessage = ''
try { await api.search('s', '/x', '陈默') } catch (error) { routeMessage = error.message }
check('非 JSON 的 404 说清是「运行中的 host 没有这个路由」，并带上它自己报告的路由表',
  routeMessage.includes('/api/novel/search')
  && routeMessage.includes('2 条路由')
  && routeMessage.includes('里面没有它')
  && routeMessage.includes('新进程'))
check('这句话的证据来自运行中的 host 自己（确实问了 ping）',
  probed.some(path => path.includes('/api/novel/ping')))

globalThis.fetch = async () => new Response('<html>boom</html>', { status: 500 })
let otherMessage = ''
try { await api.search('s', '/x', '陈默') } catch (error) { otherMessage = error.message }
check('其他非 JSON 状态不乱编解释', otherMessage === 'host 返回了非 JSON 响应（HTTP 500）')

globalThis.fetch = async () => new Response('nope', { status: 404 })
let bareMessage = ''
try { await api.search('s', '/x', '陈默') } catch (error) { bareMessage = error.message }
check('连 ping 也是 404 时不再递归，只报路由缺失',
  bareMessage.includes('host 里没有这个路由') && bareMessage.length < 90, bareMessage)

console.log('\n--- 一轮失败不能装成「生成完成但什么也没写」 ---')
// Real finding from running the M6 model check where the instance had no working
// model route: the session ended with reason `error`, produced no text, and the
// panel reported a finished task with 0 findings and an empty raw output.
const { startRun, isFailedReason } = await import('../src/client/runner.ts')
check('会话报 error 被认成失败', isFailedReason('error') && !isFailedReason('completed') && !isFailedReason(undefined))

/** Drive one run against a stubbed transport. */
async function driveRun(polls) {
  const events = []
  globalThis.fetch = async (url) => {
    const path = String(url)
    if (!path.includes('runId=')) {
      return new Response(JSON.stringify({ ok: true, runId: 'run-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const next = polls.shift() ?? { text: '', done: true, reason: 'completed' }
    return new Response(JSON.stringify({ ok: true, run: next }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  await new Promise(resolve => {
    startRun('s', 'prompt', 'label', {
      onDelta: text => { events.push(`delta:${text}`) },
      onSettle: reason => { events.push(`settle:${reason}`); resolve() },
      onError: message => { events.push(`error:${message}`); resolve() },
    })
  })
  return events
}

const failedRun = await driveRun([{ text: '', done: true, reason: 'error' }])
check('reason=error 走 onError，且说明这一轮没有输出',
  failedRun.length === 1 && failedRun[0].startsWith('error:') && failedRun[0].includes('没有留下任何输出'), failedRun.join('|'))
const finishedRun = await driveRun([
  { text: '接通', done: false },
  { text: '接通', done: true, reason: 'completed' },
])
check('正常结束仍然是 onSettle，且增量按累积长度投递',
  finishedRun.join('|') === 'delta:接通|settle:completed', finishedRun.join('|'))
const reportedRun = await driveRun([{ text: '', done: true, reason: 'error', error: '无法创建写作 agent：没有可用凭据' }])
check('host 报了失败文本时用 host 的原话',
  reportedRun.join('|') === 'error:无法创建写作 agent：没有可用凭据', reportedRun.join('|'))

console.log(`\n${failed === 0 ? 'RESULT: PASS' : `RESULT: FAIL — ${String(failed)} 项不符`}（${String(passed)} 通过 / ${String(failed)} 失败）`)
process.exit(failed === 0 ? 0 : 1)
