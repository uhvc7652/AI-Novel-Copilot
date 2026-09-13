/**
 * Client-half load check for the P0-0 spike.
 *
 * Runs the built `lib/client.js` under Node with a stubbed module loader and a
 * stubbed cordis context, then renders each surface with `react-dom/server`.
 * This answers the questions a browser would otherwise be needed for:
 *
 *   1. Does the bundle's closure factory execute and export the module face?
 *   2. Does `apply()` register the tab type and the tab body without throwing?
 *   3. Does each component actually render (JSX + hooks valid)?
 *   4. Does a specific branch's text appear — and, for the one styling mistake
 *      that is invisible to every other check, is a dimmed text style wrapped
 *      around a live control?
 *
 * It does NOT replace a real browser: DOM events, the sidebar shell, and the
 * host round trip still need the real UI.
 *
 * Usage: node spike/client-load-check.mjs
 */
import { readFile, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// Both the bundle and this renderer must go through the SAME module instance:
// an ESM `import` of react-dom would load the ESM React alongside the CJS one
// the bundle requires, and React reports that dual instance as an invalid hook
// call. In the browser both come from the shell's single module table.
const { renderToStaticMarkup } = require('react-dom/server')

/** Registrations the bundle performed on the stubbed loader. */
const loaded = []
/** Everything `apply()` did, in order. */
const trace = []

const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const fakeWindow = { __ModuleLoader__: { load: registration => loaded.push(registration) } }
const moduleShim = { exports: {} }

// The bundle is CJS by contract; `type: module` means Node would not run it
// directly, so it is evaluated the way the browser's module table does.
new Function('window', 'require', 'module', 'exports', code)(
  fakeWindow,
  require,
  moduleShim,
  moduleShim.exports,
)

console.log(`loader registrations: ${String(loaded.length)}`)
const registration = loaded[0]
if (registration === undefined) {
  console.log('RESULT: FAIL — the bundle never called window.__ModuleLoader__.load')
  process.exit(1)
}
console.log(`  id: ${String(registration.id)}`)
console.log(`  factory is a function: ${String(typeof registration.factory === 'function')}`)

/** Every specifier the bundle resolved, so instance identity can be asserted. */
const resolved = new Map()
const bundleRequire = (specifier) => {
  const loadedModule = require(specifier)
  if (!resolved.has(specifier)) resolved.set(specifier, loadedModule)
  return loadedModule
}

const face = registration.factory(bundleRequire)
console.log(`exports: ${Object.keys(face).join(', ')}`)
console.log(`  boot graph module requests: ${[...resolved.keys()].join(', ')}`)
console.log(`  react instance shared with the renderer: ${String(resolved.get('react') === require('react'))}`)
console.log(`  apply is a function: ${String(typeof face.apply === 'function')}`)
console.log(`  inject: ${JSON.stringify(face.inject)}`)

if (typeof face.apply !== 'function') {
  console.log('RESULT: FAIL — the module face has no apply()')
  process.exit(1)
}

let registeredBody
const slotRegistrations = []
const ctx = {
  effect(callback, label) {
    trace.push(`effect(${String(label)})`)
    const disposer = callback()
    trace.push(`  -> ran, disposer=${typeof disposer}`)
    return disposer
  },
  sidebarRightTabs: {
    register(definition) {
      trace.push(`sidebarRightTabs.register(id=${definition.id} kind=${definition.kind} priority=${definition.priority})`)
      trace.push(`  title() = ${definition.title()}`)
      trace.push(`  guide entries = ${String(definition.guide?.length ?? 0)}`)
      return () => {}
    },
  },
  sidebarRight: {
    expand() {
      trace.push('sidebarRight.expand()')
    },
    openTab(kind) {
      trace.push(`sidebarRight.openTab(${String(kind)})`)
    },
  },
  slots: {
    inject(name, install) {
      trace.push(`slots.inject(${name})`)
      return install()
    },
    register(options, component) {
      trace.push(`slots.register(name=${options.name} key=${String(options.key)} id=${String(options.id)}) component=${typeof component}`)
      registeredBody = component
      slotRegistrations.push({ options, component })
      return () => {}
    },
  },
}

try {
  face.apply(ctx)
  console.log('apply() completed without throwing')
} catch (error) {
  console.log(`RESULT: FAIL — apply() threw: ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
}

console.log('--- trace ---')
for (const line of trace) console.log(line)

if (slotRegistrations.length === 0) {
  console.log('RESULT: FAIL — no slot registration happened')
  process.exit(1)
}

try {
  // Each component is handed to the renderer, never invoked directly: a direct
  // call runs its hooks outside any render and React reports an invalid hook
  // call. The registration's inject face is delivered as props, as the slot
  // framework does.
  for (const { options, component } of slotRegistrations) {
    // The framework calls a function-valued `inject` per render and spreads the
    // result into props. An object here is exactly the bug that renders a pane
    // blank with `inject is not a function`, so this check reproduces that contract.
    if (options.inject !== undefined && typeof options.inject !== 'function') {
      throw new TypeError(`${String(options.name)}: inject must be a function, got ${typeof options.inject}`)
    }
    const injected = typeof options.inject === 'function' ? options.inject() : {}
    const element = require('react').createElement(component, {
      sessionId: 'spike-session',
      ...injected,
    })
    const markup = renderToStaticMarkup(element)
    console.log(`--- rendered ${String(options.name)} (${String(markup.length)} chars) ---`)
    console.log(markup.slice(0, 700))
  }
  checkSurfaces(face, require('react'), renderToStaticMarkup)
  await checkDimmedControls()
  console.log('RESULT: PASS — bundle executes, registrations correct, every surface renders')
} catch (error) {
  console.log(`RESULT: FAIL — render threw: ${error instanceof Error ? error.stack : String(error)}`)
  process.exit(1)
}

/**
 * Render each P2 surface with real fixtures, then look for the text that only
 * exists when the interesting branch ran.
 *
 * P1 shipped a task button that was dead on arrival: the branch that draws it
 * runs only once a chapter is open, the check never opened one, and rendering
 * "passed". So every assertion here is about content that a *specific* branch
 * produces — a card in the library list, a beat row, the three task buttons —
 * not merely that markup came back.
 */
function checkSurfaces(face, react, render) {
  const views = face.__views
  if (views === undefined) throw new TypeError('module face exports no __views (needed to render the surfaces)')
  const env = {
    sessionId: 'spike-session',
    root: 'E:/spike-novel',
    busy: false,
    run: async () => 'ok',
    note: () => {},
    error: () => {},
  }
  const chapter = {
    path: 'chapters/v01/c0001.md',
    id: 'c0001',
    volume: 1,
    number: 1,
    title: '楔子·雨夜',
    status: 'draft',
    targetWords: 3000,
    wordCount: 1200,
    beats: ['陈默在雨夜捡到半块青铜镜', '被巡夜人撞见，仓皇逃走'],
    summary: '陈默捡到青铜镜。',
    pov: 'chen-mo',
    characters: ['chen-mo'],
    locations: ['qingshi-town'],
  }
  const snapshot = {
    title: '测试之书',
    genre: '中文长篇网文',
    targetWords: 1000000,
    volumes: [{ dir: 'v01', volume: 1, chapters: [chapter] }],
    chapterCount: 1,
    wordCount: 1200,
  }
  const library = {
    groups: [
      {
        type: 'character',
        label: '角色',
        dir: 'characters',
        cards: [
          {
            path: 'settings/characters/chen-mo.md',
            id: 'chen-mo',
            type: 'character',
            name: '陈默',
            aliases: ['默哥'],
            role: '主角',
            status: '',
            archived: false,
            tags: [],
            firstAppear: 'c0001',
            appearsIn: ['c0001'],
            gist: '十九岁的剑修',
          },
          // Two threads: an open one (whose row the surface renders in full, with
          // both ends recorded) and a collected one (which only its group header
          // shows, because the closed groups start folded).
          {
            path: 'settings/threads/th-001.md',
            id: 'th-001',
            type: 'thread',
            name: '半块青铜镜的来历',
            aliases: [],
            status: 'planted',
            archived: false,
            tags: [],
            appearsIn: [],
            thread: {
              status: 'planted',
              plantedIn: 'c0001',
              plantedQuote: '他握紧了那半块青铜镜',
              reinforcedIn: [],
              plannedPayoff: '第一卷末',
              payoffIn: [],
            },
            gist: '第一章的那面镜子',
          },
          {
            path: 'settings/threads/th-002.md',
            id: 'th-002',
            type: 'thread',
            name: '巡夜人的身份',
            aliases: [],
            status: 'paid',
            archived: false,
            tags: [],
            appearsIn: [],
            thread: {
              status: 'paid',
              plantedIn: 'c0001',
              plantedQuote: '巡夜人敲了下一家的门',
              reinforcedIn: [],
              payoffIn: ['c0001'],
              payoffQuote: '他摘下了斗笠',
            },
            gist: '巷口那个巡夜人',
          },
          {
            path: 'settings/characters/lao-zhou.md',
            id: 'lao-zhou',
            type: 'character',
            name: '老周',
            aliases: [],
            status: '',
            archived: true,
            tags: [],
            appearsIn: [],
            gist: '巡夜人',
          },
        ],
      },
    ],
    pages: [
      { path: 'settings/world.md', exists: true, title: '世界观', gist: '灵气复苏' },
      { path: 'settings/timeline.md', exists: false, title: '时间线', gist: '' },
    ],
    total: 4,
    archived: 1,
  }

  const stubTask = label => ({
    id: 'stub',
    label,
    hint: 'stub',
    kind: 'prose',
    apply: 'replace-body',
    place: 'chapter',
    build: async () => { throw new Error('the check never runs a task') },
  })

  /** One report, shaped exactly as the host returns it. */
  const checkReport = {
    issues: [{
      key: 'missing-ref:chapters/v01/c0001.md:qingshi-town',
      rule: 'missing-ref',
      severity: 'error',
      title: '第 1 章《楔子·雨夜》的 locations 指向不存在的卡「qingshi-town」',
      detail: '这一章的 frontmatter 里写着 qingshi-town，但 settings/ 下没有这张卡。',
      path: 'chapters/v01/c0001.md',
      chapter: 'chapters/v01/c0001.md',
      evidence: ['chapters/v01/c0001.md · locations: qingshi-town', 'settings/*/qingshi-town.md 不存在'],
    }],
    ignored: [],
    stale: [],
    counts: { error: 1, warn: 0, info: 0 },
    scanned: { chapters: 1, cards: 1, pages: 1 },
  }

  const surfaces = [
    ['Panel', { sessionId: 'spike-session', pickDirectory: async () => null }, ['选择文件夹', '打开', '初始化', '正文', '伏笔', '设定', '大纲', '检索', '检查', '修改记录', '导出', '快捷键']],
    ['SettingsView', { env, library, chapters: [chapter], active: true, onReload: async () => {}, onOpenChapter: () => {}, onOpenDocument: () => {} }, ['陈默', '新建卡', '世界观', '已存档 1 张']],
    ['OutlineView', { env, snapshot, cards: library.groups[0].cards, active: true, onOpenChapter: () => {}, onChanged: async () => {}, onOpenDocument: () => {} }, ['本卷卷纲', '续写卷纲', '按卷纲拆章', '楔子·雨夜', '要点 2']],
    [
      'SearchView',
      { env, chapters: [chapter], onOpenChapter: () => {}, onOpenCard: () => {} },
      // The empty box is not an empty surface: the retrieval view has to say what
      // it searches and give the author a question to start from.
      ['检索', '清空', '确定性检索', '陈默上次出场在哪', '青铜镜第一次出现是哪章'],
    ],
    [
      'ChecksView',
      {
        env,
        report: checkReport,
        chapters: [chapter],
        onRun: () => {},
        onIgnore: () => {},
        onSave: () => {},
        onOpenChapter: () => {},
        onOpenCard: () => {},
      },
      // A report is only useful if its three parts all reach the pixels: the
      // counts, the finding with its rule name, and the two-sided evidence.
      ['重新检查', '保存报告', '1 错误 · 0 警告 · 0 提示', '引用了不存在的设定 id', '跳到第 1 章', '依据（2 条）', 'settings/*/qingshi-town.md'],
    ],
    [
      // M7's record surface. Server rendering runs no effects, so this is the
      // cold state an author sees before the host has answered — which is a state
      // worth rendering, because "nothing here yet" and "broken" look identical
      // when a surface forgets to say which it is.
      'HistoryView',      {
        env,
        path: 'chapters/v01/c0001.md',
        title: '第 1 章 · 楔子·雨夜',
        active: true,
        dirty: false,
        onRestored: () => {},
        onLocate: () => {},
      },
      ['第 1 章 · 楔子·雨夜', '还没有记录', '回滚到上一版', '刷新', '这个文件还没有被面板保存过'],
    ],
    [
      // ...and the state where no document is open at all, which must not offer a
      // rollback of nothing.
      'HistoryView',
      { env, active: false, dirty: false, title: '', onRestored: () => {}, onLocate: () => {} },
      ['先打开一章或一张卡', '!回滚到上一版'],
    ],
    [
      // The foreshadowing surface. An open thread must reach the pixels with both
      // of its ends: the sentence it was planted with (that is what the jump
      // selects) and where it is planned to pay off. Deleted threads are **not**
      // in this list; the count is what says where they went.
      'ThreadsView',
      {
        env,
        threads: library.groups.flatMap(group => group.cards).filter(card => card.type === 'thread'),
        archived: 2,
        chapters: [chapter],
        onJump: () => {},
        onOpenCard: () => {},
        onReload: async () => {},
      },
      ['未回收', '已回收', '半块青铜镜的来历', '他握紧了那半块青铜镜', '第一卷末', '放弃', '打开卡片', '埋点', '回收', '第 1 章', '已删除 2 条', '已删除（存档）的伏笔不在这里'],
    ],
    [
      'ThreadsView',
      { env, threads: [], archived: 1, chapters: [chapter], onJump: () => {}, onOpenCard: () => {}, onReload: async () => {} },
      ['还没有伏笔', '记为伏笔', '另有 1 条已删除的伏笔'],
    ],
    ['TaskBar', {
      env,
      tasks: [stubTask('按章纲写整章'), stubTask('续写')],
      context: () => { throw new Error('the check never runs a task') },
      volume: 1,
      onProse: () => {},
      onDocument: () => {},
      onCreateChapters: () => {},
    }, ['按章纲写整章', '续写']],
    [
      // P5's export surface. What must reach the pixels is the *choice* — format,
      // scope, the three ways out — plus the honesty about what gets exported:
      // archived chapters stay home, and unsaved prose is not in the file.
      'ExportView',
      { env, snapshot },
      ['Markdown（.md）', '纯文本（.txt）', '全书', '某一卷', '预览', '导出到 exports/', '下载', '还没有导出过', '只导出没存档的章'],
    ],
    [
      // ...and with a chapter open and dirty, the surface has to warn that the
      // composer holds more than the disk does — the one way this button can
      // surprise an author.
      'ExportView',
      { env, snapshot, openChapter: { path: 'chapters/v01/c0001.md', title: '楔子·雨夜', number: 1, dirty: true } },
      ['当前章', '导出不会带上它', '先保存（Ctrl+S）再导出'],
    ],
    [
      // The timeline's own editor (B): a table, not a blob of Markdown. The rows
      // it lists must be the parsed table's, the picker must offer the chapters
      // that exist, and the escape hatch must be visible.
      'TimelineEditor',
      {
        env,
        body: [
          '# 时间线',
          '',
          '| 叙事序 | 故事时间 | 事件 | 章节 |',
          '|---|---|---|---|',
          '| 1 | 元启三年·春 | 陈默被逐出家门 | c0001 |',
          '',
        ].join('\n'),
        chapters: [chapter],
        onChange: () => {},
      },
      ['叙事序按行号自动排', '元启三年·春', '陈默被逐出家门', 'c0001', '+ 加一行', '编辑原文', '删', '第 1 章 楔子·雨夜'],
    ],
    [
      // A timeline file with no table yet: the editor says so rather than
      // rendering nothing, and creating the first row builds the table.
      'TimelineEditor',
      { env, body: '# 时间线\n', chapters: [chapter], onChange: () => {} },
      ['还没有行', '这一页还没有表格'],
    ],
    [
      // The list field that does not eat commas (the author typed 「灵异,悬疑」 into
      // a tag box and watched the comma vanish). A server render cannot type for
      // us, so this asserts the part that can be seen — the stored labels are
      // displayed with their separator — and the pure parsing is asserted in
      // format-check.
      'ListField',
      { value: ['灵异', '悬疑'], onChange: () => {}, placeholder: '标签（逗号分隔）' },
      ['value="灵异, 悬疑"', 'placeholder="标签（逗号分隔）"'],
    ],
    [
      'ListField',
      { value: [], onChange: () => {}, placeholder: '别名（逗号分隔）' },
      ['value=""', '别名（逗号分隔）'],
    ],
    [
      'ModelIssueList',
      {
        issues: [
          {
            severity: 'error',
            where: '第 3 段｜陈默第一次开口',
            quote: '陈默御剑而起',
            basis: 'settings/characters/chen-mo.md 的「## 能力」写着尚未筑基',
            suggestion: '改成借青铜镜之力',
          },
          { severity: 'info', where: '结尾', quote: '他笑了', basis: '', suggestion: '' },
        ],
      },
      // The two halves of a model finding — the sentence and its conflict — are
      // the whole reason this layer is trustworthy, so both must reach the pixels.
      ['陈默御剑而起', '尚未筑基', '改成借青铜镜之力', '错误 · 1', '提示 · 1', '第 3 段｜陈默第一次开口'],
    ],
    ['ModelIssueList', { issues: [] }, ['模型没有报出问题']],
    ['ModelIssueList', { issues: [], error: '输出里没有可解析的 JSON 数组' }, ['输出里没有可解析的 JSON 数组']],
    [
      // M4's problem list: the same findings, but with somewhere to click.
      'ModelIssueList',
      {
        issues: [{
          severity: 'warn',
          where: '第 2 段',
          quote: '他不由得叹了口气',
          basis: '口头禅：不由得',
          suggestion: '删掉，直接写动作',
        }],
        onLocate: () => {},
      },
      ['他不由得叹了口气', '定位到正文', '口头禅：不由得'],
    ],
    [
      // ...and no button when the surface behind the report has no editor to select into.
      'ModelIssueList',
      {
        issues: [{
          severity: 'warn',
          where: '第 2 段',
          quote: '他不由得叹了口气',
          basis: '口头禅：不由得',
          suggestion: '',
        }],
      },
      ['他不由得叹了口气', '!定位到正文'],
    ],
  ]
  for (const [name, props, expected] of surfaces) {
    const component = views[name]
    if (typeof component !== 'function') throw new TypeError(`__views.${name} is not a component`)
    const markup = render(react.createElement(component, props))
    // A `!`-prefixed marker asserts absence: the only way to check that a control
    // is *conditional* (the locate button exists only where there is an editor).
    const missing = expected.filter(text => !text.startsWith('!') && !markup.includes(text))
    const unwanted = expected.filter(text => text.startsWith('!') && markup.includes(text.slice(1)))
    if (missing.length > 0 || unwanted.length > 0) {
      throw new Error(`${name} rendered wrong: missing ${missing.join(', ')}`
        + `${unwanted.length === 0 ? '' : `; should not contain ${unwanted.map(text => text.slice(1)).join(', ')}`}`)
    }
    console.log(`  ${name}: ${String(markup.length)} chars, all ${String(expected.length)} markers correct`)
  }
}

/**
 * Fail when a dimmed *text* style wraps a live control.
 *
 * `metaLine` carries `opacity: 0.7`, and CSS opacity is inherited — so a button
 * or checkbox inside one renders permanently faded, which reads as "disabled"
 * even though it works (the preview's 采纳 button shipped that way). No render,
 * type, or format check can see this: the markup is correct and the handler
 * fires; only the pixels are wrong. So the rule is checked at its source.
 *
 * The scan tracks the styled element's own tag depth, so a caption that closes
 * *before* the controls (the shape that shipped) does not end the search the way
 * a naive "stop at the next closing tag" rule would. A text line that both opens
 * and closes on one line is skipped, which is what keeps a group heading from
 * being blamed for its sibling rows.
 */
function dimmedControlLines(source) {
  /** Opens minus closes of one tag name on one line. */
  const countTag = (line, tag) => {
    const opens = line.match(new RegExp(`<${tag}\\b`, 'g'))?.length ?? 0
    const closes = line.match(new RegExp(`</${tag}\\b`, 'g'))?.length ?? 0
    return opens - closes
  }
  const violates = (lines) => {
    const found = []
    lines.forEach((line, index) => {
      const match = /<([a-z][a-z0-9]*)\b[^>]*style=\{\{?[^}]*metaLine/.exec(line)
      if (match === null) return
      const tag = match[1]
      let depth = countTag(line, tag)
      if (depth <= 0) return
      for (const next of lines.slice(index + 1, index + 12)) {
        if (/<(button|input|select|textarea)\b/.test(next)) {
          found.push(index + 1)
          break
        }
        depth += countTag(next, tag)
        if (depth <= 0) break
      }
    })
    return found
  }
  // The detector is only worth trusting if it still fires on the shape that
  // shipped the bug (the pre-fix preview header row, caption closing early).
  const regression = [
    "<div style={{ ...metaLine, display: 'flex', justifyContent: 'space-between', gap: 8 }}>",
    '  <span>预览</span>',
    '  <span style={row}>',
    '    <button type="button" style={button} onClick={onAdopt}>采纳</button>',
    '  </span>',
    '</div>',
  ]
  if (violates(regression).length !== 1) {
    throw new Error('the dimmed-control detector no longer catches the shape it was written for')
  }
  // ...and that it does NOT fire on the corrected layout, where the caption is
  // dimmed on its own and the buttons are its siblings.
  const corrected = [
    '<div style={controlRow}>',
    '  <span style={caption}>预览</span>',
    '  <span style={row}>',
    '    <button type="button" style={button}>采纳</button>',
    '  </span>',
    '</div>',
  ]
  if (violates(corrected).length !== 0) {
    throw new Error('the dimmed-control detector fires on the corrected layout')
  }
  // ...and that a dimmed text line closing on its own line is not a violation,
  // even when a control follows it as a sibling.
  const textLine = [
    '<div style={metaLine}>{group.label} · 3</div>',
    '{cards.map(card => (',
    '  <button type="button">{card.name}</button>',
    '))}',
  ]
  if (violates(textLine).length !== 0) {
    throw new Error('the dimmed-control detector blames a self-closed text line for its sibling control')
  }
  return violates(source.split(/\r?\n/))
}

/** Run the source rule over every client view. */
async function checkDimmedControls() {
  const directory = new URL('../src/client/', import.meta.url)
  const files = (await readdir(directory)).filter(name => name.endsWith('.tsx'))
  if (files.length === 0) throw new Error('no client .tsx sources found')
  let checked = 0
  for (const name of files) {
    const lines = dimmedControlLines(await readFile(new URL(name, directory), 'utf8'))
    if (lines.length > 0) {
      throw new Error(`${name} dims a control with metaLine at line(s) ${lines.join(', ')}; use controlRow/checkLine and keep metaLine on the text`)
    }
    checked += 1
  }
  console.log(`  dimmed-control rule: ${String(checked)} view files clean`)
}
