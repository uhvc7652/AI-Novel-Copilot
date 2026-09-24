/**
 * The outline view: the book line, the volume outline, and one chapter's beats.
 *
 * Format S1 puts a chapter's beats in *its own* frontmatter rather than in a
 * separate outline file, so this view edits chapter files — the same document
 * the prose view edits, through the same route. That is the point of the
 * decision: the plan and what was written from it live in one file and cannot
 * disagree.
 *
 * Outline tasks land here too, and their results always arrive as a buffer:
 * "续写卷纲" fills the volume-outline editor, and the author's save is what
 * writes the file (D9).
 *
 * @module dsh-ai-novel-copilot/client/OutlineView
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { BOOK_OUTLINE_FILE, volumeOutlinePath, volumeOutlineSkeleton } from '../novel/paths.ts'
import { documentChanged } from '../novel/buffer.ts'
import type { CardSummary, ChapterSummary, ProjectSnapshot } from '../novel/project.ts'
import type { PlanChapter } from './plan.ts'
import * as api from './api.ts'
import { OUTLINE_TASKS, type TaskContext } from './tasks.ts'
import { TaskBar } from './TaskBar.tsx'
import {
  box,
  button,
  input,
  listRow,
  metaLine,
  row,
  STATUS_LABEL,
  textarea,
  type PanelEnv,
} from './ui.ts'
import { useQuoteLocate } from './locate.ts'
import { ListField } from './ListField.tsx'
import { createNextVolume, createdVolumeNote, nextVolumeNumber } from './volumes.ts'

/** Props for the outline view. */
export interface OutlineViewProps {
  /** Shared panel environment. */
  env: PanelEnv
  /** The project tree, which carries every chapter's beats and summary. */
  snapshot: ProjectSnapshot
  /** Setting cards, so a planning prompt can name real ids. */
  cards?: readonly CardSummary[]
  /** Open a chapter in the prose view. */
  onOpenChapter(path: string): void
  /** Re-read the project tree after chapters were created. */
  onChanged(): Promise<void>
  /** Whether this surface is the one on screen, which is when it owns "the open document". */
  active: boolean
  /** Bumped by the panel when this editor should re-read the outline it has open. */
  refreshToken?: number
  /**
   * Bumped by the panel when `Ctrl+S` means this surface's document rather than
   * the chapter. Which of the two editors it saves is decided by `which` — the
   * one on screen — so the key saves what the author is looking at.
   */
  saveToken?: number
  /** Tell the panel which document this surface has open, so M7's record view follows it. */
  onOpenDocument?(path: string, surface: 'outline', dirty: boolean): void
  /** A passage to select in the outline editor, from a diff line. */
  locate?: { quote: string, token: number }
}

/** A document open in one of the editors. */
interface OpenDoc {
  path: string
  data: Record<string, unknown>
  body: string
  original: { data: Record<string, unknown>, body: string }
  exists: boolean
}

/** Which outline is on screen. */
type Which = 'book' | 'volume' | 'chapter'

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
 * The parsing moved into `ListField` (which keeps the comma the author typed),
 * so this only has to answer "what are the labels".
 * @param data - frontmatter data.
 * @param key - field name.
 * @returns the labels.
 */
function listOf(data: Record<string, unknown>, key: string): string[] {
  const value = data[key]
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string')
  return typeof value === 'string' && value.trim() !== '' ? [value] : []
}

/** The beats of a chapter document, as a mutable list. */
function beatsOf(data: Record<string, unknown>): string[] {
  const value = data.beats
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/**
 * The outline view.
 * @param props - environment, the tree, the cards, and the navigation hooks.
 */
export function OutlineView({ env, snapshot, cards, onOpenChapter, onChanged, active, refreshToken, saveToken, onOpenDocument, locate }: OutlineViewProps) {
  const lastVolume = snapshot.volumes.at(-1)?.volume ?? 1
  const [which, setWhich] = useState<Which>('volume')
  const [volume, setVolume] = useState(lastVolume)
  const [outline, setOutline] = useState<OpenDoc>()
  const [chapter, setChapter] = useState<OpenDoc>()
  /** The outline editor, for a diff line to put the cursor on. */
  const outlineRef = useRef<HTMLTextAreaElement | null>(null)

  useQuoteLocate(outlineRef, locate, outline?.body ?? '', env.note)

  /**
   * Re-read the open outline when the panel says the file changed underneath us.
   *
   * A rollback writes to disk without going through this editor; without this the
   * buffer would keep showing the text that was just replaced.
   */
  const refreshSeen = useRef(refreshToken)
  useEffect(() => {
    if (refreshToken === undefined || refreshToken === refreshSeen.current) return
    refreshSeen.current = refreshToken
    const current = which === 'chapter' ? chapter : outline
    if (current === undefined) return
    const path = current.path
    void (async () => {
      try {
        const loaded = await api.readDocument(env.sessionId, env.root, path)
        const next: OpenDoc = {
          path: loaded.path,
          data: loaded.data,
          body: loaded.body,
          original: { data: { ...loaded.data }, body: loaded.body },
          exists: true,
        }
        if (which === 'chapter') setChapter(next)
        else setOutline(next)
      } catch {
        // The file may be gone; keeping the buffer beats blanking the editor.
      }
    })()
  }, [chapter, env, outline, refreshToken, which])

  /**
   * Load the outline the current tab shows.
   *
   * This is a background read, not a user action, so it does not take the busy
   * flag or overwrite the note line on success — the note line belongs to what
   * the author just did. The editor follows the tab and the volume, and an
   * unsaved buffer is never replaced by a refresh: the path guard is what stops
   * that.
   */
  useEffect(() => {
    if (which === 'chapter') return
    const path = which === 'book' ? BOOK_OUTLINE_FILE : volumeOutlinePath(volume)
    if (outline?.path === path) return
    let cancelled = false
    void (async () => {
      try {
        const loaded = await api.readDocument(env.sessionId, env.root, path)
        if (cancelled) return
        setOutline({
          path: loaded.path,
          data: loaded.data,
          body: loaded.body,
          original: { data: { ...loaded.data }, body: loaded.body },
          exists: true,
        })
      } catch (error) {
        if (cancelled) return
        if (error instanceof Error && error.name === 'novel/not-found') {
          setOutline({ path, data: {}, body: '', original: { data: {}, body: '' }, exists: false })
        } else {
          env.note(`读取 ${path} 失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }
    })()
    return () => { cancelled = true }
  }, [env.note, env.root, env.sessionId, outline?.path, volume, which])

  /** Load one chapter for beats editing. */
  const loadChapter = useCallback((summary: ChapterSummary) => {
    void env.run(`读取章纲「${summary.title}」`, async () => {
      const loaded = await api.readDocument(env.sessionId, env.root, summary.path)
      setChapter({
        path: loaded.path,
        data: loaded.data,
        body: loaded.body,
        original: { data: { ...loaded.data }, body: loaded.body },
        exists: true,
      })
      setWhich('chapter')
      return `已读取 ${loaded.path}`
    })
  }, [env])

  const patchOutline = useCallback((body: string) => {
    setOutline(previous => (previous === undefined ? previous : { ...previous, body }))
  }, [])

  const patchChapter = useCallback((next: Partial<Record<string, unknown>>) => {
    setChapter(previous => {
      if (previous === undefined) return previous
      const data = { ...previous.data }
      for (const [key, value] of Object.entries(next)) {
        // Clearing a field deletes it rather than leaving `undefined` in the
        // mapping: an empty `targetWords: undefined` would be serialized as a
        // null-ish key the author never typed.
        if (value === undefined) delete data[key]
        else data[key] = value
      }
      return { ...previous, data }
    })
  }, [])

  const onSaveOutline = useCallback(() => {
    if (outline === undefined) return
    void env.run('保存大纲', async () => {
      const written = await api.writeDocument(env.sessionId, env.root, outline.path, outline.data, outline.body)
      setOutline({ ...outline, original: { data: { ...outline.data }, body: outline.body }, exists: true })
      const warning = written.warning === undefined ? '' : `｜注意：${written.warning}`
      return `已保存 ${outline.path}（${written.operation === 'create' ? '新建' : '覆盖'}，${String(written.after.length)} 字节）${warning}`
    }, () => { saveCurrentRef.current?.() })
  }, [env, outline])

  const onSaveChapter = useCallback(() => {
    if (chapter === undefined) return
    void env.run('保存章纲', async () => {
      const written = await api.writeDocument(env.sessionId, env.root, chapter.path, chapter.data, chapter.body)
      setChapter({ ...chapter, original: { data: { ...chapter.data }, body: chapter.body }, exists: true })
      await onChanged()
      const warning = written.warning === undefined ? '' : `｜注意：${written.warning}`
      return `已保存 ${chapter.path}（${String(written.after.length)} 字节）${warning}`
    }, () => { saveCurrentRef.current?.() })
  }, [chapter, env, onChanged])

  /**
   * Save what is on screen.
   *
   * This surface holds two documents — the outline and one chapter's beats — and
   * `which` is already the answer to "which one is the author looking at", so the
   * key follows the same switch the editors do instead of guessing.
   */
  const saveCurrent = useCallback(() => {
    if (which === 'chapter') {
      if (chapter === undefined) {
        env.note('大纲页里还没有打开章纲——先在下面点一章')
        return
      }
      onSaveChapter()
      return
    }
    if (outline === undefined) {
      env.note('大纲页里还没有打开卷纲——先在左边选一卷')
      return
    }
    onSaveOutline()
  }, [chapter, env, onSaveChapter, onSaveOutline, outline, which])
  /**
   * ...and the current one as a ref, so a failed save's retry re-enters the
   * newest dispatch rather than re-running the closure that failed with the
   * buffer it held at that moment.
   */
  const saveCurrentRef = useRef<(() => void) | undefined>(undefined)
  saveCurrentRef.current = saveCurrent

  /** Save when the panel asks (`Ctrl+S` / the footer's 保存), once per request. */
  const saveSeen = useRef(saveToken)
  useEffect(() => {
    if (saveToken === undefined || saveToken === saveSeen.current) return
    saveSeen.current = saveToken
    saveCurrent()
  }, [saveCurrent, saveToken])

  /**
   * Edit one beat.
   * @param index - which beat.
   * @param value - its new text, or undefined to remove it.
   * @param move - shift it by one position when set.
   */
  const editBeat = useCallback((index: number, value?: string, move?: -1 | 1) => {
    setChapter(previous => {
      if (previous === undefined) return previous
      const beats = beatsOf(previous.data)
      if (move !== undefined) {
        const target = index + move
        if (target < 0 || target >= beats.length) return previous
        const next = [...beats]
        const held = next[index] ?? ''
        next[index] = next[target] ?? ''
        next[target] = held
        return { ...previous, data: { ...previous.data, beats: next } }
      }
      if (value === undefined) {
        return { ...previous, data: { ...previous.data, beats: beats.filter((_, at) => at !== index) } }
      }
      const next = [...beats]
      next[index] = value
      return { ...previous, data: { ...previous.data, beats: next } }
    })
  }, [])

  /** Build a task context from the current tree. */
  const context = useCallback((): TaskContext => ({
    sessionId: env.sessionId,
    root: env.root,
    meta: {
      title: snapshot.title,
      ...(snapshot.genre === undefined ? {} : { genre: snapshot.genre }),
      ...(snapshot.targetWords === undefined ? {} : { targetWords: snapshot.targetWords }),
    },
    volumes: snapshot.volumes,
    volume,
    ...(cards === undefined ? {} : { cards }),
  }), [cards, env, snapshot, volume])

  /** Take a generated outline into the matching editor buffer. */
  const onDocument = useCallback((target: string, text: string, label: string) => {
    setWhich(target === BOOK_OUTLINE_FILE ? 'book' : 'volume')
    setOutline(previous => ({
      path: target,
      data: previous?.path === target ? previous.data : {},
      body: text,
      original: previous?.path === target ? previous.original : { data: {}, body: '' },
      exists: previous?.path === target ? previous.exists : true,
    }))
    env.note(`已采纳「${label}」到 ${target} 的编辑区，确认后点保存落盘`)
  }, [env])

  /** Create the chapters a plan proposed. */
  const onCreateChapters = useCallback((chapters: readonly PlanChapter[], targetVolume: number) => {
    void env.run('按计划建章', async () => {
      let created = 0
      for (const plan of chapters) {
        await api.createChapter(env.sessionId, env.root, {
          volume: targetVolume,
          title: plan.title,
          beats: plan.beats,
          characters: plan.characters,
          locations: plan.locations,
          refs: plan.refs,
          ...(plan.summary === undefined ? {} : { summary: plan.summary }),
          ...(plan.targetWords === undefined ? {} : { targetWords: plan.targetWords }),
        })
        created += 1
      }
      await onChanged()
      return `已建 ${String(created)} 章（章纲已写进各自的 frontmatter）`
    })
  }, [env, onChanged])

  const selected = snapshot.volumes.find(item => item.volume === volume)
  // Archived chapters are not planning material: they are not part of the story
  // any more, and listing them here would invite re-planning over a scene the
  // author took back out. They stay visible (and restorable) in the 正文 tree.
  const planned = (selected?.chapters ?? []).filter(item => !item.archived)
  const outlineDirty = outline !== undefined && documentChanged(outline, outline.original)
  const beats = chapter === undefined ? [] : beatsOf(chapter.data)

  /**
   * Create the next volume: write its outline skeleton and open it here.
   *
   * This is what makes 「还没有章节的第二卷」 possible at all. Nothing else is
   * written — no `chapters/vNN/` directory, no empty chapter (format §1: empty
   * directories are not pre-created) — but because the outline file now exists,
   * the volume appears in every volume picker and in the chapter tree, and its
   * 卷纲 can be written (or generated by 「续写卷纲」/「按卷纲拆章」) before a word of
   * prose exists. The write itself is shared with the chapter tree's button
   * (`client/volumes.ts`), so the two can never do different things.
   */
  const onAddVolume = useCallback(() => {
    const volumes = snapshot.volumes
    void env.run('新建卷', async () => {
      const created = await createNextVolume(env.sessionId, env.root, volumes)
      const body = volumeOutlineSkeleton(created.volume)
      setOutline({ path: created.path, data: {}, body, original: { data: {}, body }, exists: true })
      setVolume(created.volume)
      setWhich('volume')
      await onChanged()
      return createdVolumeNote(created)
    })
  }, [env, onChanged, snapshot.volumes])

  /**
   * Edit the open outline's frontmatter.
   *
   * The volume's **name** is the one frontmatter field this surface offers; the
   * outline's prose is the textarea. Clearing the box deletes the key rather than
   * writing an empty `title:` — "never named" and "named the empty string" are
   * different facts (format §4.11).
   */
  const patchOutlineData = useCallback((key: string, value: string) => {
    setOutline(previous => {
      if (previous === undefined) return previous
      const data = { ...previous.data }
      if (value.trim() === '') delete data[key]
      else data[key] = value
      return { ...previous, data }
    })
  }, [])

  /** How one volume is offered in the picker: its number, then its name. */
  const volumeOptionLabel = useCallback((item: { volume: number, title?: string }): string =>
    item.title === undefined || item.title.trim() === ''
      ? `第 ${String(item.volume)} 卷`
      : `第 ${String(item.volume)} 卷 · ${item.title}`, [])

  /**
   * Report what this surface has open, while it is the one on screen.
   *
   * A chapter's beats tab edits a chapter document, but its body lives in the
   * prose editor — so what this surface reports is the outline, not the chapter,
   * and a diff line for that chapter belongs on the prose tab, which is where
   * the editor for its text actually is.
   */
  useEffect(() => {
    if (!active || which === 'chapter' || outline === undefined) return
    onOpenDocument?.(outline.path, 'outline', outlineDirty)
  }, [active, onOpenDocument, outline, outlineDirty, which])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
      <div style={row}>
        <select
          style={input}
          value={volume}
          onChange={event => {
            const next = Number(event.target.value)
            setVolume(next)
            setWhich('volume')
          }}
        >
          {(snapshot.volumes.length === 0 ? [{ volume: 1, dir: 'v01', chapters: [] }] : snapshot.volumes).map(item => (
            <option key={item.dir} value={item.volume}>{volumeOptionLabel(item)}</option>
          ))}
        </select>
        <button
          type="button"
          style={button}
          disabled={env.busy}
          title={`新建第 ${String(nextVolumeNumber(snapshot.volumes))} 卷：写下它的卷纲骨架，这一卷立刻出现在大纲页、章节树与导出的卷列表里（还不用有章节）`}
          onClick={onAddVolume}
        >
          ＋ 新建卷
        </button>
        <button
          type="button"
          style={{ ...button, fontWeight: which === 'book' ? 600 : 400 }}
          onClick={() => { setWhich('book') }}
        >
          全书主线
        </button>
        <button
          type="button"
          style={{ ...button, fontWeight: which === 'volume' ? 600 : 400 }}
          onClick={() => { setWhich('volume') }}
        >
          本卷卷纲
        </button>
        <button
          type="button"
          style={{ ...button, fontWeight: which === 'chapter' ? 600 : 400 }}
          disabled={chapter === undefined}
          onClick={() => { setWhich('chapter') }}
        >
          章纲
        </button>
      </div>

      <TaskBar
        env={env}
        tasks={OUTLINE_TASKS}
        context={context}
        volume={volume}
        onProse={() => { env.note('大纲任务不会改正文') }}
        onDocument={onDocument}
        onCreateChapters={onCreateChapters}
      />

      {which !== 'chapter' && (
        <>
          {/* 卷名：卷纲 frontmatter 的可选 `title`，导出与大启用它（格式 §4.11）。
              全书主线没有名字，所以这个框只在卷纲这一页出现。 */}
          {which === 'volume' && (
            <input
              style={input}
              value={typeof outline?.data.title === 'string' ? outline.data.title : ''}
              placeholder={`第 ${String(volume)} 卷的名字（可留空，如「北境篇」）`}
              disabled={env.busy || outline === undefined}
              onChange={event => { patchOutlineData('title', event.target.value) }}
            />
          )}
          <div style={{ ...row, justifyContent: 'space-between' }}>
            <span style={metaLine}>{outline?.path ?? '读取中…'}{outline?.exists === false ? '（尚未落盘）' : ''}</span>
            <button
              type="button"
              style={button}
              disabled={env.busy || outline === undefined || !outlineDirty}
              onClick={onSaveOutline}
            >
              保存大纲
            </button>
          </div>
          <textarea
            ref={outlineRef}
            style={{ ...textarea, minHeight: 200 }}
            value={outline?.body ?? ''}
            placeholder={which === 'book' ? '# 全书主线' : '# 第 N 卷 卷纲'}
            onChange={event => { patchOutline(event.target.value) }}
          />
        </>
      )}

      <div style={box}>
        <div style={metaLine}>
          本卷章节 · {String(planned.length)} 章（点一章编辑它的章纲）
        </div>
        {planned.length === 0
          ? <div style={metaLine}>这一卷还没有章节。用「按卷纲拆章」排章，或在正文页「+ 新建章节」。</div>
          : planned.map(item => (
            <button
              key={item.path}
              type="button"
              style={{
                ...listRow,
                background: chapter?.path === item.path
                  ? 'color-mix(in srgb, currentColor 12%, transparent)'
                  : 'transparent',
              }}
              onClick={() => { loadChapter(item) }}
            >
              <span>第 {String(item.number)} 章 {item.title}</span>
              <span style={{ opacity: 0.65 }}>
                {STATUS_LABEL[item.status]} · {String(item.wordCount)} 字 · 要点 {String(item.beats.length)}
              </span>
            </button>
          ))}
        <div style={{ ...row, marginTop: 6 }}>
          <button
            type="button"
            style={button}
            disabled={env.busy || chapter === undefined}
            onClick={() => { if (chapter !== undefined) onOpenChapter(chapter.path) }}
          >
            在正文页打开
          </button>
        </div>
      </div>

      {which === 'chapter' && chapter !== undefined && (
        <>
          <div style={row}>
            <input
              style={{ ...input, flex: '1 1 120px' }}
              value={field(chapter.data, 'title')}
              placeholder="章节标题"
              onChange={event => { patchChapter({ title: event.target.value }) }}
            />
            <input
              style={{ ...input, width: 80 }}
              value={field(chapter.data, 'targetWords')}
              placeholder="目标字数"
              inputMode="numeric"
              onChange={event => {
                patchChapter({ targetWords: event.target.value === '' ? undefined : Number(event.target.value) })
              }}
            />
            <input
              style={{ ...input, width: 110 }}
              value={field(chapter.data, 'pov')}
              placeholder="视角 id"
              onChange={event => { patchChapter({ pov: event.target.value }) }}
            />
          </div>
          <div style={row}>
            <ListField
              style={{ ...input, flex: '1 1 120px' }}
              value={listOf(chapter.data, 'characters')}
              placeholder="出场角色 id（逗号分隔）"
              onChange={ids => { patchChapter({ characters: ids }) }}
            />
            <ListField
              style={{ ...input, flex: '1 1 120px' }}
              value={listOf(chapter.data, 'locations')}
              placeholder="地点 id（逗号分隔）"
              onChange={ids => { patchChapter({ locations: ids }) }}
            />
            <ListField
              style={{ ...input, flex: '1 1 120px' }}
              value={listOf(chapter.data, 'refs')}
              placeholder="引用的设定 id（逗号分隔）"
              title="这一章要依据的世界设定卡（settings/lore/：境界阶梯、体系规则…）"
              onChange={ids => { patchChapter({ refs: ids }) }}
            />
            {/* 参考章节：写作任务会把这几章的**全文**交给模型（上一章自动带上），
                与正文页那一行是同一份数据的两个视图。 */}
            <ListField
              style={{ ...input, flex: '1 1 120px' }}
              value={listOf(chapter.data, 'contextChapters')}
              placeholder="参考章节 id（逗号分隔）"
              title="这几章的全文会随写作任务进 prompt（上一章不用写，它自动带上）"
              onChange={ids => { patchChapter({ contextChapters: ids }) }}
            />
          </div>
          <input
            style={input}
            value={field(chapter.data, 'summary')}
            placeholder="一句话摘要（检索的第一层索引）"
            onChange={event => { patchChapter({ summary: event.target.value }) }}
          />
          <div style={box}>
            <div style={metaLine}>章纲要点（写正文时按这个顺序推进）</div>
            {beats.map((beat, index) => (
              <div key={index} style={{ ...row, marginTop: 4 }}>
                <input
                  style={{ ...input, flex: '1 1 200px' }}
                  value={beat}
                  onChange={event => { editBeat(index, event.target.value) }}
                />
                <button type="button" style={button} onClick={() => { editBeat(index, undefined, -1) }}>↑</button>
                <button type="button" style={button} onClick={() => { editBeat(index, undefined, 1) }}>↓</button>
                <button type="button" style={button} onClick={() => { editBeat(index) }}>删</button>
              </div>
            ))}
            <div style={{ ...row, marginTop: 6 }}>
              <button
                type="button"
                style={button}
                onClick={() => { patchChapter({ beats: [...beats, ''] }) }}
              >
                + 加一条要点
              </button>
              <button
                type="button"
                style={button}
                disabled={env.busy || !beatsDirty(chapter)}
                onClick={onSaveChapter}
              >
                保存章纲
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/** Whether a chapter's outline (its frontmatter, which is where the beats live) differs from what was loaded. */
function beatsDirty(doc: OpenDoc): boolean {
  return documentChanged(doc, doc.original)
}
