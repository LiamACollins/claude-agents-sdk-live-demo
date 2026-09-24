import "server-only";

import {
  createSdkMcpServer,
  query,
  tool,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { resolveRunCost } from "@/lib/model-cost";
import { runtimeResultJsonSchema } from "@/lib/result-contract";
import type { EmitRunEvent, RuntimeResult } from "@/lib/run-events";
import {
  compactEvidence,
  compactLedgerEvidence,
  parseRuntimeResult,
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
import { hasRemoteClaudeRunner, runRemoteClaudeAgent } from "./claude-remote";

function isRuntimeResult(value: unknown): value is RuntimeResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RuntimeResult>;
  return (
    typeof candidate.title === "string" &&
    typeof candidate.answer === "string" &&
    Array.isArray(candidate.citations)
  );
}

function blockRecord(block: unknown) {
  return block && typeof block === "object" ? (block as Record<string, unknown>) : null;
}

function toolCallDetail(
  block: Record<string, unknown>,
  message: { parent_tool_use_id?: string | null; subagent_type?: string },
) {
  if (block.name === "StructuredOutput") {
    return "Claude Agent SDK schema-output handoff.";
  }
  const input = blockRecord(block.input);
  const delegatedAgent = typeof input?.subagent_type === "string" ? input.subagent_type : null;
  if (block.name === "Agent" && delegatedAgent === "researcher") {
    return "Coordinator delegated to the research agent.";
  }
  if (block.name === "Agent" && delegatedAgent === "citation-verifier") {
    return "Coordinator delegated to the citation verifier.";
  }
  if (message.parent_tool_use_id && message.subagent_type === "researcher") {
    return "Research agent tool call.";
  }
  if (message.parent_tool_use_id && message.subagent_type === "citation-verifier") {
    return "Citation verifier tool call.";
  }
  return message.parent_tool_use_id ? "Sub-agent tool call." : "Coordinator tool call.";
}

export async function runClaudeAgent(
  question: string,
  modelLabel: string,
  emit: EmitRunEvent,
) {
  const model = resolveModelId(modelLabel);
  if (hasRemoteClaudeRunner()) {
    return runRemoteClaudeAgent(question, model, emit);
  }

  const startedAt = Date.now();
  const trace = traceEmitter(emit);
  const evidence = new RunEvidenceLedger();

  const server = createSdkMcpServer({
    name: "novamind",
    version: "1.0.0",
    tools: [
      tool(
        "search_literature",
        "Search the Convex literature corpus for exact passages.",
        { question: z.string() },
        async ({ question: toolQuestion }) => {
          const search = await searchAndRecordLiterature(evidence, toolQuestion, 5);
          return { content: [{ type: "text", text: JSON.stringify(compactEvidence(search)) }] };
        },
      ),
      tool(
        "read_evidence",
        "Read the immutable accumulated evidence ledger for this run.",
        {},
        async () => ({
          content: [{ type: "text", text: JSON.stringify(compactLedgerEvidence(evidence)) }],
        }),
      ),
    ],
  });

  let resultMessage: SDKResultMessage | null = null;
  let finalText = "";
  const supportsAdaptiveEffort =
    model === "claude-opus-5" || model === "claude-sonnet-5";
  const run = query({
    prompt: coordinatorPrompt(question),
    options: {
      model,
      systemPrompt: COORDINATOR_INSTRUCTIONS,
      agents: {
        researcher: {
          description: "Searches the literature corpus and returns exact evidence passages.",
          prompt: RESEARCH_INSTRUCTIONS,
          model,
          tools: ["mcp__novamind__search_literature"],
          maxTurns: 7,
          omitClaudeMd: true,
        },
        "citation-verifier": {
          description: "Checks whether every material claim in a proposed answer is supported by its cited retrieved passage.",
          prompt: VERIFIER_LEDGER_INSTRUCTIONS,
          model,
          tools: ["mcp__novamind__read_evidence"],
          maxTurns: 3,
          omitClaudeMd: true,
        },
      },
      tools: ["Agent"],
      allowedTools: [
        "Agent",
        "mcp__novamind__search_literature",
        "mcp__novamind__read_evidence",
      ],
      mcpServers: { novamind: server },
      includePartialMessages: true,
      forwardSubagentText: true,
      agentProgressSummaries: true,
      outputFormat: { type: "json_schema", schema: runtimeResultJsonSchema },
      settingSources: [],
      permissionPrompts: "none",
      persistSession: false,
      maxTurns: 8,
      maxBudgetUsd: 2,
      thinking: supportsAdaptiveEffort
        ? { type: "adaptive", display: "summarized" }
        : { type: "enabled", budgetTokens: 1_024, display: "summarized" },
      ...(supportsAdaptiveEffort ? { effort: "high" as const } : {}),
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: anthropicApiKey(),
        CLAUDE_AGENT_SDK_CLIENT_APP: "novamind-sdk-comparison/0.1.0",
        CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: "1",
      },
    },
  });

  for await (const message of run) {
    if (
      message.type === "system" &&
      (message.subtype === "model_refusal_fallback" ||
        message.subtype === "model_refusal_no_fallback")
    ) {
      const category = message.api_refusal_category ?? "unspecified";
      const fallback =
        message.subtype === "model_refusal_fallback"
          ? `; fallback to ${message.fallback_model} was rejected for benchmark purity`
          : "";
      throw new Error(`Claude ${message.original_model} refusal (${category})${fallback}.`);
    }
    if (message.type === "assistant") {
      for (const rawBlock of message.message.content) {
        const block = blockRecord(rawBlock);
        if (!block) continue;
        if (block.type === "tool_use") {
          trace(
            "tool_call",
            String(block.name ?? "Tool call"),
            toolCallDetail(block, message),
            { payload: block.input },
          );
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          trace("reasoning", "Reasoning summary", block.thinking, { source: "sdk" });
        } else if (block.type === "text" && typeof block.text === "string") {
          if (!message.parent_tool_use_id) finalText += block.text;
          trace(
            "message",
            message.subagent_type ?? "Coordinator response",
            block.text.slice(0, 240),
            { payload: { parentToolUseId: message.parent_tool_use_id } },
          );
        }
      }
      continue;
    }
    if (message.type === "user") {
      const content = Array.isArray(message.message.content) ? message.message.content : [];
      for (const rawBlock of content) {
        const block = blockRecord(rawBlock);
        if (block?.type === "tool_result") {
          trace("tool_result", "Tool result", "Claude Agent SDK returned a tool result.", {
            payload: block.content,
          });
        }
      }
      continue;
    }
    if (message.type === "system" && message.subtype === "task_progress" && message.summary) {
      trace("reasoning", "Sub-agent progress", message.summary, { source: "sdk" });
      continue;
    }
    if (message.type === "tool_use_summary") {
      trace("reasoning", "Tool-use summary", message.summary, { source: "sdk" });
      continue;
    }
    if (message.type === "stream_event" && !message.parent_tool_use_id) {
      const event = message.event as unknown as Record<string, unknown>;
      const delta = blockRecord(event.delta);
      if (event.type === "content_block_delta" && delta?.type === "text_delta") {
        const text = String(delta.text ?? "");
        emit({ type: "text_delta", text });
      }
      continue;
    }
    if (message.type === "result") resultMessage = message;
  }

  if (!resultMessage) throw new Error("Claude Agent SDK returned no result message.");
  if (resultMessage.subtype !== "success") {
    throw new Error(resultMessage.errors.join(" ") || `Claude run ended: ${resultMessage.subtype}`);
  }

  const result = isRuntimeResult(resultMessage.structured_output)
    ? resultMessage.structured_output
    : parseRuntimeResult(resultMessage.result || finalText);
  trace("message", "Structured output", "Claude Agent SDK returned schema-validated output.", {
    source: "sdk",
    payload: result,
  });
  const verification = verifyCitations(result.citations, evidence.passages());
  if (!verification.valid) throw new Error("The returned citations failed deterministic lineage checks.");

  const usage = Object.values(resultMessage.modelUsage).reduce(
    (total, modelUsage) => ({
      input: total.input + modelUsage.inputTokens,
      output: total.output + modelUsage.outputTokens,
      cachedInput: total.cachedInput + modelUsage.cacheReadInputTokens,
      cacheWrite: total.cacheWrite + modelUsage.cacheCreationInputTokens,
      reasoning: total.reasoning + (modelUsage.thinkingTokens ?? 0),
      total: total.total + modelUsage.inputTokens + modelUsage.outputTokens,
    }),
    { input: 0, output: 0, cachedInput: 0, cacheWrite: 0, reasoning: 0, total: 0 },
  );
  const cost = resolveRunCost({
    modelId: model,
    usage,
    inputAccounting: "separate-cache-buckets",
    nativeCostUsd: resultMessage.total_cost_usd,
    nativeSource: "Claude Agent SDK estimate",
  });

  return {
    result,
    durationMs: Date.now() - startedAt,
    usage,
    ...cost,
    contextHandling: "SDK modelUsage includes coordinator and sub-agents",
    activity: {
      model: {
        orchestratorTurns: resultMessage.num_turns,
        completeness: "partial" as const,
        note: "Claude Agent SDK main-loop turns; sub-agent and sidechain requests are excluded.",
      },
    },
  };
}
