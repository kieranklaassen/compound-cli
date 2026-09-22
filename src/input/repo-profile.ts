import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "README.md"];
const INSTRUCTION_LINES = 40;
const MANIFESTS = [
  "package.json",
  "Gemfile",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "Package.swift",
  "mix.exs",
  "composer.json",
  "Dockerfile",
];

export type RepoProfile = {
  repository: string;
  instructions: Record<string, string>;
  top_level: string[];
  manifests: string[];
  declared_packs: string[];
};

/** What a repository is about, for `packs suggest` when no work context is given (plan KTD13). */
export function repoProfile(repoRoot: string, declaredPacks: readonly string[]): RepoProfile {
  const instructions: Record<string, string> = {};
  for (const name of INSTRUCTION_FILES) {
    const path = join(repoRoot, name);
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    instructions[name] = readFileSync(path, "utf8")
      .split(/\r?\n/)
      .slice(0, INSTRUCTION_LINES)
      .join("\n")
      .trim();
  }
  const entries = readdirSync(repoRoot, { withFileTypes: true });
  return {
    repository: basename(repoRoot),
    instructions,
    top_level: entries
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
      .map((e) => `${e.name}/`)
      .sort(),
    manifests: MANIFESTS.filter((name) => entries.some((e) => e.isFile() && e.name === name)),
    declared_packs: [...declaredPacks],
  };
}
