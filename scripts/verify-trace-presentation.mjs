import assert from "node:assert/strict";
import { presentTrace } from "../lib/trace-presentation.ts";

const events = [
  {
    id: "1",
    kind: "tool_call",
    label: "Coordinator tool call",
    detail: "Native OpenAI Agents SDK event.",
    source: "sdk",
    status: "Complete",
    payload: {
      rawItem: { name: "research_agent", type: "function_call" },
      prompt: "Return structured output after the sub-agent finishes.",
    },
  },
  {
    id: "2",
    kind: "tool_call",
    label: "mcp__novamind__search_literature",
    detail: "Sub-agent tool call.",
    source: "sdk",
    status: "Complete",
  },
  {
    id: "3",
    kind: "tool_result",
    label: "citation_verifier",
    detail: "Tool result returned to ToolLoopAgent.",
    source: "sdk",
    status: "Complete",
  },
  {
    id: "4",
    kind: "message",
    label: "Structured output",
    detail: "Schema validated.",
    source: "sdk",
    status: "Complete",
  },
];

const presented = presentTrace(events);
assert.deepEqual(
  presented.map(({ label, kind, phase, depth }) => ({ label, kind, phase, depth })),
  [
    { label: "Research agent", kind: "agent", phase: "research", depth: 0 },
    { label: "Literature search", kind: "tool", phase: "research", depth: 1 },
    { label: "Citation verifier result", kind: "agent", phase: "verification", depth: 0 },
    { label: "Structured output", kind: "result", phase: "result", depth: 0 },
  ],
);
assert.equal(presented[0].event.label, "Coordinator tool call");
assert.equal(presented[1].event.label, "mcp__novamind__search_literature");

console.log("Verified canonical labels while preserving native SDK events.");

const claudeEvents = presentTrace([
  {
    id: "claude-agent",
    kind: "tool_call",
    label: "Agent",
    detail: "Coordinator delegated to the research agent.",
    source: "sdk",
    status: "Complete",
    payload: {
      name: "Agent",
      input: {
        subagent_type: "researcher",
        prompt: "Search, verify citations, then return structured output.",
      },
    },
  },
  {
    id: "claude-search",
    kind: "tool_call",
    label: "mcp__novamind__search_literature",
    detail: "MCP tool call.",
    source: "sdk",
    status: "Complete",
  },
  {
    id: "claude-output",
    kind: "tool_call",
    label: "StructuredOutput",
    detail: "Claude Agent SDK output tool.",
    source: "sdk",
    status: "Complete",
  },
  {
    id: "claude-output-result",
    kind: "tool_result",
    label: "Tool result",
    detail: "Output tool result.",
    source: "sdk",
    status: "Complete",
    payload: { content: "The structured output was accepted." },
  },
  {
    id: "claude-reasoning",
    kind: "reasoning",
    label: "Reasoning summary",
    detail: "Final reasoning event.",
    source: "sdk",
    status: "Complete",
    payload: { text: "I will now provide structured output." },
  },
]);

assert.deepEqual(
  claudeEvents.map(({ label, kind, phase, depth }) => ({ label, kind, phase, depth })),
  [
    { label: "Research agent", kind: "agent", phase: "research", depth: 0 },
    { label: "Literature search", kind: "tool", phase: "research", depth: 1 },
    { label: "Structured output", kind: "result", phase: "result", depth: 1 },
    { label: "Structured output result", kind: "result", phase: "result", depth: 1 },
    { label: "Reasoning", kind: "reasoning", phase: "result", depth: 1 },
  ],
);
assert.equal(claudeEvents[0].event.detail, "Coordinator delegated to the research agent.");
assert.equal(claudeEvents[2].nativeType, "SDK output handoff");
assert.equal(claudeEvents[3].nativeType, "SDK output handoff");

const compatibleEvents = presentTrace([
  {
    id: "compatible-research",
    kind: "tool_call",
    label: "research_agent",
    detail: "Vercel AI SDK or OpenAI-compatible tool call.",
    source: "sdk",
    status: "Complete",
  },
  {
    id: "compatible-citations",
    kind: "tool_call",
    label: "citation_verifier",
    detail: "Vercel AI SDK or OpenAI-compatible tool call.",
    source: "sdk",
    status: "Complete",
  },
  {
    id: "compatible-output",
    kind: "message",
    label: "Structured output",
    detail: "Schema validated.",
    source: "sdk",
    status: "Complete",
  },
]);

assert.deepEqual(
  compatibleEvents.map(({ label, phase }) => ({ label, phase })),
  [
    { label: "Research agent", phase: "research" },
    { label: "Citation verifier", phase: "verification" },
    { label: "Structured output", phase: "result" },
  ],
);

console.log("Verified Claude, OpenAI Agents for GPT and Gemini, and Vercel event labels.");
