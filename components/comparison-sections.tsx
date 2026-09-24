"use client";

import { useState } from "react";
import type { Runtime } from "@/lib/demo-data";
import { conciseEvaluationRationale } from "@/lib/evaluation-format";
import type { EvaluationId } from "@/lib/run-events";

const evaluationRows: Array<{
  id: EvaluationId;
  label: string;
  evaluator: "LLM judge" | "Deterministic";
  description: string;
}> = [
  {
    id: "claim_groundedness",
    label: "Claim groundedness",
    evaluator: "LLM judge",
    description: "Whether every material claim is supported and scoped correctly by its cited passages.",
  },
  {
    id: "answer_relevance",
    label: "Answer relevance",
    evaluator: "LLM judge",
    description: "Whether the answer directly and concisely addresses the experimental input.",
  },
  {
    id: "structural_output_valid",
    label: "Structured output",
    evaluator: "Deterministic",
    description: "Whether the final payload matches the shared JSON contract.",
  },
  {
    id: "citation_lineage_valid",
    label: "Citation lineage",
    evaluator: "Deterministic",
    description: "Whether every citation resolves to a retrieved passage ID and source URL.",
  },
  {
    id: "tools_succeeded",
    label: "Tools succeeded",
    evaluator: "Deterministic",
    description: "Whether every tool the harness invoked returned a result without an error.",
  },
  {
    id: "required_workflow_completed",
    label: "Required workflow",
    evaluator: "Deterministic",
    description: "Whether both required research and citation-verification stages completed.",
  },
];

function usageValue(runtime: Runtime, label: string) {
  return runtime.usage.find((item) => item.label === label)?.value ?? "—";
}

function activityValue(value: number | undefined) {
  return value === undefined ? "—" : value.toLocaleString();
}

const metricRows: Array<{
  id: string;
  label: string;
  description: string;
  value: (runtime: Runtime) => string;
  detail?: (runtime: Runtime) => string;
}> = [
  {
    id: "cost",
    label: "Model cost",
    description: "Runtime token cost: native SDK cost when available, otherwise provider usage priced at audited list rates.",
    value: (runtime) => runtime.cost,
    detail: (runtime) => runtime.costSource,
  },
  {
    id: "duration",
    label: "Time",
    description: "App-measured wall-clock duration for the full runtime.",
    value: (runtime) => runtime.duration,
  },
  {
    id: "input-tokens",
    label: "Input tokens",
    description: "SDK/provider-reported input tokens; each provider retains its native definition.",
    value: (runtime) => usageValue(runtime, "Input"),
  },
  {
    id: "output-tokens",
    label: "Output tokens",
    description: "SDK/provider-reported output tokens; each provider retains its native definition.",
    value: (runtime) => usageValue(runtime, "Output"),
  },
  {
    id: "cached-input",
    label: "Cached input",
    description: "Provider-reported cache-read tokens; — means the endpoint did not expose this field.",
    value: (runtime) => usageValue(runtime, "Cached"),
  },
  {
    id: "native-tool-calls",
    label: "Native tool calls",
    description: "Tool calls emitted by the SDK. Counts reflect each harness's native abstraction and are not a quality score.",
    value: (runtime) => activityValue(runtime.runActivity?.tools?.nativeCalls),
    detail: (runtime) => runtime.runActivity?.tools
      ? runtime.runActivity.tools.sequence.join(" → ") || "No tool calls emitted."
      : "No tool activity was reported.",
  },
];

function scoreText(score: Runtime["evaluations"][number]) {
  if (score.score === null) return "—";
  if (score.evaluator === "deterministic") return score.score === 1 ? "1" : "0";
  return `${Math.round(score.score * 100)}%`;
}

function ResultCard({ runtime }: { runtime: Runtime }) {
  const [view, setView] = useState<"formatted" | "json">("formatted");
  const formattedTabId = `${runtime.id}-formatted-tab`;
  const formattedPanelId = `${runtime.id}-formatted-panel`;
  const jsonTabId = `${runtime.id}-json-tab`;
  const jsonPanelId = `${runtime.id}-json-panel`;

  return (
    <article className="result-card">
      <header className="section-card-header result-card-header">
        <div><strong>{runtime.sdk}</strong><span>{runtime.model}</span></div>
        <div className="result-tabs" role="tablist" aria-label={`${runtime.sdk} result view`}>
          <button aria-controls={formattedPanelId} aria-selected={view === "formatted"} id={formattedTabId} onClick={() => setView("formatted")} role="tab" type="button">Formatted</button>
          <button aria-controls={jsonPanelId} aria-selected={view === "json"} id={jsonTabId} onClick={() => setView("json")} role="tab" type="button">Raw JSON</button>
        </div>
      </header>
      {runtime.result ? view === "formatted" ? (
        <div aria-labelledby={formattedTabId} className="result-card-body" id={formattedPanelId} role="tabpanel">
          <h3>{runtime.result.title}</h3>
          <p>{runtime.result.answer}</p>
          <div className="citation-list">
            {runtime.result.citations.map((citation) => (
              <a href={citation.url} key={citation.passageId} rel="noreferrer" target="_blank">
                <strong>{citation.passageId}</strong>
                <span>{citation.label}</span>
              </a>
            ))}
          </div>
        </div>
      ) : (
        <pre aria-labelledby={jsonTabId} className="result-json" id={jsonPanelId} role="tabpanel">{JSON.stringify(runtime.result, null, 2)}</pre>
      ) : (
        <p className="card-placeholder">
          {runtime.status === "Error" ? runtime.error : "Waiting for structured output…"}
        </p>
      )}
    </article>
  );
}

export function ResultGrid({ runtimes }: { runtimes: Runtime[] }) {
  return (
    <section className="comparison-section" aria-labelledby="results-title">
      <div className="trajectory-heading">
        <h2 id="results-title">Structured results</h2>
      </div>
      <div
        className="run-grid result-grid"
        style={{ "--run-count": Math.min(runtimes.length, 4), "--tablet-run-count": Math.min(runtimes.length, 2) } as React.CSSProperties}
      >
        {runtimes.map((runtime) => <ResultCard key={runtime.id} runtime={runtime} />)}
      </div>
    </section>
  );
}

export function EvaluationGrid({ runtimes }: { runtimes: Runtime[] }) {
  return (
    <section className="comparison-section" aria-labelledby="evals-title">
      <div className="trajectory-heading">
        <h2 id="evals-title">Evals</h2>
      </div>
      <div className="eval-table-shell">
        <table
          className="eval-table"
          style={{ "--eval-runtime-count": Math.max(runtimes.length, 1) } as React.CSSProperties}
        >
          <thead>
            <tr>
              <th aria-label="Evaluation metric" className="eval-index-heading" scope="col" />
              {runtimes.map((runtime) => (
                <th key={runtime.id} scope="col">
                  <span className="eval-runtime-name">{runtime.sdk}</span>
                  <span className="eval-runtime-model">{runtime.model}</span>
                  <span className="trace-links">
                    {runtime.traceLinks.braintrust ? <a href={runtime.traceLinks.braintrust} rel="noreferrer" target="_blank">Braintrust ↗</a> : null}
                    {runtime.traceLinks.langsmith ? <a href={runtime.traceLinks.langsmith} rel="noreferrer" target="_blank">LangSmith ↗</a> : null}
                  </span>
                  {runtime.observabilityWarnings.length ? <span className="integration-warning">Trace incomplete</span> : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="eval-body">
            {evaluationRows.map((row) => {
              const metricTooltipId = `${row.id}-definition`;
              return (
                <tr className={row.evaluator === "LLM judge" ? "eval-row-judge" : "eval-row-deterministic"} key={row.id}>
                  <th aria-describedby={metricTooltipId} className="eval-metric" scope="row" tabIndex={0}>
                    <span>{row.label}</span>
                    <small>{row.evaluator}</small>
                    <span className="eval-tooltip" id={metricTooltipId} role="tooltip">{row.description}</span>
                  </th>
                  {runtimes.map((runtime) => {
                    const score = runtime.evaluations.find((candidate) => candidate.id === row.id);
                    const tooltipId = `${runtime.id}-${row.id}-tooltip`;
                    return (
                      <td
                        aria-describedby={score ? tooltipId : undefined}
                        className={score?.status === "Error" ? "eval-score eval-score-error" : "eval-score"}
                        key={runtime.id}
                        tabIndex={score ? 0 : undefined}
                      >
                        <strong>{score ? scoreText(score) : "—"}</strong>
                        {score ? <span className="eval-tooltip" id={tooltipId} role="tooltip">{conciseEvaluationRationale(score.rationale)}</span> : null}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
          <tbody className="metrics-body">
            <tr className="eval-group-row">
              <th scope="rowgroup">Run metrics</th>
              <td aria-hidden="true" colSpan={Math.max(runtimes.length, 1)} />
            </tr>
            {metricRows.map((row) => {
              const metricTooltipId = `${row.id}-definition`;
              return (
                <tr className="metric-row" key={row.id}>
                  <th aria-describedby={metricTooltipId} className="eval-metric" scope="row" tabIndex={0}>
                    <span>{row.label}</span>
                    <small>Metric</small>
                    <span className="eval-tooltip" id={metricTooltipId} role="tooltip">{row.description}</span>
                  </th>
                  {runtimes.map((runtime) => {
                    const tooltipId = `${runtime.id}-${row.id}-tooltip`;
                    return (
                      <td aria-describedby={tooltipId} className="metric-value" key={runtime.id} tabIndex={0}>
                        <strong>{row.value(runtime)}</strong>
                        <span className="eval-tooltip" id={tooltipId} role="tooltip">{row.detail?.(runtime) ?? row.description}</span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
