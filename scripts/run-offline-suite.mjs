import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}

const modelProfiles = {
  small: {
    "claude-agent": "Claude Haiku 4.5",
    "openai-agent": "GPT-5.4 nano",
    "gemini-openai": "Gemini 3.1 Flash-Lite",
    "vercel-agent": "Claude Haiku 4.5",
  },
  top: {
    "claude-agent": "Claude Opus 5",
    "openai-agent": "GPT-5.1",
    "gemini-openai": "Gemini 3.1 Pro",
    "vercel-agent": "Claude Opus 5",
  },
};

const profile = argument("profile", "small");
const runtimeModels = modelProfiles[profile];
if (!runtimeModels) throw new Error(`Unsupported profile: ${profile}. Use small or top.`);
const expectedJudgeModel = argument("judge-model", "claude-opus-5");

function flag(name) {
  return process.argv.includes(`--${name}`);
}

const baseUrl = argument("base-url", "http://localhost:3000").replace(/\/$/, "");
const selectedRuntimes = argument("runtimes", Object.keys(runtimeModels).join(","))
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const limit = Number(argument("limit", "10"));
const delayMs = Number(argument("delay-ms", "1000"));
const suiteId = argument(
  "suite-id",
  `offline-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`,
);
const outputDir = path.resolve(argument("output", `tmp/eval-suite/${suiteId}`));
const dryRun = flag("dry-run");

for (const runtimeId of selectedRuntimes) {
  if (!runtimeModels[runtimeId]) throw new Error(`Unsupported runtime: ${runtimeId}`);
}
if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error("--limit must be 1-10.");
if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("--delay-ms must be non-negative.");

const cases = JSON.parse(
  await readFile(new URL("../evals/agentic-search-cases.json", import.meta.url), "utf8"),
).slice(0, limit);
const plan = cases.flatMap((testCase) =>
  selectedRuntimes.map((runtimeId) => ({
    testCase,
    runtimeId,
    model: runtimeModels[runtimeId],
  })),
);

console.log(`Suite ${suiteId}: ${cases.length} cases × ${selectedRuntimes.length} runtimes = ${plan.length} runs.`);
console.log(`Endpoint: ${baseUrl}/api/run`);
if (dryRun) {
  for (const item of plan) console.log(`${item.testCase.id}\t${item.runtimeId}\t${item.model}`);
  process.exit(0);
}

await mkdir(outputDir, { recursive: true });
const resultsPath = path.join(outputDir, "results.jsonl");
await writeFile(resultsPath, "", "utf8");

async function runOne(item) {
  const response = await fetch(`${baseUrl}/api/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      runtimeId: item.runtimeId,
      model: item.model,
      question: item.testCase.input,
      comparisonId: suiteId,
    }),
  });
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }

  let buffer = "";
  let complete;
  let runError;
  for await (const chunk of response.body) {
    buffer += new TextDecoder().decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === "complete") complete = event;
      if (event.type === "error") runError = event.message;
    }
  }
  if (buffer.trim()) {
    const event = JSON.parse(buffer);
    if (event.type === "complete") complete = event;
    if (event.type === "error") runError = event.message;
  }
  if (!complete) throw new Error(runError ?? "Stream ended without a completion event.");
  if (complete.judgeModel !== expectedJudgeModel) {
    throw new Error(
      `Judge mismatch: expected ${expectedJudgeModel}, received ${complete.judgeModel ?? "unreported"}.`,
    );
  }

  const citedPmcids = new Set(
    complete.result.citations.map(({ passageId }) => passageId.split(":")[0]),
  );
  const goldCoverage =
    item.testCase.goldPmcids.filter((pmcid) => citedPmcids.has(pmcid)).length /
    item.testCase.goldPmcids.length;
  return {
    suiteId,
    profile,
    judgeModel: complete.judgeModel,
    caseId: item.testCase.id,
    input: item.testCase.input,
    goldPmcids: item.testCase.goldPmcids,
    runtimeId: item.runtimeId,
    model: item.model,
    goldCoverage,
    completedAt: new Date().toISOString(),
    complete,
  };
}

const results = [];
for (const [index, item] of plan.entries()) {
  process.stdout.write(`[${index + 1}/${plan.length}] ${item.testCase.id} · ${item.runtimeId} … `);
  try {
    const result = await runOne(item);
    results.push(result);
    await appendFile(resultsPath, `${JSON.stringify(result)}\n`, "utf8");
    console.log("complete");
  } catch (error) {
    const failure = {
    suiteId,
    profile,
      caseId: item.testCase.id,
      runtimeId: item.runtimeId,
      model: item.model,
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
    results.push(failure);
    await appendFile(resultsPath, `${JSON.stringify(failure)}\n`, "utf8");
    console.log(`failed: ${failure.error}`);
  }
  if (index < plan.length - 1 && delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

function average(values) {
  const numeric = values.filter((value) => Number.isFinite(value));
  return numeric.length ? numeric.reduce((sum, value) => sum + value, 0) / numeric.length : null;
}

function score(result, id) {
  return result.complete?.evaluations?.find((evaluation) => evaluation.id === id)?.score;
}

const rows = selectedRuntimes.map((runtimeId) => {
  const runtimeResults = results.filter((result) => result.runtimeId === runtimeId && result.complete);
  return {
    runtimeId,
    completed: runtimeResults.length,
    groundedness: average(runtimeResults.map((result) => score(result, "claim_groundedness"))),
    relevance: average(runtimeResults.map((result) => score(result, "answer_relevance"))),
    toolExecutionSuccess: average(runtimeResults.map((result) => score(result, "tools_succeeded"))),
    workflowCompletion: average(
      runtimeResults.map((result) => score(result, "required_workflow_completed")),
    ),
    goldCoverage: average(runtimeResults.map((result) => result.goldCoverage)),
    nativeToolCalls: average(
      runtimeResults.map((result) => result.complete.activity?.tools?.nativeCalls),
    ),
    retrievalOperations: average(
      runtimeResults.map((result) => result.complete.activity?.tools?.retrievalOperations),
    ),
    verificationOperations: average(
      runtimeResults.map((result) => result.complete.activity?.tools?.verificationOperations),
    ),
    orchestratorTurns: average(
      runtimeResults.map((result) => result.complete.activity?.model?.orchestratorTurns),
    ),
    durationMs: average(runtimeResults.map((result) => result.complete.durationMs)),
    costUsd: average(runtimeResults.map((result) => result.complete.costUsd)),
  };
});

await writeFile(
  path.join(outputDir, "summary.json"),
  `${JSON.stringify({ suiteId, profile, expectedJudgeModel, rows }, null, 2)}\n`,
);
const headers = Object.keys(rows[0] ?? { runtimeId: "" });
const markdown = [
  `# Agentic search suite: ${suiteId}`,
  "",
  `Profile: ${profile}; judge: ${expectedJudgeModel}.`,
  "",
  `Runs: ${plan.length}; completed: ${results.filter((result) => result.complete).length}.`,
  "",
  `| ${headers.join(" | ")} |`,
  `| ${headers.map(() => "---").join(" | ")} |`,
  ...rows.map((row) => `| ${headers.map((header) => row[header] ?? "—").join(" | ")} |`),
  "",
].join("\n");
await writeFile(path.join(outputDir, "summary.md"), markdown, "utf8");
console.log(`Results: ${resultsPath}`);
console.log(`Summary: ${path.join(outputDir, "summary.md")}`);
