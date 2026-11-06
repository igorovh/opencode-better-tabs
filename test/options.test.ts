import { expect, test } from "bun:test"
import { DEFAULT_KEYS, readOptions } from "../src/options"

test("defaults to alt and the built-in key pool", () => {
  expect(readOptions({})).toEqual({ modifier: "alt", slotKeys: [...DEFAULT_KEYS], warnings: [] })
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
