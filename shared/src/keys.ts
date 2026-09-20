/** Key-chord parsing for press_key ("Escape", "ArrowDown", "Control+a", "Shift+Tab"). Shared so validation and execution agree. */

export interface KeyChord {
  /** KeyboardEvent.key */
  key: string;
  /** KeyboardEvent.code */
  code: string;
  /** Legacy keyCode / CDP windowsVirtualKeyCode. */
  keyCode: number;
  /** The character this key inserts, when it inserts one and no command modifier is held. */
  text: string | null;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

const MODIFIERS: Record<string, "alt" | "ctrl" | "meta" | "shift"> = {
  alt: "alt",
  option: "alt",
  opt: "alt",
  ctrl: "ctrl",
  control: "ctrl",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  win: "meta",
  shift: "shift",
};

const NAMED: Record<string, [key: string, code: string, keyCode: number, text: string | null]> = {
  enter: ["Enter", "Enter", 13, "\r"],
  return: ["Enter", "Enter", 13, "\r"],
  escape: ["Escape", "Escape", 27, null],
  esc: ["Escape", "Escape", 27, null],
  tab: ["Tab", "Tab", 9, null],
  backspace: ["Backspace", "Backspace", 8, null],
  delete: ["Delete", "Delete", 46, null],
  del: ["Delete", "Delete", 46, null],
  space: [" ", "Space", 32, " "],
  spacebar: [" ", "Space", 32, " "],
  arrowup: ["ArrowUp", "ArrowUp", 38, null],
  up: ["ArrowUp", "ArrowUp", 38, null],
  arrowdown: ["ArrowDown", "ArrowDown", 40, null],
  down: ["ArrowDown", "ArrowDown", 40, null],
  arrowleft: ["ArrowLeft", "ArrowLeft", 37, null],
  left: ["ArrowLeft", "ArrowLeft", 37, null],
  arrowright: ["ArrowRight", "ArrowRight", 39, null],
  right: ["ArrowRight", "ArrowRight", 39, null],
  home: ["Home", "Home", 36, null],
  end: ["End", "End", 35, null],
  pageup: ["PageUp", "PageUp", 33, null],
  pagedown: ["PageDown", "PageDown", 34, null],
};

const PUNCT_CODES: Record<string, [code: string, keyCode: number]> = {
  "-": ["Minus", 189],
  "=": ["Equal", 187],
  "[": ["BracketLeft", 219],
  "]": ["BracketRight", 221],
  "\\": ["Backslash", 220],
  ";": ["Semicolon", 186],
  "'": ["Quote", 222],
  ",": ["Comma", 188],
  ".": ["Period", 190],
  "/": ["Slash", 191],
  "`": ["Backquote", 192],
};

/** Returns null when the chord names a key we don't know — callers reject rather than guess. */
export function parseKeyChord(raw: string): KeyChord | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // "Control++" / a bare "+" mean the plus key itself.
  const parts = trimmed === "+" ? ["+"] : trimmed.endsWith("++") ? [...trimmed.slice(0, -2).split("+"), "+"] : trimmed.split("+");
  const chord: KeyChord = { key: "", code: "", keyCode: 0, text: null, alt: false, ctrl: false, meta: false, shift: false };
  const keyPart = parts.pop()!.trim();
  for (const p of parts) {
    const mod = MODIFIERS[p.trim().toLowerCase()];
    if (!mod) return null;
    chord[mod] = true;
  }
  const named = NAMED[keyPart.toLowerCase()];
  if (named) {
    [chord.key, chord.code, chord.keyCode, chord.text] = named;
  } else if (/^f([1-9]|1[0-2])$/i.test(keyPart)) {
    const n = Number(keyPart.slice(1));
    chord.key = chord.code = `F${n}`;
    chord.keyCode = 111 + n;
  } else if (keyPart.length === 1) {
    const ch = keyPart;
    if (/[a-z]/i.test(ch)) {
      chord.key = chord.shift ? ch.toUpperCase() : ch.toLowerCase();
      chord.code = `Key${ch.toUpperCase()}`;
      chord.keyCode = ch.toUpperCase().charCodeAt(0);
    } else if (/[0-9]/.test(ch)) {
      chord.key = ch;
      chord.code = `Digit${ch}`;
      chord.keyCode = ch.charCodeAt(0);
    } else {
      const punct = PUNCT_CODES[ch];
      chord.key = ch;
      chord.code = punct?.[0] ?? "";
      chord.keyCode = punct?.[1] ?? 0;
    }
    chord.text = chord.key;
  } else {
    return null;
  }
  if (chord.alt || chord.ctrl || chord.meta) chord.text = null;
  return chord;
}
