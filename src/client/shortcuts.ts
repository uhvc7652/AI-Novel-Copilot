/**
 * The panel's keyboard shortcuts, as data.
 *
 * Three rules decide everything here, and each of them is a response to a way
 * this feature usually goes wrong:
 *
 * 1. **A binding always carries a modifier.** Not one shortcut in this set is an
 *    unmodified printable key, so none of them can swallow a keystroke the
 *    author meant to type. That is what makes "the panel never has to ask
 *    whether focus is in a textarea" true rather than optimistic — and it is why
 *    `Ctrl+Z` is still nothing but the browser's own per-character undo inside
 *    the editor (M7's rollback kept its own key, in its own tab, for the same
 *    reason).
 * 2. **Modifiers must match exactly.** `Ctrl+Alt+1` switching tabs must not also
 *    fire on `Ctrl+Shift+Alt+1`: a near-miss that silently does something is
 *    worse than a key that does nothing.
 * 3. **Bindings are published, not hidden.** {@link shortcutHelp} renders the
 *    same table the matcher uses, so the help text cannot drift from the
 *    behaviour, and every button that has a shortcut can name it in its tooltip.
 *
 * `Ctrl` and `Cmd` are treated as the same modifier: the shell is a web app, and
 * on macOS the Cmd key is where a shortcut of this kind belongs.
 *
 * @module dsh-ai-novel-copilot/client/shortcuts
 */
import { PANEL_SECTIONS, type PanelSection } from './ui.ts'

/** What a keystroke can ask the panel to do. */
export type ShortcutAction =
  | 'save'
  | 'prev-chapter'
  | 'next-chapter'
  | 'cancel'
  | `section:${PanelSection}`

/** The part of a keyboard event the matcher reads. */
export interface KeyEventLike {
  /** `KeyboardEvent.key`. */
  key: string
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  metaKey?: boolean
}

/** One binding. */
export interface Binding {
  /** What pressing it does. */
  action: ShortcutAction
  /** The key it matches, as `KeyboardEvent.key` (single characters lowercased). */
  key: string
  /** Whether a control modifier is required. */
  ctrl?: boolean
  /** Whether Alt is required. */
  alt?: boolean
  /** Whether Shift is required. */
  shift?: boolean
  /** How it is printed in a tooltip or the help list. */
  keys: string
  /** One line saying what it does. */
  description: string
}

/**
 * Every binding, in help order.
 *
 * `Alt+↑/↓` for chapter navigation rather than `Ctrl+←/→`: the horizontal pair
 * is the browser's back/forward in several shells, and spending an author's
 * back-button muscle memory on "next chapter" is how a shortcut becomes a way to
 * lose work. In the vertical pair, up is towards the top of the chapter tree,
 * which is the direction the tree reads in.
 */
export const KEY_BINDINGS: readonly Binding[] = [
  {
    action: 'save',
    key: 's',
    ctrl: true,
    keys: 'Ctrl+S',
    description: '保存当前文档（正文 / 设定卡 / 大纲都算）',
  },
  {
    action: 'prev-chapter',
    key: 'ArrowUp',
    alt: true,
    keys: 'Alt+↑',
    description: '上一章',
  },
  {
    action: 'next-chapter',
    key: 'ArrowDown',
    alt: true,
    keys: 'Alt+↓',
    description: '下一章',
  },
  ...PANEL_SECTIONS.map((section, index): Binding => ({
    action: `section:${section.id}`,
    key: String(index + 1),
    ctrl: true,
    alt: true,
    keys: `Ctrl+Alt+${String(index + 1)}`,
    description: `切到「${section.label}」`,
  })),
  {
    action: 'cancel',
    key: 'Escape',
    keys: 'Esc',
    description: '关掉「记为伏笔」表单，或清掉状态行上的失败提示',
  },
]

/** Whether a control modifier is held, counting Cmd as one. */
function controlled(event: KeyEventLike): boolean {
  return event.ctrlKey === true || event.metaKey === true
}

/** Compare one required modifier flag, treating undefined as "not required". */
function exactly(wanted: boolean | undefined, held: boolean): boolean {
  return wanted === true ? held : !held
}

/**
 * The action one keystroke asks for, if any.
 *
 * The event shape is a plain object rather than a `KeyboardEvent` so the
 * matching rules — exact modifiers, lowercased letters, unbound keys falling
 * through — can be pinned down without a DOM.
 * @param event - the keystroke.
 * @returns the action, or undefined when nothing is bound to it.
 */
export function actionFor(event: KeyEventLike): ShortcutAction | undefined {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
  const control = controlled(event)
  const alt = event.altKey === true
  const shift = event.shiftKey === true
  const found = KEY_BINDINGS.find(binding => binding.key === key
    && exactly(binding.ctrl, control)
    && exactly(binding.alt, alt)
    && exactly(binding.shift, shift))
  return found?.action
}

/**
 * How an action's key is printed, for a button's tooltip.
 * @param action - the action.
 * @returns the label, or undefined when nothing is bound to it.
 */
export function shortcutLabel(action: ShortcutAction): string | undefined {
  return KEY_BINDINGS.find(binding => binding.action === action)?.keys
}

/**
 * The help list the panel shows, derived from the bindings themselves.
 * @returns one line per binding.
 */
export function shortcutHelp(): { keys: string, description: string }[] {
  return KEY_BINDINGS.map(binding => ({ keys: binding.keys, description: binding.description }))
}
