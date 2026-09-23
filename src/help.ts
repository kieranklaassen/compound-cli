import pkg from "../package.json" with { type: "json" };
import { EXIT_CODE_DOCS } from "./exit-codes.ts";

export const VERSION: string = pkg.version;

const EXIT_LINES = EXIT_CODE_DOCS.map(
  (entry) => `  ${entry.code}  ${entry.name.padEnd(16)}${entry.meaning}`,
).join("\n");

export const MAIN_HELP = `compound ${VERSION}
The optional tool for working on compound docs: learnings, pack rules, frontmatter validation and repair, recall, and benches.

Usage
  compound <command> [options]
  bunx compound-cli <command> [options]

Commands
  find      Recall learnings and pack rules relevant to a work context
  packs     resolve | list | suggest | add: declared and suggested Compound Packs
  bench     Run a gold set of cases and report recall, cost, and latency
  doctor    Check the key, the corpus, and pack sources
  audit     Validate learning frontmatter against the schema; --fix repairs it
  version   Print the version

Global options
  --root <dir>   Repository root (default: the enclosing git checkout)
  --debug        Print the stack trace when a command fails
  --help, -h     Show help for a command

Environment
  TYPESAFE_API_KEY          Required by find, packs suggest, and bench
  COMPOUND_CASSETTE_MODE    off (default) | record | replay | auto
  COMPOUND_CASSETTE_DIR     Where cassettes are written or read
  CE_PACKS_CACHE_ROOT       Override the git cache for pack sources
  CE_PACKS_GIT_TIMEOUT      Seconds allowed per git clone (default 60)

Exit codes
${EXIT_LINES}

Run \`compound <command> --help\` for the options of one command.
`;

export const FIND_HELP = `compound find: recall learnings and pack rules relevant to a work context

Usage
  compound find [activity] [options]
  git diff main | compound find --diff - --gate --json

Input channels (at least one)
  [activity]                Plain-language sentence describing the work
  --concept <text>          Repeatable. Concepts the work touches
  --decision <text>         Repeatable. Decisions under consideration
  --domain <text>           Repeatable. Domains or areas involved
  --module <text>           Repeatable. Modules the work changes
  --path <file>             Repeatable. Changed file paths
  --diff <file|->           Unified diff to read (- for stdin)
  --plan <file>             Unified plan or brainstorm to read (the judge reads up to 8000 chars of it)
  --doc <file>              Draft learning to read (required with --overlap)

Modes
  --gate                    Answer "is there relevant knowledge" as one probability
  --overlap                 Judge --doc against existing learnings on five dimensions

Judging
  --threshold <0..1>        Hit threshold for learnings and rules (default 0.6; 0.5 with --frontmatter-only)
  --tier-one-threshold <p>  Tier-one pass to earn a body read (default 0.3)
  --frontmatter-only        Skip tier two; tier-one scores are final
  --batch <n>               Candidates per tier-one request (default 48)
  --parallel <n>            Concurrent requests (default 4)
  --candidate-cap <n>       Cap on judged candidates; those without applies_when are cut first (default 400)
  --excerpt-chars <n>       Body excerpt budget per document (default 6000)
  --model <name>            TypeSafe model (default jev-latest)

Filters
  --kind <k>                Repeatable: solution | pack_rule | pack_candidate
  --problem-type <t>        Repeatable frontmatter problem_type
  --module-filter <m>       Repeatable frontmatter module
  --tag <t>                 Repeatable frontmatter tag
  --pack <id>               Repeatable pack id
  --no-sources              Do not consult known pack sources for candidates

Output
  --json                    Structured output (schema_version 1)
  --compact                 One tab-separated row per hit, then a # trailer
  --root <dir>              Repository root

Exit codes: 0 success (hits or nothing_relevant), 2 usage, 3 not configured,
4 missing corpus, 5 judge failure, 1 internal.
`;

export const PACKS_HELP = `compound packs: declared and suggested Compound Packs

Usage
  compound packs resolve [--json]        Roots for the declared packs (packs-resolve.py shape)
  compound packs list [--json]           Declared packs with their rules
  compound packs suggest [activity] [--concept ...] [--json] [--refresh]
                                         Undeclared packs whose README matches the work or repo
  compound packs add <id> [--yes]        Append the packs: entry for a suggested pack

Options
  --root <dir>              Repository root
  --threshold <0..1>        Relevance threshold for suggest (default 0.5)
  --model <name>            TypeSafe model (default jev-latest)
  --refresh                 Re-clone known git sources before suggesting
  --yes                     Write without confirmation (add)
`;

export const BENCH_HELP = `compound bench: run a gold set and report recall, cost, and latency

Usage
  compound bench --cases <file> [--root <checkout>] [--json] [--out <file>]

Options
  --cases <file>            Cases file (see bench/cases/ce-plugin.json)
  --root <dir>              Corpus checkout; overrides the cases file's corpus block
  --threshold <0..1>        Relevance threshold (default 0.6)
  --sweep <p,p,...>         Re-score the same judgments at several thresholds
  --frontmatter-only        Skip tier two
  --enforce-floor           Exit 1 when a floor in the cases file is not met, or a replay's threshold pin is missing or differs
  --jobs <n>                Cases to run concurrently (default 1)
  --precision-floor <p>     Report the best recall whose precision lower bound meets p
  --json                    Full result as JSON
  --out <file>              Also write the JSON result to a file
  --model <name>            TypeSafe model (default jev-latest)
`;

export const AUDIT_HELP = `compound audit: validate learning and pack frontmatter against the schema, and repair it

Usage
  compound audit [--root <dir>] [--json] [--strict] [--packs] [--pack-dir <dir>]... [--stats] [--report <file>]
  compound audit --fix [--jev] [--dry-run | --yes] [--root <dir>] [--json] [--report <file>]

Checks every file under <root>/solutions/ against the schema in effect for the repository:
the CLI's defaults (the plugin's schema.yaml) layered with the repository's own
compound.schema.fields in .compound-engineering/config.yaml (see docs/config.md). Frontmatter
that parses and quotes hazards, no bare null/true/123 in a string field, title, date,
problem_type, module, component, severity, the bug-track fields (symptoms, root_cause,
resolution_type), and the findability fields applies_when (present, specific, at most 5)
and tags (lowercase, at most 8). Errors are schema and parser-safety violations; warnings
are findability gaps. Exit 6 when a file has an error; --strict makes warnings count.
Every finding names where its rule came from (default, config.yaml, config.local.yaml).

--fix is a linter's fix: the deterministic repairs only, no key needed. A date from the
file's history or name, enum spelling, tag format, scalars wrapped in lists, duplicates
removed, a title from the first heading, a value cut at ' #' recovered, a bare literal
quoted. Every change is a diff of the frontmatter block; bodies are never touched.
--fix --jev adds the fixers that ask the judge (TYPESAFE_API_KEY, exit 3 without it):
problem_type, severity, resolution_type, and any custom enum as a choice over the values
in effect for this repository; module, component, and root_cause as a choice over the
values this corpus already uses; tags as judgments over the corpus's own tags; applies_when
and symptoms from sentences extracted from the body and judged one by one. Nothing is
invented: when no candidate passes, the field is marked needs_author with the reason.

Options
  --root <dir>              Repository root (default: the git root of the working directory)
  --json                    Print the report as JSON (schema_version 1)
  --strict                  Warnings fail too (or compound.audit.strict: true in the config)
  --packs                   Also audit the rules and READMEs of declared packs (never fixed)
  --pack-dir <dir>          Pack-authoring mode: every child of <dir> is a pack with a README
                            and rules (or compound.audit.pack_dirs in the config); repeatable
  --stats                   Field coverage of the learnings, and README coverage per pack rule
  --report <file>           Write the JSON report to a file whatever the terminal format
  --fix                     Propose and apply the deterministic repairs
  --jev                     With --fix: add the Jev fixers (needs the key)
  --dry-run                 With --fix: show the diffs, write nothing
  --yes                     With --fix: apply without the prompt (required off a TTY)
  --model <name>            With --fix --jev: TypeSafe model (default jev-latest)

The Jev fixers hold answers to bars the report echoes under "thresholds": a Choice below
0.4, a tag below 0.6, or a situation or symptom below 0.7 goes to the author instead.
The exit code always describes the files on disk: after --dry-run or a declined prompt
the summary's "after fixing" (JSON: summary.after_fix) says what a --yes run would leave.

Exit codes: 0 all files pass; 6 a file fails; 2 usage or a broken compound: config block;
3 --fix --jev without a key; 4 no corpus; 5 the judge failed during --fix --jev (nothing
is written then).
`;

export const DOCTOR_HELP = `compound doctor: check the key, the corpus, and pack sources

Usage
  compound doctor [--root <dir>] [--json] [--strict]

Options
  --strict                  Exit 3 when TYPESAFE_API_KEY is missing
  --no-sources              Skip reachability checks of known pack sources
`;
