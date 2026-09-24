import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { conciseEvaluationRationale } from "../lib/evaluation-format.ts";
import {
  evaluateRequiredToolStages,
  evaluateToolExecution,
} from "../lib/trace-presentation.ts";

const comparisonSections = readFileSync("components/comparison-sections.tsx", "utf8");
assert.ok(
  comparisonSections.indexOf('label: "Model cost"') <
    comparisonSections.indexOf('label: "Time"'),
  "Model cost must be the first run metric.",
);
for (const removedMetric of ["Search queries", "Verification calls", "Coordinator turns"]) {
  assert.doesNotMatch(comparisonSections, new RegExp(removedMetric));
}

assert.equal(
  conciseEvaluationRationale("The cited passages directly support every material claim. A second sentence should not appear."),
  "The cited passages directly support every material claim.",
);

const longRationale = conciseEvaluationRationale(
  "This deliberately long rationale contains far more than eighteen words so the interface always presents one compact and scannable sentence to evaluators.",
);
assert.equal(longRationale.split(" ").length, 18);
assert.match(longRationale, /\.$/);
assert.equal(conciseEvaluationRationale(""), "No rationale returned.");

const event = (id, kind, label, status = "Complete") => ({
  id,
  kind,
  label,
  detail: label,
  source: "sdk",
  status,
});

const completePipeline = evaluateRequiredToolStages([
  event("1", "tool_call", "research_agent"),
  event("2", "tool_result", "research_agent"),
  event("3", "tool_call", "citation_verifier"),
  event("4", "tool_result", "citation_verifier"),
]);
assert.equal(completePipeline.succeeded, true);
assert.equal(
  completePipeline.rationale,
  "Research and citation verification completed with 2 tool calls and 2 results.",
);

const missingVerifier = evaluateRequiredToolStages([
  event("1", "tool_call", "research_agent"),
  event("2", "tool_result", "research_agent"),
]);
assert.equal(missingVerifier.succeeded, false);
assert.equal(
  missingVerifier.rationale,
  "Citation verification did not complete; 1 tool call produced 1 result.",
);

const successfulSingleTool = evaluateToolExecution([
  event("1", "tool_call", "research_agent"),
  event("2", "tool_result", "research_agent"),
]);
assert.equal(successfulSingleTool.succeeded, true);
assert.equal(
  successfulSingleTool.rationale,
  "1 tool call produced 1 result; every invoked tool returned successfully.",
);
assert.equal(missingVerifier.succeeded, false);

const missingToolResult = evaluateToolExecution([
  event("1", "tool_call", "research_agent"),
]);
assert.equal(missingToolResult.succeeded, false);
assert.equal(
  missingToolResult.rationale,
  "1 tool call produced 0 results; at least one invoked tool did not return a result.",
);

const duplicateResearch = evaluateRequiredToolStages([
  event("1", "tool_call", "research_agent"),
  event("2", "tool_result", "research_agent"),
  event("3", "tool_call", "research_agent"),
  event("4", "tool_result", "research_agent"),
]);
assert.equal(duplicateResearch.succeeded, false);

const erroredPipeline = evaluateRequiredToolStages([
  event("1", "tool_call", "research_agent"),
  event("2", "tool_result", "research_agent"),
  event("3", "tool_call", "citation_verifier"),
  event("4", "tool_result", "citation_verifier", "Error"),
]);
assert.equal(erroredPipeline.succeeded, false);
assert.equal(erroredPipeline.rationale, "1 trace event reported an error.");

const erroredTool = evaluateToolExecution([
  event("1", "tool_call", "research_agent"),
  event("2", "tool_result", "research_agent", "Error"),
]);
assert.equal(erroredTool.succeeded, false);

console.log("Verified evaluation rationale presentation and required tool-stage scoring.");
