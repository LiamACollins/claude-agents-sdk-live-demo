import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const openAiRunner = readFileSync("lib/server/runners/openai-agent.ts", "utf8");
const vercelRunner = readFileSync("lib/server/runners/vercel-agent.ts", "utf8");
const claudeRunner = readFileSync("lib/server/runners/claude-agent.ts", "utf8");
const modalClaudeRunner = readFileSync("modal/claude-runner.mjs", "utf8");
const prompts = readFileSync("lib/server/prompts.ts", "utf8");
const runRoute = readFileSync("app/api/run/route.ts", "utf8");
const evaluations = readFileSync("lib/server/evaluations.ts", "utf8");
const resultContract = readFileSync("lib/result-contract.ts", "utf8");
const offlineSuite = readFileSync("scripts/run-offline-suite.mjs", "utf8");

assert.equal(
  existsSync("lib/server/runners/gemini-openai.ts"),
  false,
  "The bespoke Gemini loop must stay deleted.",
);
assert.match(runRoute, /runOpenAiAgent.*import\("@\/lib\/server\/runners\/openai-agent"\)/s);
assert.match(runRoute, /runGeminiOpenAiAgent.*import\("@\/lib\/server\/runners\/openai-agent"\)/s);
assert.match(openAiRunner, /async function runOpenAiAgentsRuntime\(/);
assert.match(openAiRunner, /useResponses: true/);
assert.match(openAiRunner, /useResponses: false/);
assert.doesNotMatch(
  openAiRunner,
  /stream:\s*true|onStream:/,
  "Both OpenAI Agents SDK providers must use the same non-stream model transport.",
);
assert.equal(
  [...openAiRunner.matchAll(/\.asTool\(\{/g)].length,
  2,
  "The OpenAI Agents SDK coordinator must expose exactly two specialist agents as tools.",
);
for (const sharedPrompt of [
  "COORDINATOR_INSTRUCTIONS",
  "RESEARCH_INSTRUCTIONS",
  "VERIFIER_LEDGER_INSTRUCTIONS",
]) {
  assert.match(openAiRunner, new RegExp(sharedPrompt));
  assert.match(vercelRunner, new RegExp(sharedPrompt));
}
assert.equal(
  [...vercelRunner.matchAll(/new ToolLoopAgent\(\{/g)].length,
  3,
  "Vercel must use coordinator, research, and verifier ToolLoopAgent instances.",
);
assert.match(vercelRunner, /researchAgent\.generate\(/);
assert.match(vercelRunner, /verifierAgent\.generate\(/);
assert.match(vercelRunner, /return run\.text;/);
assert.match(vercelRunner, /tracedCoordinatorResults\.add\(toolCallId\)/);
assert.match(vercelRunner, /if \(tracedCoordinatorResults\.has\(part\.toolCallId\)\) continue;/);
assert.equal(
  [...vercelRunner.matchAll(/Research agent result|Citation verifier result/g)].length,
  2,
  "Vercel must trace both coordinator-level specialist results exactly once.",
);
assert.doesNotMatch(
  vercelRunner,
  /citation_support_review/,
  "The Vercel verifier must not receive an extra structured-output advantage.",
);
for (const localRunner of [openAiRunner, vercelRunner, claudeRunner]) {
  assert.match(localRunner, /@\/lib\/result-contract/);
}
assert.match(resultContract, /additionalProperties: false/);
assert.match(modalClaudeRunner, /passageId: \{ type: "string", pattern:/);
for (const phrase of [
  "complete suffix after any colon",
  "exact verbatim match for an item in the evidence ledger",
]) {
  assert.match(modalClaudeRunner, new RegExp(phrase));
}
for (const claudePath of [claudeRunner, modalClaudeRunner]) {
  assert.match(
    claudePath,
    /model === "claude-opus-5" \|\| model === "claude-sonnet-5"/,
    "Claude Opus 5 and Sonnet 5 must share adaptive high effort.",
  );
  assert.match(claudePath, /type: "adaptive"/);
  assert.match(claudePath, /budgetTokens: 1_024/);
  assert.match(
    claudePath,
    /supportsAdaptiveEffort \? \{ effort: "high"(?: as const)? \} : \{\}/,
    "Claude effort must be omitted for Haiku 4.5, which only supports manual thinking budgets.",
  );
}
assert.match(vercelRunner, /vercelAnthropicProviderOptions\(model\)/);
assert.equal(
  [...vercelRunner.matchAll(/providerOptions: anthropicCacheControl/g)].length,
  3,
  "Vercel must place native Anthropic cache breakpoints on each static specialist tool set.",
);
assert.match(openAiRunner, /reasoning: \{ effort: "high" as const \}/);
assert.match(evaluations, /effort: "high"/);
assert.match(openAiRunner, /maxTokens: 25_000/);
assert.match(openAiRunner, /tracingDisabled: true/);
assert.match(vercelRunner, /maxOutputTokens: 2_048/);
assert.equal(
  [...vercelRunner.matchAll(/maxOutputTokens: 4_096/g)].length,
  2,
  "Vercel research and coordinator agents need room for thinking plus their returned payloads.",
);
for (const claudePath of [claudeRunner, modalClaudeRunner]) {
  assert.match(claudePath, /maxBudgetUsd: 2/);
}
assert.match(runRoute, /judgeModel: evaluation\.judgeModel/);
assert.match(evaluations, /NOVAMIND_EVAL_JUDGE_MODEL \?\? "claude-opus-5"/);
assert.match(evaluations, /NOVAMIND_EVAL_JUDGE_LABEL \?\? "Claude Opus 5"/);
assert.match(vercelRunner, /NoObjectGeneratedError\.isInstance/);
assert.match(claudeRunner, /CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: "1"/);
assert.match(modalClaudeRunner, /CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: "1"/);
assert.match(claudeRunner, /model_refusal_no_fallback/);
assert.match(modalClaudeRunner, /model_refusal_no_fallback/);
assert.match(prompts, /read-only evidence-synthesis benchmark/);
assert.match(modalClaudeRunner, /read-only evidence-synthesis benchmark/);
for (const promptSource of [prompts, modalClaudeRunner]) {
  assert.match(promptSource, /Delegate to each specialist at least once/);
  assert.match(promptSource, /Their order and any additional delegations remain your decision/);
  assert.match(promptSource, /verify the changed answer again before finishing/);
  assert.match(promptSource, /every material claim.*independent citation review/s);
}
assert.match(claudeRunner, /tools: \["mcp__novamind__search_literature"\]/);
assert.match(claudeRunner, /tools: \["mcp__novamind__read_evidence"\]/);
assert.match(openAiRunner, /tools: \[searchTool\]/);
assert.match(openAiRunner, /tools: \[readEvidenceTool\]/);
assert.match(vercelRunner, /id: "novamind-research-specialist"[\s\S]*?tools: \{[\s\S]*?search_literature:/);
assert.match(vercelRunner, /id: "novamind-citation-verifier"[\s\S]*?tools: \{[\s\S]*?read_evidence:/);
for (const model of ["Claude Opus 5", "GPT-5.1", "Gemini 3.1 Pro"]) {
  assert.match(offlineSuite, new RegExp(model.replaceAll(".", "\\.")));
}
assert.match(offlineSuite, /expectedJudgeModel = argument\("judge-model", "claude-opus-5"\)/);

console.log("Harness parity verification passed.");
