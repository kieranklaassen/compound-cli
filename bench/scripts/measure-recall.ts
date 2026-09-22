/**
 * Measurement harness for optimization runs. Prints one flat JSON object.
 *
 * Environment:
 *   TYPESAFE_API_KEY      required (misses in the dev cassettes are recorded live)
 *   CORA_ROOT             checkout whose docs/solutions is the private corpus
 *   CORA_CASES            cases file for the dev (or held-out) split
 *   CORA_CASSETTES        cassette directory for that split (auto mode: replay hits, record misses)
 *   PUBLIC_CASSETTES      scratch copy of bench/fixtures/cassettes/ce-plugin (auto mode)
 *   PRECISION_FLOOR       precision lower bound the primary metric must respect (default 0.30)
 *   LATENCY_CASES         how many cases to run live for the latency probe (default 12; 0 skips)
 *   JOBS                  concurrent cases for the recall run (default 4)
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "..");
const env = process.env;
const need = (name: string): string => {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const coraRoot = need("CORA_ROOT");
const coraCases = need("CORA_CASES");
const coraCassettes = need("CORA_CASSETTES");
const publicCassettes = env.PUBLIC_CASSETTES ?? resolve(root, "bench/fixtures/cassettes/ce-plugin");
const floor = Number(env.PRECISION_FLOOR ?? "0.30");
const latencyCases = Number(env.LATENCY_CASES ?? "12");
const jobs = env.JOBS ?? "4";

type Report = {
  aggregate: {
    macro_recall: number | null;
    micro_recall: number | null;
    precision_lower_bound: number | null;
    negatives_correct: number | null;
    labeling_errors: number;
    positive_cases: number;
  };
  f05: number | null;
  recall_at_precision_floor: {
    recall: number | null;
    macro_recall: number | null;
    threshold: number | null;
    precision_lower_bound: number | null;
    negatives_correct: number | null;
    f05: number | null;
  } | null;
  latency_ms: { median: number; p90: number; mean: number };
  cost: { total_usd: number; mean_usd: number; requests: number; input_tokens: number };
  cases: Array<{ id: string; negative: boolean; wall_ms: number }>;
};

function bench(args: string[], extraEnv: Record<string, string>): Report {
  const proc = spawnSync("bun", ["run", resolve(root, "src/bin.ts"), "bench", "--json", ...args], {
    cwd: root,
    env: { ...env, ...extraEnv },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (proc.status !== 0) {
    throw new Error(`bench ${args.join(" ")} failed (exit ${proc.status}): ${proc.stderr.slice(-2000)}`);
  }
  return JSON.parse(proc.stdout) as Report;
}

const dev = bench(
  ["--cases", coraCases, "--root", coraRoot, "--jobs", jobs, "--precision-floor", String(floor)],
  { COMPOUND_CASSETTE_MODE: "auto", COMPOUND_CASSETTE_DIR: coraCassettes },
);

let medianLiveMs: number | null = null;
if (latencyCases > 0) {
  const ids = dev.cases.filter((c) => !c.negative).slice(0, latencyCases).map((c) => c.id);
  const live = bench(
    ["--cases", coraCases, "--root", coraRoot, "--jobs", "1", ...ids.flatMap((id) => ["--only", id])],
    { COMPOUND_CASSETTE_MODE: "off", COMPOUND_CASSETTE_DIR: "" },
  );
  medianLiveMs = live.latency_ms.median;
}

const pub = bench(["--cases", resolve(root, "bench/cases/ce-plugin.json"), "--jobs", jobs], {
  COMPOUND_CASSETTE_MODE: "auto",
  COMPOUND_CASSETTE_DIR: publicCassettes,
});

const floored = dev.recall_at_precision_floor;
const out = {
  recall_at_floor: floored?.recall ?? 0,
  macro_recall_at_floor: floored?.macro_recall ?? 0,
  floor_threshold: floored?.threshold ?? null,
  floor_precision: floored?.precision_lower_bound ?? 0,
  f05_at_floor: floored?.f05 ?? 0,
  negatives_at_floor: floored?.negatives_correct ?? 0,
  operating_micro_recall: dev.aggregate.micro_recall ?? 0,
  operating_macro_recall: dev.aggregate.macro_recall ?? 0,
  operating_precision: dev.aggregate.precision_lower_bound ?? 0,
  operating_negatives: dev.aggregate.negatives_correct ?? 0,
  operating_f05: dev.f05 ?? 0,
  labeling_errors: dev.aggregate.labeling_errors,
  positive_cases: dev.aggregate.positive_cases,
  median_ms_live: medianLiveMs,
  median_ms_replay: dev.latency_ms.median,
  cost_per_case_usd: dev.cost.mean_usd,
  requests_per_case: dev.aggregate.positive_cases ? Number((dev.cost.requests / dev.cases.length).toFixed(2)) : 0,
  input_tokens_per_case: dev.cases.length ? Math.round(dev.cost.input_tokens / dev.cases.length) : 0,
  public_macro_recall: pub.aggregate.macro_recall ?? 0,
  public_negatives: pub.aggregate.negatives_correct ?? 0,
  public_precision: pub.aggregate.precision_lower_bound ?? 0,
  precision_floor: floor,
};
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
