import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { consolePlugin } from "./src/channel.js";
import { setConsoleRuntime } from "./src/runtime.js";

const plugin = {
  id: "console",
  name: "Console",
  description: "Console channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setConsoleRuntime(api.runtime);
    api.registerChannel({ plugin: consolePlugin });
  },
};

export default plugin;
