// Regression: ISSUE-001 — Haiku requests included the unsupported effort parameter.
// Found by /qa on 2026-09-23
// Report: .gstack/qa-reports/qa-report-novamind-sdk-comparison-vercel-app-2026-09-23.md
import assert from "node:assert/strict";
import { vercelAnthropicProviderOptions } from "../lib/server/vercel-anthropic-options.ts";

const haiku = vercelAnthropicProviderOptions("claude-haiku-4-5-20251001");
assert.equal("effort" in haiku, false);
assert.deepEqual(haiku.thinking, {
  type: "enabled",
  budgetTokens: 1_024,
});

for (const model of ["claude-opus-5", "claude-sonnet-5"]) {
  const options = vercelAnthropicProviderOptions(model);
  assert.equal(options.effort, "high");
  assert.deepEqual(options.thinking, {
    type: "adaptive",
    display: "summarized",
  });
}

console.log("Vercel Anthropic provider options regression passed.");
