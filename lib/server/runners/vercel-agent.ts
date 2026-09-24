import "server-only";

import { createAnthropic } from "@ai-sdk/anthropic";
import { NoObjectGeneratedError, Output, stepCountIs, tool, ToolLoopAgent } from "ai";
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
import { anthropicApiKey, resolveModelId } from "../models";
import {
  COORDINATOR_INSTRUCTIONS,
  RESEARCH_INSTRUCTIONS,
  VERIFIER_LEDGER_INSTRUCTIONS,
  coordinatorPrompt,
} from "../prompts";
import { traceEmitter } from "../trace";
import { vercelAnthropicProviderOptions } from "../vercel-anthropic-options";

type RunUsage = {
  input: number;
  output: number;
  cachedInput?: number;
  cacheWrite?: number;
  reasoning?: number;
  total: number;
};

const anthropicCacheControl = {
  anthropic: {
    cacheControl: { type: "ephemeral" as const },
  },
};

function blockRecord(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function combineUsage(left: RunUsage, right: RunUsage): RunUsage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cachedInput:
      left.cachedInput === undefined && right.cachedInput === undefined
        ? undefined
        : (left.cachedInput ?? 0) + (right.cachedInput ?? 0),
    cacheWrite:
      left.cacheWrite === undefined && right.cacheWrite === undefined
        ? undefined
        : (left.cacheWrite ?? 0) + (right.cacheWrite ?? 0),
    reasoning:
      left.reasoning === undefined && right.reasoning === undefined
        ? undefined
        : (left.reasoning ?? 0) + (right.reasoning ?? 0),
    total: left.total + right.total,
  };
}

function refusalFromProviderMetadata(metadata: unknown) {
  const provider = blockRecord(metadata);
  const anthropic = blockRecord(provider?.anthropic);
  const stopDetails = blockRecord(anthropic?.stopDetails);
  if (stopDetails?.type !== "refusal") return null;
  return {
    category: typeof stopDetails.category === "string" ? stopDetails.category : "unspecified",
    explanation:
      typeof stopDetails.explanation === "string" ? stopDetails.explanation : undefined,
  };
}

export async function runVercelAgent(
  question: string,
  modelLabel: string,
  emit: EmitRunEvent,
) {
  const startedAt = Date.now();
  const trace = traceEmitter(emit);
  const model = resolveModelId(modelLabel);
  const evidence = new RunEvidenceLedger();
  const provider = createAnthropic({ apiKey: anthropicApiKey() });
  const anthropicProviderOptions = vercelAnthropicProviderOptions(model);
  let subagentUsage: RunUsage = { input: 0, output: 0, total: 0 };
  let subagentPricingUsage: RunUsage = { input: 0, output: 0, total: 0 };
  let auxiliaryRequests = 0;
  const tracedCoordinatorResults = new Set<string>();

  const recordSubagentUsage = (run: {
    usage: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      inputTokenDetails: {
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
        noCacheTokens?: number;
      };
      outputTokenDetails: { reasoningTokens?: number };
    };
    steps: unknown[];
  }) => {
    const inputDetails = run.usage.inputTokenDetails;
    const nestedUsage: RunUsage = {
      input: run.usage.inputTokens ?? 0,
      output: run.usage.outputTokens ?? 0,
      cachedInput: inputDetails.cacheReadTokens,
      cacheWrite: inputDetails.cacheWriteTokens,
      reasoning: run.usage.outputTokenDetails.reasoningTokens,
      total: run.usage.totalTokens ?? 0,
    };
    subagentUsage = combineUsage(subagentUsage, nestedUsage);
    subagentPricingUsage = combineUsage(subagentPricingUsage, {
      ...nestedUsage,
      input:
        inputDetails.noCacheTokens ??
        Math.max(
          0,
          nestedUsage.input -
            (nestedUsage.cachedInput ?? 0) -
            (nestedUsage.cacheWrite ?? 0),
        ),
    });
    auxiliaryRequests += run.steps.length;
  };

  const traceSubagentStep = (agentName: string) =>
    (step: {
      reasoningText?: string;
      toolCalls: Array<{ toolName: string; input: unknown }>;
      toolResults: Array<{ toolName: string; output: unknown }>;
    }) => {
      if (step.reasoningText?.trim()) {
        trace("reasoning", `${agentName} reasoning`, step.reasoningText.trim(), {
          source: "sdk",
        });
      }
      for (const call of step.toolCalls) {
        trace("tool_call", call.toolName, `${agentName} invoked a tool.`, {
          source: "sdk",
          payload: call.input,
        });
      }
      for (const result of step.toolResults) {
        trace("tool_result", result.toolName, `${agentName} received a tool result.`, {
          source: "sdk",
          payload: result.output,
        });
      }
    };

  const researchAgent = new ToolLoopAgent({
    id: "novamind-research-specialist",
    model: provider(model),
    instructions: RESEARCH_INSTRUCTIONS,
    tools: {
      search_literature: tool({
        description: "Search the Convex literature corpus for exact passages.",
        inputSchema: z.object({ question: z.string() }),
        providerOptions: anthropicCacheControl,
        execute: async ({ question: toolQuestion }) => {
          const search = await searchAndRecordLiterature(evidence, toolQuestion, 5);
          return compactEvidence(search);
        },
      }),
    },
    stopWhen: stepCountIs(7),
    maxOutputTokens: 4_096,
    providerOptions: {
      anthropic: anthropicProviderOptions,
    },
    onStepEnd: traceSubagentStep("Research specialist"),
  });

  const verifierAgent = new ToolLoopAgent({
    id: "novamind-citation-verifier",
    model: provider(model),
    instructions: VERIFIER_LEDGER_INSTRUCTIONS,
    tools: {
      read_evidence: tool({
        description: "Read the immutable accumulated evidence ledger for this run.",
        inputSchema: z.object({}),
        providerOptions: anthropicCacheControl,
        execute: async () => compactLedgerEvidence(evidence),
      }),
    },
    stopWhen: stepCountIs(3),
    maxOutputTokens: 2_048,
    providerOptions: {
      anthropic: anthropicProviderOptions,
    },
    onStepEnd: traceSubagentStep("Citation verifier"),
  });

  const tools = {
    research_agent: tool({
      description: "Delegate literature retrieval to the research specialist.",
      inputSchema: z.object({ question: z.string() }),
      execute: async ({ question: toolQuestion }, { toolCallId }) => {
        const run = await researchAgent.generate({ prompt: toolQuestion });
        recordSubagentUsage(run);
        tracedCoordinatorResults.add(toolCallId);
        trace(
          "tool_result",
          "Research agent result",
          "Research specialist returned to ToolLoopAgent.",
          { source: "sdk", payload: { toolCallId, output: run.text } },
        );
        return run.text;
      },
    }),
    citation_verifier: tool({
      description: "Check whether every material claim in a proposed answer is supported by its cited retrieved passage.",
      inputSchema: z.object({ draft: runtimeResultSchema }),
      providerOptions: anthropicCacheControl,
      execute: async ({ draft }, { toolCallId }) => {
        const run = await verifierAgent.generate({
          prompt: JSON.stringify({ proposedAnswer: draft }),
        });
        recordSubagentUsage(run);
        tracedCoordinatorResults.add(toolCallId);
        trace(
          "tool_result",
          "Citation verifier result",
          "Citation verifier returned to ToolLoopAgent.",
          { source: "sdk", payload: { toolCallId, output: run.text } },
        );
        return run.text;
      },
    }),
  };

  const agent = new ToolLoopAgent({
    id: "novamind-vercel-tool-loop",
    model: provider(model),
    instructions: COORDINATOR_INSTRUCTIONS,
    tools,
    output: Output.object({
      schema: runtimeResultSchema,
      name: "literature_search_result",
      description: "A cited answer produced from passages returned by the literature search tool.",
    }),
    stopWhen: stepCountIs(8),
    maxOutputTokens: 4_096,
    providerOptions: {
      anthropic: anthropicProviderOptions,
    },
  });

  const stream = await agent.stream({ prompt: coordinatorPrompt(question) });
  let reasoning = "";
  let usage: RunUsage = { input: 0, output: 0, total: 0 };
  let pricingUsage = usage;
  let orchestratorTurns = 0;
  let finalProviderMetadata: unknown;

  for await (const part of stream.fullStream) {
    if (part.type === "error") {
      throw part.error instanceof Error ? part.error : new Error(String(part.error));
    }
    if (part.type === "reasoning-delta") {
      reasoning += part.text;
      continue;
    }
    if (part.type === "reasoning-end" && reasoning.trim()) {
      trace("reasoning", "Reasoning summary", reasoning.trim(), { source: "sdk" });
      reasoning = "";
      continue;
    }
    if (part.type === "tool-call") {
      trace("tool_call", part.toolName, "Tool call emitted by ToolLoopAgent.", {
        payload: part.input,
      });
      continue;
    }
    if (part.type === "tool-result") {
      if (tracedCoordinatorResults.has(part.toolCallId)) continue;
      trace("tool_result", part.toolName, "Tool result returned to ToolLoopAgent.", {
        payload: { toolCallId: part.toolCallId, output: part.output },
      });
      continue;
    }
    if (part.type === "tool-error") {
      trace("error", part.toolName, "Tool execution failed inside ToolLoopAgent.", {
        status: "Error",
        payload: {
          toolCallId: part.toolCallId,
          input: part.input,
          error: part.error instanceof Error ? part.error.message : String(part.error),
        },
      });
      continue;
    }
    if (part.type === "text-delta") {
      emit({ type: "text_delta", text: part.text });
      continue;
    }
    if (part.type === "finish-step") {
      orchestratorTurns += 1;
      finalProviderMetadata = part.providerMetadata;
      continue;
    }
    if (part.type === "finish") {
      const inputDetails = part.totalUsage.inputTokenDetails;
      usage = {
        input: part.totalUsage.inputTokens ?? 0,
        output: part.totalUsage.outputTokens ?? 0,
        cachedInput: inputDetails.cacheReadTokens,
        cacheWrite: inputDetails.cacheWriteTokens,
        reasoning: part.totalUsage.outputTokenDetails.reasoningTokens,
        total: part.totalUsage.totalTokens ?? 0,
      };
      pricingUsage = {
        ...usage,
        input:
          inputDetails.noCacheTokens ??
          Math.max(
            0,
            usage.input - (usage.cachedInput ?? 0) - (usage.cacheWrite ?? 0),
          ),
      };
    }
  }

  let result;
  try {
    result = await stream.output;
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      const refusal = refusalFromProviderMetadata(finalProviderMetadata);
      if (refusal) {
        throw new Error(
          `Claude ${model} refusal (${refusal.category})${refusal.explanation ? `: ${refusal.explanation}` : "."}`,
        );
      }
      const providerDetails = JSON.stringify(finalProviderMetadata)?.slice(0, 400);
      throw new Error(
        `Vercel structured output failed (${error.finishReason ?? "unknown finish"}; ${error.text?.length ?? 0} text characters): ${error.text?.slice(0, 240) || "no final text"}${providerDetails ? `; provider: ${providerDetails}` : ""}`,
      );
    }
    throw error;
  }
  trace("message", "Structured output", "ToolLoopAgent returned schema-validated output.", {
    source: "sdk",
    payload: result,
  });
  const verification = verifyCitations(result.citations, evidence.passages());
  if (!verification.valid) throw new Error("The returned citations failed deterministic lineage checks.");
  usage = combineUsage(usage, subagentUsage);
  pricingUsage = combineUsage(pricingUsage, subagentPricingUsage);
  const cost = resolveRunCost({
    modelId: model,
    usage: pricingUsage,
    inputAccounting: "separate-cache-buckets",
  });

  return {
    result,
    durationMs: Date.now() - startedAt,
    usage,
    ...cost,
    contextHandling: "AI SDK ToolLoopAgent state; coordinator and sub-agent usage combined",
    activity: {
      model: {
        orchestratorTurns,
        auxiliaryRequests,
        totalRequests: orchestratorTurns + auxiliaryRequests,
        completeness: "complete" as const,
        note: "Exact coordinator steps plus nested research and citation-verifier steps.",
      },
    },
  };
}
