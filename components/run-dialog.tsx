import { useEffect, useMemo, useRef } from "react";
import type { Runtime } from "@/lib/demo-data";
import { presentTrace } from "@/lib/trace-presentation";
import { CloseIcon } from "./icons";
import { RuntimeTrace } from "./runtime-trace";

function payloadText(payload: unknown) {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

export function RunDialog({
  runtime,
  activeEvent,
  onSelect,
  onClose,
}: {
  runtime: Runtime;
  activeEvent: number;
  onSelect: (index: number) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const events = useMemo(() => presentTrace(runtime.activity), [runtime.activity]);
  const selected = events[activeEvent] ?? events.at(-1) ?? null;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  function closeOnBackdrop(event: React.MouseEvent<HTMLDialogElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    ) onClose();
  }

  return (
    <dialog
      className="run-dialog"
      aria-labelledby="dialog-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onMouseDown={closeOnBackdrop}
      ref={dialogRef}
    >
      <header className="dialog-header">
        <div><p className="eyebrow">{runtime.sdk}</p><h2 id="dialog-title">{runtime.model}</h2></div>
        <button className="icon-button" type="button" aria-label="Close run details" onClick={onClose}><CloseIcon /></button>
      </header>
      <div className="dialog-body">
        <aside className="trace-pane">
          <p className="pane-label">Run trace</p>
          <RuntimeTrace runtime={runtime} activeIndex={activeEvent} onSelect={onSelect} variant="dialog" />
        </aside>
        <section className="detail-pane">
          <div className="trace-detail">
            <p className="pane-label">{selected?.nativeType ?? "Event"}</p>
            <h3>{selected?.label ?? "No event selected"}</h3>
            {selected ? <p className="native-event-name">Native label: {selected.event.label}</p> : null}
            <p>{selected?.event.detail}</p>
            {selected?.event.payload === undefined ? null : <pre>{payloadText(selected.event.payload)}</pre>}
          </div>
        </section>
      </div>
    </dialog>
  );
}
