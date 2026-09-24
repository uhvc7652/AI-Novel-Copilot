/**
 * Browser half of AI-Novel-Copilot.
 *
 * Three registrations, one product:
 *
 * - the **tab type** (kind `novel`), registered in the `extension` band so a
 *   type shipped outside the product is allowed to own its own kind;
 * - the **panel body**, which is the writing surface itself;
 * - a **footer entry** in the left sidebar, because a tab type shows up nowhere
 *   until someone opens it from the right sidebar's guide page. The footer
 *   button is the front door: it expands the right sidebar and opens the panel.
 *
 * Runtime rules this file obeys (enforced by DSH's client-build purity gate):
 * the only value imports are `react` and this package's own modules; every
 * cross-package capability arrives as a cordis service through `inject`.
 * Styles are inline, so the bundle needs no CSS pipeline.
 *
 * @module dsh-ai-novel-copilot/client
 */
import { useCallback, useState } from 'react'
import { Panel } from './Panel.tsx'
import { ChecksView } from './ChecksView.tsx'
import { ExportView } from './ExportView.tsx'
import { HistoryView } from './HistoryView.tsx'
import { ModelIssueList } from './IssueList.tsx'
import { OutlineView } from './OutlineView.tsx'
import { SearchView } from './SearchView.tsx'
import { SettingsView } from './SettingsView.tsx'
import { TaskBar } from './TaskBar.tsx'
import { ThreadsView } from './ThreadsView.tsx'
import { TimelineEditor } from './TimelineEditor.tsx'
import { ListField } from './ListField.tsx'
import { ChapterCards } from './ChapterCards.tsx'
import { ChapterContext } from './ChapterContext.tsx'

/**
 * The view components, exported for `spike/client-load-check.mjs`.
 *
 * The slot framework reads only `apply` and `inject`, so these extra exports are
 * inert in the browser. They exist because "the component renders" was not
 * enough in P1: a task button was dead for weeks because the branch that draws
 * it runs only once a chapter is open, and the check never opened one. A check
 * that can render each surface with real fixtures is the cheap half of that
 * lesson; the interactive half still needs the author's browser.
 */
export const __views = { Panel, SettingsView, OutlineView, TaskBar, SearchView, ChecksView, HistoryView, ThreadsView, ModelIssueList, ExportView, TimelineEditor, ListField, ChapterCards, ChapterContext }

/** This implementation's identity in the tab system, and the key its body registers under. */
const NOVEL_ID = 'dsh-ai-novel-copilot'

/** The tab kind this package owns. */
const NOVEL_KIND = 'novel'

/** Browser services this plugin reads: slots, the tab registry, and the panel controller. */
export const inject = ['slots', 'sidebarRightTabs', 'sidebarRight']

/** The face handed to the footer entry, so it can drive the right sidebar. */
interface FooterInjected {
  /**
   * Reveal the writing panel.
   * @returns a short status line for the button's own feedback.
   */
  openPanel: () => string
}

/** The face handed to the panel body: the shell's directory picker. */
interface PanelFace {
  /**
   * Open the shell's directory chooser.
   * @returns the selected directory, or null when cancelled.
   */
  pickDirectory: () => Promise<string | null>
}

/**
 * The always-visible front door in the left sidebar's footer.
 * @param props - the injected face.
 */
function NovelFooterAction({ openPanel }: FooterInjected) {
  const [label, setLabel] = useState('小说')
  const onClick = useCallback(() => { setLabel(openPanel()) }, [openPanel])
  return (
    <button
      type="button"
      title="AI-Novel-Copilot：打开小说写作台"
      onClick={onClick}
      style={{
        font: 'inherit',
        fontSize: 12,
        padding: '2px 8px',
        cursor: 'pointer',
        background: 'transparent',
        color: 'inherit',
        border: '1px solid currentColor',
        borderRadius: 4,
        opacity: 0.85,
      }}
    >
      {label}
    </button>
  )
}

/**
 * Ask the shell for a directory, when this deployment has a picker.
 *
 * `ctx.get` reads a service **without** the inject requirement (cordis: "Read a
 * service from the store without the inject requirement"), and that is the
 * point: a hard `uiWorkspace` dependency would stop this whole plugin from
 * loading in a deployment composed without a directory picker, where the panel
 * only stands to lose one button. The lookup happens per click, so activation
 * order between this plugin and the picker does not matter.
 * @param ctx - client root context.
 * @returns the selected directory, or null when the author cancelled.
 * @throws when no picker is composed, with an instruction instead of a stack.
 */
async function pickDirectory(ctx: any): Promise<string | null> {
  const ui: { pickDirectory?: () => Promise<string | null> } | undefined = ctx.get?.('uiWorkspace')
  if (typeof ui?.pickDirectory !== 'function') {
    throw new Error('这个部署没有装目录选择器，请直接在输入框里填工程路径')
  }
  return await ui.pickDirectory()
}

/**
 * Client plugin body: register the tab type, the panel, and the front door.
 * @param ctx - client root context carrying the slot framework and the sidebar services.
 */
export function apply(ctx: any): void {
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: NOVEL_ID,
    kind: NOVEL_KIND,
    priority: 'extension',
    title: () => '小说',
    guide: [{
      order: 50,
      title: () => '小说写作台',
      description: () => '章节树、正文编辑器与设定库（AI-Novel-Copilot）',
    }],
  }), 'ai-novel-copilot: novel tab type')

  // The panel reads its data from this plugin's own routes, and tasks run in a
  // host-side writing child — so the only face it takes is the shell's
  // directory picker, letting 「选择文件夹」 open the same chooser the workspace
  // sidebar uses.
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    {
      name: 'sidebar.right.pane.tab',
      key: NOVEL_ID,
      inject: (): PanelFace => ({ pickDirectory: () => pickDirectory(ctx) }),
    },
    Panel,
  )), 'ai-novel-copilot: novel tab body')

  ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    {
      name: 'sidebar.footer.action',
      id: NOVEL_ID,
      order: 50,
      inject: (): FooterInjected => ({
        openPanel: (): string => {
          try {
            ctx.sidebarRight.expand()
            ctx.sidebarRight.openTab(NOVEL_KIND)
            return '小说 ✓'
          } catch {
            // No session surface is mounted yet: the column has nothing to open into.
            return '先开会话'
          }
        },
      }),
    },
    NovelFooterAction,
  )), 'ai-novel-copilot: sidebar footer entry')
}
