import { describe, expect, it } from "vitest"
import { insertNewlineAt } from "../src/composer-newline.js"

describe("insertNewlineAt", () => {
  it("appends when the caret is at the end", () => {
    const r = insertNewlineAt({
      value: "fix the relay",
      selectionStart: 13,
      selectionEnd: 13,
    })
    expect(r.value).toBe("fix the relay\n")
    expect(r.caret).toBe(14)
  })

  it("splits at the caret when it is in the middle", () => {
    // The common case on a phone: typed a line, tapped the button, keep going
    // on the next one.
    const r = insertNewlineAt({
      value: "onetwo",
      selectionStart: 3,
      selectionEnd: 3,
    })
    expect(r.value).toBe("one\ntwo")
    expect(r.caret).toBe(4)
  })

  it("replaces a selection instead of keeping it", () => {
    const r = insertNewlineAt({
      value: "keep DROP keep",
      selectionStart: 5,
      selectionEnd: 10,
    })
    expect(r.value).toBe("keep \nkeep")
    expect(r.caret).toBe(6)
  })

  it("works on an empty field", () => {
    const r = insertNewlineAt({ value: "", selectionStart: 0, selectionEnd: 0 })
    expect(r.value).toBe("\n")
    expect(r.caret).toBe(1)
  })

  it("clamps indices that run past the text", () => {
    // A draft restore can write a value while the element still reports the
    // caret from the previous one. Slicing unclamped would not throw — it would
    // insert in the wrong place, which is worse.
    const r = insertNewlineAt({
      value: "abc",
      selectionStart: 99,
      selectionEnd: 99,
    })
    expect(r.value).toBe("abc\n")
    expect(r.caret).toBe(4)
  })

  it("treats a reversed selection as a point", () => {
    // Browsers never report end before start; this is the guard, and the
    // behaviour it buys is "insert at the start index" rather than a slice that
    // runs backwards.
    const r = insertNewlineAt({
      value: "abcdef",
      selectionStart: 4,
      selectionEnd: 2,
    })
    expect(r.value).toBe("abcd\nef")
    expect(r.caret).toBe(5)
  })

  it("keeps existing line breaks alone", () => {
    const r = insertNewlineAt({
      value: "a\nb",
      selectionStart: 1,
      selectionEnd: 1,
    })
    expect(r.value).toBe("a\n\nb")
    expect(r.caret).toBe(2)
  })
})
