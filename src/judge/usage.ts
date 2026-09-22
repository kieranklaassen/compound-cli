import { USD_PER_INPUT_TOKEN } from "../find/defaults.ts";

export type UsageReport = {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  estimated_usd: number;
  wall_ms: number;
  model: string | null;
};

export class UsageTracker {
  requests = 0;
  inputTokens = 0;
  outputTokens = 0;
  model: string | null = null;
  private readonly startedAt = performance.now();

  record(result: { model: string; usage: { input_tokens: number; output_tokens: number } }): void {
    this.requests += 1;
    this.inputTokens += result.usage.input_tokens;
    this.outputTokens += result.usage.output_tokens;
    this.model = result.model;
  }

  snapshot(): UsageReport {
    return {
      requests: this.requests,
      input_tokens: this.inputTokens,
      output_tokens: this.outputTokens,
      estimated_usd: Number((this.inputTokens * USD_PER_INPUT_TOKEN).toFixed(8)),
      wall_ms: Math.round(performance.now() - this.startedAt),
      model: this.model,
    };
  }
}
