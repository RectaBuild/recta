// Compiled in CI against @elizaos/core 2.0.5 (installed there, not a dependency): the plugin must be an elizaOS Plugin.
import type { Action, Plugin } from "@elizaos/core";
import { rectaElizaPlugin, rectaPlugin } from "../dist/elizaos.js";

export const plugin: Plugin = rectaPlugin;
export const actions: Action[] = rectaElizaPlugin({}).actions;
