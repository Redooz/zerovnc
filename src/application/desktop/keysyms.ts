// X11 keysyms for text entry and key chords. Keysyms are the desktop input
// vocabulary the executor sends; they are not VNC wire types.

const MODIFIERS: Record<string, number> = {
  ctrl: 0xffe3,
  control: 0xffe3,
  shift: 0xffe1,
  alt: 0xffe9,
  meta: 0xffe7,
  super: 0xffeb,
};

const NAMED: Record<string, number> = {
  return: 0xff0d,
  enter: 0xff0d,
  tab: 0xff09,
  escape: 0xff1b,
  esc: 0xff1b,
  backspace: 0xff08,
  delete: 0xffff,
  space: 0x20,
  home: 0xff50,
  left: 0xff51,
  up: 0xff52,
  right: 0xff53,
  down: 0xff54,
  pageup: 0xff55,
  pagedown: 0xff56,
  end: 0xff57,
};

// Keysym for one Unicode code point. Latin-1 maps to itself; other characters use
// the Unicode keysym range (0x01000000 + code point).
export function keysymForCodePoint(codePoint: number): number {
  if ((codePoint >= 0x20 && codePoint <= 0x7e) || (codePoint >= 0xa0 && codePoint <= 0xff)) {
    return codePoint;
  }
  return 0x01000000 + codePoint;
}

// Keysyms for typing text, one per code point, in order.
export function keysymsForText(text: string): number[] {
  return [...text].map((character) => keysymForCodePoint(character.codePointAt(0)!));
}

// Keysyms for a key chord such as "Return", "Tab", "ctrl+a", or "shift+Tab".
// Modifiers come first; the final part is the key itself. Returns null when a part
// is not recognized.
export function keysymsForChord(chord: string): number[] | null {
  const parts = chord.split("+").map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => part === "")) return null;
  const keys: number[] = [];
  const last = parts[parts.length - 1]!;
  for (const modifier of parts.slice(0, -1)) {
    const keysym = MODIFIERS[modifier.toLowerCase()];
    if (keysym === undefined) return null;
    keys.push(keysym);
  }
  const named = NAMED[last.toLowerCase()];
  if (named !== undefined) {
    keys.push(named);
  } else if ([...last].length === 1) {
    keys.push(keysymForCodePoint(last.codePointAt(0)!));
  } else {
    return null;
  }
  return keys;
}
