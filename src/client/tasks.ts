/**
 * Task definitions: what each operation reads, and what it asks for.
 *
 * Requirement §5 fixes the shape — a task is *input assembly + prompt template
 * + output structure + write strategy*, and the assembly is explicit so the
 * panel can show the author exactly what was fed to the model before they trust
 * the result. That is why every definition returns its `inputs` list rather than
 * reading files behind the author's back.
 *
 * P2 adds two output shapes beyond prose, so `kind` and `apply` are explicit
 * rather than implied by the task's name:
 *
 * - `prose` — text that lands in a chapter body (append or replace);
 * - `doc` — a whole Markdown file the panel shows in an editor (a volume
 *   outline, the book line) and the author saves through the ordinary path;
 * - `plan` — a JSON chapter list, which the panel renders for confirmation
 *   before it creates any chapter.
 *
 * M6's model layer adds a fourth:
 *
 * - `issues` — a JSON issue list, rendered as a finding report. It has nothing
 *   to adopt (`report`): the answer *is* the product, and the only thing this
 *   task leaves behind is a run record under `.novel/runs/`.
 *
 * @module dsh-ai-novel-copilot/client/tasks
 */
import { BOOK_OUTLINE_FILE, CARD_LABELS, CARD_TYPES, cardPath, volumeOutlinePath, WORLD_FILE } from '../novel/paths.ts'
import { cardHasField, liveCards, type CardField } from '../novel/cards.ts'
import type { CardSummary, ChapterSummary, VolumeSummary } from '../novel/project.ts'
import { RULE_LABELS, type CheckReport } from '../novel/checks.ts'
import { countWords } from '../novel/words.ts'
import * as api from './api.ts'
import type { LoadedChapter } from '../novel/io.ts'

/** One file assembled into a prompt, with the reason it was read. */
export interface TaskInput {
  /** Storage-relative path. */
  path: string
  /** Why this file is in the prompt. */
  reason: string
}

/** What a task's output is. */
export type TaskKind = 'prose' | 'doc' | 'plan' | 'issues'

/** How the panel applies a task's output. */
export type TaskApply = 'append-body' | 'replace-body' | 'write-document' | 'chapter-plan' | 'report'

/** Where a task is offered in the panel. */
export type TaskPlace = 'chapter' | 'outline' | 'checks'

/** What a task definition reads. */
export interface TaskContext {
  /** Session whose sandbox the reads run under. */
  sessionId: string
  /** Project root. */
  root: string
  /** Book facts the host already parsed, rendered into the prompt as prose. */
  meta: { title: string, genre?: string, targetWords?: number }
  /** The project tree, so a task can find the previous chapter and the outline state. */
  volumes: VolumeSummary[]
  /** The chapter open in the editor, for chapter tasks. */
  chapter?: LoadedChapter
  /** Volume the task works in: the open chapter's, or the last one. */
  volume: number
  /**
   * Setting cards the panel already loaded.
   *
   * A planning prompt has to name *real* card ids, and ids alone are unreadable
   * to a model deciding who appears in chapter 3 — so the panel hands over the
   * cards it has, and this module renders them as `id — 名字`.
   */
  cards?: readonly CardSummary[]
  /**
   * The last consistency report, when the panel has one.
   *
   * The model layer runs *after* the rules layer for a reason: a problem the
   * deterministic pass already stated is a problem the model must not spend
   * tokens restating, and the author must not have to read twice. The panel
   * hands the report over so this module can list what is already known.
   */
  checks?: CheckReport
}

/** A task ready to run: its prompt and the assembly it was built from. */
export interface AssembledTask {
  /** Stable task id, used in the run record's filename. */
  id: string
  /** Button label. */
  label: string
  /** What the output is. */
  kind: TaskKind
  /** How the panel applies it. */
  apply: TaskApply
  /** For `write-document`: the file the result replaces. */
  target?: string
  /** The prompt to send. */
  prompt: string
  /** Every file the prompt was assembled from. */
  inputs: TaskInput[]
}

/** One operation the panel offers. */
export interface TaskDefinition {
  /** Stable task id. */
  id: string
  /** Button label. */
  label: string
  /** One-line description, shown as the button's tooltip. */
  hint: string
  /** What the output is. */
  kind: TaskKind
  /** How the result is applied. */
  apply: TaskApply
  /** Where the task is offered. */
  place: TaskPlace
  /**
   * Assemble the task.
   * @param ctx - project facts, and the chapter when the task works on one.
   * @returns the prompt and its assembly.
   */
  build(ctx: TaskContext): Promise<AssembledTask>
}

/**
 * The chapters a task may treat as story material.
 *
 * Archived chapters stay in the tree and keep their numbers, but they are not
 * part of the story any more: a task must neither anchor continuity on one nor
 * re-plan over it. Written here rather than imported from the project layer
 * because that layer pulls in the YAML parser, and this module ships to the
 * browser.
 * @param volumes - the project tree.
 * @returns the live chapters, in volume and number order.
 */
function liveChapters(volumes: readonly VolumeSummary[]): ChapterSummary[] {
  return volumes.flatMap(volume => volume.chapters).filter(chapter => !chapter.archived)
}

/** How many style samples a single prompt may carry. */
const MAX_SAMPLES = 3

/** How much of one style sample a prompt may carry. */
const SAMPLE_LIMIT = 1200

/** Where the author's approved passages live (format §4.8). */
const SAMPLES_DIR = 'style/samples'

/** The last `limit` characters of a body, so a long chapter still fits a prompt. */
function tail(text: string, limit: number): string {
  const trimmed = text.trim()
  return trimmed.length <= limit ? trimmed : trimmed.slice(-limit)
}

/** Everything after a leading frontmatter block. */
function bodyOnly(text: string): string {
  return text.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '')
}

/**
 * Strip everything that carries no authorial content, leaving what a file
 * actually says.
 *
 * A freshly scaffolded project is full of heading-only skeletons — `## 卷目标`
 * with nothing under it, `- 人称与叙述距离：` with nothing after the colon.
 * Feeding those to the model is pure noise, so a file that reduces to nothing
 * here is treated as unwritten and left out of the prompt entirely.
 * @param text - the file as stored.
 * @returns the remaining substance, whitespace removed.
 */
function substanceOf(text: string): string {
  return text
    .replace(/^---[\s\S]*?\n---[ \t]*\r?\n?/, '')       // YAML frontmatter
    .replace(/^[ \t]*#{1,6}[ \t].*$/gm, '')             // headings
    .replace(/^[ \t]*[-*+][ \t]*[^：:\n]*[：:][ \t]*$/gm, '') // label-only bullets
    .replace(/^[ \t]*[-*+][ \t]*$/gm, '')               // empty bullets
    .replace(/\s+/g, '')
}

/** Whether a supporting file has been written yet. */
function hasSubstance(text: string): boolean {
  return substanceOf(text).length > 0
}

/** Read a supporting file, recording it as an input only when it has content. */
async function include(
  ctx: TaskContext,
  path: string,
  reason: string,
  inputs: TaskInput[],
): Promise<string | undefined> {
  try {
    const value = await api.readText(ctx.sessionId, ctx.root, path)
    if (value === undefined || !hasSubstance(value)) return undefined
    inputs.push({ path, reason })
    return value
  } catch {
    // A missing or unreadable supporting file must not fail the task; the
    // input list simply does not mention it.
    return undefined
  }
}

/** Render the chapter's `beats` frontmatter as a bullet list. */
function beatsOf(chapter: LoadedChapter): string[] {
  const beats = chapter.data.beats
  if (!Array.isArray(beats)) return []
  return beats.filter((beat): beat is string => typeof beat === 'string' && beat.trim() !== '')
}

/** A list-of-strings field out of loaded frontmatter data. */
function listField(data: Record<string, unknown>, key: string): string[] {
  const value = data[key]
  if (typeof value === 'string') return value.trim() === '' ? [] : [value.trim()]
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
}

/** The chapter's title, falling back to its path. */
function titleOf(chapter: LoadedChapter): string {
  const title = chapter.data.title
  return typeof title === 'string' && title !== '' ? title : chapter.path
}

/** Target length declared in frontmatter, when present. */
function targetOf(chapter: LoadedChapter): number | undefined {
  const target = chapter.data.targetWords
  return typeof target === 'number' && Number.isFinite(target) ? target : undefined
}

/** The chapter a prose task works on, or a clear failure when none is open. */
function requireChapter(ctx: TaskContext): LoadedChapter {
  if (ctx.chapter === undefined) throw new Error('这个任务需要先打开一章')
  return ctx.chapter
}

/**
 * Read the author's style samples, newest files first by name.
 *
 * Requirement §4 M4 asks for the samples to be assembled *with* the generation
 * tasks, and until now only `style-guide.md` was — so a task that promised to
 * honour the author's voice was working from the rules alone. The list is read
 * from the directory rather than inferred, because the panel cannot know which
 * samples exist and silently including none would be the same bug again.
 * @param ctx - task context.
 * @param inputs - assembly list to record into.
 * @returns the sample texts, each already trimmed to a prompt-sized excerpt.
 */
async function includeSamples(ctx: TaskContext, inputs: TaskInput[]): Promise<string[]> {
  let names: string[]
  try {
    const listing = await api.readDirectory(ctx.sessionId, ctx.root, SAMPLES_DIR)
    names = listing.entries
      .filter(entry => entry.type === 'file' && entry.name.endsWith('.md'))
      .map(entry => entry.name)
      .sort()
      .slice(0, MAX_SAMPLES)
  } catch {
    // No samples directory is the normal state of a young project.
    return []
  }
  const samples: string[] = []
  let total = 0
  for (const name of names) {
    const path = `${SAMPLES_DIR}/${name}`
    const text = await include(ctx, path, '风格样本（作者认可的段落）', inputs)
    if (text === undefined) continue
    const excerpt = tail(text, SAMPLE_LIMIT)
    samples.push(`### ${name}\n${excerpt}`)
    total += excerpt.length
    // The guide is the rule; the samples are the illustration. Three excerpts
    // that fit are worth more than ten that push the chapter out of the prompt.
    if (total >= SAMPLE_LIMIT * MAX_SAMPLES) break
  }
  return samples
}

/** The shared preamble every prose task needs: book, chapter, beats, voice, cards. */
async function assembleCommon(ctx: TaskContext, inputs: TaskInput[], withCards = true): Promise<{
  header: string
  voice: string
  volume: string
  settings: string
}> {
  const voice = await include(ctx, 'style/style-guide.md', '文风规则', inputs) ?? ''
  const samples = await includeSamples(ctx, inputs)
  const volume = await include(
    ctx,
    volumeOutlinePath(ctx.volume),
    '本卷目标与冲突',
    inputs,
  ) ?? ''
  // The book facts come from the project snapshot the host already parsed,
  // rendered as one readable line. Dumping `novel.yaml` verbatim would hand the
  // model machine fields (`currentVolume`, a raw `targetWords` integer) that say
  // nothing about how to write.
  inputs.push({ path: 'novel.yaml', reason: '作品元数据（书名/体裁/目标字数）' })
  const facts = [`《${ctx.meta.title}》`]
  if (ctx.meta.genre !== undefined && ctx.meta.genre !== '') facts.push(ctx.meta.genre)
  if (ctx.meta.targetWords !== undefined && ctx.meta.targetWords > 0) {
    facts.push(`全书目标约 ${String(Math.round(ctx.meta.targetWords / 10000))} 万字`)
  }
  const lines: string[] = [`【作品】${facts.join(' · ')}`]
  if (ctx.chapter !== undefined) {
    inputs.push({ path: ctx.chapter.path, reason: '本章（正文与章纲）' })
    lines.push(`【本章】${titleOf(ctx.chapter)}`)
    const beats = beatsOf(ctx.chapter)
    if (beats.length > 0) lines.push(`【本章要点】\n${beats.map(beat => `- ${beat}`).join('\n')}`)
  }
  const withSamples = samples.length === 0
    ? voice
    : `${voice}${voice.trim() === '' ? '' : '\n\n'}【风格样本（照着这个语感写）】\n${samples.join('\n\n')}`
  // The setting cards this chapter is written against — the ones the author
  // attached to it, whatever their type. Rendered here rather than in each task
  // because 续写 / 改写 / 扩写 / 润色 / 整章 all need exactly the same material:
  // a card the panel let the author attach and the task then forgot would be a
  // reference that only exists on screen. `withCards` is false for the style
  // check, which is about voice and would only carry noise — and whose input list
  // must not name a file its prompt does not contain.
  const settings = !withCards || ctx.chapter === undefined
    ? ''
    : (await cardBlocks(ctx, chapterWritingIds(ctx.chapter), inputs)).join('\n\n')
  return { header: lines.join('\n\n'), voice: withSamples, volume, settings }
}

/** Rules every prose task shares, so the output stays paste-ready. */
const OUTPUT_RULES = [
  '- 直接输出正文，不要复述已有内容，不要输出任何解释、标题、编号或总结句。',
  '- 保持人称、时态与叙述视角前后一致。',
]

/**
 * The card's own facts, as one line for a prompt.
 *
 * Until C1 an assembled card block carried **only the body**: a card's `role`,
 * `age`, `gender`, aliases and tags never reached the model, so a field the
 * author filled in was a field nobody read (the panel did not even offer a box
 * for `age`). Those are content, not machine bookkeeping — P1's rule that ran
 * frontmatter out of prompts was aimed at `id`/`type`/`archived`/`wordCount`, and
 * it took the author's facts out along with the plumbing.
 *
 * Empty fields are dropped rather than printed blank: an unfilled field must not
 * be fed to the model as if it were a fact.
 *
 * Which fields exist is a question for the card's **type** (`novel/cards.ts`
 * `CARD_FIELDS`, format §4.3), not for the frontmatter: a 地点卡 that happens to
 * carry `age: 300年` was written by hand (or by the panel before the form stopped
 * offering the box), and 「年龄: 300年」 in a prompt about a town is a fact the
 * model will use wrongly. The panel and this line read the same table.
 * @param card - the card summary, which is what the panel already has.
 * @returns one `｜`-joined line, or an empty string when there is nothing to say.
 */
export function cardFacts(card: CardSummary): string {
  const owns = (field: CardField): boolean => cardHasField(card.type, field)
  const parts = [
    card.name === card.id ? '' : `名字: ${card.name}`,
    card.aliases.length === 0 ? '' : `别名: ${card.aliases.join('、')}`,
    card.role === undefined || !owns('role') ? '' : `身份: ${card.role}`,
    card.age === undefined || !owns('age') ? '' : `年龄: ${card.age}`,
    card.gender === undefined || !owns('gender') ? '' : `性别: ${card.gender}`,
    card.tags.length === 0 ? '' : `标签: ${card.tags.join('、')}`,
  ].filter(part => part !== '')
  return parts.join('｜')
}

/**
 * Render the given card ids as `id — name` blocks with their bodies.
 *
 * A chapter names card ids; those ids are what the model has to keep straight,
 * so each block leads with the id and follows with the card's own text. Lookup
 * tries every card type in format order because a chapter records an id, not a
 * type — the format makes ids globally unique so the first hit is the only hit.
 * @param ctx - task context.
 * @param ids - card ids named by the chapter.
 * @param inputs - assembly list to record into.
 * @returns the rendered blocks, and whether anything was found.
 */
async function cardBlocks(
  ctx: TaskContext,
  ids: readonly string[],
  inputs: TaskInput[],
): Promise<string[]> {
  const blocks: string[] = []
  // **Every** card the chapter references, with no cap. There used to be one (six),
  // and it silently dropped the rest: a card the author attached by hand and the
  // model never saw is the same lie as a panel row that shows a card the prompt
  // does not contain. References are an authorial decision, not a heuristic the
  // assembler gets to trim — if a chapter's cards make the prompt long, that is
  // the author's call to make, and the input list (`inputs`) shows them all.
  const wanted = [...new Set(ids)]
  for (const id of wanted) {
    for (const type of CARD_TYPES) {
      const path = cardPath(type, id)
      let text: string | undefined
      try {
        text = await api.readText(ctx.sessionId, ctx.root, path)
      } catch {
        text = undefined
      }
      if (text === undefined) continue
      inputs.push({ path, reason: `出场设定卡：${id}` })
      const body = bodyOnly(text).trim()
      const summary = (ctx.cards ?? []).find(card => card.id === id)
      const facts = summary === undefined ? '' : cardFacts(summary)
      const sections = [`## ${id}`]
      if (facts !== '') sections.push(facts)
      if (body !== '') sections.push(body)
      blocks.push(sections.join('\n'))
      break
    }
  }
  return blocks
}

/**
 * The previous chapter in the same volume, with its summary and its ending.
 *
 * A generator that has never seen the previous chapter invents a scene that
 * cannot follow from it: the summary is the cheap continuity anchor, and the
 * tail is what makes the join seamless.
 *
 * "Previous" means the previous *live* chapter: an archived chapter has been
 * withdrawn from the story, so anchoring continuity on it would have the writer
 * continue from a scene the author has taken out of the book.
 * @param ctx - task context.
 * @param chapter - the chapter being written.
 * @param inputs - assembly list to record into.
 * @returns the rendered block, or undefined when there is no earlier chapter.
 */
async function previousChapterBlock(
  ctx: TaskContext,
  chapter: LoadedChapter,
  inputs: TaskInput[],
): Promise<string | undefined> {
  const number = typeof chapter.data.number === 'number' ? chapter.data.number : undefined
  if (number === undefined || number <= 1) return undefined
  const volume = ctx.volumes.find(item => item.volume === ctx.volume)
  const previous: ChapterSummary | undefined = volume?.chapters
    .filter(item => !item.archived && item.number < number)
    .sort((left, right) => right.number - left.number)[0]
  if (previous === undefined) return undefined
  const lines = [`【上一章】第 ${String(previous.number)} 章 ${previous.title}`]
  if (previous.summary !== '') lines.push(`摘要：${previous.summary}`)
  const text = await api.readText(ctx.sessionId, ctx.root, previous.path)
  if (text !== undefined && text.trim() !== '') {
    inputs.push({ path: previous.path, reason: '上一章结尾（衔接用）' })
    lines.push(`结尾：\n${tail(bodyOnly(text), 800)}`)
  }
  return lines.join('\n')
}

/** 续写：continue the chapter from where it stops. */
const continueTask: TaskDefinition = {
  id: 'continue',
  label: '续写',
  hint: '接着本章结尾往下写',
  kind: 'prose',
  apply: 'append-body',
  place: 'chapter',
  async build(ctx) {
    const chapter = requireChapter(ctx)
    const inputs: TaskInput[] = []
    const { header, voice, volume, settings } = await assembleCommon(ctx, inputs)
    const body = chapter.body.trim()
    const written = tail(body, 1500)
    // Say which it is: a short chapter goes in whole, and calling a four-word
    // draft "结尾部分" would be a small lie in the one place the author is
    // invited to check what was actually sent.
    const truncated = written !== body
    const prompt = [
      header,
      volume.trim() === '' ? '' : `【本卷目标】\n${volume.trim()}`,
      voice.trim() === '' ? '' : `【文风规则】\n${voice.trim()}`,
      settings.trim() === '' ? '' : `【本章相关设定】\n${settings.trim()}`,
      written === ''
        ? '【已写正文】（本章尚无正文，请从头写起）'
        : truncated ? `【已写正文（结尾部分）】\n${written}` : `【已写正文】\n${written}`,
      ['【要求】', ...OUTPUT_RULES, '- 续写约 800–1200 字，与前文无缝衔接。'].join('\n'),
    ].filter(section => section !== '').join('\n\n')
    return { id: continueTask.id, label: continueTask.label, kind: 'prose', apply: 'append-body', prompt, inputs }
  },
}

/** 改写：rewrite the chapter without changing what happens in it. */
const rewriteTask: TaskDefinition = {
  id: 'rewrite',
  label: '改写',
  hint: '重写本章，情节不变，改善节奏与文笔',
  kind: 'prose',
  apply: 'replace-body',
  place: 'chapter',
  async build(ctx) {
    const chapter = requireChapter(ctx)
    const inputs: TaskInput[] = []
    const { header, voice, volume, settings } = await assembleCommon(ctx, inputs)
    const target = targetOf(chapter)
    const prompt = [
      header,
      volume.trim() === '' ? '' : `【本卷目标】\n${volume.trim()}`,
      voice.trim() === '' ? '' : `【文风规则】\n${voice.trim()}`,
      settings.trim() === '' ? '' : `【本章相关设定】\n${settings.trim()}`,
      `【当前正文】\n${chapter.body.trim()}`,
      [
        '【要求】',
        ...OUTPUT_RULES,
        '- 重写这一章的正文：情节点、信息量与人物关系保持不变，改善节奏、画面感与措辞。',
        `- 篇幅与原文相当${target === undefined ? '' : `（目标约 ${String(target)} 字）`}。`,
      ].join('\n'),
    ].filter(section => section !== '').join('\n\n')
    return { id: rewriteTask.id, label: rewriteTask.label, kind: 'prose', apply: 'replace-body', prompt, inputs }
  },
}

/** 扩写：expand the chapter with detail, not new plot. */
const expandTask: TaskDefinition = {
  id: 'expand',
  label: '扩写',
  hint: '把本章写长，补细节不加情节',
  kind: 'prose',
  apply: 'replace-body',
  place: 'chapter',
  async build(ctx) {
    const chapter = requireChapter(ctx)
    const inputs: TaskInput[] = []
    const { header, voice, volume, settings } = await assembleCommon(ctx, inputs)
    const target = targetOf(chapter) ?? Math.max(1000, countWords(chapter.body))
    const prompt = [
      header,
      volume.trim() === '' ? '' : `【本卷目标】\n${volume.trim()}`,
      voice.trim() === '' ? '' : `【文风规则】\n${voice.trim()}`,
      settings.trim() === '' ? '' : `【本章相关设定】\n${settings.trim()}`,
      `【当前正文】\n${chapter.body.trim()}`,
      [
        '【要求】',
        ...OUTPUT_RULES,
        '- 扩写这一章：补充场景、动作、对话与心理细节，让节奏更从容。',
        '- 不新增情节转折、不引入新人物、不改变已有事实。',
        `- 目标篇幅约 ${String(Math.round(target * 1.5))} 字。`,
      ].join('\n'),
    ].filter(section => section !== '').join('\n\n')
    return { id: expandTask.id, label: expandTask.label, kind: 'prose', apply: 'replace-body', prompt, inputs }
  },
}

/**
 * 润色本章：the same events, told better — and told in the author's own voice.
 *
 * Deliberately distinct from 改写: that task reworks pacing and imagery with the
 * model's judgement, while this pass is bound by a checklist (the voice rules,
 * plus the author's own samples) and by one hard constraint — nothing about what
 * happens may change. That is what makes it safe to run on a chapter the author
 * is otherwise happy with.
 */
const polishTask: TaskDefinition = {
  id: 'polish',
  label: '润色本章',
  hint: '按文风规则与样本打磨语言：去 AI 味、调节奏、改对话腔调（情节与信息量不变）',
  kind: 'prose',
  apply: 'replace-body',
  place: 'chapter',
  async build(ctx) {
    const chapter = requireChapter(ctx)
    const inputs: TaskInput[] = []
    const { header, voice, volume, settings } = await assembleCommon(ctx, inputs)
    const target = targetOf(chapter)
    const prompt = [
      header,
      volume.trim() === '' ? '' : `【本卷目标】\n${volume.trim()}`,
      voice.trim() === '' ? '' : `【文风规则与样本】\n${voice.trim()}`,
      settings.trim() === '' ? '' : `【本章相关设定】\n${settings.trim()}`,
      `【当前正文】\n${chapter.body.trim()}`,
      [
        '【要求】',
        ...OUTPUT_RULES,
        '- 润色这一章：情节、信息量、人物关系、场景顺序全部不变，只改语言。',
        '- 逐条对照上面的文风规则；规则里列出的禁用词与 AI 味清单，一条都不许留。',
        '- 重点处理：AI 口头禅与套话、排比与四字词堆砌、段末总结句、形容词与副词密度、对话腔调（每个人说话要像他自己）。',
        '- 句长要有变化：该短的地方短到底，长句只用在需要一口气读完的地方。',
        `- 篇幅与原文相当${target === undefined ? '' : `（目标约 ${String(target)} 字）`}，不要顺手扩写或删段。`,
      ].join('\n'),
    ].filter(section => section !== '').join('\n\n')
    return {
      id: polishTask.id,
      label: polishTask.label,
      kind: 'prose',
      apply: 'replace-body',
      prompt,
      inputs,
    }
  },
}

/** The habits 「去 AI 味」 looks for, named so the report can say which one it is. */
const STYLE_HABITS = [
  '「不禁」「不由得」「仿佛」「彷佛」「这一刻」这类口头禅与套话',
  '排比与四字词堆砌（连续三个以上同构短语、成语串烧）',
  '段末总结句（把刚写过的意思再概括一遍，或下结论、升华、点题）',
  '形容词与副词密度过高（每句都挂着修饰，动作与对白被淹没）',
  '对话腔调不分人（所有人都一样的书面语、一样的长句、都爱反问）',
  '连接词与转折词滥用（然而、于是、紧接着、与此同时 频繁出现）',
]

/**
 * 去 AI 味检查：report the passages that read like a machine wrote them.
 *
 * The problem list M4 asks for, and it is a list of **passages**, not of advice:
 * every finding must quote the sentence and name the habit, which is exactly what
 * lets the panel put the cursor on it. The categories are the ones the
 * requirement names, plus connectives — the same failure wearing another hat.
 *
 * It reads the voice rules **and** the samples, because "sounds like a machine"
 * is only answerable against a target: the samples are that target, and a chapter
 * that already sounds like them is not a chapter with a problem.
 */
const styleCheckTask: TaskDefinition = {
  id: 'style-check',
  label: '去 AI 味检查',
  hint: '按文风规则与样本找出读起来像机器写的句子（不改文件，逐条可定位到正文）',
  kind: 'issues',
  apply: 'report',
  place: 'chapter',
  async build(ctx) {
    const chapter = requireChapter(ctx)
    const inputs: TaskInput[] = []
    const { header, voice } = await assembleCommon(ctx, inputs, false)
    const body = chapter.body.trim()
    const prompt = [
      header,
      voice.trim() === '' ? '' : `【文风规则与样本】\n${voice.trim()}`,
      body === '' ? '【本章正文】（还没有正文）' : `【本章正文】\n${body}`,
      [
        '【任务】找出这一章里读起来像机器写的句子，逐条给出原句与改法。',
        '',
        '【要查的毛病】',
        ...STYLE_HABITS.map(habit => `- ${habit}`),
        '',
        '【输出要求】',
        '- 只输出一个 JSON 数组，不要解释、不要代码块围栏、不要 Markdown。',
        '- 每个元素形如：',
        '  {"severity":"warn","where":"第 3 段第 2 句","quote":"正文里的原句","basis":"段末总结句：把刚写的动作又概括了一遍","suggestion":"直接删掉这半句，落在动作上收尾"}',
        '- quote 必须逐字复制【本章正文】里的原句（含标点）；找不到原句的不要报。',
        '- basis 必须点名是上面哪一种毛病；suggestion 要给出可以直接替换或删除的写法。',
        '- severity：warn = 明显像机器写的；info = 轻微、可留可改。',
        '- 没有这类问题就输出 []。不要报情节、设定与错别字问题（那不属于文风）。',
        '- 最多 12 条，挑最像机器的写；宁可少报也不要凑数。',
      ].join('\n'),
    ].filter(section => section !== '').join('\n\n')
    return {
      id: styleCheckTask.id,
      label: styleCheckTask.label,
      kind: 'issues',
      apply: 'report',
      prompt,
      inputs,
    }
  },
}

/**
 * 按章纲生成整章：write the whole chapter from its beats.
 *
 * This is requirement §5's example assembly, in full: the book line, the volume
 * outline, the chapter's beats, the cards of the characters it names, and the
 * previous chapter's summary and ending. Everything the model is told comes from
 * a file the author can see in the input list.
 */
const wholeChapterTask: TaskDefinition = {
  id: 'whole-chapter',
  label: '按章纲写整章',
  hint: '按本章要点写完整一章（需要章纲）',
  kind: 'prose',
  apply: 'replace-body',
  place: 'chapter',
  async build(ctx) {
    const chapter = requireChapter(ctx)
    const inputs: TaskInput[] = []
    const { header, voice, volume, settings } = await assembleCommon(ctx, inputs)
    const book = await include(ctx, BOOK_OUTLINE_FILE, '全书主线', inputs) ?? ''
    const beats = beatsOf(chapter)
    const previous = await previousChapterBlock(ctx, chapter, inputs)
    const target = targetOf(chapter) ?? 3000
    const existing = chapter.body.trim()
    const prompt = [
      header,
      book.trim() === '' ? '' : `【全书主线】\n${book.trim()}`,
      volume.trim() === '' ? '' : `【本卷目标】\n${volume.trim()}`,
      voice.trim() === '' ? '' : `【文风规则】\n${voice.trim()}`,
      settings.trim() === '' ? '' : `【本章相关设定】\n${settings.trim()}`,
      previous ?? '',
      existing === '' ? '' : `【已有正文（未完成，请在此基础上写完整章）】\n${tail(existing, 2000)}`,
      [
        '【要求】',
        ...OUTPUT_RULES,
        beats.length === 0
          ? '- 本章还没有章纲：顺着本卷目标与上一章结尾推进，不新增未铺垫的重大设定或人物。'
          : '- 严格按【本章要点】的顺序写完整一章，每一条都要落到正文里。',
        `- 目标篇幅约 ${String(target)} 字。`,
        '- 用叙事与对话推进，不要分节标题、不要提纲式罗列。',
      ].join('\n'),
    ].filter(section => section !== '').join('\n\n')
    return { id: wholeChapterTask.id, label: wholeChapterTask.label, kind: 'prose', apply: 'replace-body', prompt, inputs }
  },
}

/** 续写卷纲：complete the current volume's outline. */
const volumeOutlineTask: TaskDefinition = {
  id: 'volume-outline',
  label: '续写卷纲',
  hint: '按全书主线与本卷已写章节，补全本卷大纲',
  kind: 'doc',
  apply: 'write-document',
  place: 'outline',
  async build(ctx) {
    const inputs: TaskInput[] = []
    const book = await include(ctx, BOOK_OUTLINE_FILE, '全书主线', inputs) ?? ''
    const target = volumeOutlinePath(ctx.volume)
    const current = await include(ctx, target, '本卷现有卷纲', inputs) ?? ''
    const volume = ctx.volumes.find(item => item.volume === ctx.volume)
    const written = (volume?.chapters ?? [])
      // Archived chapters are not "已写": the outline should be planned around
      // the story that exists, not around a scene the author took back out.
      .filter(chapter => !chapter.archived && chapter.summary !== '')
      .map(chapter => `第 ${String(chapter.number)} 章 ${chapter.title}：${chapter.summary}`)
    if (written.length > 0) inputs.push({ path: 'chapters/*（摘要）', reason: `本卷已写 ${String(written.length)} 章的摘要` })
    const cast = renderCast(ctx)
    const prompt = [
      `【作品】《${ctx.meta.title}》`,
      `【任务】补全第 ${String(ctx.volume)} 卷的卷纲。`,
      book.trim() === '' ? '' : `【全书主线】\n${book.trim()}`,
      current.trim() === '' ? '【本卷现有卷纲】（空白）' : `【本卷现有卷纲】\n${current.trim()}`,
      written.length === 0 ? '【本卷已写章节】（无）' : `【本卷已写章节】\n${written.join('\n')}`,
      cast === '' ? '' : `【可用设定】\n${cast}`,
      [
        '【要求】',
        '- 输出这一卷卷纲的完整 Markdown 文件：保留并补全「## 卷目标」「## 卷冲突」「## 卷末状态」三节。',
        '- 在卷纲里写清这一卷从哪里开始、冲突如何升级、卷末停在什么状态；不要写正文。',
        '- 不要输出任何解释、代码块围栏或额外的标题层级。',
      ].join('\n'),
    ].filter(section => section !== '').join('\n\n')
    return {
      id: volumeOutlineTask.id,
      label: volumeOutlineTask.label,
      kind: 'doc',
      apply: 'write-document',
      target,
      prompt,
      inputs,
    }
  },
}

/** 续写全书主线：complete `outline/book.md`. */
const bookOutlineTask: TaskDefinition = {
  id: 'book-outline',
  label: '续写主线',
  hint: '按已有卷纲与章节，补全全书主线',
  kind: 'doc',
  apply: 'write-document',
  place: 'outline',
  async build(ctx) {
    const inputs: TaskInput[] = []
    const current = await include(ctx, BOOK_OUTLINE_FILE, '全书现有主线', inputs) ?? ''
    const outlines: string[] = []
    for (const volume of ctx.volumes) {
      const text = await include(ctx, volumeOutlinePath(volume.volume), `第 ${String(volume.volume)} 卷卷纲`, inputs)
      if (text !== undefined) outlines.push(`### 第 ${String(volume.volume)} 卷\n${text.trim()}`)
    }
    const numbers = liveChapters(ctx.volumes)
    if (numbers.length > 0) {
      inputs.push({ path: 'chapters/*（目录）', reason: `已写 ${String(numbers.length)} 章的标题与字数` })
    }
    const cast = renderCast(ctx)
    const prompt = [
      `【作品】《${ctx.meta.title}》`,
      '【任务】补全全书主线（大纲）。',
      current.trim() === '' ? '【现有主线】（空白）' : `【现有主线】\n${current.trim()}`,
      outlines.length === 0 ? '' : `【各卷卷纲】\n${outlines.join('\n\n')}`,
      numbers.length === 0
        ? ''
        : `【已写章节】\n${numbers.map(chapter => `第 ${String(chapter.number)} 章 ${chapter.title}（${String(chapter.wordCount)} 字）`).join('\n')}`,
      cast === '' ? '' : `【可用设定】\n${cast}`,
      [
        '【要求】',
        '- 输出全书主线的完整 Markdown 文件：保留并补全「## 核心卖点」「## 主角弧光」「## 卷结构」三节。',
        '- 卷结构写明每一卷的目标与转折，以及全书的高潮与结局方向。',
        '- 不要输出正文、解释或代码块围栏。',
      ].join('\n'),
    ].filter(section => section !== '').join('\n\n')
    return {
      id: bookOutlineTask.id,
      label: bookOutlineTask.label,
      kind: 'doc',
      apply: 'write-document',
      target: BOOK_OUTLINE_FILE,
      prompt,
      inputs,
    }
  },
}

/** 按卷纲拆章：turn the volume outline into a chapter plan. */
const chapterPlanTask: TaskDefinition = {
  id: 'chapter-plan',
  label: '按卷纲拆章',
  hint: '按本卷卷纲排出接下来的章节与章纲（不会直接落盘）',
  kind: 'plan',
  apply: 'chapter-plan',
  place: 'outline',
  async build(ctx) {
    const inputs: TaskInput[] = []
    const book = await include(ctx, BOOK_OUTLINE_FILE, '全书主线', inputs) ?? ''
    const volume = await include(ctx, volumeOutlinePath(ctx.volume), '本卷卷纲', inputs) ?? ''
    const existing = liveChapters(ctx.volumes)
    if (existing.length > 0) {
      inputs.push({ path: 'chapters/*（目录）', reason: `已有 ${String(existing.length)} 章，用来避免重复排章` })
    }
    const cast = renderCast(ctx)
    const existingLines = existing.map(chapter => {
      const beats = chapter.beats.length === 0 ? '' : `（要点：${chapter.beats.join('；')}）`
      return `第 ${String(chapter.number)} 章 ${chapter.title}${beats}`
    })
    const prompt = [
      `【作品】《${ctx.meta.title}》`,
      `【任务】把第 ${String(ctx.volume)} 卷的卷纲拆成接下来的章节，给出每章的章纲。`,
      book.trim() === '' ? '' : `【全书主线】\n${book.trim()}`,
      volume.trim() === '' ? '' : `【本卷卷纲】\n${volume.trim()}`,
      existingLines.length === 0 ? '【已有章节】（无）' : `【已有章节】\n${existingLines.join('\n')}`,
      cast === '' ? '' : `【可用设定 id】\n${cast}`,
      [
        '【要求】',
        '- 只输出一个 JSON 数组，不要解释、不要代码块围栏、不要 Markdown。',
        '- 每个元素形如：',
        '  {"title":"第 N 章 章名","beats":["要点1","要点2"],"characters":["角色id"],"locations":["地点id"],"refs":["设定id"],"summary":"一句话概要","targetWords":3000}',
        '- 从【已有章节】之后接着往下排，章号连续，不要重复已有的章。',
        '- characters/locations/refs 只能使用【可用设定 id】里出现过的 id；没有合适的就留空数组。',
        '- refs 放这一章真正要依据的世界设定（境界阶梯、体系规则…），一章 0–2 条就够。',
        '- 每章 2–4 条 beats，每条一句话，写清这一章要发生什么。',
      ].join('\n'),
    ].filter(section => section !== '').join('\n\n')
    return {
      id: chapterPlanTask.id,
      label: chapterPlanTask.label,
      kind: 'plan',
      apply: 'chapter-plan',
      prompt,
      inputs,
    }
  },
}

/**
 * The card ids one chapter is **written** against, point of view first.
 *
 * Every reference field the chapter has: the point of view, the characters it
 * stages, the locations it uses, and the generic setting cards it is written
 * against (`refs`, format §3.2). The panel's card picker writes into these same
 * three fields (routed by card type, `chapterRefFieldOf`), so "I attached this
 * card to this chapter" and "the model was given it" are the same statement:
 * **all** of them travel, with no cap (see {@link cardBlocks}).
 * @param chapter - the chapter being written.
 * @returns distinct card ids, in the order they should be read.
 */
function chapterWritingIds(chapter: LoadedChapter): string[] {
  const ids = [
    ...listField(chapter.data, 'characters'),
    ...listField(chapter.data, 'locations'),
    ...listField(chapter.data, 'refs'),
  ]
  const pov = chapter.data.pov
  if (typeof pov === 'string' && pov !== '') ids.unshift(pov)
  return [...new Set(ids)]
}

/**
 * The card ids one chapter names, point of view first.
 * @param chapter - the chapter being checked.
 * @returns distinct card ids, in the order they should be read.
 */
function chapterCardIds(chapter: LoadedChapter): string[] {
  const ids = [
    ...listField(chapter.data, 'characters'),
    ...listField(chapter.data, 'locations'),
    ...listField(chapter.data, 'refs'),
  ]
  const pov = chapter.data.pov
  if (typeof pov === 'string' && pov !== '') ids.unshift(pov)
  return [...new Set(ids)]
}

/**
 * The deterministic findings this chapter already has, as report lines.
 * @param ctx - task context.
 * @param path - the chapter's storage-relative path.
 * @returns one line per finding.
 */
function knownFindings(ctx: TaskContext, path: string): string[] {
  return (ctx.checks?.issues ?? [])
    .filter(issue => issue.chapter === path || issue.path === path)
    .slice(0, 20)
    .map(issue => `${issue.title}（${RULE_LABELS[issue.rule]}）`)
}

/**
 * 一致性检查（模型）：read one chapter against the cards it names and the book's
 * hard constraints, and report only what it can cite.
 *
 * The rules layer (`src/novel/checks.ts`) already states everything that is a
 * fact about ids, numbers and recorded lifecycles. What it cannot see is
 * *meaning*: a character using an ability their card forbids, a location
 * described as intact two chapters after it burned down, a dead man speaking.
 * That is what this task asks the model for — which is why the prompt leads with
 * the hard constraints and the cards rather than with the outline.
 *
 * Two limits are deliberate, and the prompt states both:
 *
 * - the model sees **one chapter** plus its cards. A million-word book does not
 *   fit in a prompt, and feeding a "relevant excerpt" would make the check's
 *   scope unknowable — a report whose reach the author cannot picture is a
 *   report they cannot trust;
 * - it is told **not** to report spelling, punctuation or style. Those belong to
 *   M4, and mixing them into a consistency report buries the contradictions.
 */
const chapterCheckTask: TaskDefinition = {
  id: 'chapter-check',
  label: '一致性检查（模型）',
  hint: '把本章正文与出场设定卡、世界观硬约束交给模型，只报能指出依据的矛盾（不改任何文件）',
  kind: 'issues',
  apply: 'report',
  place: 'checks',
  async build(ctx) {
    const chapter = requireChapter(ctx)
    const inputs: TaskInput[] = []
    inputs.push({ path: 'novel.yaml', reason: '作品元数据（书名/体裁）' })
    const world = await include(ctx, WORLD_FILE, '世界观与硬约束', inputs) ?? ''
    const volume = await include(ctx, volumeOutlinePath(ctx.volume), '本卷目标', inputs) ?? ''
    const ids = chapterCardIds(chapter)
    const cards = await cardBlocks(ctx, ids, inputs)
    const previous = await previousChapterBlock(ctx, chapter, inputs)
    inputs.push({ path: chapter.path, reason: '本章（正文与章纲）' })
    const known = knownFindings(ctx, chapter.path)
    if (known.length > 0) {
      inputs.push({
        path: '.novel（规则检查结果）',
        reason: `规则已经报出的 ${String(known.length)} 条，交给模型避免重复`,
      })
    }

    const number = typeof chapter.data.number === 'number' ? chapter.data.number : 0
    const beats = beatsOf(chapter)
    const summary = typeof chapter.data.summary === 'string' ? chapter.data.summary.trim() : ''
    const facts = [`【本章】第 ${String(number)} 章《${titleOf(chapter)}》`]
    if (beats.length > 0) facts.push(`本章要点：\n${beats.map(beat => `- ${beat}`).join('\n')}`)
    if (summary !== '') facts.push(`本章摘要：${summary}`)
    if (ids.length > 0) facts.push(`本章登记的卡：${ids.join('、')}`)
    const body = chapter.body.trim()

    const prompt = [
      `【作品】《${ctx.meta.title}》${ctx.meta.genre === undefined || ctx.meta.genre === '' ? '' : ` · ${ctx.meta.genre}`}`,
      '【任务】检查这一章的正文与下面的设定卡、世界观硬约束、本卷目标、上一章是否自相矛盾。只报你能指出依据的问题。',
      world.trim() === '' ? '' : `【世界观与硬约束】\n${world.trim()}`,
      volume.trim() === '' ? '' : `【本卷目标】\n${volume.trim()}`,
      cards.length === 0 ? '' : `【本章相关设定卡】\n${cards.join('\n\n')}`,
      previous ?? '',
      facts.join('\n'),
      body === '' ? '【本章正文】（本章还没有正文）' : `【本章正文】\n${body}`,
      known.length === 0 ? '' : `【规则已经报过的（不要重复）】\n${known.map(line => `- ${line}`).join('\n')}`,
      [
        '【输出要求】',
        '- 只输出一个 JSON 数组，不要解释、不要代码块围栏、不要 Markdown。',
        '- 每个元素形如：',
        '  {"severity":"error","where":"第 3 段｜陈默第一次开口","quote":"正文里的原句","basis":"settings/characters/chen-mo.md 的「## 能力」写着……","suggestion":"改成……"}',
        '- quote 必须逐字复制【本章正文】里的原句；找不到原句的问题不要报。',
        '- basis 必须写出冲突的另一边：哪张卡的哪个字段、世界观哪条硬约束、或哪一章的什么事实。',
        '- severity：error = 与已确立的事实直接冲突；warn = 可疑或前后不一致；info = 值得确认。',
        '- 没有矛盾就输出 []，不要为了凑数报问题；不要报错别字、标点与文风问题（那不属于一致性）。',
      ].join('\n'),
    ].filter(section => section !== '').join('\n\n')

    return {
      id: chapterCheckTask.id,
      label: chapterCheckTask.label,
      kind: 'issues',
      apply: 'report',
      prompt,
      inputs,
    }
  },
}

/**
 * Render the loaded cards as `类型 — id — 名字` lines for a planning prompt.
 *
 * The type is the panel's own label rather than the raw `type:` value, because
 * the model uses these lines to choose `refs` as well as `characters`: 「设定:
 * jian-xiu — 剑修境界」 says what the card is, `lore:` says nothing.
 * @param ctx - task context.
 * @returns the rendered list, or an empty string when no cards were loaded.
 */
function renderCast(ctx: TaskContext): string {
  // A retired card is not material a prompt should offer: deleted cards are out
  // (P2), and so is a thread the author abandoned — a dropped line is not
  // something a new chapter should weave in. Same predicate the checks and the
  // panel use (`novel/cards.ts`).
  const cards = liveCards(ctx.cards ?? [])
  if (cards.length === 0) return ''
  return cards
    .map(card => `${CARD_LABELS[card.type]}: ${card.id} — ${card.name}`)
    .join('\n')
}

/** Chapter tasks, in the order the panel shows their buttons. */
export const CHAPTER_TASKS: readonly TaskDefinition[] = [
  wholeChapterTask,
  continueTask,
  rewriteTask,
  expandTask,
  polishTask,
  styleCheckTask,
]

/** Outline tasks, in the order the panel shows their buttons. */
export const OUTLINE_TASKS: readonly TaskDefinition[] = [volumeOutlineTask, bookOutlineTask, chapterPlanTask]

/** Consistency-check tasks, offered on the 检查 surface. */
export const CHECK_TASKS: readonly TaskDefinition[] = [chapterCheckTask]

/** Every task this plugin offers. */
export const TASKS: readonly TaskDefinition[] = [...CHAPTER_TASKS, ...OUTLINE_TASKS, ...CHECK_TASKS]

/**
 * Assemble one task.
 * @param task - the definition to run.
 * @param ctx - project facts and the open chapter.
 * @returns the assembled task.
 */
export async function assemble(task: TaskDefinition, ctx: TaskContext): Promise<AssembledTask> {
  return await task.build(ctx)
}

/** Re-exported so the panel can type a chapter summary without importing the project layer. */
export type { ChapterSummary }
