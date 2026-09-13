/**
 * The export surface: render the book as `md`/`txt`, write it under `exports/`,
 * or download it.
 *
 * Two things shape this view.
 *
 * First, **the host renders and the panel chooses.** Scope, format and
 * selection are the author's decisions; turning chapters into one manuscript is
 * the host's job, because only the host has the prose. So every button here is a
 * request, and the preview is literally the string the write would contain —
 * there is no second renderer in the browser that could disagree with it.
 *
 * Second, **what is on screen is not what is exported.** The export reads the
 * files; unsaved buffer changes are not in them. That is worth saying out loud
 * on the surface, because "I exported it" and "it is in the file" being different
 * things is exactly the kind of surprise this panel exists to avoid (D9).
 *
 * @module dsh-ai-novel-copilot/client/ExportView
 */
import { useCallback, useEffect, useState } from 'react'
import type { ProjectSnapshot } from '../novel/project.ts'
import * as api from './api.ts'
import { box, button, caption, controlRow, input, listRow, metaLine, previewText, row, type PanelEnv } from './ui.ts'

/** Props for the export view. */
export interface ExportViewProps {
  /** Shared panel environment. */
  env: PanelEnv
  /** The project tree, for the volume list and the default scope. */
  snapshot: ProjectSnapshot
  /** The chapter open in the prose surface, when there is one. */
  openChapter?: { path: string, title: string, number: number, dirty: boolean }
}

/** How much of a rendered export the preview shows. */
const PREVIEW_CHARS = 1200

/** How many already-written exports the surface lists. */
const LIST_LIMIT = 12

/**
 * Hand one string to the browser as a file.
 *
 * A Blob URL plus a synthetic `<a download>`: the panel has no filesystem of its
 * own, and this is the one way a web page can put bytes in the author's
 * Downloads folder. The URL is revoked on the next tick rather than immediately,
 * because some browsers cancel a download whose object URL disappeared in the
 * same task.
 * @param fileName - the name the browser should save it under.
 * @param text - the file's content.
 * @throws when the environment has no DOM to download with.
 */
function downloadText(fileName: string, text: string): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('这个环境不能下载文件——用「导出到 exports/」，文件会写进工程目录')
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => { URL.revokeObjectURL(url) }, 0)
}

/**
 * The export view.
 * @param props - environment, the project tree, and the open chapter.
 */
export function ExportView({ env, snapshot, openChapter }: ExportViewProps) {
  const [format, setFormat] = useState<'md' | 'txt'>('md')
  const [scope, setScope] = useState<api.ExportScope>('book')
  const [volume, setVolume] = useState(() => snapshot.volumes.at(-1)?.volume ?? 1)
  const [plan, setPlan] = useState<api.ExportPlan>()
  /** Names already sitting in `exports/`, newest first. */
  const [written, setWritten] = useState<string[]>()

  /** The spec the three buttons act on. */
  const spec = useCallback((): api.ExportSpec => ({
    format,
    scope,
    ...(scope === 'volume' ? { volume } : {}),
    ...(scope === 'chapter' && openChapter !== undefined ? { path: openChapter.path } : {}),
  }), [format, openChapter, scope, volume])

  /** Re-read `exports/`, tolerating its absence: no exports yet is not a failure. */
  const refreshList = useCallback(() => {
    void api.readDirectory(env.sessionId, env.root, 'exports').then(
      listing => {
        setWritten(listing.entries
          .filter(entry => entry.type === 'file')
          .map(entry => entry.name)
          .sort()
          .reverse()
          .slice(0, LIST_LIMIT))
      },
      () => { setWritten(undefined) },
    )
  }, [env.root, env.sessionId])

  useEffect(() => { refreshList() }, [refreshList])

  // A preview belongs to the selection it was rendered from: leaving it on screen
  // while the author changes the scope would show one thing and export another.
  useEffect(() => { setPlan(undefined) }, [format, scope, volume])

  const onPreview = useCallback(() => {
    void env.run('预览导出', async () => {
      // The head is what keeps opening this tab cheap on a million-word book: the
      // host renders the whole manuscript (it has to, to count it honestly) and
      // sends back only the opening. Download asks for everything (see below).
      const rendered = await api.readExport(env.sessionId, env.root, spec(), PREVIEW_CHARS)
      setPlan(rendered)
      return `预览：${rendered.scopeLabel} · ${String(rendered.chapters)} 章 · ${String(rendered.words)} 字`
        + `（全文 ${String(rendered.bytes)} 字节，文件名 ${rendered.fileName}）`
    })
  }, [env, spec])

  const onWrite = useCallback(() => {
    void env.run('导出', async () => {
      const saved = await api.writeExport(env.sessionId, env.root, spec())
      refreshList()
      return `已导出到 ${saved.path}（${String(saved.chapters)} 章 · ${String(saved.words)} 字 · ${String(saved.bytes)} 字节）`
    })
  }, [env, refreshList, spec])

  const onDownload = useCallback(() => {
    void env.run('下载导出', async () => {
      // Always re-read without a head: `plan` may be a 1200-character preview, and
      // downloading a preview under the book's filename is the one mistake this
      // button must not make.
      const rendered = await api.readExport(env.sessionId, env.root, spec())
      downloadText(rendered.fileName, rendered.text)
      return `已开始下载 ${rendered.fileName}（${String(rendered.chapters)} 章 · ${String(rendered.words)} 字 · ${String(rendered.bytes)} 字节）`
    })
  }, [env, spec])

  const head = plan?.text ?? ''
  const truncated = plan?.truncated === true

  return (
    <>
      <div style={controlRow}>
        <span style={caption}>
          导出这本书的正文（{String(snapshot.chapterCount)} 章 · {String(snapshot.wordCount)} 字）。
          只导出没存档的章；导出的是磁盘上的正文，编辑器里未保存的改动不在里面。
        </span>
      </div>

      <div style={row}>
        <select
          style={input}
          value={format}
          onChange={event => { setFormat(event.target.value === 'txt' ? 'txt' : 'md') }}
        >
          <option value="md">Markdown（.md）</option>
          <option value="txt">纯文本（.txt）</option>
        </select>
        <select
          style={input}
          value={scope}
          onChange={event => {
            const next = event.target.value
            setScope(next === 'volume' || next === 'chapter' ? next : 'book')
          }}
        >
          <option value="book">全书</option>
          <option value="volume">某一卷</option>
          <option value="chapter" disabled={openChapter === undefined}>当前章</option>
        </select>
        {scope === 'volume' && (
          <select style={input} value={String(volume)} onChange={event => { setVolume(Number(event.target.value)) }}>
            {snapshot.volumes.map(item => (
              <option key={item.dir} value={String(item.volume)}>
                第 {String(item.volume)} 卷（{String(item.chapters.filter(chapter => !chapter.archived).length)} 章）
              </option>
            ))}
          </select>
        )}
        {scope === 'chapter' && (
          <span style={caption}>
            {openChapter === undefined
              ? '（先在「正文」页打开一章）'
              : `第 ${String(openChapter.number)} 章 ${openChapter.title}${openChapter.dirty ? ' · 有未保存修改' : ''}`}
          </span>
        )}
      </div>

      <div style={row}>
        <button type="button" style={button} disabled={env.busy} onClick={onPreview}>预览</button>
        <button type="button" style={button} disabled={env.busy} onClick={onWrite}>导出到 exports/</button>
        <button type="button" style={button} disabled={env.busy} onClick={onDownload}>下载</button>
        <span style={metaLine}>md 保留标题层级，txt 用纯文本行；两者正文逐字相同。</span>
      </div>

      {plan !== undefined && (
        <div style={box}>
          <div style={controlRow}>
            <span style={caption}>{plan.fileName}</span>
            <span style={caption}>{String(plan.chapters)} 章 · {String(plan.words)} 字</span>
          </div>
          <pre style={previewText}>{head}</pre>
          {truncated && (
            <div style={metaLine}>
              预览只取开头 {String(PREVIEW_CHARS)} 个字符（全文 {String(plan.bytes)} 字节）；
              「导出到 exports/」与「下载」拿到的都是完整的。
            </div>
          )}
        </div>
      )}

      <div style={controlRow}>
        <span style={caption}>exports/ 里已有的导出{written === undefined ? '' : ` · ${String(written.length)} 个`}</span>
        <button type="button" style={button} disabled={env.busy} onClick={refreshList}>刷新列表</button>
      </div>
      {written === undefined || written.length === 0
        ? <div style={metaLine}>还没有导出过。点「导出到 exports/」会写进工程目录下的 exports/（派生文件，不进 git）。</div>
        : (
          <div style={box}>
            {written.map(name => (
              <div key={name} style={listRow}>{name}</div>
            ))}
          </div>
        )}
      {openChapter?.dirty === true && (
        <div style={metaLine}>提示：当前章有未保存的修改，导出不会带上它——先保存（Ctrl+S）再导出。</div>
      )}
    </>
  )
}
