import type {
  EvaluationScore,
  RunActivity,
  RunComplete,
  RunStatus,
  RuntimeId,
  RuntimeResult,
  TraceEvent,
  TraceLinks,
} from "@/lib/run-events";

export type Runtime = {
  id: RuntimeId;
  sdk: string;
  model: string;
  modelOptions: string[];
  duration: string;
  cost: string;
  costSource: string;
  status: RunStatus;
  activity: TraceEvent[];
  runActivity?: RunActivity;
  usage: { label: string; value: string }[];
  contextHandling: string;
  result: RuntimeResult | null;
  evaluations: EvaluationScore[];
  traceLinks: TraceLinks;
  observabilityWarnings: string[];
  error: string | null;
};

function makeRuntime(
  id: RuntimeId,
  sdk: string,
  model: string,
  modelOptions: string[],
): Runtime {
  return {
    id,
    sdk,
    model,
    modelOptions,
    duration: "—",
    cost: "—",
    costSource: "Not run",
    status: "Ready",
    activity: [],
    runActivity: undefined,
    usage: [
      { label: "Input", value: "—" },
      { label: "Output", value: "—" },
      { label: "Cached", value: "—" },
      { label: "Reasoning", value: "—" },
      { label: "Total", value: "—" },
    ],
    contextHandling: "—",
    result: null,
    evaluations: [],
    traceLinks: {},
    observabilityWarnings: [],
    error: null,
  };
}

export const initialRuntimes: Runtime[] = [
  makeRuntime(
    "claude-agent",
    "Claude Agent SDK",
    "Claude Haiku 4.5",
    ["Claude Haiku 4.5", "Claude Sonnet 5", "Claude Opus 5"],
  ),
  makeRuntime(
    "openai-agent",
    "OpenAI Agents SDK",
    "GPT-5.4 nano",
    ["GPT-5.4 nano", "GPT-5.4 mini", "GPT-5.1"],
  ),
  makeRuntime(
    "gemini-openai",
    "OpenAI Agents SDK",
    "Gemini 3.1 Flash-Lite",
    ["Gemini 3.1 Flash-Lite", "Gemini 3.8 Flash", "Gemini 3.1 Pro"],
  ),
  makeRuntime(
    "vercel-agent",
    "Vercel AI SDK",
    "Claude Haiku 4.5",
    ["Claude Haiku 4.5", "Claude Sonnet 5", "Claude Opus 5"],
  ),
];

export function asRunning(runtime: Runtime): Runtime {
  return {
    ...runtime,
    duration: "—",
    cost: "—",
    costSource: "Running",
    status: "Running",
    activity: [],
    runActivity: undefined,
    usage: runtime.usage.map((item) => ({ ...item, value: "—" })),
    contextHandling: "—",
    result: null,
    evaluations: [],
    traceLinks: {},
    observabilityWarnings: [],
    error: null,
  };
}

export function withComplete(runtime: Runtime, complete: RunComplete): Runtime {
  const usage = complete.usage;
  return {
    ...runtime,
    status: "Complete",
    duration: `${(complete.durationMs / 1_000).toFixed(1)}s`,
    cost: complete.costUsd === undefined ? "—" : `$${complete.costUsd.toFixed(4)}`,
    costSource: complete.costSource,
    contextHandling: complete.contextHandling,
    result: complete.result,
    runActivity: complete.activity,
    evaluations: complete.evaluations ?? [],
    traceLinks: complete.traceLinks ?? {},
    observabilityWarnings: complete.observabilityWarnings ?? [],
    usage: [
      { label: "Input", value: usage.input.toLocaleString() },
      { label: "Output", value: usage.output.toLocaleString() },
      { label: "Cached", value: usage.cachedInput?.toLocaleString() ?? "—" },
      { label: "Reasoning", value: usage.reasoning?.toLocaleString() ?? "—" },
      { label: "Total", value: usage.total.toLocaleString() },
    ],
  };
}
