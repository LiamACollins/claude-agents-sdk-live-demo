import assert from "node:assert/strict";
import { summarizeToolActivity } from "../lib/tool-activity.ts";

function event(kind, label, payload = undefined) {
  return {
    id: crypto.randomUUID(),
    kind,
    label,
    detail: "test",
    source: "sdk",
    status: "Complete",
    payload,
  };
}

const openAi = summarizeToolActivity("openai-agent", [
  event("tool_call", "Coordinator tool call", {
    rawItem: { name: "research_agent", arguments: '{"question":"KRAS inhibitor"}' },
  }),
  event("tool_result", "Coordinator tool result"),
  event("tool_call", "Sub-agent tool call", {
    rawItem: { name: "search_literature", arguments: '{"question":"KRAS inhibitor"}' },
  }),
  event("tool_result", "Sub-agent tool result"),
  event("tool_call", "Coordinator tool call", { rawItem: { name: "citation_verifier" } }),
  event("tool_result", "Coordinator tool result"),
  event("tool_call", "Coordinator tool call", { rawItem: { name: "citation_verifier" } }),
]);

assert.deepEqual(openAi.sequence, [
  "research_agent",
  "search_literature",
  "citation_verifier",
  "citation_verifier",
]);
assert.equal(openAi.nativeCalls, 4);
assert.equal(openAi.retrievalOperations, 1);
assert.equal(openAi.verificationOperations, 2);
assert.equal(openAi.distinctSearchQueries, 1);

const claude = summarizeToolActivity("claude-agent", [
  event("tool_call", "Agent", { subagent_type: "researcher" }),
  event("tool_call", "mcp__novamind__search_literature", { question: "query one" }),
  event("tool_call", "Agent", { subagent_type: "citation-verifier" }),
  event("tool_call", "mcp__novamind__read_evidence", {}),
]);

assert.deepEqual(claude.byName, {
  research_agent: 1,
  search_literature: 1,
  citation_verifier: 1,
  read_evidence: 1,
});
assert.equal(claude.retrievalOperations, 1);
assert.equal(claude.verificationOperations, 1);

const gemini = summarizeToolActivity("gemini-openai", [
  event("tool_call", "Coordinator tool call", {
    rawItem: { name: "research_agent", arguments: '{"input":"query"}' },
  }),
  event("tool_result", "Coordinator tool result"),
  event("tool_call", "Sub-agent tool call", {
    rawItem: { name: "search_literature", arguments: '{"question":"query"}' },
  }),
  event("tool_result", "Sub-agent tool result"),
  event("tool_call", "Coordinator tool call", {
    rawItem: { name: "citation_verifier" },
  }),
  event("tool_result", "Coordinator tool result"),
  event("tool_call", "Sub-agent tool call", {
    rawItem: { name: "read_evidence" },
  }),
  event("tool_result", "Sub-agent tool result"),
]);
assert.equal(gemini.retrievalOperations, 1);
assert.equal(gemini.verificationOperations, 1);
assert.deepEqual(gemini.byName, {
  research_agent: 1,
  search_literature: 1,
  citation_verifier: 1,
  read_evidence: 1,
});

console.log("Tool activity verification passed.");
