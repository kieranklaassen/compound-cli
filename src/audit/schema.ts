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
