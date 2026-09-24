import { NextResponse } from "next/server";
import type {
  EmitRunEvent,
  RunComplete,
  RunRequest,
  RuntimeId,
  TraceEvent,
} from "@/lib/run-events";
import { safeError } from "@/lib/server/trace";
import { summarizeToolActivity } from "@/lib/tool-activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

const runtimeIds = new Set<RuntimeId>([
  "claude-agent",
  "openai-agent",
  "gemini-openai",
  "vercel-agent",
]);

async function runSelected(request: RunRequest, emit: EmitRunEvent): Promise<RunComplete> {
  if (request.runtimeId === "claude-agent") {
    const { runClaudeAgent } = await import("@/lib/server/runners/claude-agent");
    return runClaudeAgent(request.question, request.model, emit);
  }
  if (request.runtimeId === "openai-agent") {
    const { runOpenAiAgent } = await import("@/lib/server/runners/openai-agent");
    return runOpenAiAgent(request.question, request.model, emit);
  }
  if (request.runtimeId === "gemini-openai") {
    const { runGeminiOpenAiAgent } = await import("@/lib/server/runners/openai-agent");
    return runGeminiOpenAiAgent(request.question, request.model, emit);
  }
  const { runVercelAgent } = await import("@/lib/server/runners/vercel-agent");
  return runVercelAgent(request.question, request.model, emit);
}

export async function POST(httpRequest: Request) {
  let body: RunRequest;
  try {
    body = (await httpRequest.json()) as RunRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON request." }, { status: 400 });
  }

  if (
    !runtimeIds.has(body.runtimeId) ||
    typeof body.model !== "string" ||
    typeof body.question !== "string" ||
    typeof body.comparisonId !== "string" ||
    !/^[a-z0-9-]{8,80}$/i.test(body.comparisonId) ||
    body.question.trim().length < 8 ||
    body.question.length > 2_000
  ) {
    return NextResponse.json({ error: "Invalid run request." }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const trace: TraceEvent[] = [];
      const emit: EmitRunEvent = (event) => {
        if (event.type === "trace") trace.push(event.event);
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      void (async () => {
        try {
          emit({ type: "status", status: "Running" });
          const result = await runSelected(body, emit);
          const complete: RunComplete = {
            ...result,
            activity: {
              ...result.activity,
              tools: summarizeToolActivity(body.runtimeId, trace),
            },
          };
          const { evaluateRun } = await import("@/lib/server/evaluations");
          const evaluation = await evaluateRun(body.question, complete.result, trace);
          const { recordObservability } = await import("@/lib/server/observability");
          const observability = await recordObservability({
            request: body,
            complete,
            trace,
            evaluation,
          });
          emit({
            type: "complete",
            ...complete,
            judgeModel: evaluation.judgeModel,
            evaluations: evaluation.scores,
            traceLinks: observability.links,
            observabilityWarnings: observability.warnings,
          });
          emit({ type: "status", status: "Complete" });
        } catch (error) {
          const message = safeError(error);
          console.error("[run] runtime failed", {
            runtimeId: body.runtimeId,
            model: body.model,
            comparisonId: body.comparisonId,
            message,
          });
          emit({ type: "error", message });
          emit({ type: "status", status: "Error" });
        } finally {
          controller.close();
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
