import { Plugin } from "@opencode/plugin"
import { METADATA_KEY } from "./sub-sessions"

// The tab bar lives in the TUI entry; the server part only lets an agent attach sub-sessions to its own tab.
export default Plugin.define({
  id: "better-tabs.server",
  async setup(ctx) {
    // The server reads its options from opencode.jsonc, not from the TUI's cli.json.
    if (ctx.options?.subSessions === false) return
    const registration = await ctx.tool.transform((tools) =>
      tools.add({
        name: "better_tabs_attach",
        description:
          "Show another session as a sub-session under this session in the tab bar, for example a session you " +
          "just started for part of your task. Pass detach: true to show it as a normal tab again.",
        input: {
          type: "object",
          properties: {
            sessionID: { type: "string", description: "ID of the session to attach, such as ses_..." },
            detach: { type: "boolean", description: "Remove the link instead of adding it" },
          },
          required: ["sessionID"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const { sessionID, detach } = input as { sessionID: string; detach?: boolean }
          if (sessionID === context.sessionID) return { content: "A session cannot be its own sub-session." }
          const session = await ctx.session.get({ sessionID })
          const parent = detach ? null : context.sessionID
          await ctx.session.update({ sessionID, metadata: { ...session.metadata, [METADATA_KEY]: { parent } } })
          return {
            content: detach
              ? `${sessionID} is a normal tab again.`
              : `${sessionID} now shows under this session in the tab bar.`,
          }
        },
      }),
    )
    return registration.dispose
  },
})
