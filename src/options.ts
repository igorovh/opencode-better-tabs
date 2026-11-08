// alt+a/b/d/e/f edit the prompt (line start/end, word moves, word delete), so they are skipped.
export const DEFAULT_KEYS = "123456789cghijklmnopqrstuvwxyz"
// Many terminals send ctrl+digit as a plain digit, so the modifier defaults to alt.
export const DEFAULT_MODIFIER = "alt"
// Closing a tab keeps the session, so asking every time is opt-in.
export const DEFAULT_CONFIRM_CLOSE = false
const MODIFIERS = new Set(["alt", "ctrl", "shift", "meta", "super", "hyper"])

export type Options = { modifier: string; slotKeys: string[]; confirmClose: boolean; warnings: string[] }

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
  return { modifier, slotKeys, confirmClose, warnings }
}
