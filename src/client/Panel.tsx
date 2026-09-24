/**
 * The writing panel: the project tree, the chapter editor, and the task loop.
 *
 * Everything the panel does is an explicit author action — open a project, pick
 * a chapter, type, save, and run one named task whose assembled inputs are shown
 * before its output is trusted. Adopting a generation only edits the buffer;
 * the file is written by the same save path as a hand-typed change.
 *
 * P2 makes the panel a shell over three surfaces that share the project tree:
 * 正文 (this file's own editor), 设定 (the card library), and 大纲 (the book line,
 * volume outlines, and chapter beats). The sections are all mounted and hidden
 * with `display`, not unmounted, because each one holds a buffer: switching to
 * the outline mid-edit and back must not throw the edit away.
 *
 * @module dsh-ai-novel-copilot/client/Panel
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { countWords } from '../novel/words.ts'
import { documentChanged } from '../novel/buffer.ts'
import { chapterRefFieldOf, type ChapterRefField } from '../novel/cards.ts'
import { chapterIdOfPath, nextThreadId } from '../novel/paths.ts'
import type { LoadedDocument, SettingsLibrary } from '../novel/io.ts'
import type { CardSummary, ChapterStatus, ChapterSummary, ProjectSnapshot } from '../novel/project.ts'
import type { CheckIssue, CheckReport } from '../novel/checks.ts'
import * as api from './api.ts'
import { pointedText, useQuoteLocate } from './locate.ts'
import { ExportView } from './ExportView.tsx'
import { OutlineView } from './OutlineView.tsx'
import {
  loadRecents,
  recentLabel,
  rememberProject,
  saveRecents,
  type RecentProject,
} from './projects.ts'
import { actionFor, shortcutHelp, shortcutLabel } from './shortcuts.ts'
import { SettingsView } from './SettingsView.tsx'
import { ThreadsView } from './ThreadsView.tsx'
import { SearchView } from './SearchView.tsx'
import { ChecksView } from './ChecksView.tsx'
import { HistoryView } from './HistoryView.tsx'
import { TaskBar } from './TaskBar.tsx'
import { ChapterCards } from './ChapterCards.tsx'
import { ChapterContext } from './ChapterContext.tsx'
import { CHAPTER_TASKS, CHECK_TASKS, type TaskContext } from './tasks.ts'
import {
  box,
  button,
  caption,
  checkLine,
  controlRow,
  input,
  listRow,
  liveThreads,
  metaLine,
  PANEL_SECTIONS,
  row,
  STATUS_LABEL,
  textarea,
  wrap,
  type PanelEnv,
  type PanelSection,
} from './ui.ts'

/** Props the slot framework passes to a session-scoped tab body. */
export interface PanelProps {
  /** Session this tab belongs to; every request carries it for sandbox resolution. */
  sessionId?: string
  /**
   * The shell's directory picker, when the deployment composes one.
   *
   * Omitted rather than required: a deployment without a picker still gets the
   * whole panel, minus the 「选择文件夹」 button's effect.
   */
  pickDirectory?: () => Promise<string | null>
}

/** The chapter currently open in the editor. */
interface OpenChapter {
  path: string
  data: Record<string, unknown>
  body: string
}

/** Which surface the panel is showing. */
type Section = PanelSection

/** Section tabs, in the order the panel shows them (see `ui.ts` — the order is numbered by `shortcuts.ts`). */
const SECTIONS = PANEL_SECTIONS

/** Where a failure message is coloured; dim grey text cannot say "this went wrong". */
const ERROR_COLOR = '#d9534f'

/** Which one the status line is carrying. */
type NoteTone = 'info' | 'error'

/** The status line's current content. */
interface Note {
  text: string
  tone: NoteTone
}

/** Where the panel remembers the last project root. */
const ROOT_STORAGE_KEY = 'dsh-ai-novel-copilot.root'

/** Read a string field out of frontmatter data. */
function field(data: Record<string, unknown>, key: string): string {
  const value = data[key]
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return ''
}

/**
 * Read a chapter's reference ids out of frontmatter, tolerating a bare scalar.
 *
 * `characters` / `locations` / `refs` are hand-editable (format §3.2), and a
 * single id written without brackets is legal — the panel must not show "no
 * cards" for a chapter whose file says `refs: jian-xiu-jingjie`. `contextChapters`
 * is the same shape for chapters, so it reads through the same function.
 * @param data - the chapter's frontmatter.
 * @param key - which reference field.
 * @returns the ids, in the order written.
 */
function refsOf(data: Record<string, unknown>, key: ChapterRefField | 'contextChapters'): string[] {
  const value = data[key]
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
  return typeof value === 'string' && value.trim() !== '' ? [value.trim()] : []
}

/** A hidden section keeps its buffer but takes no space. */
function sectionStyle(active: boolean): CSSProperties {
  return {
    display: active ? 'flex' : 'none',
    flexDirection: 'column',
    gap: 8,
    flex: '1 1 auto',
    minHeight: 0,
  }
}

/**
 * A chapter's display number: what its frontmatter says, else the tree's.
 *
 * A plain function rather than a `useMemo` beside the other derived values
 * because the foreshadowing actions need it, and they are declared earlier in
 * the component than those values are — a `const` referenced from a hook's
 * dependency array before its declaration is a temporal-dead-zone error, not a
 * style preference.
 * @param snapshot - the project tree, when it has loaded.
 * @param open - the open chapter.
 * @returns the number to print, or 0 when nothing knows it.
 */
function chapterNumberIn(snapshot: ProjectSnapshot | undefined, open: OpenChapter): number {
  const declared = open.data.number
  if (typeof declared === 'number' && Number.isFinite(declared)) return declared
  return snapshot?.volumes.flatMap(volume => volume.chapters)
    .find(chapter => chapter.path === open.path)?.number ?? 0
}

/**
 * The panel body.
 * @param props - framework props; the panel uses `sessionId`.
 */
export function Panel({ sessionId, pickDirectory }: PanelProps) {
  const [root, setRoot] = useState('')
  const [snapshot, setSnapshot] = useState<ProjectSnapshot>()
  const [library, setLibrary] = useState<SettingsLibrary>()
  /** Why the library is not readable, when a read failed — shown beside the picker. */
  const [libraryNote, setLibraryNote] = useState<string>()
  const [section, setSection] = useState<Section>('prose')
  const [open, setOpen] = useState<OpenChapter>()
  const [original, setOriginal] = useState<OpenChapter>()
  /**
   * The one status line.
   *
   * It carries a tone rather than being a bare string because a failure and a
   * success used to be indistinguishable: both were dim grey text, so "已保存"
   * and "保存失败：…" looked the same at a glance and the author had to read
   * every line to know whether the last action worked.
   */
  const [status, setStatus] = useState<Note>({ text: '未打开工程', tone: 'info' })
  /**
   * The last operation that failed, kept so it can be run again.
   *
   * A failed save is the moment re-doing the whole action by hand is most
   * annoying, and the operation is a closure the panel already holds. Cleared by
   * any success, so the button never offers to redo something unrelated.
   *
   * `redo` exists because a retry must not re-run a *stale* operation: the save
   * closure captures the buffer as it was when the failure happened, so retrying
   * after another paragraph would write the older draft. A caller that writes
   * editor state passes a redo which re-derives it from the current render
   * instead; everything else (a fetch, a scan, a rollback to a named version)
   * is the same call either way.
   */
  const [retry, setRetry] = useState<{
    label: string
    operation: () => Promise<string>
    redo?: () => void
  }>()
  /** Whether the shortcut cheat-sheet is open. */
  const [showKeys, setShowKeys] = useState(false)
  const [busy, setBusy] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  /** Projects the author has opened before, newest first. */
  const [recents, setRecents] = useState<RecentProject[]>([])
  /** Whether retired chapters are listed in the tree. */
  const [showArchived, setShowArchived] = useState(false)
  /** A card the retrieval view asked the settings surface to open. */
  const [focusCard, setFocusCard] = useState<{ path: string, token: number }>()
  /** The last consistency report, for the checks surface. */
  const [checkReport, setCheckReport] = useState<CheckReport>()
  /** Whether the open project has been checked at least once. */
  const checkedRef = useRef(false)
  /** The prose editor, so a finding can put the cursor on the sentence it quoted. */
  const bodyRef = useRef<HTMLTextAreaElement | null>(null)
  /** A locate request waiting for the prose section to be on screen. */
  const [locateRequest, setLocateRequest] = useState<{ quote: string, token: number }>()
  /**
   * The document the author is looking at right now, and which surface holds it.
   *
   * Three surfaces edit documents (prose, settings, outline) and each keeps its
   * own open file, so "which document is open" has to be answered in one place:
   * the modification record (M7) reads it to decide whose versions to list, and a
   * locate request needs to know which editor to select in. Without this the
   * history tab showed the *chapter's* record while a card was open — which is
   * exactly the bug the author hit.
   */
  const [activeDoc, setActiveDoc] = useState<{ path: string, surface: 'prose' | 'settings' | 'outline', dirty?: boolean }>()
  /** A locate request bound for the settings editor. */
  const [settingsLocate, setSettingsLocate] = useState<{ quote: string, token: number }>()
  /** A locate request bound for the outline editor. */
  const [outlineLocate, setOutlineLocate] = useState<{ quote: string, token: number }>()
  /** Bumped when the other editors should re-read whatever they have open. */
  const [refreshToken, setRefreshToken] = useState(0)
  /**
   * Bumped to ask a sibling surface to save what it has open.
   *
   * `Ctrl+S` means "save the document I am looking at", and that document may be
   * a card or an outline rather than the chapter — the panel knows *which*
   * surface owns it (`activeDoc`) but not *how* that surface writes it. A token
   * is how the request crosses that seam without lifting three editors' save
   * logic into one place: same shape as `refreshToken`, and for the same reason.
   */
  const [settingsSaveToken, setSettingsSaveToken] = useState(0)
  const [outlineSaveToken, setOutlineSaveToken] = useState(0)
  /** The name being typed for a foreshadowing about to be recorded at the cursor. */
  const [threadDraft, setThreadDraft] = useState('')
  /** Whether the 「记为伏笔」 form is open. */
  const [recordingThread, setRecordingThread] = useState(false)
  /** Which open thread the next 「在这里回收」 collects. */
  const [collecting, setCollecting] = useState('')
  /**
   * One of the sibling surfaces saying which document it has open.
   *
   * Both surfaces mean the same thing by it — "this is what the author is looking
   * at" — and the record view only cares about the latest one, so there is one
   * callback rather than a setter per surface.
   *
   * It bails out when nothing changed, and that is not an optimisation: the
   * reporter fires on every keystroke in those editors (dirty travels with it),
   * and storing a fresh object each time would re-render the panel, which would
   * fire the reporter again.
   */
  const onOpenDocument = useCallback((path: string, surface: 'settings' | 'outline', dirty: boolean) => {
    setActiveDoc(previous => previous !== undefined && previous.path === path
      && previous.surface === surface && previous.dirty === dirty
      ? previous
      : { path, surface, dirty })
  }, [])
  /** Mirror of `recents` for writers, so an update never depends on a stale render. */
  const recentsRef = useRef<RecentProject[]>([])
  /** Guards against writing the same chapter twice at once. */
  const saveRef = useRef(false)
  /**
   * The current "save whatever is open" action.
   *
   * Declared as a ref because `onSave` (which needs it as the redo for a failed
   * save) is defined *before* `saveActive`, and the two cannot depend on each
   * other through `useCallback` deps without a cycle. The ref is filled during
   * render, so by the time a button can be clicked it holds the current one.
   */
  const saveActiveRef = useRef<(() => void) | undefined>(undefined)
  /** Whether this mount has already restored the last project. */
  const restoredRef = useRef(false)
  /**
   * Which task wrote the text currently in the editor, if any.
   *
   * The modification record (M7) stores what produced each version, and the only
   * layer that knows is this one: a task puts text into the buffer, the author
   * presses 保存 later. Cleared on save, so the next version is attributed to
   * whoever writes it next rather than inheriting the label forever.
   */
  const [provenance, setProvenance] = useState<string>()

  /** Replace the remembered list, in state and in storage together. */  const storeRecents = useCallback((next: RecentProject[]) => {
    recentsRef.current = next
    setRecents(next)
    saveRecents(next)
  }, [])

  const rememberRoot = useCallback((value: string) => {
    setRoot(value)
    try {
      globalThis.localStorage?.setItem(ROOT_STORAGE_KEY, value)
    } catch {
      // ignored
    }
  }, [])

  /**
   * Whether the chapter buffer differs from the file.
   *
   * The **whole frontmatter** (`documentChanged`), not a list of remembered
   * fields. This used to compare body/title/status/targetWords only, so adding a
   * referenced card from the picker below left the buffer "unchanged": 保存 stayed
   * disabled, no unsaved-changes prompt fired, and the reference was gone on the
   * next chapter switch. Every editable field has to count.
   */
  const dirty = open !== undefined && original !== undefined && documentChanged(open, original)

  /**
   * Whether the document on screen differs from the file.
   *
   * The panel holds three editable documents and each knows its own dirty state;
   * the footer's 保存 button and `Ctrl+S` both act on "the one the author is
   * looking at", which is `activeDoc` (see M7) rather than the visible tab.
   */
  const activeDirty = activeDoc === undefined
    ? false
    : activeDoc.surface === 'prose' ? dirty : activeDoc.dirty === true

  /**
   * Warn before the page goes away with unsaved text in it.
   *
   * A browser will not show a custom message any more, only its own "leave
   * site?" prompt, and that is still the difference between a lost paragraph and
   * a decision. Switching chapters and cards already asks; closing the tab, the
   * window, or reloading after a rebuild did not ask anything.
   */
  useEffect(() => {
    if (!activeDirty) return
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault()
      // Older engines read `returnValue`; the standard reads `preventDefault`.
      event.returnValue = ''
    }
    globalThis.addEventListener('beforeunload', warn)
    return () => { globalThis.removeEventListener('beforeunload', warn) }
  }, [activeDirty])

  /** Put a message on the status line. */
  const say = useCallback((text: string, tone: NoteTone = 'info') => {
    setStatus({ text, tone })
  }, [])

  /**
   * Run one operation with a shared busy/error surface.
   *
   * Every host call in the panel goes through here, which is what makes the error
   * handling uniform: a failure is coloured, says which action failed, keeps a
   * retry in hand, and names the host's error code, no matter which button
   * produced it.
   * @param label - what the operation is, for the failure line and the retry button.
   * @param operation - the work; its return value becomes the status line.
   * @param redo - how to redo it from current state, when re-running the closure
   *   would use state that has moved on since it was captured.
   */
  const run = useCallback(async (
    label: string,
    operation: () => Promise<string>,
    redo?: () => void,
  ) => {
    setBusy(true)
    try {
      say(await operation())
      setRetry(undefined)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // The host's stable code is worth printing: `novel/outside-project` and
      // `FS_STALE_VERSION` say which layer refused and which rule was hit, which
      // a Chinese sentence alone cannot, and the author is often the person who
      // will read the host's log next. Which codes qualify is `api`'s rule
      // rather than this line's: an `FS_*` refusal is precisely the case a
      // `novel/` prefix test here used to swallow.
      const code = api.errorCodeOf(error)
      say(`${label}失败${code === undefined ? '' : `（${code}）`}：${message}`, 'error')
      setRetry(redo === undefined ? { label, operation } : { label, operation, redo })
    } finally {
      setBusy(false)
    }
  }, [say])

  const effectiveRoot = useCallback(async (): Promise<string> => {
    if (root.trim() !== '') return root.trim()
    const info = await api.ping(sessionId)
    rememberRoot(info.defaultRoot)
    return info.defaultRoot
  }, [rememberRoot, root, sessionId])

  const refresh = useCallback(async (target: string): Promise<ProjectSnapshot> => {
    const next = await api.openProject(sessionId ?? '', target)
    setSnapshot(next)
    return next
  }, [sessionId])

  /**
   * Re-read the settings library.
   *
   * A failure here is **not** swallowed: the picker's list is what the author
   * checks a new card against, and a list that silently stayed stale is
   * indistinguishable from a card that was never created (that is exactly how
   * 「我新建了方衡，加卡里没有」 was reported). The reason travels to the row as a
   * note, and 刷新 beside it retries.
   */
  const reloadLibrary = useCallback(async (): Promise<void> => {
    const target = root.trim()
    if (target === '') return
    try {
      setLibrary(await api.readCards(sessionId ?? '', target))
      setLibraryNote(undefined)
    } catch (error) {
      setLibraryNote(`设定库没读出来：${error instanceof Error ? error.message : String(error)}（点「刷新」再试）`)
    }
  }, [root, sessionId])

  /**
   * Keep the library current while the prose surface is on screen.
   *
   * One small read per chapter switch (the host is local) buys a list that is
   * current whenever the author looks at it — the alternative is a picker that
   * quietly shows yesterday's cards.
   */
  useEffect(() => {
    if (section !== 'prose' || open === undefined) return
    void reloadLibrary()
  }, [open?.path, reloadLibrary, section])

  /**
   * Read one project into the panel and remember it.
   *
   * The single path every way in goes through — 打开, 选择文件夹, a remembered
   * project, the auto-restore on mount — so "which book is open" and "what the
   * panel remembers" cannot drift apart.
   * @param target - absolute project root.
   * @returns a status line for the note area.
   */
  const openRoot = useCallback(async (target: string): Promise<string> => {
    rememberRoot(target)
    const next = await refresh(target)
    setOpen(undefined)
    setOriginal(undefined)
    // A report belongs to the project it was run against.
    setCheckReport(undefined)
    checkedRef.current = false
    storeRecents(rememberProject(recentsRef.current, { root: target, title: next.title, at: Date.now() }))
    // The card library is a second read; failing it must not fail the open — but
    // it must not vanish either, so the reason goes to the picker's note.
    void api.readCards(sessionId ?? '', target).then(
      next => { setLibrary(next); setLibraryNote(undefined) },
      error => {
        setLibraryNote(`设定库没读出来：${error instanceof Error ? error.message : String(error)}（点「刷新」再试）`)
      },
    )
    return `已打开《${next.title}》：${String(next.chapterCount)} 章，${String(next.wordCount)} 字`
  }, [refresh, rememberRoot, sessionId, storeRecents])

  // The panel is the front door to a long book, so it reopens the last project
  // by itself. Only a project that was actually opened is restored — a path that
  // was typed and never read stays text, and never turns into an error on mount.
  useEffect(() => {
    if (restoredRef.current) return
    restoredRef.current = true
    const remembered = loadRecents()
    storeRecents(remembered)
    try {
      const typed = globalThis.localStorage?.getItem(ROOT_STORAGE_KEY)
      if (typed !== null && typed !== undefined && typed !== '') setRoot(typed)
    } catch {
      // A blocked storage API is not worth failing the panel over.
    }
    const last = remembered[0]
    if (last !== undefined) void run('打开上次的工程', async () => await openRoot(last.root))
  }, [openRoot, run, storeRecents])

  // The title box mirrors the project until the author edits it.
  useEffect(() => {
    if (snapshot !== undefined) setTitleDraft(snapshot.title)
  }, [snapshot])

  /**
   * The root every project operation needs.
   *
   * An empty root used to travel to the host and come back as a bare
   * `缺少参数 root`, which says nothing about what to do. The panel refuses it
   * here, with an instruction, and never sends it.
   */
  const projectRoot = useCallback((action: string): string | undefined => {
    const value = root.trim()
    if (value !== '') return value
    say(`${action}前请先点「打开」或「初始化」——工程目录还是空的`)
    return undefined
  }, [root, say])

  /** Everything the three surfaces need from the host. */
  const env: PanelEnv = useMemo(() => ({
    sessionId: sessionId ?? '',
    root: root.trim(),
    busy,
    run,
    note: say,
    error: (text: string) => { say(text, 'error') },
  }), [busy, root, run, say, sessionId])

  const onOpen = useCallback(() => {
    void run('打开工程', async () => await openRoot(await effectiveRoot()))
  }, [effectiveRoot, openRoot, run])

  /** Open one of the remembered projects. */
  const onOpenRecent = useCallback((entry: RecentProject) => {
    void run(`打开《${entry.title}》`, async () => await openRoot(entry.root))
  }, [openRoot, run])

  /** Pick a folder with the shell's own chooser and open it. */
  const onPickFolder = useCallback(() => {
    if (pickDirectory === undefined) {
      say('这个部署没有装目录选择器，请直接在上面填工程路径')
      return
    }
    void run('选择文件夹', async () => {
      const picked = await pickDirectory()
      if (picked === null || picked === '') return '已取消选择'
      return await openRoot(picked)
    })
  }, [openRoot, pickDirectory, run])

  const onCreate = useCallback(() => {
    void run('初始化工程', async () => {
      const target = await effectiveRoot()
      const result = await api.createProject(sessionId ?? '', target, '未命名小说')
      // A project the panel just created is a project it has opened: it goes
      // through the same path, so it lands in the remembered list too.
      const opened = await openRoot(target)
      return `已初始化 ${String(result.created.length)} 个文件（跳过已存在的 ${String(result.skipped.length)} 个）；${opened}`
    })
  }, [effectiveRoot, openRoot, run, sessionId])

  /** Load one chapter by path, whichever surface asked for it. */
  const loadChapter = useCallback((path: string, locate?: string) => {
    // Already here: re-reading would throw away unsaved edits to show the author
    // the same text, so a jump within the open chapter only moves the cursor.
    if (open?.path === path) {
      setSection('prose')
      setActiveDoc({ path, surface: 'prose' })
      if (locate !== undefined) setLocateRequest({ quote: locate, token: Date.now() })
      return
    }
    if (dirty && !globalThis.confirm('当前章节有未保存的修改，放弃并切换？')) return
    void run('打开章节', async () => {
      const loaded = await api.readChapter(sessionId ?? '', root.trim(), path)
      const next: OpenChapter = { path: loaded.path, data: loaded.data, body: loaded.body }
      setOpen(next)
      setOriginal({ ...next, data: { ...next.data } })
      // A different chapter's text did not come from the task that filled this
      // one, so the provenance must not follow the author across the tree.
      setProvenance(undefined)
      setActiveDoc({ path: loaded.path, surface: 'prose' })
      setSection('prose')
      // Set in the same continuation as the new body, so the locate effect sees
      // the chapter that is actually on screen rather than the one it replaced.
      if (locate !== undefined) setLocateRequest({ quote: locate, token: Date.now() })
      return `已打开 ${loaded.path}（${String(loaded.wordCount)} 字）`
    })
  }, [dirty, open, root, run, sessionId])

  /**
   * Take a rolled-back document back into the editor that holds it.
   *
   * M7's rollback is a plain write on the host, so the file is already on disk
   * when this runs. Which buffer to replace depends on the surface: only the
   * prose buffer lives here, and putting a card's text into it would be worse
   * than doing nothing. The other two editors are told to re-read what they have
   * open (`refreshToken`) — leaving their buffer stale would show the author the
   * text the rollback just replaced, which reads as "the rollback failed".
   */
  const onRestored = useCallback((document: LoadedDocument) => {
    if (activeDoc?.surface === 'prose') {
      const next: OpenChapter = { path: document.path, data: document.data, body: document.body }
      setOpen(next)
      setOriginal({ ...next, data: { ...next.data } })
      setProvenance(undefined)
    }
    setRefreshToken(token => token + 1)
    const target = root.trim()
    if (target !== '') void refresh(target)
  }, [activeDoc, refresh, root])

  const onSelect = useCallback((summary: ChapterSummary) => {
    loadChapter(summary.path)
  }, [loadChapter])

  /** The chapter id the open chapter's references use, or empty when none is open. */
  const openChapterId = open === undefined ? '' : chapterIdOfPath(open.path) ?? ''
  /** Every foreshadowing thread in the project — deleted (archived) ones excluded. */
  const threads = useMemo(
    () => liveThreads(library?.groups.flatMap(group => group.cards) ?? []),
    [library],
  )
  /**
   * Threads the author deleted, which the 伏笔 tab no longer lists.
   *
   * Counted so the surface can say where they went: a card that disappears from
   * the only list the author looks at, with no hint, reads as "the panel lost
   * it". They are still in the settings library behind 「显示已存档」, and
   * restoring one brings it back here — and back into the checks.
   */
  const archivedThreads = useMemo(
    () => (library?.groups.flatMap(group => group.cards) ?? [])
      .filter(card => card.type === 'thread' && card.archived).length,
    [library],
  )
  /** The threads that could be collected right now. */
  const openThreads = useMemo(
    () => threads.filter(thread => thread.thread?.status === undefined
      || thread.thread.status === '' || thread.thread.status === 'planted' || thread.thread.status === 'reinforced'),
    [threads],
  )

  /**
   * Record a foreshadowing at whatever the author is pointing at.
   *
   * Three writes, all of them existing routes: the card is created (which gives
   * it the type's section skeleton and `status: planted`), read back for its
   * real body, and written once more with the plant recorded. The card's **body
   * is not touched** — 埋点方式 / 回收设计 are the author's prose, and a panel
   * that filled them in would be writing into the one place the format reserves
   * for a human.
   */
  const recordThread = useCallback(() => {
    const name = threadDraft.trim()
    const target = projectRoot('记伏笔')
    if (target === undefined) return
    if (open === undefined) {
      say('先在正文页打开一章，再记伏笔')
      return
    }
    if (name === '') {
      say('给这条伏笔起个名字（写在伏笔卡的标题上）')
      return
    }
    const quote = pointedText(bodyRef.current, open.body)
    const chapter = openChapterId
    void run('记伏笔', async () => {
      const id = nextThreadId(threads.map(thread => thread.id))
      const created = await api.createCard(sessionId ?? '', target, 'thread', id, name)
      const loaded = await api.readDocument(sessionId ?? '', target, created.path)
      await api.writeDocument(sessionId ?? '', target, created.path, {
        ...loaded.data,
        ...(chapter === '' ? {} : { plantedIn: chapter }),
        ...(quote === '' ? {} : { plantedQuote: quote }),
      }, loaded.body)
      setThreadDraft('')
      setRecordingThread(false)
      await reloadLibrary()
      const at = `第 ${String(chapterNumberIn(snapshot, open))} 章`
      return quote === ''
        ? `已记下伏笔「${name}」：埋点在${at}（没选中句子，只记了章号）`
        : `已记下伏笔「${name}」：埋点在${at} · 「${quote.slice(0, 20)}${quote.length > 20 ? '…' : ''}」`
    })
  }, [open, openChapterId, projectRoot, reloadLibrary, run, sessionId, snapshot, threadDraft, threads])

  /**
   * Mark a thread as paid off where the author is standing.
   *
   * `status` and `payoffIn` are written **together**, which is the whole point of
   * doing this from the panel: M6 reports them disagreeing (`thread-unpaid`), and
   * that check should stay a safety net for hand-edited files rather than a chore
   * the panel makes the author do.
   */
  const collectThread = useCallback(() => {
    const target = projectRoot('回收伏笔')
    if (target === undefined) return
    const thread = openThreads.find(candidate => candidate.id === collecting)
    if (thread === undefined) {
      say('先在上面选一条要回收的伏笔')
      return
    }
    if (open === undefined || openChapterId === '') {
      say('先在正文页打开一章，回收会记在那一章上')
      return
    }
    const quote = pointedText(bodyRef.current, open.body)
    void run('回收伏笔', async () => {
      const loaded = await api.readDocument(sessionId ?? '', target, thread.path)
      const existing = Array.isArray(loaded.data.payoffIn)
        ? (loaded.data.payoffIn as unknown[]).filter((entry): entry is string => typeof entry === 'string')
        : []
      await api.writeDocument(sessionId ?? '', target, thread.path, {
        ...loaded.data,
        status: 'paid',
        payoffIn: [...new Set([...existing, openChapterId])],
        ...(quote === '' ? {} : { payoffQuote: quote }),
      }, loaded.body)
      setCollecting('')
      await reloadLibrary()
      const at = `第 ${String(chapterNumberIn(snapshot, open))} 章`
      return quote === ''
        ? `「${thread.name}」已回收在${at}（没选中句子，只记了章号）`
        : `「${thread.name}」已回收在${at} · 「${quote.slice(0, 20)}${quote.length > 20 ? '…' : ''}」`
    })
  }, [collecting, open, openChapterId, openThreads, projectRoot, reloadLibrary, run, sessionId, snapshot])

  /**
   * Open a setting card in the settings surface, from a search hit.
   *
   * The two surfaces are siblings, so this is the one place a jump crosses
   * between them. The token is what makes a second click on the same card work:
   * the value changes even when the path does not, and the settings view keys
   * its load off the token rather than the path.
   */
  const openCard = useCallback((path: string) => {
    setFocusCard({ path, token: Date.now() })
    setSection('settings')
  }, [])

  /**
   * Ask for a quoted passage to be selected, in whichever editor holds it.
   *
   * The work happens in an effect rather than here because the section has to be
   * on screen first: a `textarea` that is still `display: none` cannot take
   * focus, so selecting before the switch would leave the cursor nowhere. The
   * quote's own surface decides — a card's diff line has to land in the card's
   * editor, not in the chapter buffer, which is a different document entirely.
   */
  const locateQuote = useCallback((quote: string) => {
    const request = { quote, token: Date.now() }
    if (activeDoc?.surface === 'settings') {
      setSection('settings')
      setSettingsLocate(request)
      return
    }
    if (activeDoc?.surface === 'outline') {
      setSection('outline')
      setOutlineLocate(request)
      return
    }
    setSection('prose')
    setLocateRequest(request)
  }, [activeDoc])

  useQuoteLocate(bodyRef, locateRequest, open?.body ?? '', say)

  /**
   * Run the deterministic consistency checks.
   *
   * The report lives here rather than in the view for the same reason the card
   * library does: it belongs to the open project, and a surface that refetches on
   * every mount would scan the whole book each time the author glances at a tab.
   */
  const runChecks = useCallback(() => {
    const target = projectRoot('检查')
    if (target === undefined) return
    checkedRef.current = true
    void run('一致性检查', async () => {
      const found = await api.checkProject(sessionId ?? '', target)
      setCheckReport(found)
      if (found.issues.length === 0) return '一致性检查完成：没有发现问题'
      return `一致性检查完成：${String(found.counts.error)} 错误 · `
        + `${String(found.counts.warn)} 警告 · ${String(found.counts.info)} 提示`
    })
  }, [projectRoot, run, sessionId])

  /** Ignore one finding, or bring it back. */
  const onIgnoreCheck = useCallback((issue: CheckIssue, ignored: boolean) => {
    const target = projectRoot('忽略')
    if (target === undefined) return
    void run(ignored ? '忽略这一条' : '取消忽略', async () => {
      const result = await api.setCheckIgnore(sessionId ?? '', target, issue.key, ignored)
      setCheckReport(result.report)
      return `${ignored ? '已忽略' : '已恢复'}：${issue.title}`
    })
  }, [projectRoot, run, sessionId])

  /** Write the report under `.novel/runs/`. */
  const onSaveCheck = useCallback(() => {
    const target = projectRoot('保存报告')
    if (target === undefined) return
    void run('保存报告', async () =>
      `报告已写入 ${await api.saveCheckReport(sessionId ?? '', target)}`)
  }, [projectRoot, run, sessionId])

  /**
   * Switch surfaces, running the checks the first time the checks tab is opened.
   *
   * A report that only appears after pressing a button is a report the author
   * forgets to ask for; a report re-run on every tab switch is a scan they never
   * asked for. First visit only, and once per project.
   */
  const onSelectSection = useCallback((next: Section) => {
    setSection(next)
    // Coming back to the prose tab means the chapter is what the author is
    // looking at again — or nothing at all, when no chapter is open; the other
    // two surfaces re-report for themselves when they become active. Without
    // this the modification record would keep showing the card you looked at
    // before switching back.
    if (next === 'prose') setActiveDoc(open === undefined ? undefined : { path: open.path, surface: 'prose' })
    if (next !== 'checks' || checkedRef.current || root.trim() === '') return
    checkedRef.current = true
    runChecks()
  }, [open, root, runChecks])

  const onSave = useCallback(() => {
    if (open === undefined || saveRef.current) return
    const target = projectRoot('保存')
    if (target === undefined) return
    saveRef.current = true
    void run('保存', async () => {
      try {
        // The version's provenance travels with the write, so the modification
        // record can say a task wrote this rather than guessing from the text.
        const written = await api.writeChapter(
          sessionId ?? '',
          target,
          open.path,
          open.data,
          open.body,
          provenance === undefined ? undefined : { kind: 'task', label: provenance },
        )
        setOriginal({ ...open, data: { ...open.data } })
        setProvenance(undefined)
        await refresh(target)
        const delta = written.before === null ? '新建' : `${String(written.before.length)} → ${String(written.after.length)} 字节`
        // A save whose undo entry did not get written is a half-failure, and the
        // author is the only one who can decide whether to care.
        const warning = written.warning === undefined ? '' : `｜注意：${written.warning}`
        return `已保存 ${open.path}（${String(written.wordCount)} 字，${delta}）${warning}`
      } finally {
        saveRef.current = false
      }
    }, () => { saveActiveRef.current?.() })
  }, [open, projectRoot, provenance, refresh, run, sessionId])

  /** The live chapters in reading order, which is the order Alt+↑/↓ walks. */
  const chapterOrder = useMemo(
    () => (snapshot?.volumes ?? [])
      .flatMap(volume => volume.chapters)
      .filter(chapter => !chapter.archived)
      .sort((left, right) => left.volume - right.volume || left.number - right.number),
    [snapshot],
  )

  /**
   * Walk the chapter tree, one chapter at a time.
   *
   * The jump goes through {@link loadChapter}, so it inherits the one thing a
   * keyboard shortcut must not lose: the prompt about unsaved edits. A shortcut
   * that bypassed that guard would be a way to lose a paragraph without touching
   * the mouse.
   * @param step - `-1` for the previous chapter, `1` for the next.
   */
  const moveChapter = useCallback((step: -1 | 1) => {
    if (open === undefined) {
      say('还没有打开章节——先在工程树里点一章')
      return
    }
    const at = chapterOrder.findIndex(chapter => chapter.path === open.path)
    if (at < 0) {
      say('这一章不在工程树里（可能已存档）——先打开一章再翻')
      return
    }
    const target = chapterOrder[at + step]
    if (target === undefined) {
      say(step < 0 ? '已经是第一章了' : '已经是最后一章了')
      return
    }
    loadChapter(target.path)
  }, [chapterOrder, loadChapter, open, say])

  /**
   * Save whichever document the author is looking at.
   *
   * `Ctrl+S` and the footer's 保存 button are the same action, which is why this
   * exists rather than the shortcut calling `onSave` directly: half the author's
   * saved work is cards and outlines, and a "save" key that silently saved a
   * different file than the one on screen would be worse than no key at all.
   */
  const saveActive = useCallback(() => {
    if (activeDoc === undefined) {
      say('还没有打开任何文档——先在工程树或设定库里点一份，再保存')
      return
    }
    if (activeDoc.surface === 'settings') {
      setSettingsSaveToken(token => token + 1)
      return
    }
    if (activeDoc.surface === 'outline') {
      setOutlineSaveToken(token => token + 1)
      return
    }
    onSave()
  }, [activeDoc, onSave, say])
  saveActiveRef.current = saveActive

  /**
   * Act on one keystroke, if it is one this panel binds.
   *
   * The handler lives on the panel root, so a key only ever means something while
   * the author's focus is inside the panel: the shell's own shortcuts (and the
   * browser's) stay untouched everywhere else, which is the whole reason this
   * plugin does not register a global listener.
   */
  const onKeyDown = useCallback((event: {
    key: string
    ctrlKey: boolean
    altKey: boolean
    shiftKey: boolean
    metaKey: boolean
    preventDefault: () => void
  }) => {
    const action = actionFor(event)
    if (action === undefined) return
    // Every binding is ours once matched — including the save key, whose browser
    // default is an OS "save page" dialog that must not appear over the editor.
    event.preventDefault()
    if (action === 'save') {
      saveActive()
      return
    }
    if (action === 'prev-chapter') {
      moveChapter(-1)
      return
    }
    if (action === 'next-chapter') {
      moveChapter(1)
      return
    }
    if (action === 'cancel') {
      if (recordingThread) {
        setRecordingThread(false)
        setThreadDraft('')
        say('已关掉「记为伏笔」表单')
      } else if (status.tone === 'error') {
        say('已清掉失败提示')
      }
      return
    }
    if (action.startsWith('section:')) {
      // The action id *is* the section id (`section:checks`), so the mapping
      // cannot drift from `PANEL_SECTIONS` — it is derived from it.
      onSelectSection(action.slice('section:'.length) as Section)
    }
  }, [moveChapter, onSelectSection, recordingThread, saveActive, say, status.tone])

  /** Rename the book in `novel.yaml`, leaving every other field in that file alone. */
  const onRename = useCallback(() => {
    const target = projectRoot('改名')
    if (target === undefined) return
    const title = titleDraft.trim()
    if (title === '') {
      say('书名不能为空')
      return
    }
    void run('改名', async () => {
      const meta = await api.writeMeta(sessionId ?? '', target, { title })
      await refresh(target)
      return `书名已改为《${meta.title}》`
    })
  }, [projectRoot, refresh, run, sessionId, titleDraft])

  const onAddChapter = useCallback(() => {
    const target = projectRoot('新建章节')
    if (target === undefined) return
    void run('新建章节', async () => {
      const volume = snapshot?.volumes.at(-1)?.volume ?? 1
      const created = await api.createChapter(sessionId ?? '', target, { volume, title: '新章节' })
      await refresh(target)
      const loaded = await api.readChapter(sessionId ?? '', target, created.path)
      const next: OpenChapter = { path: loaded.path, data: loaded.data, body: loaded.body }
      setOpen(next)
      setOriginal({ ...next, data: { ...next.data } })
      return `已新建 ${created.path}`
    })
  }, [projectRoot, refresh, run, sessionId, snapshot])

  /**
   * Retire the open chapter, or put it back.
   *
   * This is the panel's "delete", and the reason it is not a deletion is the
   * filesystem seam: `ctx.fs` has no primitive that removes anything (resolve,
   * stat, list, read, write, edit — that is the whole surface, and DSH's file
   * tools are the same), while the sandbox policy is the author's own statement
   * about their files, so reaching for `node:fs` is not an option. Marking the
   * chapter takes it out of the tree and out of every task's story material
   * while its id, its number and its words stay exactly where they were, and
   * the archive is one click from being undone.
   */
  const onToggleArchive = useCallback(() => {
    if (open === undefined) return
    const archived = open.data.archived === true
    if (!archived) {
      const title = field(open.data, 'title')
      const go = globalThis.confirm(
        `把「${title === '' ? open.path : title}」标为已存档？\n`
        + '它会从章节树里消失，也不再作为续写的上一章；文件保留，随时可以恢复。',
      )
      if (!go) return
    }
    const target = projectRoot(archived ? '恢复章节' : '存档章节')
    if (target === undefined) return
    void run(archived ? '恢复章节' : '存档章节', async () => {
      const data = { ...open.data }
      if (archived) delete data.archived
      else data.archived = true
      const written = await api.writeChapter(sessionId ?? '', target, open.path, data, open.body)
      setOpen({ ...open, data })
      setOriginal({ ...open, data: { ...data } })
      await refresh(target)
      return archived
        ? `已恢复 ${open.path}（${String(written.wordCount)} 字）`
        : `已存档 ${open.path}：树里不再显示，勾「显示已存档」可以找回`
    })
  }, [open, projectRoot, refresh, run, sessionId])

  const edit = useCallback((patch: Partial<Record<'title' | 'status' | 'targetWords', string>>) => {    setOpen(previous => {
      if (previous === undefined) return previous
      const data = { ...previous.data }
      if (patch.title !== undefined) data.title = patch.title
      if (patch.status !== undefined) data.status = patch.status
      if (patch.targetWords !== undefined) {
        // Clearing the field deletes the key: `undefined` in the mapping would
        // serialize as a value the author never typed.
        if (patch.targetWords === '') delete data.targetWords
        else data.targetWords = Number(patch.targetWords)
      }
      return { ...previous, data }
    })
  }, [])

  /** Every setting card in the library, by id — what a reference chip resolves against. */
  const cardsById = useMemo(
    () => new Map((library?.groups ?? []).flatMap(group => group.cards).map(card => [card.id, card])),
    [library],
  )

  /**
   * The cards this chapter is written against, as chips.
   *
   * All three reference fields, in format order, so a card attached from the
   * outline page (by id) shows up here exactly like one attached from this row. A
   * card the library does not know is still listed: the file says it is
   * referenced, and hiding it would hide a `missing-ref` the author has to fix.
   */
  const chapterCards = useMemo(() => {
    const fields: ChapterRefField[] = ['characters', 'locations', 'refs']
    return fields.flatMap(field => refsOf(open?.data ?? {}, field)
      .map(id => ({ id, field, card: cardsById.get(id) })))
  }, [cardsById, open])

  /**
   * Attach one card to the open chapter, in the field its type belongs to.
   *
   * Routed by type (`chapterRefFieldOf`) rather than by "what the author meant":
   * a character card in `characters` is what 出场 means to `pov-unlisted` and to
   * retrieval's "who appears in which chapter". Every writing task reads all
   * three fields, so wherever the id lands, the next 续写 / 改写 / 扩写 sees it.
   */
  const attachCard = useCallback((id: string) => {
    const card = cardsById.get(id)
    if (card === undefined) return
    const field = chapterRefFieldOf(card.type)
    setOpen(previous => {
      if (previous === undefined) return previous
      const ids = refsOf(previous.data, field)
      if (ids.includes(id)) return previous
      return { ...previous, data: { ...previous.data, [field]: [...ids, id] } }
    })
    say(`已把「${card.name}」记为本章引用——生成任务会带上它，保存后落盘`)
  }, [cardsById, say])

  /**
   * Detach one card from the open chapter.
   *
   * An emptied field is written as `[]`, which is what the scaffold and the
   * outline editor write — an absent key would be a third shape for the same
   * fact.
   */
  const detachCard = useCallback((id: string, field: ChapterRefField) => {
    setOpen(previous => {
      if (previous === undefined) return previous
      const ids = refsOf(previous.data, field).filter(entry => entry !== id)
      return { ...previous, data: { ...previous.data, [field]: ids } }
    })
  }, [])

  /**
   * The chapters this chapter attaches by hand, in the order the file lists them.
   *
   * `contextChapters` is the chapter-side twin of the three card fields above,
   * and it is read the same tolerant way: a hand-written scalar is one id.
   */
  const contextChapters = useMemo(
    () => refsOf(open?.data ?? {}, 'contextChapters'),
    [open],
  )

  /**
   * Attach one chapter to the open chapter as 参考章节.
   *
   * The id written is the chapter summary's id — the frontmatter `id` when it has
   * one — and task assembly resolves it against every chapter, by that id or by
   * the one the filename encodes, so the two halves cannot disagree about what
   * the author picked.
   */
  const attachContextChapter = useCallback((id: string) => {
    const chapter = snapshot?.volumes.flatMap(volume => volume.chapters)
      .find(item => item.id === id)
    setOpen(previous => {
      if (previous === undefined) return previous
      const ids = refsOf(previous.data, 'contextChapters')
      if (ids.includes(id)) return previous
      return { ...previous, data: { ...previous.data, contextChapters: [...ids, id] } }
    })
    say(`已把「${chapter === undefined ? id : `第 ${String(chapter.number)} 章 ${chapter.title}`}」记为参考章节——生成任务会带上它的全文，保存后落盘`)
  }, [say, snapshot])

  /** Detach one chapter from the open chapter. */
  const detachContextChapter = useCallback((id: string) => {
    setOpen(previous => {
      if (previous === undefined) return previous
      const ids = refsOf(previous.data, 'contextChapters').filter(entry => entry !== id)
      return { ...previous, data: { ...previous.data, contextChapters: ids } }
    })
  }, [])

  /** Take a generated chapter body into the editor buffer, still unsaved. */
  const onProse = useCallback((text: string, apply: 'append' | 'replace', label: string) => {
    setOpen(previous => {
      if (previous === undefined) return previous
      const body = apply === 'append'
        ? `${previous.body.replace(/\s+$/, '')}\n\n${text.trim()}\n`
        : `${text.trim()}\n`
      return { ...previous, body }
    })
    setSection('prose')
    setProvenance(label)
    say(`已采纳「${label}」到编辑器，确认后点保存落盘`)
  }, [say])

  const words = useMemo(() => (open === undefined ? 0 : countWords(open.body)), [open])
  /**
   * What to call the document the modification record is showing.
   *
   * Derived rather than stored: a card's name is editable in its own surface, so
   * a title captured when it was opened would go stale the moment the author
   * renamed it — which is exactly the kind of edit they are about to look up.
   */
  const activeTitle = useMemo(() => {
    if (activeDoc === undefined) return ''
    if (activeDoc.surface === 'prose') return field(open?.data ?? {}, 'title') || activeDoc.path
    const card = library?.groups.flatMap(group => group.cards).find(item => item.path === activeDoc.path)
    return card?.name ?? activeDoc.path
  }, [activeDoc, library, open])
  const openVolume = useMemo(() => {
    const declared = open?.data.volume
    if (typeof declared === 'number' && Number.isFinite(declared)) return declared
    return snapshot?.volumes.at(-1)?.volume ?? 1
  }, [open, snapshot])

  /** Assemble a chapter task against the current buffer, not the file on disk. */
  const chapterContext = useCallback((): TaskContext => {
    const target = root.trim()
    return {
      sessionId: sessionId ?? '',
      root: target,
      meta: {
        title: snapshot?.title ?? '未命名小说',
        ...(snapshot?.genre === undefined ? {} : { genre: snapshot.genre }),
        ...(snapshot?.targetWords === undefined ? {} : { targetWords: snapshot.targetWords }),
      },
      volumes: snapshot?.volumes ?? [],
      ...(open === undefined
        ? {}
        : { chapter: { path: open.path, data: open.data, body: open.body, wordCount: countWords(open.body), version: '' } }),
      volume: openVolume,
      ...(library === undefined ? {} : { cards: library.groups.flatMap(group => group.cards) }),
      // The model check excludes what the rules already said; handing the report
      // over is what makes "先确定性、后模型" true in practice rather than in prose.
      ...(checkReport === undefined ? {} : { checks: checkReport }),
    }
  }, [checkReport, library, open, openVolume, root, sessionId, snapshot])

  return (
    <div style={wrap} onKeyDown={onKeyDown}>
      <div style={row}>
        <input
          style={{ ...input, flex: '1 1 160px' }}
          value={root}
          placeholder="小说工程目录（留空则用会话工作区下的 novel/）"
          onChange={event => { rememberRoot(event.target.value) }}
        />
        <button
          type="button"
          style={button}
          title={pickDirectory === undefined ? '这个部署没有装目录选择器' : '用系统的文件夹选择器挑一个工程目录'}
          disabled={busy}
          onClick={onPickFolder}
        >
          选择文件夹
        </button>
        <button type="button" style={button} disabled={busy} onClick={onOpen}>打开</button>
        <button type="button" style={button} disabled={busy} onClick={onCreate}>初始化</button>
      </div>

      {/* One button per project the author has opened before, newest first. */}
      {recents.length > 0 && (
        <div style={{ ...row, fontSize: 11 }}>
          <span style={caption}>打开过：</span>
          {recents.map(entry => (
            <button
              key={entry.root}
              type="button"
              style={{
                ...button,
                padding: '1px 6px',
                fontWeight: root.trim() === entry.root ? 600 : 400,
              }}
              title={entry.root}
              disabled={busy}
              onClick={() => { onOpenRecent(entry) }}
            >
              {recentLabel(entry)}
            </button>
          ))}
        </div>
      )}

      <div style={row}>
        {SECTIONS.map(item => (
          <button
            key={item.id}
            type="button"
            style={{ ...button, fontWeight: section === item.id ? 600 : 400 }}
            title={`${item.label}（${shortcutLabel(`section:${item.id}`) ?? ''}）`}
            onClick={() => { onSelectSection(item.id) }}
          >
            {item.label}
          </button>
        ))}
        <button
          type="button"
          style={{ ...button, padding: '1px 6px', fontSize: 11 }}
          title="这个面板认哪些键"
          onClick={() => { setShowKeys(value => !value) }}
        >
          快捷键
        </button>
      </div>

      {/* The cheat-sheet is rendered from the bindings themselves, so it cannot
          describe a key the panel no longer listens for. */}
      {showKeys && (
        <div style={{ ...box, maxHeight: 160 }}>
          {shortcutHelp().map(entry => (
            <div key={entry.keys} style={{ ...row, justifyContent: 'space-between' }}>
              <span>{entry.description}</span>
              <span style={caption}>{entry.keys}</span>
            </div>
          ))}
          <div style={metaLine}>
            键只在焦点位于这个面板里时生效；正文编辑器里的 Ctrl+Z 仍然是浏览器自己的逐字撤销，
            回滚在「修改记录」页签里。
          </div>
        </div>
      )}

      <div style={box}>
        {snapshot === undefined
          ? <div style={metaLine}>尚未打开工程。点「选择文件夹」挑一个目录后「打开」，或「初始化」新建一本；打开过的工程下次会自动回来。</div>
          : (
            <>
              <div style={{ ...row, justifyContent: 'space-between' }}>
                <input
                  style={{ ...input, flex: '1 1 120px' }}
                  value={titleDraft}
                  placeholder="书名"
                  onChange={event => { setTitleDraft(event.target.value) }}
                />
                <span style={row}>
                  <button
                    type="button"
                    style={button}
                    disabled={busy || titleDraft.trim() === '' || titleDraft.trim() === snapshot.title}
                    onClick={onRename}
                  >
                    改名
                  </button>
                  <button type="button" style={button} disabled={busy} onClick={onAddChapter}>+ 新建章节</button>
                </span>
              </div>
              <div style={{ ...row, justifyContent: 'space-between' }}>
                <span style={caption}>
                  {snapshot.genre ?? '未设体裁'} · {String(snapshot.chapterCount)} 章 · {String(snapshot.wordCount)} 字
                  {snapshot.targetWords === undefined ? '' : ` / 目标 ${String(snapshot.targetWords)} 字`}
                  {snapshot.archivedCount === 0
                    ? ''
                    : ` · 已存档 ${String(snapshot.archivedCount)} 章 / ${String(snapshot.archivedWords)} 字`}
                </span>
                {snapshot.archivedCount > 0 && (
                  <label style={checkLine}>
                    <input
                      type="checkbox"
                      checked={showArchived}
                      onChange={event => { setShowArchived(event.target.checked) }}
                    /> 显示已存档
                  </label>
                )}
              </div>
              {snapshot.volumes.map(volume => {
                const chapters = volume.chapters.filter(chapter => showArchived || !chapter.archived)
                if (chapters.length === 0) return null
                return (
                  <div key={volume.dir} style={{ marginTop: 6 }}>
                    <div style={metaLine}>
                      第 {String(volume.volume)} 卷 · {String(chapters.length)} 章 ·
                      {' '}{String(chapters.reduce((sum, item) => sum + item.wordCount, 0))} 字
                    </div>
                    {chapters.map(chapter => (
                      <button
                        key={chapter.path}
                        type="button"
                        title={chapter.archived ? `${chapter.path}（已存档，可恢复）` : chapter.path}
                        style={{
                          ...listRow,
                          background: open?.path === chapter.path
                            ? 'color-mix(in srgb, currentColor 12%, transparent)'
                            : 'transparent',
                          opacity: chapter.archived ? 0.5 : 1,
                        }}
                        onClick={() => { onSelect(chapter) }}
                      >
                        <span>
                          第 {String(chapter.number)} 章 {chapter.title}
                          {chapter.archived ? ' · 已存档' : ''}
                        </span>
                        <span style={{ opacity: 0.65 }}>
                          {STATUS_LABEL[chapter.status]} · {String(chapter.wordCount)} 字
                          {chapter.beats.length === 0 ? '' : ` · 要点 ${String(chapter.beats.length)}`}
                        </span>
                      </button>
                    ))}
                  </div>
                )
              })}
            </>
          )}
      </div>

      {/* 正文 */}
      <div style={sectionStyle(section === 'prose')}>
        {open !== undefined && (
          <>
            <div style={row}>
              <input
                style={{ ...input, flex: '1 1 120px' }}
                value={field(open.data, 'title')}
                placeholder="章节标题"
                onChange={event => { edit({ title: event.target.value }) }}
              />
              <select
                style={input}
                value={field(open.data, 'status') === '' ? 'draft' : field(open.data, 'status')}
                onChange={event => { edit({ status: event.target.value }) }}
              >
                {(Object.keys(STATUS_LABEL) as ChapterStatus[]).map(status => (
                  <option key={status} value={status}>{STATUS_LABEL[status]}</option>
                ))}
              </select>
              <input
                style={{ ...input, width: 76 }}
                value={field(open.data, 'targetWords')}
                placeholder="目标字数"
                inputMode="numeric"
                onChange={event => { edit({ targetWords: event.target.value }) }}
              />
            </div>
            {open.data.archived === true && (
              <div style={metaLine}>
                这一章已存档：树里不显示，也不会被当成续写的上一章。下面「恢复本章」可以取消。
              </div>
            )}
            <textarea
              ref={bodyRef}
              style={textarea}
              value={open.body}
              placeholder="正文。章纲要点在「大纲」页编辑；生成任务会按要点写整章。"
              onChange={event => { setOpen({ ...open, body: event.target.value }) }}
            />
            {/* Foreshadowing, both ends of it, where the prose is (M7-adjacent:
                the record is only useful if you can get back to the sentence). */}
            <div style={controlRow}>
              <span style={caption}>
                伏笔：把光标放到某一句上，再记或收
                {openThreads.length === 0 ? '' : ` · 未回收 ${String(openThreads.length)} 条`}
              </span>
              <span style={row}>
                <button type="button" style={button} disabled={busy}
                  title="把光标所在的那一句（或选中的一段）记为一条伏笔的埋点"
                  onClick={() => { setRecordingThread(value => !value) }}>
                  记为伏笔
                </button>
                <select
                  style={input}
                  value={collecting}
                  disabled={busy || openThreads.length === 0}
                  onChange={event => { setCollecting(event.target.value) }}
                >
                  <option value="">{openThreads.length === 0 ? '没有未回收的伏笔' : '选一条伏笔…'}</option>
                  {openThreads.map(thread => (
                    <option key={thread.id} value={thread.id}>{thread.name}</option>
                  ))}
                </select>
                <button type="button" style={button} disabled={busy || collecting === ''}
                  title="把这一章记为它的回收章，并同时把状态改成已回收"
                  onClick={collectThread}>
                  在这里回收
                </button>
              </span>
            </div>
            {recordingThread && (
              <div style={row}>
                <input
                  style={{ ...input, flex: '1 1 160px' }}
                  value={threadDraft}
                  placeholder="这条伏笔叫什么（如 半块青铜镜的来历）"
                  onChange={event => { setThreadDraft(event.target.value) }}
                  onKeyDown={event => { if (event.key === 'Enter') recordThread() }}
                />
                <span style={caption}>
                  埋点记在「{open.path}」{pointedText(bodyRef.current, open.body) === '' ? '（正文里没东西可记）' : ''}
                </span>
                <button type="button" style={button} disabled={busy} onClick={recordThread}>记下</button>
                <button type="button" style={button} disabled={busy}
                  onClick={() => { setRecordingThread(false); setThreadDraft('') }}>
                  取消
                </button>
              </div>
            )}
            {/* The cards this chapter is written against — attached here, where the
                tasks that use them are. Routed by card type into frontmatter
                (`chapterRefFieldOf`), so this row and the outline page's id fields
                are two views of one thing. */}
            <ChapterCards
              env={env}
              {...(library === undefined ? {} : { groups: library.groups })}
              attached={chapterCards}
              onAttach={attachCard}
              onDetach={detachCard}
              onRefresh={() => { void reloadLibrary() }}
              {...(libraryNote === undefined ? {} : { note: libraryNote })}
            />
            {/* The chapters this chapter is written against — the previous one is
                automatic, and these are the ones only the author knows about. */}
            <ChapterContext
              env={env}
              volumes={snapshot?.volumes ?? []}
              {...(open === undefined ? {} : { openPath: open.path })}
              attached={contextChapters}
              onAttach={attachContextChapter}
              onDetach={detachContextChapter}
            />
            <TaskBar
              env={env}
              tasks={CHAPTER_TASKS}
              context={chapterContext}
              volume={openVolume}
              onProse={onProse}
              onDocument={() => { env.note('正文任务不会改大纲文件') }}
              onCreateChapters={() => { env.note('正文任务不会新建章节') }}
              onLocate={locateQuote}
            />
          </>
        )}
      </div>

      {/* 伏笔 */}
      <div style={sectionStyle(section === 'threads')}>
        {snapshot !== undefined && (
          <ThreadsView
            env={env}
            threads={threads}
            archived={archivedThreads}
            chapters={snapshot.volumes.flatMap(volume => volume.chapters)}
            onJump={loadChapter}
            onOpenCard={openCard}
            onReload={reloadLibrary}
            {...(open === undefined ? {} : { openChapter: open.path })}
          />
        )}
      </div>

      {/* 设定 */}
      <div style={sectionStyle(section === 'settings')}>
        {snapshot !== undefined && (
          <SettingsView
            env={env}
            library={library}
            chapters={snapshot.volumes.flatMap(volume => volume.chapters)}
            onReload={reloadLibrary}
            onOpenChapter={loadChapter}
            active={section === 'settings'}
            refreshToken={refreshToken}
            saveToken={settingsSaveToken}
            onOpenDocument={onOpenDocument}
            {...(focusCard === undefined ? {} : { focus: focusCard })}
            {...(settingsLocate === undefined ? {} : { locate: settingsLocate })}
          />
        )}
      </div>

      {/* 大纲 */}
      <div style={sectionStyle(section === 'outline')}>
        {snapshot !== undefined && (
          <OutlineView
            env={env}
            snapshot={snapshot}
            {...(library === undefined ? {} : { cards: library.groups.flatMap(group => group.cards) })}
            onOpenChapter={loadChapter}
            onChanged={async () => { await refresh(root.trim()) }}
            active={section === 'outline'}
            refreshToken={refreshToken}
            saveToken={outlineSaveToken}
            onOpenDocument={onOpenDocument}
            {...(outlineLocate === undefined ? {} : { locate: outlineLocate })}
          />
        )}
      </div>

      {/* 检索 */}
      <div style={sectionStyle(section === 'search')}>
        {snapshot !== undefined && (
          <SearchView
            env={env}
            chapters={snapshot.volumes.flatMap(volume => volume.chapters)}
            onOpenChapter={loadChapter}
            onOpenCard={openCard}
          />
        )}
      </div>

      {/* 检查 */}
      <div style={sectionStyle(section === 'checks')}>
        {snapshot !== undefined && (
          <>
            <ChecksView
              env={env}
              {...(checkReport === undefined ? {} : { report: checkReport })}
              chapters={snapshot.volumes.flatMap(volume => volume.chapters)}
              onRun={runChecks}
              onIgnore={onIgnoreCheck}
              onSave={onSaveCheck}
              onOpenChapter={loadChapter}
              onOpenCard={openCard}
            />
            {/* The rules layer needs no model; this one does, and it reads one
                chapter. Saying which chapter out loud is what keeps the report's
                reach knowable. */}
            {open === undefined
              ? (
                <div style={metaLine}>
                  模型检查按「当前打开的章节」跑：先在「正文」页打开一章，再回到这里。
                </div>
              )
              : (
                <>
                  <div style={metaLine}>
                    模型检查（第 {String(openVolume)} 卷 · {field(open.data, 'title') || open.path}）：
                    把这一章的正文与它引用的设定卡、世界观硬约束交给模型，只报能指出依据的矛盾；不会改动任何文件。
                  </div>
                  <TaskBar
                    env={env}
                    tasks={CHECK_TASKS}
                    context={chapterContext}
                    volume={openVolume}
                    onProse={() => { env.note('模型检查不会改正文') }}
                    onDocument={() => { env.note('模型检查不会改大纲') }}
                    onCreateChapters={() => { env.note('模型检查不会新建章节') }}
                  />
                </>
              )}
          </>
        )}
      </div>

      {/* 修改记录（M7） */}
      <div style={sectionStyle(section === 'history')}>
        <HistoryView
          env={env}
          {...(activeDoc === undefined ? {} : { path: activeDoc.path })}
          title={activeTitle}
          active={section === 'history'}
          dirty={activeDirty}
          onRestored={onRestored}
          onLocate={locateQuote}
        />
      </div>

      {/* 导出（P5） */}
      <div style={sectionStyle(section === 'export')}>
        {snapshot !== undefined && (
          <ExportView
            env={env}
            snapshot={snapshot}
            {...(open === undefined
              ? {}
              : {
                  openChapter: {
                    path: open.path,
                    title: field(open.data, 'title'),
                    number: chapterNumberIn(snapshot, open),
                    dirty,
                  },
                })}
          />
        )}
      </div>

      <div style={{ ...row, justifyContent: 'space-between' }}>
        <span style={metaLine}>
          {open === undefined ? '未打开章节' : `${open.path} · ${String(words)} 字${dirty ? ' · 有未保存修改' : ''}`}
        </span>
        <span style={row}>
          {open !== undefined && (
            <button
              type="button"
              style={button}
              title="面板里的「删除」：文件保留，标记为已存档，可随时恢复"
              disabled={busy}
              onClick={onToggleArchive}
            >
              {open.data.archived === true ? '恢复本章' : '存档本章'}
            </button>
          )}
          <button
            type="button"
            style={button}
            title={`保存当前文档${shortcutLabel('save') === undefined ? '' : `（${String(shortcutLabel('save'))}）`}`
              + `${activeDoc === undefined ? '' : `：${activeTitle}`}`}
            disabled={busy || activeDoc === undefined || !activeDirty}
            onClick={saveActive}
          >
            保存
          </button>
        </span>
      </div>
      {/* The status line, with its tone. The text is dim on purpose (it is not a
          control), which is exactly why the failure state needs its own colour:
          two messages that differ only in wording are read the same way at a
          glance. The retry button is a sibling of the dimmed span, never a child
          — `opacity` is inherited and would dim the control too. */}
      <div style={{ ...row, minHeight: 16, alignItems: 'flex-start' }}>
        <span style={{ ...metaLine, ...(status.tone === 'error' ? { color: ERROR_COLOR, opacity: 1 } : {}) }}>
          {busy ? '处理中…' : status.text}
        </span>
        {status.tone === 'error' && retry !== undefined && (
          <button
            type="button"
            style={{ ...button, padding: '1px 6px', fontSize: 11 }}
            title={`再跑一次「${retry.label}」`}
            disabled={busy}
            onClick={() => {
              // A redo re-derives the action from the current render; only the
              // operations with nothing to re-derive fall back to the closure.
              if (retry.redo === undefined) void run(retry.label, retry.operation)
              else retry.redo()
            }}
          >
            重试
          </button>
        )}
      </div>
    </div>
  )
}
