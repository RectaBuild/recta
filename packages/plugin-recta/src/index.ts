/**
 * @recta/plugin-recta: Recta's free tools as an elizaOS plugin, for the elizaOS plugin registry. The plugin itself is
 * `@recta/mcp/elizaos` (one implementation, the same checks): `RECTA_PREFLIGHT` before bridging (total cost, arrival
 * time and any proven cheaper route), `RECTA_FIT` and `RECTA_TRIAL_EVALUATION`. Keyless: it never signs or sends.
 */
import { rectaPlugin } from "@recta/mcp/elizaos";

export { rectaElizaPlugin, rectaPlugin, type RectaElizaOptions, type ElizaPluginLike, type ElizaActionLike, type ElizaActionResult, type ElizaRuntimeLike } from "@recta/mcp/elizaos";
export default rectaPlugin;
