import { Plugin } from "@opencode/plugin"

// All behavior lives in the TUI entry; the server entry exists for directory-plugin discovery.
export default Plugin.define({
  id: "better-tabs.server",
  setup() {},
})
