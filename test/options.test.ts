import { expect, test } from "bun:test"
import { DEFAULT_CONFIRM_CLOSE, DEFAULT_KEYS, DEFAULT_PADDING, readOptions } from "../src/options"

test("defaults to alt, the built-in key pool, no close confirmation and unpadded rows", () => {
  expect(readOptions({})).toEqual({
    modifier: "alt",
    slotKeys: [...DEFAULT_KEYS],
    confirmClose: DEFAULT_CONFIRM_CLOSE,
    padding: DEFAULT_PADDING,
    warnings: [],
  })
})

test("accepts a combined modifier and drops unusable keys", () => {
  const options = readOptions({ modifier: "Ctrl+Shift", keys: "1a1-B" })
  expect(options.modifier).toBe("ctrl+shift")
  expect(options.slotKeys).toEqual(["1", "a", "b"])
  expect(options.warnings).toEqual([])
})

test("falls back with a warning on invalid values instead of binding dead keys", () => {
  const options = readOptions({ modifier: "alt+q", keys: "!!" })
  expect(options.modifier).toBe("alt")
  expect(options.slotKeys).toEqual([...DEFAULT_KEYS])
  expect(options.warnings).toHaveLength(2)
})

test("reads confirmClose and rejects values that are not booleans", () => {
  expect(readOptions({ confirmClose: true }).confirmClose).toBe(true)
  expect(readOptions({ confirmClose: false }).warnings).toEqual([])
  for (const confirmClose of ["true", 1, null]) {
    const options = readOptions({ confirmClose })
    expect(options.confirmClose).toBe(DEFAULT_CONFIRM_CLOSE)
    expect(options.warnings).toHaveLength(1)
  }
})

test("reads padding and rejects values that are not a whole number in range", () => {
  expect(readOptions({ padding: 2 }).padding).toBe(2)
  expect(readOptions({ padding: 0 }).warnings).toEqual([])
  for (const padding of ["1", 1.5, -1, 4, null]) {
    const options = readOptions({ padding })
    expect(options.padding).toBe(DEFAULT_PADDING)
    expect(options.warnings).toHaveLength(1)
  }
})
