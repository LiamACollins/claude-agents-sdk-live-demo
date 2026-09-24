import type { TraceEvent } from "@/lib/run-events";

export type TraceDisplayKind = "agent" | "reasoning" | "tool" | "result" | "error";
export type TracePhase = "coordination" | "research" | "verification" | "result";

export type PresentedTraceEvent = {
  event: TraceEvent;
  label: string;
  kind: TraceDisplayKind;
  phase: TracePhase;
  depth: 0 | 1;
  nativeType: string;
};

const nativeTypeLabels = {
  reasoning: "Reasoning",
  tool_call: "Tool call",
  tool_result: "Tool result",
  message: "Message",
  error: "Error",
} as const;

const semanticKeys = new Set([
  "agent",
  "agent_name",
  "agentname",
  "name",
  "subagent_type",
  "subagenttype",
  "tool_name",
  "toolname",
  "type",
]);

function canonical(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function semanticPayloadValues(value: unknown, depth = 0): string[] {
  if (!value || typeof value !== "object" || depth > 5) return [];

  if (Array.isArray(value)) {
    return value.flatMap((item) => semanticPayloadValues(item, depth + 1));
  }

  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
    const normalizedKey = key.toLowerCase();
    const ownValue =
      semanticKeys.has(normalizedKey) && typeof item === "string" && item.length <= 120
        ? [item]
        : [];
    return [...ownValue, ...semanticPayloadValues(item, depth + 1)];
  });
}

function semanticIdentifiers(event: TraceEvent) {
  return [event.label, ...semanticPayloadValues(event.payload)].map(canonical);
}

function hasIdentifier(identifiers: string[], candidates: string[]) {
  return identifiers.some((identifier) =>
    candidates.some((candidate) => identifier.includes(candidate)),
  );
}

export function presentTrace(events: TraceEvent[]): PresentedTraceEvent[] {
  let currentPhase: TracePhase = "coordination";

  return events.map((event) => {
    const identifiers = semanticIdentifiers(event);
    const labelText = canonical(event.label);
    const detailText = canonical(event.detail);
    let label = event.label;
    let kind: TraceDisplayKind = event.kind === "error" ? "error" : "reasoning";
    let phase = currentPhase;
    let depth: 0 | 1 = 0;
    let nativeType: string = nativeTypeLabels[event.kind];

    if (event.kind === "error") {
      label = "Run failed";
      kind = "error";
    } else if (hasIdentifier(identifiers, ["structuredoutput"])) {
      label = event.kind === "tool_result" ? "Structured output result" : "Structured output";
      kind = "result";
      phase = "result";
      depth = event.kind === "message" ? 0 : 1;
      nativeType = event.kind === "message" ? "Structured output" : "SDK output handoff";
    } else if (hasIdentifier(identifiers, ["verifycitations"])) {
      label = event.kind === "tool_result" ? "Citation check result" : "Citation check";
      kind = "tool";
      phase = "verification";
      depth = 1;
    } else if (
      hasIdentifier(identifiers, ["citationverifier"]) ||
      detailText.includes("citationverifier")
    ) {
      label = event.kind === "tool_result" ? "Citation verifier result" : "Citation verifier";
      kind = "agent";
      phase = "verification";
    } else if (hasIdentifier(identifiers, ["searchliterature"])) {
      label = event.kind === "tool_result" ? "Literature search result" : "Literature search";
      kind = "tool";
      phase = "research";
      depth = 1;
    } else if (
      hasIdentifier(identifiers, ["researchagent", "researchspecialist", "researcher"]) ||
      detailText.includes("researchagent") ||
      detailText.includes("researcheragent") ||
      detailText.includes("researchspecialist")
    ) {
      label = event.kind === "tool_result" ? "Research agent result" : "Research agent";
      kind = "agent";
      phase = "research";
    } else if (event.kind === "reasoning") {
      label = "Reasoning";
      kind = "reasoning";
      depth = currentPhase === "coordination" ? 0 : 1;
    } else if (event.kind === "tool_result") {
      if (currentPhase === "result") {
        label = "Structured output result";
        kind = "result";
        nativeType = "SDK output handoff";
      } else {
        label = currentPhase === "verification" ? "Citation verifier result" : "Research agent result";
        kind = "agent";
      }
      phase = currentPhase;
      depth = 1;
    } else if (event.kind === "tool_call") {
      label = "Tool call";
      kind = "tool";
      depth = 1;
    } else if (event.kind === "message") {
      label = labelText.includes("coordinator") ? "Coordinator" : event.label;
      kind = "agent";
    }

    currentPhase = phase;
    return {
      event,
      label,
      kind,
      phase,
      depth,
      nativeType,
    };
  });
}

function countLabel(count: number, singular: string, plural: string) {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function evaluateRequiredToolStages(events: TraceEvent[]) {
  const presented = presentTrace(events);
  const toolCalls = events.filter(({ kind }) => kind === "tool_call").length;
  const toolResults = events.filter(({ kind }) => kind === "tool_result").length;
  const errors = events.filter(({ kind, status }) => kind === "error" || status === "Error").length;
  const completedPhases = new Set(
    (["research", "verification"] as const).filter((phase) => {
      const phaseEvents = presented.filter((event) => event.phase === phase);
      return (
        phaseEvents.some(({ event }) => event.kind === "tool_call") &&
        phaseEvents.some(({ event }) => event.kind === "tool_result")
      );
    }),
  );

  if (errors > 0) {
    return {
      succeeded: false,
      rationale: `${countLabel(errors, "trace event", "trace events")} reported an error.`,
    };
  }

  const missing = [
    completedPhases.has("research") ? null : "research",
    completedPhases.has("verification") ? null : "citation verification",
  ].filter((phase): phase is string => phase !== null);
  const counts = `${countLabel(toolCalls, "tool call", "tool calls")} produced ${countLabel(toolResults, "result", "results")}`;

  if (missing.length > 0) {
    const missingText = missing.join(" and ");
    const missingLabel = `${missingText[0].toUpperCase()}${missingText.slice(1)}`;
    return {
      succeeded: false,
      rationale: `${missingLabel} did not complete; ${counts}.`,
    };
  }

  return {
    succeeded: true,
    rationale: `Research and citation verification completed with ${countLabel(toolCalls, "tool call", "tool calls")} and ${countLabel(toolResults, "result", "results")}.`,
  };
}

export function evaluateToolExecution(events: TraceEvent[]) {
  const toolCalls = events.filter(({ kind }) => kind === "tool_call").length;
  const toolResults = events.filter(({ kind }) => kind === "tool_result").length;
  const errors = events.filter(({ kind, status }) => kind === "error" || status === "Error").length;

  if (errors > 0) {
    return {
      succeeded: false,
      rationale: `${countLabel(errors, "trace event", "trace events")} reported an error.`,
    };
  }

  if (toolCalls === 0) {
    return {
      succeeded: false,
      rationale: "No tool calls were emitted.",
    };
  }

  const counts = `${countLabel(toolCalls, "tool call", "tool calls")} produced ${countLabel(toolResults, "result", "results")}`;
  if (toolResults < toolCalls) {
    return {
      succeeded: false,
      rationale: `${counts}; at least one invoked tool did not return a result.`,
    };
  }

  return {
    succeeded: true,
    rationale: `${counts}; every invoked tool returned successfully.`,
  };
}
