// alt+a/b/d/e/f edit the prompt (line start/end, word moves, word delete), so they are skipped.
export const DEFAULT_KEYS = "123456789cghijklmnopqrstuvwxyz"
// Many terminals send ctrl+digit as a plain digit, so the modifier defaults to alt.
export const DEFAULT_MODIFIER = "alt"
// Closing a tab keeps the session, so asking every time is opt-in.
export const DEFAULT_CONFIRM_CLOSE = false
// Rows are one line of text; padding adds a blank line above and below it, opt-in.
export const DEFAULT_PADDING = 0
const MAX_PADDING = 3
const MODIFIERS = new Set(["alt", "ctrl", "shift", "meta", "super", "hyper"])

export type Options = { modifier: string; slotKeys: string[]; confirmClose: boolean; padding: number; warnings: string[] }

export function readOptions(raw: Record<string, unknown> | undefined): Options {
  const warnings: string[] = []
  let modifier = DEFAULT_MODIFIER
  if (raw?.modifier !== undefined) {
    const value = typeof raw.modifier === "string" ? raw.modifier.trim().toLowerCase() : ""
    if (value && value.split("+").every((part) => MODIFIERS.has(part))) modifier = value
    else warnings.push(`Ignoring modifier ${JSON.stringify(raw.modifier)}; using ${DEFAULT_MODIFIER}`)
  }
  let keys = DEFAULT_KEYS
  if (raw?.keys !== undefined) {
    if (typeof raw.keys === "string" && /[a-z0-9]/i.test(raw.keys)) keys = raw.keys
    else warnings.push(`Ignoring keys ${JSON.stringify(raw.keys)}; it needs at least one of a-z or 0-9`)
  }
  const slotKeys = [...new Set(keys.toLowerCase())].filter((key) => /^[a-z0-9]$/.test(key))
  let confirmClose = DEFAULT_CONFIRM_CLOSE
  if (raw?.confirmClose !== undefined) {
    if (typeof raw.confirmClose === "boolean") confirmClose = raw.confirmClose
    else warnings.push(`Ignoring confirmClose ${JSON.stringify(raw.confirmClose)}; it needs true or false`)
  }
  let padding = DEFAULT_PADDING
  if (raw?.padding !== undefined) {
    if (typeof raw.padding === "number" && Number.isInteger(raw.padding) && raw.padding >= 0 && raw.padding <= MAX_PADDING)
      padding = raw.padding
    else warnings.push(`Ignoring padding ${JSON.stringify(raw.padding)}; it needs a whole number from 0 to ${MAX_PADDING}`)
  }
  return { modifier, slotKeys, confirmClose, padding, warnings }
}
