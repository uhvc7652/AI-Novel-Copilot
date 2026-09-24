/**
 * Deterministic consistency checks — the M6 rules layer.
 *
 * Requirement §4 M6 splits the work in two: a rules layer that is pure
 * bookkeeping, and a model layer that reads setting cards and prose. This module
 * is the first half, and it deliberately holds no model, no network, and no
 * filesystem: it takes a corpus of already-parsed facts and returns findings.
 *
 * Three rules shape it:
 *
 * 1. **Every finding carries evidence on both sides.** A report that says "陈默
 *    不存在" is not actionable; one that says "第 3 章的 `characters` 写着
 *    chen-mo，而 settings/ 下没有 settings/*​/chen-mo.md" tells the author which
 *    file to open and what to change. That two-sided citation is what the risk
 *    table in §8 asks for, because an inconsistent report is a report nobody
 *    reads.
 * 2. **A finding's key is its identity, not its wording.** Ignoring something
 *    has to survive a re-run, so a key is `rule:path:target` — a fact about the
 *    project, not about the sentence describing it. Rewording a message must not
 *    resurrect an ignored issue.
 * 3. **Rules that cannot be decided do not guess.** "伏笔未回收" is only reported
 *    when the card names a payoff chapter that exists and the book has already
 *    moved past it; a `plannedPayoff` written as prose (`第一卷末`) is not
 *    something this layer can evaluate, and pretending otherwise would produce
 *    exactly the false positives M6 is warned about.
 *
 * @module dsh-ai-novel-copilot/novel/checks
 */
import { TIMELINE_FILE, type CardType } from './paths.ts'
import { isRetiredCard, liveCards as liveCardsOf } from './cards.ts'
import { parseTimeline } from './timeline.ts'
import { findQuote } from './quote.ts'
import type { ThreadRecord } from './project.ts'

/** One chapter, as a consistency check sees it. */
export interface CheckChapter {
  /** Storage-relative path; also the jump target. */
  path: string
  /** The id the *filename* encodes — the identity every reference uses (format §3.1). */
  fileId: string
  /** The `id` field as written, when it was written at all. */
  declaredId?: string
  title: string
  volume: number
  number: number
  status: string
  /** Point-of-view character id, when set. */
  pov?: string
  /** Character card ids the chapter features. */
  characters: string[]
  /** Location card ids the chapter uses. */
  locations: string[]
  /** Generic `lore` card ids the chapter is written against. */
  refs: string[]
  /**
   * Chapter ids the author attached as writing material (format §3.2).
   *
   * Checked against the chapters rather than the cards: these ids live in the
   * chapter id space, and a dangling one silently costs the generator the text
   * it was supposed to read.
   */
  contextChapters: string[]
  /** Target length, when the outline set one. */
  targetWords?: number
  /** Measured body length. */
  wordCount: number
  archived: boolean
  /**
   * The chapter's prose.
   *
   * Read by the rules that are about text rather than metadata — today that is
   * `thread-quote`, which has to look for a recorded sentence in the chapter it
   * was recorded from. It costs nothing: the scan reads every body anyway (the
   * search corpus needs it), so the alternative would be reading the same file
   * twice to answer the same question.
   */
  body: string
}

/** One card-to-card reference. */
export interface CheckRelation {
  /** The card id it points at. */
  to: string
  /** Free-form relation label. */
  kind: string
}

/** One setting card, as a consistency check sees it. */
export interface CheckCard {
  path: string
  id: string
  type: CardType
  name: string
  aliases: string[]
  archived: boolean
  firstAppear?: string
  relations: CheckRelation[]
  /** A thread card's lifecycle, when it is one. */
  thread?: ThreadRecord
}

/** One loose document (the timeline, the world overview, an outline). */
export interface CheckPage {
  path: string
  title: string
  body: string
}

/** Everything the rules read. */
export interface CheckCorpus {
  chapters: CheckChapter[]
  cards: CheckCard[]
  pages: CheckPage[]
}

/** Which invariant a finding is about. */
export type CheckRule =
  | 'missing-ref'
  | 'context-ref'
  | 'card-ref'
  | 'thread-ref'
  | 'timeline-ref'
  | 'alias-clash'
  | 'chapter-number'
  | 'chapter-gap'
  | 'id-mismatch'
  | 'timeline-order'
  | 'thread-unpaid'
  | 'pov-unlisted'
  | 'word-drift'
  | 'firstappear-mismatch'
  | 'archived-ref'
  | 'thread-quote'

/** Human-readable rule names, for the report's group headings. */
export const RULE_LABELS: Record<CheckRule, string> = {
  'missing-ref': '引用了不存在的设定 id',
  'context-ref': '参考章节指向不存在的章节',
  'card-ref': '设定卡引用了不存在的卡',
  'thread-ref': '伏笔引用了不存在的章节',
  'timeline-ref': '时间线引用了不存在的章节',
  'alias-clash': '名字或别名撞车',
  'chapter-number': '章号重复',
  'chapter-gap': '章号缺号',
  'id-mismatch': 'id 与文件名不一致',
  'timeline-order': '时间线倒序',
  'thread-unpaid': '伏笔未回收或状态不同步',
  'pov-unlisted': '视角人物没有登记在 characters 里',
  'word-drift': '字数与目标严重偏离',
  'firstappear-mismatch': 'firstAppear 与最早的出场登记不一致',
  'archived-ref': '还在引用已存档的卡',
  'thread-quote': '伏笔的原句在正文里找不到了',
}

/** How much a finding matters. */
export type CheckSeverity = 'error' | 'warn' | 'info'

/** Human-readable severity names. */
export const SEVERITY_LABELS: Record<CheckSeverity, string> = {
  error: '错误',
  warn: '警告',
  info: '提示',
}

/** One finding. */
export interface CheckIssue {
  /**
   * Stable identity of the fact, not of the sentence: `rule:path:target`.
   * Ignoring an issue stores this, so rewording a message keeps the decision.
   */
  key: string
  rule: CheckRule
  severity: CheckSeverity
  /** One line: what is wrong. */
  title: string
  /** Why it is wrong and what to do, in the author's terms. */
  detail: string
  /** Storage-relative path to jump to. */
  path: string
  /** The chapter the finding is about, when it is about one. */
  chapter?: string
  /** The card the finding is about, when it is about one. */
  card?: string
  /** Both sides of the inconsistency, one line each. */
  evidence: string[]
}

/** One run's findings. */
export interface CheckReport {
  /** Findings still needing attention. */
  issues: CheckIssue[]
  /** Findings the author has ignored; kept so the decision can be undone. */
  ignored: CheckIssue[]
  /** Stored ignore keys that match nothing any more. */
  stale: string[]
  /** Counts over {@link issues} only. */
  counts: Record<CheckSeverity, number>
  /** How many files the run looked at. */
  scanned: { chapters: number, cards: number, pages: number }
}

/** Severity ranking, most serious first. */
const SEVERITY_RANK: Record<CheckSeverity, number> = { error: 0, warn: 1, info: 2 }

/** How far a chapter's length may drift from its target before it is reported. */
const WORD_DRIFT = 0.4

/** Build one finding, with the key derived from the fact it is about. */
function issue(
  rule: CheckRule,
  severity: CheckSeverity,
  path: string,
  target: string,
  title: string,
  detail: string,
  evidence: string[],
  extra?: { chapter?: string, card?: string },
): CheckIssue {
  return {
    key: `${rule}:${path}:${target}`,
    rule,
    severity,
    title,
    detail,
    path,
    ...(extra?.chapter === undefined ? {} : { chapter: extra.chapter }),
    ...(extra?.card === undefined ? {} : { card: extra.card }),
    evidence,
  }
}

/** Whether chapter A comes after chapter B in story order. */
function isAfter(a: CheckChapter, b: CheckChapter): boolean {
  return a.volume > b.volume || (a.volume === b.volume && a.number > b.number)
}

/** `第 3 章《裂纹》`, for a report line. */
function chapterLabel(chapter: CheckChapter): string {
  return `第 ${String(chapter.number)} 章《${chapter.title}》`
}

/**
 * Run every deterministic rule over a corpus.
 *
 * Findings come back sorted by severity, then by story order for chapter-scoped
 * ones, so the report can be read top to bottom without re-sorting it.
 * @param corpus - the parsed project.
 * @returns every finding, in report order.
 */
export function runChecks(corpus: CheckCorpus): CheckIssue[] {
  const found: CheckIssue[] = []
  const live = corpus.chapters.filter(chapter => !chapter.archived)
  // References use the filename-derived id (format §3.1). A chapter whose
  // *declared* id disagrees is still resolvable here: that disagreement is
  // `id-mismatch`'s job to report, and reporting it a second time as a dangling
  // reference would only be noise.
  const byFileId = new Map(corpus.chapters.map(chapter => [chapter.fileId, chapter]))
  const byDeclared = new Map(
    corpus.chapters
      .filter(chapter => chapter.declaredId !== undefined && chapter.declaredId !== chapter.fileId)
      .map(chapter => [chapter.declaredId as string, chapter]),
  )
  const chapterOf = (id: string): CheckChapter | undefined => byFileId.get(id) ?? byDeclared.get(id)
  const cardById = new Map(corpus.cards.map(card => [card.id, card]))
  const cardIds = new Set(cardById.keys())
  /**
   * The cards the author is working with — deleted cards **and abandoned
   * threads** are out (`novel/cards.ts`, the same predicate the panel uses).
   *
   * The rules about **naming and lifecycle** only speak about these. The author
   * deleted a 伏笔 and wrote a new one under the same name, and later did it again
   * by *abandoning* the old one: both times the retired card came back as two
   * `alias-clash` errors, which is the daily false positive §1.6 exists to
   * prevent. An abandoned line is not in the book any more, so its name is free.
   *
   * **Id resolution below still uses every card**, retired ones included — see
   * {@link cardIds}. Deleting a card must not turn every chapter that mentions it
   * into a dangling reference; that is what `archived-ref` (info, live chapter →
   * archived card) says instead.
   */
  const liveCards = liveCardsOf(corpus.cards)

  // ── 1. Chapter frontmatter naming cards that do not exist ──────────────────
  //
  // Live chapters only, and the same line as everywhere else in this file: an
  // archived chapter is out of the book, so its frontmatter is not a claim the
  // author needs to hear about. Restoring the chapter brings the finding back.
  for (const chapter of live) {
    const missing = new Map<string, string[]>()
    const note = (id: string, field: string): void => {
      missing.set(id, [...(missing.get(id) ?? []), field])
    }
    if (chapter.pov !== undefined && !cardIds.has(chapter.pov)) note(chapter.pov, 'pov')
    for (const id of chapter.characters) if (!cardIds.has(id)) note(id, 'characters')
    for (const id of chapter.locations) if (!cardIds.has(id)) note(id, 'locations')
    for (const id of chapter.refs) if (!cardIds.has(id)) note(id, 'refs')
    for (const [id, fields] of missing) {
      found.push(issue(
        'missing-ref',
        'error',
        chapter.path,
        id,
        `${chapterLabel(chapter)} 的 ${fields.join('/')} 指向不存在的卡「${id}」`,
        `这一章的 frontmatter 里写着 ${id}，但 settings/ 下没有这张卡。可能是拼错，也可能是卡被改名或从未建立。`,
        [`${chapter.path} · ${fields.join('/')}: ${id}`, `settings/*/${id}.md 不存在`],
        { chapter: chapter.path },
      ))
    }
  }

  // ── 1b. 参考章节 naming chapters ──────────────────────────────────────────
  //
  // Same line as §1 (live chapters only), but the **target** is judged against
  // every chapter: an id that resolves to nothing is an error, one that resolves
  // to an archived chapter is a warning — an archived chapter is out of the story
  // material, so assembly skips it and the id quietly buys nothing — and naming
  // itself is only pointless, not wrong (the chapter's own prose is in the prompt
  // either way). Without this rule a hand-written id would simply vanish from the
  // prompt with nothing said, which is the class of silence the checks exist for.
  for (const chapter of live) {
    for (const id of new Set(chapter.contextChapters)) {
      const target = chapterOf(id)
      if (target === undefined) {
        found.push(issue(
          'context-ref',
          'error',
          chapter.path,
          id,
          `${chapterLabel(chapter)} 的参考章节指向不存在的章「${id}」`,
          `这一章的 frontmatter 里写着 contextChapters: ${id}，但工程里没有这一章。写作任务会把参考章节的正文交给模型——这个 id 现在是白写的。`,
          [`${chapter.path} · contextChapters: ${id}`, `chapters/**/${id}.md 不存在`],
          { chapter: chapter.path },
        ))
      } else if (target.archived) {
        found.push(issue(
          'context-ref',
          'warn',
          chapter.path,
          id,
          `${chapterLabel(chapter)} 参考的「${target.title}」已存档`,
          `第 ${String(target.number)} 章已经存档，它不再是故事材料，生成时会跳过它；这一章要接着用它的话，先把它恢复出来。`,
          [`${chapter.path} · contextChapters: ${id}`, `${target.path} · archived: true`],
          { chapter: chapter.path },
        ))
      } else if (target.path === chapter.path) {
        found.push(issue(
          'context-ref',
          'info',
          chapter.path,
          id,
          `${chapterLabel(chapter)} 把自己列成了参考章节`,
          '本章正文本来就会进 prompt，装配时会跳过这一条；从 contextChapters 里删掉它就行。',
          [`${chapter.path} · contextChapters: ${id}`],
          { chapter: chapter.path },
        ))
      }
    }
  }

  // ── 2. Setting cards naming cards that do not exist ───────────────────────
  for (const card of liveCards) {
    for (const relation of card.relations) {
      if (!cardIds.has(relation.to)) {
        found.push(issue(
          'card-ref',
          'error',
          card.path,
          relation.to,
          `${card.name} 的 relations 指向不存在的卡「${relation.to}」`,
          `「${relation.kind}」关系指向 ${relation.to}，但 settings/ 下没有这张卡；反查与检索会在这里断掉。`,
          [`${card.path} · relations: { to: ${relation.to}, kind: ${relation.kind} }`, `settings/*/${relation.to}.md 不存在`],
          { card: card.path },
        ))
      } else if (relation.to === card.id) {
        found.push(issue(
          'card-ref',
          'warn',
          card.path,
          `self:${relation.kind}`,
          `${card.name} 有一条指向自己的关系`,
          '自我关系多半是误填；它不会让检索出错，但会让关系图出现环。',
          [`${card.path} · relations: { to: ${card.id}, kind: ${relation.kind} }`],
          { card: card.path },
        ))
      }
    }
  }

  // ── 3. Threads naming chapters that do not exist, and their lifecycle ─────
  for (const card of liveCards) {
    const thread = card.thread
    if (thread === undefined) continue
    const named: { id: string, field: string }[] = [
      ...(thread.plantedIn === undefined ? [] : [{ id: thread.plantedIn, field: 'plantedIn' }]),
      ...thread.reinforcedIn.map(id => ({ id, field: 'reinforcedIn' })),
      ...thread.payoffIn.map(id => ({ id, field: 'payoffIn' })),
    ]
    for (const entry of named) {
      if (chapterOf(entry.id) !== undefined) continue
      found.push(issue(
        'thread-ref',
        'error',
        card.path,
        `${entry.field}:${entry.id}`,
        `伏笔「${card.name}」的 ${entry.field} 指向不存在的章节「${entry.id}」`,
        '伏笔卡是这条线唯一的真相（格式 §3.2），它指向的章节不在工程里，这条线的进度就无法判断。',
        [`${card.path} · ${entry.field}: ${entry.id}`, `chapters/**/${entry.id}.md 不存在`],
        { card: card.path },
      ))
    }

    const paid = thread.payoffIn.filter(id => chapterOf(id) !== undefined)
    const open = thread.status === 'planted' || thread.status === 'reinforced' || thread.status === ''
    if (thread.status === 'paid' && paid.length === 0) {
      found.push(issue(
        'thread-unpaid',
        'error',
        card.path,
        'status-paid-without-payoff',
        `伏笔「${card.name}」写着已回收，但没有回收章节`,
        'status 是 paid，payoffIn 却是空的——这条线的状态与它的记录互相矛盾。',
        [`${card.path} · status: paid`, `${card.path} · payoffIn: ${thread.payoffIn.length === 0 ? '（空）' : thread.payoffIn.join('、')}`],
        { card: card.path },
      ))
    } else if (thread.status !== 'paid' && paid.length > 0) {
      found.push(issue(
        'thread-unpaid',
        'warn',
        card.path,
        'payoff-without-status',
        `伏笔「${card.name}」已有回收章节，status 还是 ${thread.status === '' ? '（空）' : thread.status}`,
        `payoffIn 里已经写了 ${paid.join('、')}，把 status 改成 paid 才能让这条线与它的记录一致。`,
        [`${card.path} · payoffIn: ${paid.join('、')}`, `${card.path} · status: ${thread.status === '' ? '（空）' : thread.status}`],
        { card: card.path },
      ))
    } else if (open && thread.payoffIn.length === 0 && thread.plannedPayoff !== undefined) {
      // Only a payoff point that names a real chapter can be judged: 「第一卷末」
      // is prose this layer cannot evaluate, and guessing would be a false positive.
      const planned = chapterOf(thread.plannedPayoff)
      if (planned !== undefined && !planned.archived) {
        const passed = live.some(chapter => isAfter(chapter, planned))
        if (passed) {
          found.push(issue(
            'thread-unpaid',
            'warn',
            card.path,
            `overdue:${thread.plannedPayoff}`,
            `伏笔「${card.name}」的计划回收点已过，仍未回收`,
            `plannedPayoff 是 ${chapterLabel(planned)}，书已经写到更后面，但 payoffIn 还是空的。要么补回收，要么把计划往后挪。`,
            [`${card.path} · plannedPayoff: ${thread.plannedPayoff}`, `${card.path} · payoffIn: （空）`],
            { card: card.path },
          ))
        }
      }
    }

    // ── 3b. The recorded sentence can no longer be found ────────────────────
    //
    // `plantedQuote` / `payoffQuote` are stored as the sentence itself rather than
    // as an offset (`03` §4.4), which is what makes them survive edits above them
    // — and what makes them **expire** when that sentence is rewritten. The
    // format's answer to "the text changed" is to say so instead of pointing at
    // whatever now occupies those characters; this rule is the other half of that
    // promise: the panel can only say it when someone clicks, and a record nobody
    // clicks is a record that quietly stops meaning anything (`12` §4).
    //
    // The finder is the panel's own (`novel/quote.ts`), tolerance included, so the
    // report and the 「跳回埋点」 button cannot disagree about the same sentence.
    const quoted: { field: 'plantedQuote' | 'payoffQuote', text: string, chapters: CheckChapter[], label: string }[] = []
    if (thread.plantedIn !== undefined) {
      const planted = chapterOf(thread.plantedIn)
      if (planted !== undefined && thread.plantedQuote !== undefined) {
        quoted.push({ field: 'plantedQuote', text: thread.plantedQuote, chapters: [planted], label: '埋点' })
      }
    }
    if (thread.payoffQuote !== undefined) {
      // The quote is not tied to one chapter in the file: the panel appends the
      // chapter it collected in and writes that sentence, but a hand-edited card
      // may list several. So the sentence counts as present when **any** recorded
      // payoff chapter contains it — the alternative reports a stale quote for a
      // sentence the author can see with their own eyes.
      const paidChapters = thread.payoffIn
        .map(id => chapterOf(id))
        .filter((chapter): chapter is CheckChapter => chapter !== undefined)
      if (paidChapters.length > 0) {
        quoted.push({ field: 'payoffQuote', text: thread.payoffQuote, chapters: paidChapters, label: '回收' })
      }
    }
    for (const entry of quoted) {
      if (entry.text.trim() === '') continue
      const where = entry.chapters.map(chapter => `${chapter.path} · ${chapterLabel(chapter)}`).join('、')
      const stillThere = entry.chapters.some(chapter => findQuote(chapter.body, entry.text).kind === 'found')
      if (stillThere) continue
      const shown = entry.text.trim()
      found.push(issue(
        'thread-quote',
        'warn',
        card.path,
        `${entry.field}:${entry.chapters.map(chapter => chapter.fileId).join(',')}`,
        `伏笔「${card.name}」的${entry.label}原句在当前正文里找不到了`,
        `${entry.field} 存的是当时那一句原文；那一句被改写（或整段删掉）之后，这条记录就指不到东西了。`
        + '要么把原句更新成现在的那一句，要么在正文里重新记一次这条伏笔。',
        [
          `${card.path} · ${entry.field}: ${shown.length > 40 ? `${shown.slice(0, 40)}…` : shown}`,
          `${where} 里找不到这一句`,
        ],
        { card: card.path, chapter: entry.chapters[0]?.path },
      ))
    }
  }

  // ── 4. Name and alias collisions ──────────────────────────────────────────
  //
  // Only among live cards: a collision with a card the author deleted is not a
  // collision in the book they are writing.
  const byWord = new Map<string, { card: CheckCard, kind: 'name' | 'alias' }[]>()
  for (const card of liveCards) {
    const words: { word: string, kind: 'name' | 'alias' }[] = [
      { word: card.name, kind: 'name' },
      ...card.aliases.map(alias => ({ word: alias, kind: 'alias' as const })),
    ]
    for (const { word, kind } of words) {
      const trimmed = word.trim()
      if (trimmed === '') continue
      byWord.set(trimmed, [...(byWord.get(trimmed) ?? []), { card, kind }])
    }
  }
  for (const [word, users] of byWord) {
    const paths = [...new Set(users.map(user => user.card.path))]
    if (paths.length < 2) continue
    for (const path of paths) {
      const card = users.find(user => user.card.path === path)?.card
      if (card === undefined) continue
      found.push(issue(
        'alias-clash',
        'error',
        card.path,
        word,
        `「${word}」同时是 ${String(paths.length)} 张卡的名字或别名`,
        '实体解析先按名字与别名匹配（检索与任务装配都走这条路），撞车时只有一个能命中。把别名改成互不重叠的说法。',
        paths.map(other => `${other} · ${other === card.path ? '本卡' : '另一张卡'}用「${word}」`),
        { card: card.path },
      ))
    }
  }
  for (const card of liveCards) {
    for (const alias of card.aliases) {
      const other = cardById.get(alias.trim())
      // An alias pointing at a *retired* card's id is the same non-collision as a
      // shared name: that card is no longer in the working set.
      if (other === undefined || other.path === card.path || isRetiredCard(other)) continue
      found.push(issue(
        'alias-clash',
        'warn',
        card.path,
        `id:${alias.trim()}`,
        `别名「${alias.trim()}」与另一张卡的 id 撞车`,
        `别名 ${alias.trim()} 就是 ${other.id} 这张卡的 id：写进正文时，两种指法会指向不同的东西。`,
        [`${card.path} · aliases: ${alias.trim()}`, `${other.path} · id: ${other.id}`],
        { card: card.path },
      ))
    }
  }

  // ── 5. Chapter numbering: duplicates and holes ────────────────────────────
  const volumes = [...new Set(corpus.chapters.map(chapter => chapter.volume))].sort((a, b) => a - b)
  for (const volume of volumes) {
    const items = corpus.chapters
      .filter(chapter => chapter.volume === volume)
      .sort((left, right) => left.number - right.number)
    const byNumber = new Map<number, CheckChapter[]>()
    for (const chapter of items) {
      byNumber.set(chapter.number, [...(byNumber.get(chapter.number) ?? []), chapter])
    }
    for (const [number, group] of byNumber) {
      if (group.length < 2) continue
      const first = group[0] as CheckChapter
      found.push(issue(
        'chapter-number',
        'error',
        first.path,
        String(number),
        `第 ${String(volume)} 卷有两个第 ${String(number)} 章`,
        '章号决定阅读顺序与「上一章」，重复会让续写锚定到不确定的一章。',
        group.map(chapter => `${chapter.path} · number: ${String(chapter.number)}`),
        { chapter: first.path },
      ))
    }
    const highest = items.length === 0 ? 0 : (items.at(-1)?.number ?? 0)
    for (let number = 1; number <= highest; number += 1) {
      if (byNumber.has(number)) continue
      // An archived chapter keeps its number (format §4.6), so a number it holds
      // is not a hole — only a number nothing holds is. The jump target is the
      // chapter *after* the hole: there is no file to open for the missing one,
      // and that is where the author's eye needs to land.
      const next = items.find(chapter => chapter.number > number)
      found.push(issue(
        'chapter-gap',
        'warn',
        next?.path ?? (items[0]?.path ?? `chapters/v${String(volume).padStart(2, '0')}`),
        `v${String(volume)}:${String(number)}`,
        `第 ${String(volume)} 卷缺第 ${String(number)} 章`,
        `这一卷从 1 排到 ${String(highest)}，中间没有第 ${String(number)} 章，也没有哪一章存档占着这个号——多半是文件在面板之外被删掉了。`,
        [`chapters/v${String(volume).padStart(2, '0')}/ · 第 ${String(number)} 章的文件不存在`,
          `${next === undefined ? '下一章' : `下一章：${next.path}`}`],
      ))
    }
  }

  // ── 6. The id a chapter declares against the id its filename encodes ──────
  //
  // **Every chapter, archived ones included** — this is the one chapter rule that
  // deliberately does not follow the "archived chapters are out" line, and the
  // reason is the other half of that line: an archived chapter keeps its id as a
  // valid **reference target** (`chapterOf` resolves archived chapters, so a
  // thread's `plantedIn` can still name one). A file whose declared id disagrees
  // with its filename therefore makes live references land on the wrong thing —
  // a consequence for the book the author is still writing.
  for (const chapter of corpus.chapters) {
    if (chapter.declaredId === undefined || chapter.declaredId === chapter.fileId) continue
    found.push(issue(
      'id-mismatch',
      'error',
      chapter.path,
      chapter.declaredId,
      `${chapter.path} 的 id 写着 ${chapter.declaredId}，文件名却是 ${chapter.fileId}`,
      '章节身份来自文件名，引用一律用文件名派生的 id（格式 §3.1）。两者不一致时，按 id 的引用与按 path 的跳转会指向不同的东西。',
      [`${chapter.path} · id: ${chapter.declaredId}`, `文件名派生的 id: ${chapter.fileId}`],
      { chapter: chapter.path },
    ))
  }

  // ── 7. The timeline: dangling references and narrative order ─────────────
  //
  // The rows come from `novel/timeline.ts`, the same parser the panel's timeline
  // editor renders with: an editor that wrote a table the checks read differently
  // would be worse than no editor.
  const timeline = corpus.pages.find(page => page.path === TIMELINE_FILE)
  if (timeline !== undefined) {
    const rows = parseTimeline(timeline.body).rows
    for (const row of rows) {
      for (const id of row.chapters) {
        if (chapterOf(id) !== undefined) continue
        found.push(issue(
          'timeline-ref',
          'error',
          timeline.path,
          `${id}@${String(row.lineNo)}`,
          `时间线第 ${String(row.lineNo)} 行引用了不存在的章节「${id}」`,
          '时间线的每一行都该指向真实章节；指向空章节的行读起来像事实，实际上没有对应正文。',
          [`${timeline.path}:${String(row.lineNo)} · ${row.line}`, `chapters/**/${id}.md 不存在`],
        ))
      }
    }
    let previous: { chapter: CheckChapter, lineNo: number, line: string } | undefined
    for (const row of rows) {
      const first = row.chapters
        .map(id => chapterOf(id))
        .find((chapter): chapter is CheckChapter => chapter !== undefined)
      if (first === undefined) continue
      if (previous !== undefined && isAfter(previous.chapter, first)) {
        found.push(issue(
          'timeline-order',
          'warn',
          timeline.path,
          `${String(previous.lineNo)}>${String(row.lineNo)}`,
          `时间线倒序：第 ${String(row.lineNo)} 行的章节比上一行更早`,
          `表格按叙事序排列（格式 §4.5），但这一行的章节在上一行之前。要么行序错了，要么章号该核对。`,
          [`${timeline.path}:${String(previous.lineNo)} · ${chapterLabel(previous.chapter)}`, `${timeline.path}:${String(row.lineNo)} · ${chapterLabel(first)}`],
        ))
      }
      previous = { chapter: first, lineNo: row.lineNo, line: row.line }
    }
  }

  // ── 8. Point of view not listed among the chapter's characters ───────────
  //
  // Live chapters only: `pov` and `characters` exist to decide what a *task*
  // carries, and an archived chapter is never assembled into one (`client/tasks.ts`).
  for (const chapter of live) {
    if (chapter.pov === undefined || chapter.characters.includes(chapter.pov)) continue
    found.push(issue(
      'pov-unlisted',
      'warn',
      chapter.path,
      chapter.pov,
      `${chapterLabel(chapter)} 的视角人物没在 characters 里`,
      `pov 是 ${chapter.pov}，characters 里却没有它：装配任务时这张卡不会被带上，检索「谁出现在哪些章」也会漏掉这一章。`,
      [`${chapter.path} · pov: ${chapter.pov}`, `${chapter.path} · characters: ${chapter.characters.length === 0 ? '（空）' : chapter.characters.join('、')}`],
      { chapter: chapter.path },
    ))
  }

  // ── 9. Length against target ─────────────────────────────────────────────
  //
  // Live chapters only: an archived chapter is out of the word counts (`snapshot`
  // counts the live book), so its length against a target is not a fact about the
  // book any more — reporting it was the other half of what the author asked for.
  for (const chapter of live) {
    const target = chapter.targetWords
    if (target === undefined || target <= 0 || chapter.wordCount <= 0) continue
    const drift = Math.abs(chapter.wordCount - target) / target
    if (drift < WORD_DRIFT) continue
    const direction = chapter.wordCount > target ? '超出' : '不足'
    found.push(issue(
      'word-drift',
      'info',
      chapter.path,
      String(target),
      `${chapterLabel(chapter)} ${direction}目标 ${String(Math.round(drift * 100))}%`,
      `目标 ${String(target)} 字，实测 ${String(chapter.wordCount)} 字。偏差超过 ${String(Math.round(WORD_DRIFT * 100))}% 就会和卷节奏对不上，值得看一眼。`,
      [`${chapter.path} · targetWords: ${String(target)}`, `${chapter.path} · wordCount: ${String(chapter.wordCount)}（工具维护）`],
      { chapter: chapter.path },
    ))
  }

  // ── 10. firstAppear against the earliest chapter that names the card ─────
  //
  // "Earliest" is over **live** chapters: the card is in the working set, so a
  // chapter the author withdrew must not be what contradicts its `firstAppear`.
  for (const card of liveCards) {
    if (card.firstAppear === undefined || card.type === 'thread') continue
    const naming = live
      .filter(chapter =>
        chapter.characters.includes(card.id) || chapter.locations.includes(card.id)
        || chapter.refs.includes(card.id) || chapter.pov === card.id)
      .sort((left, right) => (left.volume - right.volume) || (left.number - right.number))
    const named = chapterOf(card.firstAppear)
    if (named === undefined) {
      found.push(issue(
        'firstappear-mismatch',
        'warn',
        card.path,
        `absent:${card.firstAppear}`,
        `${card.name} 的 firstAppear 指向不存在的章节「${card.firstAppear}」`,
        'firstAppear 是手写字段，它指向的章节不在工程里；检索会把这个说法原样报给作者。',
        [`${card.path} · firstAppear: ${card.firstAppear}`, `chapters/**/${card.firstAppear}.md 不存在`],
        { card: card.path },
      ))
      continue
    }
    const earliest = naming[0]
    if (earliest !== undefined && earliest.path !== named.path) {
      found.push(issue(
        'firstappear-mismatch',
        'warn',
        card.path,
        `earliest:${earliest.fileId}`,
        `${card.name} 的 firstAppear 与最早的出场登记不一致`,
        `卡片写着 ${card.firstAppear}（${chapterLabel(named)}），但最早登记它的章节是 ${chapterLabel(earliest)}。两者取其一，别让它俩一直不一致。`,
        [`${card.path} · firstAppear: ${card.firstAppear}`, `${earliest.path} · 最早的出场登记`],
        { card: card.path },
      ))
    }
  }

  // ── 11. Live chapters still pointing at archived cards ───────────────────
  for (const chapter of live) {
    const used = new Set<string>([
      ...(chapter.pov === undefined ? [] : [chapter.pov]),
      ...chapter.characters,
      ...chapter.locations,
      ...chapter.refs,
    ])
    for (const id of used) {
      const card = cardById.get(id)
      if (card?.archived !== true) continue
      found.push(issue(
        'archived-ref',
        'info',
        chapter.path,
        id,
        `${chapterLabel(chapter)} 还在引用已存档的卡「${card.name}」`,
        `卡已存档（不参与任务装配），但这一章的 frontmatter 仍写着它：要么把卡恢复，要么把这一章的引用清掉。`,
        [`${chapter.path} · 引用了 ${id}`, `${card.path} · archived: true`],
        { chapter: chapter.path, card: card.path },
      ))
    }
  }

  // ── Order: severity, then story order, then rule ─────────────────────────
  const order = new Map(corpus.chapters.map(chapter => [chapter.path, chapter]))
  return found.sort((left, right) => {
    const bySeverity = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]
    if (bySeverity !== 0) return bySeverity
    const leftChapter = left.chapter === undefined ? undefined : order.get(left.chapter)
    const rightChapter = right.chapter === undefined ? undefined : order.get(right.chapter)
    if (leftChapter !== undefined && rightChapter !== undefined) {
      const byStory = (leftChapter.volume - rightChapter.volume) || (leftChapter.number - rightChapter.number)
      if (byStory !== 0) return byStory
    } else if (leftChapter !== undefined) return -1
    else if (rightChapter !== undefined) return 1
    return left.path.localeCompare(right.path)
      || left.rule.localeCompare(right.rule)
      || left.key.localeCompare(right.key)
  })
}

/**
 * Split findings into the ones still standing and the ones already ignored.
 * @param issues - every finding of a run.
 * @param ignored - the stored ignore keys.
 * @returns the live findings, the ignored ones, and the stored keys that no longer match.
 */
export function applyIgnores(
  issues: readonly CheckIssue[],
  ignored: readonly string[],
): { issues: CheckIssue[], ignored: CheckIssue[], stale: string[] } {
  const keys = new Set(ignored)
  const live = issues.filter(finding => !keys.has(finding.key))
  const set = new Set(issues.map(finding => finding.key))
  return {
    issues: live,
    ignored: issues.filter(finding => keys.has(finding.key)),
    stale: ignored.filter(key => !set.has(key)),
  }
}

/**
 * Run the checks and apply the author's ignore decisions.
 * @param corpus - the parsed project.
 * @param ignored - the stored ignore keys.
 * @returns the report the panel renders.
 */
export function checkProject(corpus: CheckCorpus, ignored: readonly string[] = []): CheckReport {
  const split = applyIgnores(runChecks(corpus), ignored)
  return {
    issues: split.issues,
    ignored: split.ignored,
    stale: split.stale,
    counts: {
      error: split.issues.filter(finding => finding.severity === 'error').length,
      warn: split.issues.filter(finding => finding.severity === 'warn').length,
      info: split.issues.filter(finding => finding.severity === 'info').length,
    },
    scanned: {
      chapters: corpus.chapters.length,
      cards: corpus.cards.length,
      pages: corpus.pages.length,
    },
  }
}
