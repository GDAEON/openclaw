import type { PluginRuntime } from "openclaw/plugin-sdk";

let consoleRuntime: PluginRuntime | null = null;

export function setConsoleRuntime(runtime: PluginRuntime) {
  consoleRuntime = runtime;
}

export function getConsoleRuntime(): PluginRuntime {
  if (!consoleRuntime) {
    throw new Error("Console runtime is not initialized");
  }
  return consoleRuntime;
}
