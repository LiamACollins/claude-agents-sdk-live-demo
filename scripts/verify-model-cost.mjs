import assert from "node:assert/strict";
import { resolveRunCost } from "../lib/model-cost.ts";

function usage(input, output, extra = {}) {
  return { input, output, total: input + output, ...extra };
}

function assertCost(actual, expected, message) {
  assert.ok(
    actual !== undefined && Math.abs(actual - expected) < 1e-12,
    `${message}: expected ${expected}, received ${actual}`,
  );
}

const openAi = resolveRunCost({
  modelId: "gpt-5.4-nano",
  usage: usage(1_000, 200, { cachedInput: 400 }),
  inputAccounting: "cached-subset",
});
assertCost(openAi.costUsd, 0.000378, "OpenAI cached tokens must replace, not add to, input cost");

const anthropic = resolveRunCost({
  modelId: "claude-haiku-4-5-20251001",
  usage: usage(1_000, 100, { cachedInput: 400, cacheWrite: 200, reasoning: 80 }),
  inputAccounting: "separate-cache-buckets",
});
assertCost(anthropic.costUsd, 0.00179, "Anthropic cache reads and writes need distinct rates");

const noReasoningDoubleCharge = resolveRunCost({
  modelId: "claude-haiku-4-5-20251001",
  usage: usage(1_000, 100, { cachedInput: 400, cacheWrite: 200, reasoning: 0 }),
  inputAccounting: "separate-cache-buckets",
});
assert.equal(
  anthropic.costUsd,
  noReasoningDoubleCharge.costUsd,
  "reasoning is already included in output tokens",
);

const opus5 = resolveRunCost({
  modelId: "claude-opus-5",
  usage: usage(1_000, 100, { cachedInput: 400, cacheWrite: 200 }),
  inputAccounting: "separate-cache-buckets",
});
assertCost(opus5.costUsd, 0.00895, "Claude Opus 5 must use its audited cache and token rates");

const gemini = resolveRunCost({
  modelId: "gemini-3.1-flash-lite",
  usage: usage(1_000, 100, { cachedInput: 200 }),
  inputAccounting: "cached-subset",
});
assertCost(gemini.costUsd, 0.000355, "Gemini cached input should use its cached rate");

const geminiPro = resolveRunCost({
  modelId: "gemini-3.1-pro-preview",
  usage: usage(400_000, 20_000),
  requestUsages: [usage(150_000, 10_000), usage(250_000, 10_000)],
  inputAccounting: "cached-subset",
});
assertCost(geminiPro.costUsd, 1.6, "Gemini long-context tiers must be selected per request");

const gemini38Intro = resolveRunCost({
  modelId: "gemini-3.8-flash",
  usage: usage(1_000_000, 1_000_000),
  inputAccounting: "cached-subset",
  at: new Date("2026-12-31T23:59:59.000Z"),
});
const gemini38Standard = resolveRunCost({
  modelId: "gemini-3.8-flash",
  usage: usage(1_000_000, 1_000_000),
  inputAccounting: "cached-subset",
  at: new Date("2027-01-01T00:00:00.000Z"),
});
assertCost(gemini38Intro.costUsd, 4.5, "Gemini 3.8 introductory rate boundary is wrong");
assertCost(gemini38Standard.costUsd, 9, "Gemini 3.8 standard rate boundary is wrong");

const native = resolveRunCost({
  modelId: "claude-haiku-4-5-20251001",
  usage: usage(1_000, 100),
  inputAccounting: "separate-cache-buckets",
  nativeCostUsd: 0.123,
  nativeSource: "Claude Agent SDK estimate",
});
assert.deepEqual(
  native,
  { costUsd: 0.123, costSource: "Claude Agent SDK estimate" },
  "native cost must take precedence over a local estimate",
);

const unknown = resolveRunCost({
  modelId: "future-model",
  usage: usage(1_000, 100),
  inputAccounting: "cached-subset",
});
assert.equal(unknown.costUsd, undefined, "unknown models must fail closed");

const inconsistent = resolveRunCost({
  modelId: "gpt-5.4-nano",
  usage: usage(100, 10, { cachedInput: 101 }),
  inputAccounting: "cached-subset",
});
assert.equal(inconsistent.costUsd, undefined, "invalid usage buckets must fail closed");

console.log("model cost verification passed");
