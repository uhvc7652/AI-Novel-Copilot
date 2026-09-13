/**
 * The settings library: every card, grouped by type, with the card itself open
 * beside the list.
 *
 * M1 asks for CRUD over the setting cards, and the one operation `ctx.fs` cannot
 * do is delete — it has no unlink, and the sandbox seam is the only door to
 * disk. So "delete" here is **archive**: a card gains `archived: true`, drops
 * out of the default list, and can come back. A separate field rather than a
 * `status` value, because a thread's `status` is its lifecycle
 * (`planted`/`reinforced`/`paid`/`abandoned`) and one field must not mean two
 * things.
 *
 * @module dsh-ai-novel-copilot/client/SettingsView
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuoteLocate } from './locate.ts'
import { ListField } from './ListField.tsx'
import { TimelineEditor } from './TimelineEditor.tsx'
import type { SettingsLibrary, SettingsPage } from '../novel/io.ts'
import type { CardSummary, CardType, ChapterSummary } from '../novel/project.ts'
import { cardBodyHint, cardHasField, roleLabels, roleValue, type CardField } from '../novel/cards.ts'
import { CARD_LABELS, CARD_TYPES, cardTypeOfPath, TIMELINE_FILE, WORLD_FILE } from '../novel/paths.ts'
import * as api from './api.ts'
import {
  box,
  button,
  caption,
  checkLine,
  input,
  listRow,
  metaLine,
  row,
  textarea,
  THREAD_STATUS_LABEL,
  type PanelEnv,
} from './ui.ts'

/** Props for the settings view. */
export interface SettingsViewProps {
  /** Shared panel environment. */
  env: PanelEnv
  /** The loaded library, or undefined before the first load. */
  library?: SettingsLibrary
  /** Every chapter, so a card's reverse links can be shown as chapters. */
  chapters: readonly ChapterSummary[]
  /** Re-read the library after a write. */
  onReload(): Promise<void>
  /** Open a chapter in the prose view, from a card's "appears in" list. */
  onOpenChapter(path: string): void
  /**
   * A card the retrieval view jumped to.
   *
   * The token, not the path, is what triggers a load: the panel bumps it on
   * every click, so clicking the same hit twice works, while an unrelated
   * re-render (the shared busy flag changing, a library reload) does not reopen
   * the card and throw away an unsaved edit.
   */
  focus?: { path: string, token: number }
  /** Whether this surface is the one on screen, which is when it owns "the open document". */
  active: boolean
  /** Bumped by the panel when this editor should re-read the card it has open. */
  refreshToken?: number
  /**
   * Bumped by the panel when `Ctrl+S` (or the footer's 保存) means *this*
   * surface's document rather than the chapter.
   */
  saveToken?: number
  /** Tell the panel which document this surface has open, so M7's record view follows it. */
  onOpenDocument?(path: string, surface: 'settings', dirty: boolean): void
  /** A passage to select in the card body, from a finding or a diff line. */
  locate?: { quote: string, token: number }
}

/** The card (or page) currently open in the editor. */
interface OpenCard {
  path: string
  data: Record<string, unknown>
  body: string
  /** The file as loaded, for the dirty check. */
  original: { data: Record<string, unknown>, body: string }
  /** Whether the file exists on disk yet. */
  exists: boolean
}

/** Read a string field out of frontmatter data. */
function field(data: Record<string, unknown>, key: string): string {
  const value = data[key]
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return ''
}

/**
 * Read a list field as labels, tolerating a bare scalar.
 *
 * `listText` used to be the same thing joined for display, which is what made the
 * comma impossible to type: the input's value *was* the parsed list, so the round
 * trip ate the separator. The parsing now happens when the author leaves the
 * field (`ListField`), and the raw value only has to answer "what are the labels".
 * @param data - frontmatter data.
 * @param key - field name.
 * @returns the labels.
 */
function listOf(data: Record<string, unknown>, key: string): string[] {
  const value = data[key]
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string')
  return typeof value === 'string' && value.trim() !== '' ? [value] : []
}

/**
 * What each single-file page is for, shown where its form would otherwise be
 * indistinguishable from a card's.
 *
 * The two pages are not cards and have nothing in common with each other either:
 * the world overview is prose that **only 一致性检查（模型）** reads, whole, as the
 * thing a chapter is checked against, and the timeline is a **table** the
 * consistency checks read (`07` §1.1's `timeline-ref` / `timeline-order`).
 * Saying so on the page is the cheapest half of giving the timeline its own
 * editor — and of keeping detail (a cultivation ladder, a magic system) out of
 * the one file every model check has to carry.
 */
const PAGE_HINT: Record<string, string> = {
  [WORLD_FILE]: '世界观：整本书的设定总纲，散文。只有「一致性检查（模型）」会整份读它；写正文用的是本卷卷纲与本章 frontmatter 引用的设定卡——细则（境界阶梯、体系规则、术语）开一张「设定」卡更合适，这里只留总纲与不可违背的那几条。',
  [TIMELINE_FILE]: '时间线：一张表，四列是 叙事序 / 故事时间 / 事件 / 章节 id。「检查」按这张表报倒序（timeline-order）和引用不存在的章（timeline-ref）。',
}

/**
 * The settings view.
 * @param props - environment, the loaded library, and the reload hook.
 */
export function SettingsView({ env, library, chapters, onReload, onOpenChapter, focus, active, refreshToken, saveToken, onOpenDocument, locate }: SettingsViewProps) {
  const [open, setOpen] = useState<OpenCard>()
  const [showArchived, setShowArchived] = useState(false)
  const [draft, setDraft] = useState<{ type: CardType, id: string, name: string }>({
    type: 'character',
    id: '',
    name: '',
  })
  /** The card's reverse links are ids; the tree is what turns them into chapters. */
  const chapterById = useMemo(() => new Map(chapters.map(chapter => [chapter.id, chapter])), [chapters])
  /** The last jump this view acted on, so a re-render never reopens the card. */
  const focusedRef = useRef(0)
  /** The card body editor, for a finding or a diff line to put the cursor on. */
  const bodyRef = useRef<HTMLTextAreaElement | null>(null)

  useQuoteLocate(bodyRef, locate, open?.body ?? '', env.note)

  // Tell the panel which document this surface has open, but only while it is the
  // one on screen: all three surfaces stay mounted, and a hidden one claiming
  // ownership would move the modification record out from under the author.
  // `dirty` travels with it so a rollback can warn about unsaved edits to a card
  // exactly as it does for a chapter.
  const openDirty = open !== undefined
    && (open.body !== open.original.body || JSON.stringify(open.data) !== JSON.stringify(open.original.data))
  useEffect(() => {
    if (!active || open === undefined) return
    onOpenDocument?.(open.path, 'settings', openDirty)
  }, [active, onOpenDocument, open, openDirty])

  /**
   * Re-read the open card when the panel says the file changed underneath us.
   *
   * A rollback writes to disk without going through this editor, so the buffer
   * here would otherwise keep showing the text that was just replaced — which
   * reads as "the rollback did not work".
   */
  const refreshSeen = useRef(refreshToken)
  useEffect(() => {
    if (refreshToken === undefined || refreshToken === refreshSeen.current || open === undefined) return
    refreshSeen.current = refreshToken
    const path = open.path
    void (async () => {
      try {
        const loaded = await api.readDocument(env.sessionId, env.root, path)
        setOpen({
          path: loaded.path,
          data: loaded.data,
          body: loaded.body,
          original: { data: { ...loaded.data }, body: loaded.body },
          exists: true,
        })
      } catch {
        // The file may be gone; keeping the buffer is better than blanking the
        // editor the author is looking at.
      }
    })()
  }, [env, open, refreshToken])

  /** Load one card or page by path — the one entry both the list and a jump use. */
  const openPath = useCallback((path: string, label: string) => {
    void env.run(label, async () => {
      const loaded = await api.readDocument(env.sessionId, env.root, path)
      setOpen({
        path: loaded.path,
        data: loaded.data,
        body: loaded.body,
        original: { data: { ...loaded.data }, body: loaded.body },
        exists: true,
      })
      return `已打开 ${loaded.path}`
    })
  }, [env])

  /** Load one card for editing. */
  const onSelectCard = useCallback((card: CardSummary) => {
    openPath(card.path, `打开卡片「${card.name}」`)
  }, [openPath])

  // The retrieval view's jump. A path that is no longer in the library is still
  // opened: the read is what decides, and a file the host no longer serves says
  // so in the note line instead of the click doing nothing.
  useEffect(() => {
    if (focus === undefined || focusedRef.current === focus.token) return
    focusedRef.current = focus.token
    openPath(focus.path, '打开检索结果')
  }, [focus, openPath])

  /** Load one of the two single-file pages, creating its buffer when absent. */
  const onSelectPage = useCallback((page: SettingsPage) => {
    void env.run(`打开「${page.title}」`, async () => {
      try {
        const loaded = await api.readDocument(env.sessionId, env.root, page.path)
        setOpen({
          path: loaded.path,
          data: loaded.data,
          body: loaded.body,
          original: { data: { ...loaded.data }, body: loaded.body },
          exists: true,
        })
        return `已打开 ${loaded.path}`
      } catch (error) {
        if (!(error instanceof Error) || error.name !== 'novel/not-found') throw error
        setOpen({
          path: page.path,
          data: { type: page.path === WORLD_FILE ? 'world' : 'timeline', title: page.title },
          body: '',
          original: { data: {}, body: '' },
          exists: false,
        })
        return `${page.path} 还不存在，保存后创建`
      }
    })
  }, [env])

  const patch = useCallback((next: Partial<Record<string, unknown>>) => {
    setOpen(previous => (previous === undefined ? previous : { ...previous, data: { ...previous.data, ...next } }))
  }, [])

  /**
   * The current save action, for a retry to re-enter.
   *
   * A failed save keeps a retry in the status line, and re-running the closure
   * that failed would write the card as it was at that moment — so the retry
   * goes back through this ref, which always holds the newest `onSave`.
   */
  const onSaveRef = useRef<(() => void) | undefined>(undefined)

  /** Write the open card through the ordinary document path. */
  const onSave = useCallback(() => {
    if (open === undefined) return
    void env.run('保存卡片', async () => {
      const written = await api.writeDocument(env.sessionId, env.root, open.path, open.data, open.body)
      setOpen({ ...open, original: { data: { ...open.data }, body: open.body }, exists: true })
      await onReload()
      const warning = written.warning === undefined ? '' : `｜注意：${written.warning}`
      return `已保存 ${open.path}（${written.operation === 'create' ? '新建' : '覆盖'}）${warning}`
    }, () => { onSaveRef.current?.() })
  }, [env, onReload, open])
  onSaveRef.current = onSave

  /**
   * Save the open card when the panel asks for it.
   *
   * The token is compared against the value this editor last saw, so a re-render
   * never re-saves — only a new bump does. Writing an unchanged card is harmless
   * (the host records no version for identical text), but a 保存 that fired on
   * its own would be a horror.
   */
  const saveSeen = useRef(saveToken)
  useEffect(() => {
    if (saveToken === undefined || saveToken === saveSeen.current) return
    saveSeen.current = saveToken
    if (open === undefined) {
      env.note('设定页里没有打开的卡——先在左边点一张')
      return
    }
    onSave()
  }, [env, onSave, open, saveToken])

  /** Archive or restore the open card. */
  const onToggleArchive = useCallback(() => {
    if (open === undefined) return
    const archived = open.data.archived === true
    void env.run(archived ? '恢复卡片' : '存档卡片', async () => {
      const data = { ...open.data, archived: !archived }
      const written = await api.writeDocument(env.sessionId, env.root, open.path, data, open.body)
      setOpen({ ...open, data, original: { data: { ...data }, body: open.body }, exists: true })
      await onReload()
      return archived
        ? `已恢复 ${open.path}（${String(written.after.length)} 字节）`
        : `已存档 ${open.path}：默认列表里不再显示，可勾「显示已存档」再恢复`
    })
  }, [env, onReload, open])

  /** Create a new card from the panel's form. */
  const onCreate = useCallback(() => {
    const id = draft.id.trim()
    const name = draft.name.trim()
    if (id === '') {
      env.note('卡 id 不能为空（小写字母、数字与连字符）')
      return
    }
    void env.run('新建卡片', async () => {
      const created = await api.createCard(env.sessionId, env.root, draft.type, id, name === '' ? id : name)
      await onReload()
      setDraft({ type: draft.type, id: '', name: '' })
      const loaded = await api.readDocument(env.sessionId, env.root, created.path)
      setOpen({
        path: loaded.path,
        data: loaded.data,
        body: loaded.body,
        original: { data: { ...loaded.data }, body: loaded.body },
        exists: true,
      })
      return `已新建 ${created.path}`
    })
  }, [draft, env, onReload])

  const dirty = open !== undefined
    && (open.body !== open.original.body || JSON.stringify(open.data) !== JSON.stringify(open.original.data))
  /**
   * The open card's type, taken from its **directory** rather than its `type:`
   * line.
   *
   * `paths.ts` is explicit that a card's type is its directory (`cardTypeOfPath`,
   * the same reader the host's scan uses), so a file whose frontmatter says
   * `type: character` inside `settings/locations/` is a location here and in the
   * checks — one answer, not two. The form used to ask the frontmatter instead,
   * which meant a thread card missing its `type:` line got the character form.
   */
  const openType = open === undefined ? undefined : cardTypeOfPath(open.path)
  const isThread = openType === 'thread'
  const isPage = open !== undefined && (open.path === WORLD_FILE || open.path === TIMELINE_FILE)
  const isTimeline = open !== undefined && open.path === TIMELINE_FILE
  /**
   * Which optional fields this card's type actually has (format §4.3).
   *
   * Every card used to be rendered with the character form: 身份 / 年龄 / 性别 on a
   * 地点卡 too, and the same body-section hint for all of them, which is what the
   * author saw as 「地点、物品的编辑界面和角色卡的一样」. The table is in
   * `novel/cards.ts`, next to the other card rules, because `cardFacts` asks it
   * the same question when it builds a prompt.
   */
  const owns = (cardField: CardField): boolean => openType !== undefined && cardHasField(openType, cardField)
  /**
   * The label a document's own title field carries.
   *
   * A **thread** card calls it `title` (format §4.4) and a **single-file page**
   * does too (§4.5's timeline, and the world overview), while every other card
   * calls it `name`. The form used to bind `name` for pages as well, so opening
   * 世界观 or 时间线 showed an empty box that wrote a field nothing reads —
   * which is exactly what the author hit: "两个页面的编辑方式是一样的".
   */
  const titleField = isThread || isPage ? 'title' : 'name'
  const appearsIn = open === undefined || isPage ? [] : findAppearsIn(library, open.path)
  const referenced = appearsIn
    .map(id => chapterById.get(id))
    .filter((chapter): chapter is ChapterSummary => chapter !== undefined)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
      <div style={{ ...row, justifyContent: 'space-between' }}>
        <span style={metaLine}>
          {library === undefined
            ? '尚未读取设定库'
            : `${String(library.total)} 张卡 · 已存档 ${String(library.archived)} 张`}
        </span>
        <span style={row}>
          <label style={checkLine}>
            <input
              type="checkbox"
              checked={showArchived}
              onChange={event => { setShowArchived(event.target.checked) }}
            /> 显示已存档
          </label>
          <button type="button" style={button} disabled={env.busy} onClick={() => { void onReload() }}>刷新</button>
        </span>
      </div>

      <div style={row}>
        {(library?.pages ?? []).map(page => (
          <button key={page.path} type="button" style={button} disabled={env.busy} onClick={() => { onSelectPage(page) }}>
            {page.title}{page.exists ? '' : '（新建）'}
          </button>
        ))}
      </div>

      <div style={box}>
        {library === undefined || library.groups.length === 0
          ? <div style={metaLine}>还没有设定卡。下面填一个 id 和名字，点「新建卡」就会在 settings/&lt;类型&gt;/ 下建出带分节的卡片。</div>
          : library.groups.map(group => {
            const cards = group.cards.filter(card => showArchived || !card.archived)
            if (cards.length === 0) return null
            return (
              <div key={group.type} style={{ marginTop: 6 }}>
                <div style={metaLine}>{group.label} · {String(cards.length)}</div>
                {cards.map(card => (
                  <button
                    key={card.path}
                    type="button"
                    // The gist is the card's first real line; as a tooltip it
                    // costs no layout and tells the author which card this is
                    // without opening it.
                    title={card.gist === '' ? card.path : `${card.path}\n${card.gist}`}
                    style={{
                      ...listRow,
                      background: open?.path === card.path
                        ? 'color-mix(in srgb, currentColor 12%, transparent)'
                        : 'transparent',
                      opacity: card.archived ? 0.55 : 1,
                    }}
                    onClick={() => { onSelectCard(card) }}
                  >
                    <span>
                      {card.name}
                      {card.archived ? ' · 已存档' : ''}
                      {card.role === undefined ? '' : ` · ${card.role}`}
                    </span>
                    <span style={{ opacity: 0.65 }}>
                      {card.id}
                      {card.appearsIn.length === 0 ? '' : ` · 出现 ${String(card.appearsIn.length)} 章`}
                    </span>
                  </button>
                ))}
              </div>
            )
          })}
      </div>

      <div style={row}>
        <select
          style={input}
          value={draft.type}
          onChange={event => { setDraft({ ...draft, type: event.target.value as CardType }) }}
        >
          {CARD_TYPES.map(type => <option key={type} value={type}>{CARD_LABELS[type]}</option>)}
        </select>
        <input
          style={{ ...input, width: 140 }}
          value={draft.id}
          placeholder="id（如 chen-mo）"
          onChange={event => { setDraft({ ...draft, id: event.target.value }) }}
        />
        <input
          style={{ ...input, width: 140 }}
          value={draft.name}
          placeholder="显示名（如 陈默）"
          onChange={event => { setDraft({ ...draft, name: event.target.value }) }}
        />
        <button type="button" style={button} disabled={env.busy} onClick={onCreate}>新建卡</button>
      </div>

      {open !== undefined && (
        <>
          <div style={row}>
            <span style={metaLine}>{open.path}{open.exists ? '' : '（尚未落盘）'}</span>
          </div>
          <div style={row}>
            <input
              style={{ ...input, flex: '1 1 120px' }}
              value={field(open.data, titleField)}
              placeholder={isPage ? '这一页的标题' : isThread ? '伏笔标题' : '名字'}
              onChange={event => { patch({ [titleField]: event.target.value }) }}
            />
            {!isPage && (
              <>
                <input
                  style={{ ...input, width: 120 }}
                  value={field(open.data, 'id')}
                  placeholder="id"
                  disabled
                />
                <ListField
                  style={{ ...input, width: 150 }}
                  value={listOf(open.data, 'aliases')}
                  placeholder="别名（逗号分隔）"
                  onChange={labels => { patch({ aliases: labels }) }}
                />
              </>
            )}
          </div>
          {/* A single-file page has no id, no aliases and nothing to archive: its
              whole shape is `type` + `title` + prose. Showing the card fields here
              was the other half of "两个页面看起来一模一样". */}
          {isPage
            ? <div style={metaLine}>{PAGE_HINT[open.path] ?? ''}</div>
            : (
              <div style={row}>
                {/* 身份：角色卡的 `role` 与势力卡的「立场」是格式里的同一个字段
                    （`CARD_FIELDS`）。地点与物品没有这个字段，所以这里不给框。 */}
                {owns('role') && (
                  <ListField
                    style={{ ...input, width: 130 }}
                    value={roleLabels(open.data.role)}
                    placeholder={openType === 'faction' ? '立场（逗号分隔）' : '身份（逗号分隔）'}
                    title="可以写多个，例如 主角, 前朝皇子"
                    onChange={labels => {
                      const written = roleValue(labels)
                      // No labels means no key, not `role: ""`.
                      patch({ role: written === '' ? undefined : written })
                    }}
                  />
                )}
                {owns('age') && (
                  <input
                    style={{ ...input, width: 110 }}
                    value={field(open.data, 'age')}
                    placeholder="年龄"
                    inputMode="numeric"
                    onChange={event => {
                      const text = event.target.value.trim()
                      if (text === '') {
                        // Clearing the box deletes the key rather than leaving a
                        // null-ish value the author never typed.
                        patch({ age: undefined })
                        return
                      }
                      // A number when it is one, otherwise the author's own words:
                      // `age: 19岁` beats `age: NaN`, which is what a naive
                      // `Number(text)` would have written into the YAML.
                      const value = Number(text)
                      patch({ age: Number.isFinite(value) ? value : text })
                    }}
                  />
                )}
                {owns('gender') && (
                  <>
                    <input
                      style={{ ...input, width: 90 }}
                      value={field(open.data, 'gender')}
                      placeholder="性别"
                      list="novel-card-genders"
                      onChange={event => { patch({ gender: event.target.value }) }}
                    />
                    <datalist id="novel-card-genders">
                      <option value="男" />
                      <option value="女" />
                      <option value="其他" />
                    </datalist>
                  </>
                )}
                <ListField
                  style={{ ...input, flex: '1 1 120px' }}
                  value={listOf(open.data, 'tags')}
                  placeholder="标签（逗号分隔）"
                  onChange={labels => { patch({ tags: labels }) }}
                />
                {isThread && (
                  <select
                    style={input}
                    value={field(open.data, 'status') === '' ? 'planted' : field(open.data, 'status')}
                    onChange={event => { patch({ status: event.target.value }) }}
                  >
                    {Object.entries(THREAD_STATUS_LABEL).map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                )}
                <label style={checkLine}>
                  <input
                    type="checkbox"
                    checked={open.data.archived === true}
                    onChange={event => { patch({ archived: event.target.checked }) }}
                  /> 已存档
                </label>
              </div>
            )}
          {/* The timeline is a **table**, the world overview is prose, cards are
              sections — three shapes, so one shared textarea for all of them was
              the wrong default. The timeline gets rows (and 编辑原文 as the way
              out); everything else keeps the editor that suits prose. */}
          {isTimeline
            ? (
              <TimelineEditor
                env={env}
                body={open.body}
                chapters={chapters}
                onChange={body => {
                  setOpen(previous => (previous === undefined ? previous : { ...previous, body }))
                }}
                {...(locate === undefined ? {} : { locate })}
                textareaRef={bodyRef}
              />
            )
            : (
              <textarea
                ref={bodyRef}
                style={textarea}
                value={open.body}
                placeholder={isPage ? '正文' : `卡片的正文分节：${openType === undefined ? '' : cardBodyHint(openType)}`}
                onChange={event => { setOpen({ ...open, body: event.target.value }) }}
              />
            )}
          <div style={{ ...row, justifyContent: 'space-between' }}>
            <span style={{ ...row, fontSize: 11 }}>
              <span style={caption}>
                {referenced.length === 0 ? '还没有章节引用这张卡' : '出现在：'}
              </span>
              {referenced.map(chapter => (
                <button
                  key={chapter.path}
                  type="button"
                  style={{ ...button, padding: '1px 6px' }}
                  title={chapter.title}
                  onClick={() => { onOpenChapter(chapter.path) }}
                >
                  第 {String(chapter.number)} 章
                </button>
              ))}
            </span>
            <span style={row}>
              <button type="button" style={button} disabled={env.busy || !dirty} onClick={onSave}>保存</button>
              {!isPage && (
                <button type="button" style={button} disabled={env.busy} onClick={onToggleArchive}>
                  {open.data.archived === true ? '恢复' : '存档'}
                </button>
              )}
            </span>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * The chapters that reference the open card, as ids.
 * @param library - the loaded library.
 * @param path - the open card's path.
 * @returns the chapter ids the host derived, or an empty array.
 */
function findAppearsIn(library: SettingsLibrary | undefined, path: string): string[] {
  if (library === undefined) return []
  for (const group of library.groups) {
    for (const card of group.cards) {
      if (card.path === path) return card.appearsIn
    }
  }
  return []
}
