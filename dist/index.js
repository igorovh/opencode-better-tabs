// @bun
import { Plugin } from "@opencode/plugin";

var METADATA_KEY = "betterTabs";
function metadataParent(metadata) {
  if (!metadata || typeof metadata !== "object")
    return;
  const entry = metadata[METADATA_KEY];
  if (!entry || typeof entry !== "object")
    return;
  const parent = entry.parent;
  return typeof parent === "string" || parent === null ? parent : undefined;
}
function resolveParents(open, linkOf) {
  const isOpen = new Set(open);
  const result = new Map;
  for (const sessionID of open) {
    const seen = new Set([sessionID]);
    let root;
    let cycle = false;
    for (let id = linkOf(sessionID);id !== undefined && isOpen.has(id); id = linkOf(id)) {
      if (seen.has(id)) {
        cycle = true;
        break;
      }
      seen.add(id);
      root = id;
    }
    if (root && !cycle)
      result.set(sessionID, root);
  }
  return result;
}

var src_default = Plugin.define({
  id: "better-tabs.server",
  async setup(ctx) {
    if (ctx.options?.subSessions === false)
      return;
    const registration = await ctx.tool.transform((tools) => tools.add({
      name: "better_tabs_attach",
      description: "Show another session as a sub-session under this session in the tab bar, for example a session you " + "just started for part of your task. Pass detach: true to show it as a normal tab again.",
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string", description: "ID of the session to attach, such as ses_..." },
          detach: { type: "boolean", description: "Remove the link instead of adding it" }
        },
        required: ["sessionID"],
        additionalProperties: false
      },
      async execute(input, context) {
        const { sessionID, detach } = input;
        if (sessionID === context.sessionID)
          return { content: "A session cannot be its own sub-session." };
        const session = await ctx.session.get({ sessionID });
        const parent = detach ? null : context.sessionID;
        await ctx.session.update({ sessionID, metadata: { ...session.metadata, [METADATA_KEY]: { parent } } });
        return {
          content: detach ? `${sessionID} is a normal tab again.` : `${sessionID} now shows under this session in the tab bar.`
        };
      }
    }));
    return registration.dispose;
  }
});
export {
  src_default as default
};
