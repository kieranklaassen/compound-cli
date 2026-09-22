import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Fetch } from "@typesafe-ai/sdk";
import { errorMessage } from "../util.ts";
import type { CassetteMode } from "./api-key.ts";

export const CASSETTE_MISS_MARKER = "compound-cli cassette miss";

export type CassetteFile = {
  request_hash: string;
  status: number;
  body: unknown;
  meta: { model: unknown; question_count: number };
};

/**
 * A `fetch` for the TypeSafe SDK that records or replays responses keyed by
 * the SHA-256 of the canonical request body. Only the response body and
 * status are stored: never headers, never the key, never the URL.
 */
export function cassetteFetch(
  mode: Exclude<CassetteMode, "off">,
  dir: string,
  realFetch: Fetch = fetch,
): Fetch {
  return async (input, init) => {
    const bodyText = typeof init?.body === "string" ? init.body : String(init?.body ?? "");
    const request = parseJson(bodyText);
    const hash = requestHash(request);
    const file = join(dir, `${hash}.json`);
    if (mode === "replay" || (mode === "auto" && existsSync(file))) {
      if (!existsSync(file)) {
        return new Response(JSON.stringify({ error: CASSETTE_MISS_MARKER, hash, dir }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      const stored = readRecording(file);
      if (stored instanceof Error) {
        // Replay must fail loudly; auto re-records over a recording a crash left half-written.
        if (mode === "replay") {
          return new Response(
            JSON.stringify({
              error: CASSETTE_MISS_MARKER,
              hash,
              dir,
              reason: `unreadable recording: ${stored.message}`,
            }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
        }
      } else {
        return new Response(JSON.stringify(stored.body), {
          status: stored.status,
          headers: { "content-type": "application/json" },
        });
      }
    }
    const response = await realFetch(input, init);
    const text = await response.text();
    if (response.ok) {
      const questions =
        (request as { questions?: Record<string, unknown> } | undefined)?.questions ?? {};
      const stored: CassetteFile = {
        request_hash: hash,
        status: response.status,
        body: parseJson(text),
        meta: {
          model: (request as { model?: unknown } | undefined)?.model,
          question_count: Object.keys(questions).length,
        },
      };
      mkdirSync(dir, { recursive: true });
      // Compact: a held-out set is thousands of these files.
      writeFileAtomically(file, `${JSON.stringify(stored)}\n`);
    }
    return new Response(text, { status: response.status, headers: response.headers });
  };
}

function readRecording(file: string): CassetteFile | Error {
  try {
    const stored = JSON.parse(readFileSync(file, "utf8")) as CassetteFile;
    if (typeof stored?.status !== "number") return new Error("no status in recording");
    return stored;
  } catch (error) {
    return new Error(errorMessage(error));
  }
}

/** Write to a sibling temp file and rename, so a crash never leaves a half-written recording. */
export function writeFileAtomically(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export function requestHash(request: unknown): string {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

/** JSON with object keys sorted at every level, so key order never changes the hash. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
