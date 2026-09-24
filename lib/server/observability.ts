import "server-only";

import { init, type Span } from "braintrust";
import { Client } from "langsmith";
import { RunTree } from "langsmith/run_trees";
import type {
  RunComplete,
  RunRequest,
  TraceEvent,
  TraceLinks,
} from "@/lib/run-events";
import { presentTrace, type TracePhase } from "@/lib/trace-presentation";
import type { EvaluationRun } from "@/lib/server/evaluations";

type ObservabilityInput = {
  request: RunRequest;
  complete: RunComplete;
  trace: TraceEvent[];
  evaluation: EvaluationRun;
};

const phaseNames: Record<TracePhase, string> = {
  coordination: "Coordinator",
  research: "Research agent",
  verification: "Citation verifier",
  result: "Structured result",
};

function modelTag(model: string) {
  return model.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function scoreRecord(evaluation: EvaluationRun) {
  return Object.fromEntries(evaluation.scores.map(({ id, score }) => [id, score]));
}

function metrics(input: ObservabilityInput) {
  const judge = input.evaluation.judgeUsage;
  const tools = input.complete.activity?.tools;
  const model = input.complete.activity?.model;
  return {
    duration_ms: input.complete.durationMs,
    input_tokens: input.complete.usage.input,
    output_tokens: input.complete.usage.output,
    ...(input.complete.usage.cachedInput === undefined
      ? {}
      : { cached_input_tokens: input.complete.usage.cachedInput }),
    ...(input.complete.usage.reasoning === undefined
      ? {}
      : { reasoning_tokens: input.complete.usage.reasoning }),
    total_tokens: input.complete.usage.total,
    judge_input_tokens: judge?.inputTokens ?? 0,
    judge_output_tokens: judge?.outputTokens ?? 0,
    ...(tools
      ? {
          native_tool_calls: tools.nativeCalls,
          native_tool_results: tools.nativeResults,
          retrieval_operations: tools.retrievalOperations,
          verification_operations: tools.verificationOperations,
          distinct_search_queries: tools.distinctSearchQueries,
        }
      : {}),
    ...(model
      ? {
          orchestrator_turns: model.orchestratorTurns,
          ...(model.auxiliaryRequests === undefined
            ? {}
            : { auxiliary_model_requests: model.auxiliaryRequests }),
          ...(model.totalRequests === undefined
            ? {}
            : { total_model_requests: model.totalRequests }),
        }
      : {}),
  };
}

function phaseGroups(trace: TraceEvent[]) {
  const groups = new Map<TracePhase, ReturnType<typeof presentTrace>>();
  for (const event of presentTrace(trace)) {
    groups.set(event.phase, [...(groups.get(event.phase) ?? []), event]);
  }
  return groups;
}

function braintrustType(kind: ReturnType<typeof presentTrace>[number]["kind"]) {
  if (kind === "tool") return "tool" as const;
  if (kind === "reasoning") return "llm" as const;
  if (kind === "error") return "task" as const;
  return "task" as const;
}

async function recordBraintrust(input: ObservabilityInput) {
  const apiKey =
    process.env.BRAINTRUST_API_KEY ?? process.env.BRAINTRUST_API_KEY_FOR_AGENTS;
  if (!apiKey) throw new Error("Braintrust API key is not configured.");

  const experiment = init({
    project: process.env.BRAINTRUST_PROJECT ?? "NovaMind SDK Comparison",
    experiment: `comparison-${input.request.comparisonId}`,
    description: "Same experimental input and output contract across selected agent runtimes.",
    update: true,
    setCurrent: false,
    apiKey,
    gitMetadataSettings: { collect: "none" },
    metadata: { comparisonId: input.request.comparisonId },
  });
  const root = experiment.startSpan({
    name: `${input.request.runtimeId} · ${input.request.model}`,
    type: "eval",
    event: {
      input: { experimentalInput: input.request.question },
      metadata: {
        comparisonId: input.request.comparisonId,
        runtimeId: input.request.runtimeId,
        model: input.request.model,
        judgeModel: input.evaluation.judgeModel,
      },
      tags: ["novamind", "agentic-search", `runtime:${input.request.runtimeId}`],
    },
  });

  const phaseSpans: Span[] = [];
  for (const [phase, events] of phaseGroups(input.trace)) {
    const phaseSpan = root.startSpan({
      name: phaseNames[phase],
      type: "task",
      event: {
        tags: [`phase:${phase}`, `runtime:${input.request.runtimeId}`],
        metadata: { phase, runtimeId: input.request.runtimeId },
      },
    });
    phaseSpans.push(phaseSpan);
    for (const presented of events) {
      const child = phaseSpan.startSpan({
        name: presented.label,
        type: braintrustType(presented.kind),
        event: {
          input: presented.event.payload ?? presented.event.detail,
          metadata: {
            displayKind: presented.kind,
            phase: presented.phase,
            nativeLabel: presented.event.label,
            nativeType: presented.nativeType,
            nativeKind: presented.event.kind,
            runtimeId: input.request.runtimeId,
            source: presented.event.source,
          },
          tags: [
            `kind:${presented.kind}`,
            `phase:${presented.phase}`,
            `source:${presented.event.source}`,
          ],
        },
      });
      child.log({ output: presented.event.detail });
      child.end();
    }
    phaseSpan.log({ output: { eventCount: events.length } });
  }
  for (const span of phaseSpans) span.end();

  root.log({
    output: input.complete.result,
    scores: scoreRecord(input.evaluation),
    metrics: metrics(input),
    metadata: {
      evaluations: input.evaluation.scores,
      costUsd: input.complete.costUsd,
      costSource: input.complete.costSource,
      contextHandling: input.complete.contextHandling,
      activity: input.complete.activity,
    },
  });
  root.end();
  await experiment.flush();
  return root.permalink();
}

function langSmithType(kind: ReturnType<typeof presentTrace>[number]["kind"]) {
  if (kind === "tool") return "tool";
  if (kind === "reasoning") return "llm";
  return "chain";
}

async function recordLangSmith(input: ObservabilityInput) {
  const apiKey = process.env.LANGSMITH_API_KEY ?? process.env.LANGSMITH_API_KEY_FOR_AGENTS;
  if (!apiKey) throw new Error("LangSmith API key is not configured.");

  const client = new Client({ apiKey });
  const projectName = process.env.LANGSMITH_PROJECT ?? "novamind-sdk-comparison";
  const project = await client.readProject({ projectName });
  const root = new RunTree({
    name: `${input.request.runtimeId} · ${input.request.model}`,
    run_type: "chain",
    project_name: projectName,
    inputs: { experimentalInput: input.request.question },
    metadata: {
      comparisonId: input.request.comparisonId,
      runtimeId: input.request.runtimeId,
      model: input.request.model,
      judgeModel: input.evaluation.judgeModel,
    },
    tags: [
      "novamind",
      "agentic-search",
      `runtime:${input.request.runtimeId}`,
      `model:${modelTag(input.request.model)}`,
    ],
    client,
  });
  await root.postRun();

  for (const [phase, events] of phaseGroups(input.trace)) {
    const phaseRun = root.createChild({
      name: phaseNames[phase],
      run_type: "chain",
      inputs: { eventCount: events.length },
      metadata: { phase, runtimeId: input.request.runtimeId },
      tags: ["phase", `phase:${phase}`, `runtime:${input.request.runtimeId}`],
    });
    await phaseRun.postRun();
    for (const presented of events) {
      const eventRun = phaseRun.createChild({
        name: presented.label,
        run_type: langSmithType(presented.kind),
        inputs: { payload: presented.event.payload ?? null },
        metadata: {
          displayKind: presented.kind,
          phase: presented.phase,
          nativeLabel: presented.event.label,
          nativeType: presented.nativeType,
          nativeKind: presented.event.kind,
          runtimeId: input.request.runtimeId,
          source: presented.event.source,
        },
        tags: [
          `kind:${presented.kind}`,
          `phase:${presented.phase}`,
          `source:${presented.event.source}`,
          `runtime:${input.request.runtimeId}`,
        ],
      });
      await eventRun.postRun();
      await eventRun.end({ detail: presented.event.detail });
      await eventRun.patchRun();
    }
    await phaseRun.end({ eventCount: events.length });
    await phaseRun.patchRun();
  }

  await root.end({
    result: input.complete.result,
    evaluations: input.evaluation.scores,
    metrics: metrics(input),
    activity: input.complete.activity,
  });
  await root.patchRun();
  const response = await client.runs.getURL(root.id, {
    project_id: project.id,
    trace_id: root.trace_id,
  });
  if (!response.url) throw new Error("LangSmith did not return a run URL.");
  return response.url;
}

export async function recordObservability(input: ObservabilityInput) {
  const links: TraceLinks = {};
  const warnings: string[] = [];
  const [braintrust, langsmith] = await Promise.allSettled([
    recordBraintrust(input),
    recordLangSmith(input),
  ]);

  if (braintrust.status === "fulfilled") links.braintrust = braintrust.value;
  else warnings.push("Braintrust trace export failed.");
  if (langsmith.status === "fulfilled") links.langsmith = langsmith.value;
  else warnings.push("LangSmith trace export failed.");

  return { links, warnings };
}
