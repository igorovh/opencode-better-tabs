// Session metadata key that the agent tool sets and the tab bar reads.
export const METADATA_KEY = "betterTabs"

// The parent a session asks for, from session metadata: a string to attach, null to detach, undefined for none.
export function metadataParent(metadata: unknown): string | null | undefined {
  if (!metadata || typeof metadata !== "object") return undefined
  const entry = (metadata as Record<string, unknown>)[METADATA_KEY]
  if (!entry || typeof entry !== "object") return undefined
  const parent = (entry as Record<string, unknown>).parent
  return typeof parent === "string" || parent === null ? parent : undefined
}

// Maps each open sub-session to the top open tab above it. Links to closed tabs and cycles are ignored.
export function resolveParents(open: readonly string[], linkOf: (sessionID: string) => string | undefined) {
  const isOpen = new Set(open)
  const result = new Map<string, string>()
  for (const sessionID of open) {
    const seen = new Set([sessionID])
    let root: string | undefined
    let cycle = false
    for (let id = linkOf(sessionID); id !== undefined && isOpen.has(id); id = linkOf(id)) {
      if (seen.has(id)) {
        cycle = true
        break
      }
      seen.add(id)
      root = id
    }
    if (root && !cycle) result.set(sessionID, root)
  }
  return result
}
