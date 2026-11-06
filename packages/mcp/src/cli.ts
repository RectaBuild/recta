#!/usr/bin/env node
import { main } from "./index.js";

main().catch((e: unknown) => {
  process.stderr.write(`recta-mcp: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
