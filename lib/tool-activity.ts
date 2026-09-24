import type { RuntimeId, ToolActivity, TraceEvent } from "@/lib/run-events";

const semanticKeys = new Set([
  "name",
  "tool_name",
  "toolname",
  "subagent_type",
  "subagenttype",
]);

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function strings(value: unknown, depth = 0): string[] {
  if (value === null || value === undefined || depth > 6) return [];
  if (typeof value === "string") {
    if (value.length > 4_000) return [];
    const parsed = value.trim().startsWith("{") ? parseJson(value) : null;
    return parsed ? [value, ...strings(parsed, depth + 1)] : [value];
  }
  if (Array.isArray(value)) return value.flatMap((item) => strings(item, depth + 1));
  if (typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
    const own = semanticKeys.has(normalize(key)) && typeof item === "string" ? [item] : [];
    return [...own, ...strings(item, depth + 1)];
  });
}

function parseJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function canonicalToolName(event: TraceEvent) {
  const identifiers = [event.label, ...strings(event.payload)].map(normalize);
  const includes = (candidate: string) =>
    identifiers.some((identifier) => identifier.includes(candidate));

  if (includes("search_literature")) return "search_literature";
  if (includes("read_evidence")) return "read_evidence";
  if (includes("verify_citations")) return "verify_citations";
  if (includes("citation_verifier")) return "citation_verifier";
  if (
    includes("research_agent") ||
    includes("research_specialist") ||
    includes("researcher")
  ) {
    return "research_agent";
  }
  if (includes("structured_output") || includes("structuredoutput")) {
    return "structured_output";
  }
  return normalize(event.label) || "unknown_tool";
}

function queryCandidates(value: unknown, depth = 0): string[] {
  if (value === null || value === undefined || depth > 6) return [];
  if (typeof value === "string") {
    const parsed = value.trim().startsWith("{") ? parseJson(value) : null;
    return parsed ? queryCandidates(parsed, depth + 1) : [];
  }
  if (Array.isArray(value)) return value.flatMap((item) => queryCandidates(item, depth + 1));
  if (typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
    const normalizedKey = normalize(key);
    const own =
      (normalizedKey === "question" || normalizedKey === "query") &&
      typeof item === "string" &&
      item.trim()
        ? [item.trim().replace(/\s+/g, " ").toLowerCase()]
        : [];
    return [...own, ...queryCandidates(item, depth + 1)];
  });
}

export function summarizeToolActivity(
  runtimeId: RuntimeId,
  events: TraceEvent[],
): ToolActivity {
  const calls = events.filter(({ kind }) => kind === "tool_call");
  const sequence = calls.map(canonicalToolName);
  const byName = sequence.reduce<Record<string, number>>((counts, name) => {
    counts[name] = (counts[name] ?? 0) + 1;
    return counts;
  }, {});
  const explicitSearches = byName.search_literature ?? 0;
  const directResearchCalls = byName.research_agent ?? 0;
  const retrievalOperations = explicitSearches || directResearchCalls;
  const verificationOperations =
    (byName.citation_verifier ?? 0) || (byName.verify_citations ?? 0);
  const queryEvents = explicitSearches
    ? calls.filter((event) => canonicalToolName(event) === "search_literature")
    : calls.filter((event) => canonicalToolName(event) === "research_agent");
  const distinctSearchQueries = new Set(
    queryEvents.flatMap((event) => queryCandidates(event.payload)),
  ).size;

  return {
    nativeCalls: calls.length,
    nativeResults: events.filter(({ kind }) => kind === "tool_result").length,
    sequence,
    byName,
    retrievalOperations,
    verificationOperations,
    distinctSearchQueries,
  };
}
