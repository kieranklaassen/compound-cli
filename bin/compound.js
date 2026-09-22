#!/usr/bin/env node
// Entry point for the `compound` and `compound-cli` bins. A published package
// ships dist/cli.js; a git checkout (bunx github:..., bun add github:...) has
// no build, so under Bun the TypeScript source runs directly and under Node
// the message says how to get a build.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const built = join(root, "dist", "cli.js");

if (existsSync(built)) {
  await import(pathToFileURL(built).href);
} else if (typeof Bun !== "undefined") {
  await import(pathToFileURL(join(root, "src", "bin.ts")).href);
} else {
  process.stderr.write(
    "compound: this checkout has no dist/ build. Run it with Bun (bunx --bun github:kieranklaassen/compound-cli ...) or build it first (bun run build).\n",
  );
  process.exitCode = 1;
}
