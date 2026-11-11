// The parts of @metamask/agent-wallet/plugin (7.x) that the `mm recta` commands use, declared here so that building
// @recta/mcp never installs MetaMask's CLI: `mm` provides it when it loads the plugin.
declare module "@metamask/agent-wallet/plugin" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const PluginCommand: abstract new (...args: any[]) => object;
  export const InputFieldType: { readonly Text: "text"; readonly Boolean: "boolean" };
  export function schemaToFlags(schema: Record<string, unknown>): unknown;
  export const CommandError: new (code: string, message: string, hint: string) => Error;
}
