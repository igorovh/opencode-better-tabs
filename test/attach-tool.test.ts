import { expect, test } from "bun:test"
import compiledServer from "../dist/index.js"
import sourceServer from "../src/index"
import { METADATA_KEY } from "../src/sub-sessions"

const setup = async (plugin: typeof sourceServer) => {
  const metadata: Record<string, Record<string, unknown>> = { ses_child: { kept: true } }
  let tool: any
  const ctx: any = {
    tool: { transform: async (edit: (tools: any) => void) => (edit({ add: (info: any) => (tool = info) }), { dispose: async () => {} }) },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, metadata: metadata[sessionID] }),
      update: async (input: { sessionID: string; metadata: Record<string, unknown> }) => void (metadata[input.sessionID] = input.metadata),
    },
  }
  await plugin.setup(ctx)
  return { tool, metadata }
}

for (const [name, plugin] of [
  ["source", sourceServer],
  ["dist", compiledServer],
] as const) {
  test(`${name}: the attach tool links a session to the caller and keeps its other metadata`, async () => {
    const { tool, metadata } = await setup(plugin)
    expect(tool.name).toBe("better_tabs_attach")
    await tool.execute({ sessionID: "ses_child" }, { sessionID: "ses_parent" })
    expect(metadata.ses_child).toEqual({ kept: true, [METADATA_KEY]: { parent: "ses_parent" } })
    await tool.execute({ sessionID: "ses_child", detach: true }, { sessionID: "ses_parent" })
    expect(metadata.ses_child).toEqual({ kept: true, [METADATA_KEY]: { parent: null } })
    const self = await tool.execute({ sessionID: "ses_parent" }, { sessionID: "ses_parent" })
    expect(self.content).toContain("cannot")
  })
}
