"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { asRunning, initialRuntimes, type Runtime, withComplete } from "@/lib/demo-data";
import type { RunStreamEvent, RuntimeId } from "@/lib/run-events";
import { ChevronIcon, ExpandIcon } from "./icons";
import { EvaluationGrid, ResultGrid } from "./comparison-sections";
import { RunDialog } from "./run-dialog";
import { RuntimeTrace } from "./runtime-trace";

const defaultExperimentalInput =
  "Recent findings suggest that targeting KRAS G12D may improve treatment response in pancreatic cancer";

export function ComparisonWorkspace() {
  const [experimentalInput, setExperimentalInput] = useState(defaultExperimentalInput);
  const [runtimes, setRuntimes] = useState(initialRuntimes);
  const [selectedIds, setSelectedIds] = useState(
    () => new Set(initialRuntimes.map(({ id }) => id)),
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<RuntimeId | null>(null);
  const [activeEvent, setActiveEvent] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [hasRun, setHasRun] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () => runtimes.filter(({ id }) => selectedIds.has(id)),
    [runtimes, selectedIds],
  );
  const expanded = runtimes.find(({ id }) => id === expandedId) ?? null;
  const inputIsValid = experimentalInput.trim().length >= 8;
  const completedCount = selected.filter(({ status }) => status === "Complete").length;
  const errorCount = selected.filter(({ status }) => status === "Error").length;
  const finishedCount = completedCount + errorCount;

  useEffect(() => {
    if (!pickerOpen) return;
    const closeOnPointerDown = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setPickerOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPickerOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [pickerOpen]);

  function updateRuntime(id: RuntimeId, update: (runtime: Runtime) => Runtime) {
    setRuntimes((current) =>
      current.map((runtime) => (runtime.id === id ? update(runtime) : runtime)),
    );
  }

  function applyStreamEvent(id: RuntimeId, event: RunStreamEvent) {
    updateRuntime(id, (runtime) => {
      if (event.type === "status") return { ...runtime, status: event.status };
      if (event.type === "trace") {
        return { ...runtime, activity: [...runtime.activity, event.event] };
      }
      if (event.type === "text_delta") return runtime;
      if (event.type === "complete") {
        return withComplete(runtime, event);
      }
      return {
        ...runtime,
        status: "Error",
        error: event.message,
        activity: [
          ...runtime.activity,
          {
            id: `error-${Date.now()}`,
            kind: "error",
            label: "Run failed",
            detail: event.message,
            source: "app",
            status: "Error",
          },
        ],
      };
    });
  }

  async function runRuntime(runtime: Runtime, comparisonId: string) {
    const response = await fetch("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        runtimeId: runtime.id,
        model: runtime.model,
        question: experimentalInput,
        comparisonId,
      }),
    });
    if (!response.ok || !response.body) {
      const failure = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(failure?.error ?? `Run request failed (${response.status}).`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) {
          applyStreamEvent(runtime.id, JSON.parse(line) as RunStreamEvent);
        }
      }
      if (done) break;
    }
    if (buffer.trim()) {
      applyStreamEvent(runtime.id, JSON.parse(buffer) as RunStreamEvent);
    }
  }

  async function runComparison() {
    if (!inputIsValid || isRunning) return;
    const runTargets = selected;
    setPickerOpen(false);
    setIsRunning(true);
    setHasRun(true);
    const comparisonId = crypto.randomUUID();
    setRuntimes((current) =>
      current.map((runtime) => (selectedIds.has(runtime.id) ? asRunning(runtime) : runtime)),
    );

    await Promise.allSettled(
      runTargets.map(async (runtime) => {
        try {
          await runRuntime(runtime, comparisonId);
        } catch (error) {
          applyStreamEvent(runtime.id, {
            type: "error",
            message: error instanceof Error ? error.message : "Unknown browser stream error",
          });
        }
      }),
    );
    setIsRunning(false);
  }

  function toggleRuntime(id: RuntimeId) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        if (next.size > 1) next.delete(id);
      } else next.add(id);
      return next;
    });
  }

  function updateModel(id: RuntimeId, model: string) {
    const template = initialRuntimes.find((runtime) => runtime.id === id);
    updateRuntime(id, (runtime) => (template ? { ...template, model } : runtime));
  }

  function openRun(id: RuntimeId, eventIndex?: number) {
    const runtime = runtimes.find((item) => item.id === id);
    setActiveEvent(eventIndex ?? Math.max((runtime?.activity.length ?? 1) - 1, 0));
    setExpandedId(id);
  }

  return (
    <main className="shell">
      <header className="masthead">
        <div className="brand-lockup"><span className="brand-mark" /><span className="brand">NovaMind / Lab</span></div>
      </header>

      <section className="query-panel" aria-labelledby="experimental-input-label">
        <div className="query-meta">
          <label id="experimental-input-label" htmlFor="experimental-input">Experimental data input</label>
          <span>{selected.length} selected</span>
        </div>
        <textarea id="experimental-input" aria-invalid={!inputIsValid} onChange={(event) => setExperimentalInput(event.target.value)} rows={2} value={experimentalInput} />
        <div className="query-actions">
          <div className="runtime-picker" ref={pickerRef}>
            <button className="picker-button" type="button" aria-controls="runtime-picker-menu" aria-expanded={pickerOpen} onClick={() => setPickerOpen((open) => !open)}>
              {selected.length} selected <ChevronIcon />
            </button>
            {pickerOpen ? (
              <div className="picker-menu" id="runtime-picker-menu">
                {runtimes.map((runtime) => (
                  <div className="picker-row" key={runtime.id}>
                    <label><input checked={selectedIds.has(runtime.id)} onChange={() => toggleRuntime(runtime.id)} type="checkbox" /><span>{runtime.sdk}</span></label>
                    <select aria-label={`${runtime.sdk} model`} disabled={!selectedIds.has(runtime.id)} onChange={(event) => updateModel(runtime.id, event.target.value)} value={runtime.model}>
                      {runtime.modelOptions.map((option) => <option key={option}>{option}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          <button className="run-button" type="button" disabled={!inputIsValid || isRunning} onClick={runComparison}>
            {isRunning ? "Running…" : "Run comparison"}
          </button>
        </div>
      </section>

      <section className="trajectory-section" aria-labelledby="trajectory-title">
        <div className="trajectory-heading">
          <h1 id="trajectory-title">Run trajectory</h1>
          <span>{isRunning ? `Streaming · ${finishedCount} of ${selected.length} finished` : hasRun && errorCount ? `${finishedCount} finished · ${errorCount} error${errorCount === 1 ? "" : "s"}` : hasRun ? `Complete · ${completedCount} of ${selected.length}` : `${selected.length} runtimes ready`}</span>
        </div>
        <div className="run-grid" aria-live="polite" style={{ "--run-count": Math.min(selected.length, 4), "--tablet-run-count": Math.min(selected.length, 2) } as React.CSSProperties}>
          {selected.map((runtime, index) => (
            <article className="run-card" key={runtime.id} style={{ "--delay": `${index * 55}ms` } as React.CSSProperties}>
              <header className="run-header">
                <div className="run-identity"><h2>{runtime.sdk}</h2><p className="model-name">{runtime.model}</p></div>
                <div className={`status-pill status-${runtime.status.toLowerCase()}`}><span />{runtime.status}</div>
              </header>
              <RuntimeTrace runtime={runtime} onSelect={(eventIndex) => openRun(runtime.id, eventIndex)} />
              {runtime.error ? <p className="run-error">{runtime.error}</p> : null}
              <button className="inspect-button" type="button" aria-label={`Expand ${runtime.sdk}`} disabled={!runtime.activity.length} onClick={() => openRun(runtime.id)}>Inspect run <ExpandIcon /></button>
            </article>
          ))}
        </div>
      </section>

      {hasRun ? <ResultGrid runtimes={selected} /> : null}
      {hasRun ? <EvaluationGrid runtimes={selected} /> : null}

      {expanded ? (
        <RunDialog runtime={expanded} activeEvent={activeEvent} onSelect={setActiveEvent} onClose={() => setExpandedId(null)} />
      ) : null}
    </main>
  );
}
