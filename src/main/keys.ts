import { AndroidKeyCode, AndroidKeyEventMeta, type AndroidKeyCode as KeyCode } from '@yume-chan/scrcpy'

const named = AndroidKeyCode as Record<string, KeyCode>

/** DOM `KeyboardEvent.code` values that must be real Android keys, not typed text. */
const structural = new Set([
  'Enter',
  'Tab',
  'Backspace',
  'Escape',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
])

const codeNames: Record<string, keyof typeof AndroidKeyCode> = {
  Backspace: 'Backspace',
  Enter: 'Enter',
  NumpadEnter: 'NumpadEnter',
  Escape: 'Escape',
  Tab: 'Tab',
  Space: 'Space',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  Minus: 'Minus',
  Equal: 'Equal',
  BracketLeft: 'BracketLeft',
  BracketRight: 'BracketRight',
  Backslash: 'Backslash',
  Semicolon: 'Semicolon',
  Quote: 'Quote',
  Backquote: 'Backquote',
  Comma: 'Comma',
  Period: 'Period',
  Slash: 'Slash',
  CapsLock: 'CapsLock',
  NumLock: 'NumLock',
  ScrollLock: 'ScrollLock',
  Pause: 'Pause',
  PrintScreen: 'PrintScreen',
  ContextMenu: 'ContextMenu',
  ControlLeft: 'ControlLeft',
  ControlRight: 'ControlRight',
  ShiftLeft: 'ShiftLeft',
  ShiftRight: 'ShiftRight',
  AltLeft: 'AltLeft',
  AltRight: 'AltRight',
  MetaLeft: 'MetaLeft',
  MetaRight: 'MetaRight',
  NumpadDivide: 'NumpadDivide',
  NumpadMultiply: 'NumpadMultiply',
  NumpadSubtract: 'NumpadSubtract',
  NumpadAdd: 'NumpadAdd',
  NumpadDecimal: 'NumpadDecimal',
}

/** A single printable character with no command modifier is typed, not keyed. */
export function isTypingKey(code: string, key: string, mods: { ctrl: boolean; alt: boolean; meta: boolean }): boolean {
  if (mods.ctrl || mods.alt || mods.meta) return false
  if (key.length !== 1) return false
  return !structural.has(code)
}

export function androidKeyCode(code: string): KeyCode | undefined {
  const fixed = codeNames[code]
  if (fixed) return AndroidKeyCode[fixed]
  if (/^Key[A-Z]$/.test(code) || /^Digit[0-9]$/.test(code) || /^F([1-9]|1[0-2])$/.test(code) || /^Numpad[0-9]$/.test(code)) {
    return named[code]
  }
  return undefined
}

export function metaState(mod: { alt: boolean; shift: boolean; ctrl: boolean; meta: boolean }): number {
  let state: number = AndroidKeyEventMeta.None
  if (mod.alt) state |= AndroidKeyEventMeta.Alt
  if (mod.shift) state |= AndroidKeyEventMeta.Shift
  if (mod.ctrl) state |= AndroidKeyEventMeta.Ctrl
  if (mod.meta) state |= AndroidKeyEventMeta.Meta
  return state
}
