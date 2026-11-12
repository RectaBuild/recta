// After the build: checks that package.json#mm (the permissions `mm plugins install` asks the user to consent to)
// matches the command table in src/mm/specs.ts exactly, and writes oclif.manifest.json, which `mm` requires of every
// plugin so that it never imports a plugin's commands just to list them. Nothing here imports MetaMask's packages.
import { readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { COMMAND_SPECS } from "../dist/mm/specs.js";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

export function expectedMmManifest(minCliVersion) {
  return {
    schemaVersion: 1,
    minCliVersion,
    capabilities: [],
    commands: COMMAND_SPECS.map((c) => ({
      id: c.id,
      capabilities: [...c.capabilities],
      dataAccess: [...c.dataAccess],
      targetChains: c.targetChains === "any" ? "any" : [...c.targetChains],
    })),
  };
}

export function oclifManifest(version, name) {
  const commands = {};
  for (const c of COMMAND_SPECS) {
    const flags = {};
    for (const input of c.inputs) {
      flags[input.flag] = input.kind === "boolean"
        ? { name: input.flag, type: "boolean", allowNo: false, description: input.message }
        : { name: input.flag, type: "option", description: input.message, required: input.required === true, multiple: false, hasDynamicHelp: false };
    }
    const [topic, command] = c.id.split(":");
    commands[c.id] = {
      aliases: [],
      args: {},
      description: c.description,
      flags,
      hasDynamicHelp: false,
      hiddenAliases: [],
      id: c.id,
      pluginAlias: name,
      pluginName: name,
      pluginType: "core",
      strict: true,
      isESM: true,
      relativePath: ["dist", "mm", "commands", topic, `${command}.js`],
    };
  }
  return { commands, version };
}

if (process.argv[1] !== undefined && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  const expected = expectedMmManifest(pkg.mm?.minCliVersion);
  if (!isDeepStrictEqual(pkg.mm, expected)) {
    console.error("package.json#mm does not match src/mm/specs.ts. Expected:\n" + JSON.stringify(expected, null, 2));
    process.exit(1);
  }
  writeFileSync(new URL("oclif.manifest.json", root), `${JSON.stringify(oclifManifest(pkg.version, pkg.name), null, 2)}\n`);
  console.log(`oclif.manifest.json: ${COMMAND_SPECS.length} commands`);
}
