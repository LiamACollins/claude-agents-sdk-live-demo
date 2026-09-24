import "server-only";

import {
  Agent,
  OpenAIProvider,
  Runner,
  tool,
  type ModelResponse,
  type RunItem,
} from "@openai/agents";
import { z } from "zod";
import { resolveRunCost } from "@/lib/model-cost";
import { runtimeResultSchema } from "@/lib/result-contract";
import type { EmitRunEvent } from "@/lib/run-events";
import {
  compactEvidence,
  compactLedgerEvidence,
  RunEvidenceLedger,
  searchAndRecordLiterature,
  verifyCitations,
} from "../literature";
import { geminiApiKey, openAiApiKey, resolveModelId } from "../models";
import {
  COORDINATOR_INSTRUCTIONS,
  RESEARCH_INSTRUCTIONS,
  VERIFIER_LEDGER_INSTRUCTIONS,
  coordinatorPrompt,
} from "../prompts";
import { traceEmitter } from "../trace";

type RequestUsage = {
  input: number;
  output: number;
  cachedInput?: number;
  reasoning?: number;
  total: number;
};

type RuntimeConfig = {
  provider: OpenAIProvider;
  contextHandling: string;
};

function removeEncryptedReasoning(value: unknown) {
  return JSON.parse(
    JSON.stringify(value, (key, item) =>
      key === "encrypted_content" || key === "thought_signature"
        ? "[provider reasoning state omitted]"
        : item,
    ),
  ) as unknown;
}

function reasoningSummary(item: RunItem) {
  if (item.type !== "reasoning_item") return undefined;
  const content = [
    ...(item.rawItem.content ?? []),
    ...(item.rawItem.rawContent ?? []),
  ];
  return content
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join(" ") || undefined;
}

function usageForResponse(response: ModelResponse): RequestUsage {
  const cachedInput = response.usage.inputTokensDetails.some(
    (detail) => detail.cached_tokens !== undefined || detail.cachedTokens !== undefined,
  )
    ? response.usage.inputTokensDetails.reduce(
        (sum, detail) => sum + (detail.cached_tokens ?? detail.cachedTokens ?? 0),
        0,
      )
    : undefined;
  return {
    input: response.usage.inputTokens,
    output: response.usage.outputTokens,
    cachedInput,
    reasoning: response.usage.outputTokensDetails.reduce(
      (sum, detail) => sum + (detail.reasoning_tokens ?? detail.reasoningTokens ?? 0),
      0,
    ),
    total: response.usage.totalTokens,
  };
}

async function runOpenAiAgentsRuntime(
  question: string,
  modelLabel: string,
  emit: EmitRunEvent,
  config: RuntimeConfig,
) {
  const startedAt = Date.now();
  const trace = traceEmitter(emit);
  const model = resolveModelId(modelLabel);
  const evidence = new RunEvidenceLedger();
  const nestedRequestUsages: RequestUsage[] = [];
  let auxiliaryRequests = 0;

  const searchTool = tool({
    name: "search_literature",
    description: "Search the Convex literature corpus for exact passages.",
    parameters: z.object({ question: z.string() }),
    execute: async ({ question: toolQuestion }) => {
      const search = await searchAndRecordLiterature(evidence, toolQuestion, 5);
      return compactEvidence(search);
    },
  });

  const readEvidenceTool = tool({
    name: "read_evidence",
    description: "Read the immutable accumulated evidence ledger for this run.",
    parameters: z.object({}),
    execute: async () => compactLedgerEvidence(evidence),
  });

  const sharedModelSettings = { reasoning: { effort: "high" as const } };
  const researchAgent = new Agent({
    name: "Research specialist",
    instructions: RESEARCH_INSTRUCTIONS,
    model,
    modelSettings: sharedModelSettings,
    tools: [searchTool],
  });
  const verifierAgent = new Agent({
    name: "Citation verifier",
    instructions: VERIFIER_LEDGER_INSTRUCTIONS,
    model,
    modelSettings: sharedModelSettings,
    tools: [readEvidenceTool],
  });

  researchAgent.on("agent_start", () => {
    trace("message", "Research agent", "Research specialist started a model turn.", {
      source: "sdk",
    });
  });
  researchAgent.on("agent_tool_start", (_context, _activeTool, details) => {
    trace("tool_call", "Literature search", "Research agent called a retrieval tool.", {
      source: "sdk",
      payload: removeEncryptedReasoning(details.toolCall),
    });
  });
  researchAgent.on("agent_tool_end", (_context, _activeTool, result, details) => {
    trace("tool_result", "Literature search result", "Retrieval result returned to the research agent.", {
      source: "sdk",
      payload: removeEncryptedReasoning({ toolCall: details.toolCall, result }),
    });
  });
  verifierAgent.on("agent_start", () => {
    trace("message", "Citation verifier", "Citation verifier started a model turn.", {
      source: "sdk",
    });
  });
  verifierAgent.on("agent_tool_start", (_context, _activeTool, details) => {
    trace("tool_call", "Citation check", "Citation verifier read the evidence ledger.", {
      source: "sdk",
      payload: removeEncryptedReasoning(details.toolCall),
    });
  });
  verifierAgent.on("agent_tool_end", (_context, _activeTool, result, details) => {
    trace("tool_result", "Citation verifier result", "Evidence ledger returned to the citation verifier.", {
      source: "sdk",
      payload: removeEncryptedReasoning({ toolCall: details.toolCall, result }),
    });
  });

  const traceReasoningItems = (items: RunItem[], label: string) => {
    for (const item of items) {
      const summary = reasoningSummary(item);
      if (!summary) continue;
      trace("reasoning", label, summary, {
        source: "sdk",
        payload: removeEncryptedReasoning(item.toJSON()),
      });
    }
  };

  const collectSubagentOutput = (output: {
    finalOutput: unknown;
    rawResponses: ModelResponse[];
    newItems: RunItem[];
  }) => {
    auxiliaryRequests += output.rawResponses.length;
    nestedRequestUsages.push(...output.rawResponses.map(usageForResponse));
    traceReasoningItems(output.newItems, "Sub-agent reasoning");
    return typeof output.finalOutput === "string"
      ? output.finalOutput
      : JSON.stringify(output.finalOutput);
  };

  const coordinator = new Agent({
    name: "Research coordinator",
    instructions: COORDINATOR_INSTRUCTIONS,
    model,
    modelSettings: {
      ...sharedModelSettings,
      // OpenAI counts hidden reasoning inside max_output_tokens. Keep enough headroom
      // for reasoning plus the shared structured-output contract.
      maxTokens: 25_000,
      preserveRawUsage: true,
    },
    outputType: runtimeResultSchema,
    tools: [
      researchAgent.asTool({
        toolName: "research_agent",
        toolDescription: "Delegate literature retrieval to the research specialist.",
        runConfig: { modelProvider: config.provider },
        runOptions: { maxTurns: 7 },
        customOutputExtractor: collectSubagentOutput,
      }),
      verifierAgent.asTool({
        toolName: "citation_verifier",
        toolDescription: "Send a proposed answer and its retrieved evidence to a specialist that checks whether every material claim is supported.",
        runConfig: { modelProvider: config.provider },
        runOptions: { maxTurns: 3 },
        customOutputExtractor: collectSubagentOutput,
      }),
    ],
  });

  coordinator.on("agent_start", () => {
    trace("message", "Coordinator", "Coordinator started a model turn.", {
      source: "sdk",
    });
  });
  coordinator.on("agent_tool_start", (_context, activeTool, details) => {
    const isResearch = activeTool.name === "research_agent";
    trace(
      "tool_call",
      isResearch ? "Research agent" : "Citation verifier",
      isResearch
        ? "Coordinator delegated literature retrieval."
        : "Coordinator delegated citation verification.",
      { source: "sdk", payload: removeEncryptedReasoning(details.toolCall) },
    );
  });
  coordinator.on("agent_tool_end", (_context, activeTool, result, details) => {
    const isResearch = activeTool.name === "research_agent";
    trace(
      "tool_result",
      isResearch ? "Research agent result" : "Citation verifier result",
      isResearch
        ? "Research specialist returned to the coordinator."
        : "Citation verifier returned to the coordinator.",
      {
        source: "sdk",
        payload: removeEncryptedReasoning({ toolCall: details.toolCall, result }),
      },
    );
  });

  const runner = new Runner({
    modelProvider: config.provider,
    workflowName: "NovaMind agentic literature search",
    // Braintrust and LangSmith are the comparison's canonical trace stores.
    // Avoid the SDK's separate OpenAI exporter and its unrelated auth surface.
    tracingDisabled: true,
  });
  const completed = await runner.run(coordinator, coordinatorPrompt(question), {
    maxTurns: 8,
  });
  if (!completed.finalOutput) throw new Error("OpenAI Agents SDK returned no structured result.");

  traceReasoningItems(completed.newItems, "Coordinator reasoning");
  const result = runtimeResultSchema.parse(completed.finalOutput);
  trace("message", "Structured output", "OpenAI Agents SDK returned schema-validated output.", {
    source: "sdk",
    payload: result,
  });
  const verification = verifyCitations(result.citations, evidence.passages());
  if (!verification.valid) throw new Error("The returned citations failed deterministic lineage checks.");

  const requestUsages = [
    ...completed.rawResponses.map(usageForResponse),
    ...nestedRequestUsages,
  ];
  const usage = requestUsages.reduce(
    (total, response) => ({
      input: total.input + response.input,
      output: total.output + response.output,
      cachedInput: response.cachedInput !== undefined
        ? (total.cachedInput ?? 0) + response.cachedInput
        : total.cachedInput,
      reasoning: (total.reasoning ?? 0) + (response.reasoning ?? 0),
      total: total.total + response.total,
    }),
    { input: 0, output: 0, cachedInput: undefined as number | undefined, reasoning: 0, total: 0 },
  );
  const cost = resolveRunCost({
    modelId: model,
    usage,
    requestUsages,
    inputAccounting: "cached-subset",
  });

  return {
    result,
    durationMs: Date.now() - startedAt,
    usage,
    ...cost,
    contextHandling: config.contextHandling,
    activity: {
      model: {
        orchestratorTurns: completed.rawResponses.length,
        auxiliaryRequests,
        totalRequests: completed.rawResponses.length + auxiliaryRequests,
        completeness: "complete" as const,
        note: "Exact coordinator turns plus nested research and citation-verifier turns.",
      },
    },
  };
}

export async function runOpenAiAgent(
  question: string,
  modelLabel: string,
  emit: EmitRunEvent,
) {
  const provider = new OpenAIProvider({
    apiKey: openAiApiKey(),
    useResponses: true,
  });
  try {
    return await runOpenAiAgentsRuntime(question, modelLabel, emit, {
      provider,
      contextHandling: "OpenAI Agents SDK Runner over the Responses API; non-stream model transport; no persisted session",
    });
  } finally {
    await provider.close();
  }
}

export async function runGeminiOpenAiAgent(
  question: string,
  modelLabel: string,
  emit: EmitRunEvent,
) {
  const provider = new OpenAIProvider({
    apiKey: geminiApiKey(),
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    useResponses: false,
    strictFeatureValidation: true,
  });
  try {
    return await runOpenAiAgentsRuntime(question, modelLabel, emit, {
      provider,
      contextHandling: "OpenAI Agents SDK Runner over Gemini Chat Completions; non-stream model transport preserves Gemini thought signatures; no persisted session",
    });
  } finally {
    await provider.close();
  }
}
