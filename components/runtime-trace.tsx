import type { Runtime } from "@/lib/demo-data";
import { presentTrace } from "@/lib/trace-presentation";

export function RuntimeTrace({
  runtime,
  onSelect,
  activeIndex,
  variant = "card",
}: {
  runtime: Runtime;
  onSelect: (index: number) => void;
  activeIndex?: number;
  variant?: "card" | "dialog";
}) {
  const events = presentTrace(runtime.activity);

  if (events.length === 0) {
    return (
      <div className="trace-empty">
        {runtime.status === "Running" ? "Waiting for the first SDK event…" : "No run yet."}
      </div>
    );
  }

  return (
    <div className={`runtime-trace runtime-trace-${variant}`} aria-label={`${runtime.sdk} trajectory`}>
      {events.map((presented, index) => (
        <button
          className={`timeline-row trace-${presented.kind} depth-${presented.depth}${activeIndex === index ? " active" : ""}`}
          key={presented.event.id}
          onClick={() => onSelect(index)}
          type="button"
        >
          <span className="timeline-line" aria-hidden="true"><i /></span>
          <span className="timeline-copy">
            <strong>{presented.label}</strong>
            <small>{presented.nativeType} · {presented.event.source}</small>
          </span>
          <span className="timeline-status" aria-label={presented.event.status}>
            {presented.event.status === "Complete" ? "✓" : "·"}
          </span>
        </button>
      ))}
    </div>
  );
}
