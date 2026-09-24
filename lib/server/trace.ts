import "server-only";

import type { EmitRunEvent, TraceEvent, TraceKind } from "@/lib/run-events";

export function traceEmitter(emit: EmitRunEvent) {
  let sequence = 0;

  return (
    kind: TraceKind,
    label: string,
    detail: string,
    options: Partial<Pick<TraceEvent, "source" | "status" | "payload">> = {},
  ) => {
    sequence += 1;
    emit({
      type: "trace",
      event: {
        id: `event-${sequence}`,
        kind,
        label,
        detail,
        source: options.source ?? "sdk",
        status: options.status ?? "Complete",
        payload: options.payload,
      },
    });
  };
}

export function safeError(error: unknown) {
  return error instanceof Error ? error.message : "Unknown runtime error";
}
