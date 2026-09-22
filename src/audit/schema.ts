/**
 * The learning frontmatter schema, transcribed from the Compound Engineering
 * plugin's `skills/ce-compound/references/schema.yaml` (commit c152896) and the
 * pack rule set from compound-packs `tools/validate-packs.py`. Embedded on
 * purpose: locating an installed plugin at runtime is brittle across hosts.
 */

export const BUG_PROBLEM_TYPES = [
  "build_error",
  "test_failure",
  "runtime_error",
  "performance_issue",
  "database_issue",
  "security_issue",
  "ui_bug",
  "integration_issue",
  "logic_error",
] as const;

export const KNOWLEDGE_PROBLEM_TYPES = [
  "best_practice",
  "documentation_gap",
  "workflow_issue",
  "developer_experience",
  "architecture_pattern",
  "design_pattern",
  "tooling_decision",
  "convention",
] as const;

export const PROBLEM_TYPES = [...BUG_PROBLEM_TYPES, ...KNOWLEDGE_PROBLEM_TYPES] as const;

/** What each value means, in the schema's terms, so a judge can tell near-synonyms apart. */
export const PROBLEM_TYPE_DESCRIPTIONS: Record<(typeof PROBLEM_TYPES)[number], string> = {
  build_error: "bug: the build or compile step failed",
  test_failure: "bug: a test failed or the test infrastructure broke",
  runtime_error: "bug: an exception or crash while running",
  performance_issue: "bug: slowness, timeouts, or resource exhaustion",
  database_issue: "bug: schema, migration, query, or data integrity problem",
  security_issue: "bug: a vulnerability or permission gap",
  ui_bug: "bug: wrong rendering or interaction in the interface",
  integration_issue: "bug: a failure at the boundary with an external service or API",
  logic_error: "bug: wrong behaviour from wrong logic, no crash",
  best_practice:
    "knowledge: a recommended way of working; the fallback when no narrower knowledge value fits",
  documentation_gap: "knowledge: something was undocumented or documented wrongly",
  workflow_issue: "knowledge: a process or sequence of steps that failed people and how it changed",
  developer_experience: "knowledge: tooling or setup friction for developers",
  architecture_pattern: "knowledge: how components are arranged or separated at the system level",
  design_pattern:
    "knowledge: a reusable structure for a recurring problem inside code, prompts, or skills",
  tooling_decision: "knowledge: a decision about which tool, library, or command to use",
  convention: "knowledge: an agreed rule of naming, formatting, or style the team follows",
};
export type ProblemType = (typeof PROBLEM_TYPES)[number];

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;

export const RESOLUTION_TYPES = [
  "code_fix",
  "migration",
  "config_change",
  "test_fix",
  "dependency_update",
  "environment_setup",
  "workflow_improvement",
  "documentation_update",
  "tooling_addition",
  "seed_data_update",
] as const;

export const RECORD_TYPES = ["decision", "rule", "observation"] as const;

/** Open vocabulary: the corpus's own values come first; these are the fallback. */
export const SUGGESTED_COMPONENTS = [
  "rails_model",
  "rails_controller",
  "rails_view",
  "service_object",
  "background_job",
  "database",
  "api",
  "frontend",
  "hotwire_turbo",
  "email_processing",
  "brief_system",
  "assistant",
  "infrastructure",
  "observability",
  "authentication",
  "payments",
  "development_workflow",
  "testing_framework",
  "documentation",
  "tooling",
] as const;

export const SUGGESTED_ROOT_CAUSES = [
  "wrong_api",
  "data_integrity",
  "concurrency",
  "async_timing",
  "memory_leak",
  "config_error",
  "logic_error",
  "test_isolation",
  "missing_validation",
  "missing_permission",
  "missing_workflow_step",
  "inadequate_documentation",
  "missing_tooling",
  "incomplete_setup",
] as const;

export const LIMITS = {
  appliesWhenMax: 5,
  packAppliesWhenMax: 8,
  symptomsMax: 5,
  tagsMax: 8,
  itemChars: 300,
} as const;

export type Track = "bug" | "knowledge";

export function trackOf(problemType: unknown): Track | null {
  if (typeof problemType !== "string") return null;
  if ((BUG_PROBLEM_TYPES as readonly string[]).includes(problemType)) return "bug";
  if ((KNOWLEDGE_PROBLEM_TYPES as readonly string[]).includes(problemType)) return "knowledge";
  return null;
}

/** `Best Practice`, `ui-bug`, ` BEST_PRACTICE ` all normalise to a schema value, or null. */
export function normalizeEnum(value: unknown, allowed: readonly string[]): string | null {
  if (typeof value !== "string") return null;
  const key = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return allowed.find((candidate) => candidate === key) ?? null;
}

export const TAG_PATTERN = /^[a-z0-9][a-z0-9:.-]*$/;

export function normalizeTag(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9:.-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}
