export type RuntimeId =
  | "claude-agent"
  | "openai-agent"
  | "gemini-openai"
  | "vercel-agent";

export type RunStatus = "Ready" | "Running" | "Complete" | "Error";

export type TraceKind =
  | "reasoning"
  | "tool_call"
  | "tool_result"
  | "message"
  | "error";

export type TraceEvent = {
  id: string;
  kind: TraceKind;
  label: string;
  detail: string;
  source: "sdk" | "app";
  status: "Running" | "Complete" | "Error";
  payload?: unknown;
};

export type Citation = {
  passageId: string;
  label: string;
  url: string;
};

export type RuntimeResult = {
  title: string;
  answer: string;
  citations: Citation[];
};

export type RunUsage = {
  input: number;
  output: number;
  cachedInput?: number;
  cacheWrite?: number;
  reasoning?: number;
  total: number;
};

export type ToolActivity = {
  nativeCalls: number;
  nativeResults: number;
  sequence: string[];
  byName: Record<string, number>;
  retrievalOperations: number;
  verificationOperations: number;
  distinctSearchQueries: number;
};

export type ModelActivity = {
  orchestratorTurns: number;
  auxiliaryRequests?: number;
  totalRequests?: number;
  completeness: "complete" | "partial";
  note: string;
};

export type RunActivity = {
  tools?: ToolActivity;
  model?: ModelActivity;
};

export type EvaluationId =
  | "structural_output_valid"
  | "citation_lineage_valid"
  | "tools_succeeded"
  | "required_workflow_completed"
  | "claim_groundedness"
  | "answer_relevance";

export type EvaluationScore = {
  id: EvaluationId;
  label: string;
  score: number | null;
  status: "Complete" | "Error";
  evaluator: "deterministic" | "llm";
  source: string;
  rationale: string;
};

export type TraceLinks = {
  braintrust?: string;
  langsmith?: string;
};

export type RunComplete = {
  result: RuntimeResult;
  judgeModel?: string;
  durationMs: number;
  usage: RunUsage;
  costUsd?: number;
  costSource: string;
  contextHandling: string;
  activity?: RunActivity;
  evaluations?: EvaluationScore[];
  traceLinks?: TraceLinks;
  observabilityWarnings?: string[];
};

export type RunStreamEvent =
  | { type: "status"; status: RunStatus }
  | { type: "trace"; event: TraceEvent }
  | { type: "text_delta"; text: string }
  | ({ type: "complete" } & RunComplete)
  | { type: "error"; message: string };

export type RunRequest = {
  runtimeId: RuntimeId;
  model: string;
  question: string;
  comparisonId: string;
};

export type EmitRunEvent = (event: RunStreamEvent) => void;
