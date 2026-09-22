export type DiffSummary = {
  files: string[];
  symbols: string[];
  hunks: string[];
  added_lines: number;
  removed_lines: number;
  excerpt: string;
};

const EXCERPT_LINES = 80;
const EXCERPT_CHARS = 4000;

const SYMBOL_PATTERNS = [
  /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
  /\b(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /\b(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
  /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/,
  /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
  /^\s*def\s+([A-Za-z_]\w*)/,
  /^\s*(?:module|class)\s+([A-Z]\w*(?:::\w+)*)/,
  // A class method or object method: `async name(args)` or `name(args): Type {`.
  /^\s*(?:(?:public|private|protected|static|async|readonly|override)\s+)*([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*(?::\s*[^{;]+)?\{\s*$/,
];

const NOT_SYMBOLS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "function",
  "constructor",
  "with",
  "do",
  "else",
  "try",
  "await",
  "typeof",
  "new",
  "it",
  "test",
  "describe",
  "expect",
]);

/** A bounded reading of a unified diff: paths, symbol-like names, hunk contexts, and an excerpt. */
export function parseUnifiedDiff(text: string): DiffSummary {
  const files: string[] = [];
  const symbols = new Set<string>();
  const hunks: string[] = [];
  const excerpt: string[] = [];
  let added = 0;
  let removed = 0;
  for (const line of text.split(/\r?\n/)) {
    const gitHeader = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (gitHeader) {
      pushUnique(files, gitHeader[2] ?? gitHeader[1] ?? "");
      continue;
    }
    const plusHeader = line.match(/^\+\+\+ (?:b\/)?(.+)$/);
    if (plusHeader && plusHeader[1] !== "/dev/null") {
      pushUnique(files, plusHeader[1] ?? "");
      continue;
    }
    if (line.startsWith("--- ")) continue;
    const hunk = line.match(/^@@[^@]*@@\s*(.*)$/);
    if (hunk) {
      if (hunk[1]) hunks.push(hunk[1].trim());
      continue;
    }
    if (line.startsWith("+") || line.startsWith("-")) {
      if (line.startsWith("+")) added++;
      else removed++;
      const content = line.slice(1);
      for (const pattern of SYMBOL_PATTERNS) {
        const match = content.match(pattern);
        if (match?.[1] && !NOT_SYMBOLS.has(match[1])) symbols.add(match[1]);
      }
      if (excerpt.length < EXCERPT_LINES && content.trim()) excerpt.push(line.trimEnd());
    }
  }
  return {
    files,
    symbols: [...symbols].slice(0, 60),
    hunks: hunks.slice(0, 40),
    added_lines: added,
    removed_lines: removed,
    excerpt: excerpt.join("\n").slice(0, EXCERPT_CHARS),
  };
}

function pushUnique(list: string[], value: string): void {
  if (value && !list.includes(value)) list.push(value);
}
