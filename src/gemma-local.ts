#!/usr/bin/env bun
// Gemma 4 12B local inference via Ollama REST API
// Usage: bun run src/gemma-local.ts [check]

import type { GemmaClient, GemmaClientOutput } from "./gemma-bridge.ts";

const DEFAULT = { baseUrl: "http://localhost:11434", model: "gemma4:12b" };

export interface GemmaLocalConfig {
  baseUrl?: string;
  model?: string;
}

async function ollamaFetch(
  path: string,
  opts?: { method?: string; body?: unknown },
  cfg: GemmaLocalConfig = {},
): Promise<Response> {
  const { baseUrl = DEFAULT.baseUrl } = cfg;
  return fetch(`${baseUrl}${path}`, {
    method: opts?.method ?? "GET",
    headers: { "Content-Type": "application/json" },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
}

/** Check whether Ollama is reachable and gemma4:12b is pulled. */
export async function checkOllama(cfg: GemmaLocalConfig = {}): Promise<{
  ok: boolean;
  modelReady: boolean;
  models: string[];
  error?: string;
}> {
  const { model = DEFAULT.model } = cfg;
  try {
    const res = await ollamaFetch("/api/tags", {}, cfg);
    if (!res.ok) return { ok: false, modelReady: false, models: [], error: `Ollama ${res.status}` };
    const body = (await res.json()) as { models?: { name: string }[] };
    const names = (body.models ?? []).map((m) => m.name);
    return { ok: true, modelReady: names.some((n) => n === model || n.startsWith(model)), models: names };
  } catch (e) {
    return { ok: false, modelReady: false, models: [], error: String(e) };
  }
}

/** Pull gemma4:12b (blocks until complete). */
export async function pullModel(cfg: GemmaLocalConfig = {}): Promise<void> {
  const { model = DEFAULT.model } = cfg;
  const res = await ollamaFetch("/api/pull", { method: "POST", body: { model, stream: true } }, cfg);
  if (!res.ok) throw new Error(`pull failed: ${res.status}`);
  const reader = res.body?.getReader();
  if (!reader) return;
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (const line of buf.split("\n").slice(0, -1)) {
      if (!line.trim()) continue;
      try {
        const ch = JSON.parse(line);
        if (ch.status) process.stdout.write(`\r  ${ch.status}${" ".repeat(20)}`);
        if (ch.error) throw new Error(ch.error);
      } catch { /* skip malformed chunks */ }
    }
    buf = buf.split("\n").pop() ?? "";
  }
  process.stdout.write("\n");
}

/** Send a trivial prompt to load the model into GPU memory (keep-alive 5 min). */
export async function warmLoad(cfg: GemmaLocalConfig = {}): Promise<number> {
  const { model = DEFAULT.model } = cfg;
  const t0 = performance.now();
  const res = await ollamaFetch("/api/generate", {
    method: "POST",
    body: { model, prompt: "return 1", stream: false, keep_alive: "5m" },
  }, cfg);
  if (!res.ok) throw new Error(`warm-load failed: ${res.status}`);
  await res.json();
  return performance.now() - t0;
}

/** Run a short code-eval prompt and measure end-to-end latency (ms). */
export async function firstInference(cfg: GemmaLocalConfig = {}): Promise<{
  latencyMs: number;
  output: string;
}> {
  const { model = DEFAULT.model } = cfg;
  const prompt = [
    "Write a TypeScript function `fib(n: number): number` that returns the nth Fibonacci number.",
    "Only output the function body, no explanation.",
  ].join("\n");
  const t0 = performance.now();
  const res = await ollamaFetch("/api/generate", {
    method: "POST",
    body: { model, prompt, stream: false, keep_alive: "5m" },
  }, cfg);
  if (!res.ok) throw new Error(`inference failed: ${res.status}`);
  const body = (await res.json()) as { response: string };
  return { latencyMs: performance.now() - t0, output: body.response ?? "" };
}

/* ── GemmaClient implementation ─────────────────────────────────────────── */

/**
 * Concrete GemmaClient implementation routing inference requests through the
 * local Ollama REST API (`/api/generate`).
 *
 * Encapsulates model name, base URL, and HTTP transport behind the abstract
 * `GemmaClient` interface so the diff-critic bridge pipeline can invoke it
 * without depending on Ollama-specific details.
 *
 * @example
 * ```ts
 * const client = new GemmaLocalClient({ model: "gemma4:12b" });
 * const { text, latencyMs } = await client.generate("review this diff…");
 * ```
 */
export class GemmaLocalClient implements GemmaClient {
  private cfg: GemmaLocalConfig;

  constructor(cfg: GemmaLocalConfig = {}) {
    this.cfg = cfg;
  }

  /**
   * Send a prompt to the Ollama `/api/generate` endpoint and return the
   * generated text together with end-to-end latency.
   *
   * Uses `stream: false` for simplicity (blocking single-response mode) and
   * sets `keep_alive: "5m"` to keep the model warm for subsequent calls.
   *
   * @throws {Error} If the HTTP response status is not 2xx.
   */
  async generate(prompt: string): Promise<GemmaClientOutput> {
    const { model = DEFAULT.model } = this.cfg;
    const t0 = performance.now();
    const res = await ollamaFetch("/api/generate", {
      method: "POST",
      body: { model, prompt, stream: false, keep_alive: "5m" },
    }, this.cfg);
    if (!res.ok) throw new Error(`Gemma generate failed: ${res.status}`);
    const body = (await res.json()) as { response: string };
    return { text: body.response ?? "", latencyMs: performance.now() - t0 };
  }
}

// ── Standalone ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cfg: GemmaLocalConfig = {
    baseUrl: process.env.OLLAMA_URL || undefined,
    model: process.env.GEMMA_MODEL || undefined,
  };
  const check = await checkOllama(cfg);
  if (!check.ok) {
    console.error(`Ollama unreachable: ${check.error}\nEnsure \`ollama serve\` is running on localhost:11434`);
    process.exit(1);
  }
  console.log(`Ollama reachable (${check.models.length} model(s))`);

  if (process.argv[2] === "check") process.exit(0);

  if (!check.modelReady) {
    console.log("Pulling gemma4:12b…");
    await pullModel(cfg);
    console.log("Model pulled");
  } else {
    console.log(`Model ready: ${check.models.find((n) => n.startsWith("gemma4"))}`);
  }

  console.log("Warm-loading model into GPU…");
  const warmMs = await warmLoad(cfg);
  console.log(`  Done (${warmMs.toFixed(0)} ms)`);

  console.log("Running first inference (fibonacci function)…");
  const { latencyMs, output } = await firstInference(cfg);
  console.log(`  Latency: ${latencyMs.toFixed(0)} ms\n  Output:\n${output}`);
}

if (import.meta.main) main().catch((e) => { console.error(e); process.exit(1); });
