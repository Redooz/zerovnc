import { describe, expect, test } from "bun:test";
import { keysymsForChord, keysymsForText } from "../../src/application/desktop/keysyms.ts";

describe("keysyms", () => {
  test("Spanish letters and punctuation map to Latin-1 keysyms", () => {
    expect(keysymsForText("Ñá¿¡")).toEqual([0xd1, 0xe1, 0xbf, 0xa1]);
  });

  test("characters beyond Latin-1 use the Unicode keysym range", () => {
    expect(keysymsForText("€")).toEqual([0x010020ac]);
  });

  test("text is split by code point, so emoji count as one key", () => {
    expect(keysymsForText("😀a")).toEqual([0x0101f600, 0x61]);
  });

  test("chords put modifiers first and accept named keys", () => {
    expect(keysymsForChord("ctrl+a")).toEqual([0xffe3, 0x61]);
    expect(keysymsForChord("Return")).toEqual([0xff0d]);
    expect(keysymsForChord("shift+Tab")).toEqual([0xffe1, 0xff09]);
  });

  test("unknown names and empty parts are rejected", () => {
    expect(keysymsForChord("Hyper+x")).toBeNull();
    expect(keysymsForChord("ctrl+")).toBeNull();
    expect(keysymsForChord("Qwerty")).toBeNull();
  });
});
