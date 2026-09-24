import "server-only";

import type { EmitRunEvent, RunComplete, RunStreamEvent } from "@/lib/run-events";

function remoteConfig() {
  const url = process.env.MODAL_CLAUDE_RUNNER_URL;
  const token = process.env.MODAL_RUNNER_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

export function hasRemoteClaudeRunner() {
  return remoteConfig() !== null;
}

export async function runRemoteClaudeAgent(
  question: string,
  model: string,
  emit: EmitRunEvent,
): Promise<RunComplete> {
  const config = remoteConfig();
  if (!config) throw new Error("Modal Claude runner is not configured.");

  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ question, model }),
    cache: "no-store",
  });

  if (!response.ok || !response.body) {
    throw new Error(`Modal Claude runner returned HTTP ${response.status}.`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let complete: RunComplete | null = null;

  const consume = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as RunStreamEvent;
    if (event.type === "complete") {
      const { type: _type, ...result } = event;
      complete = result;
      return;
    }
    if (event.type === "error") throw new Error(event.message);
    if (event.type === "trace" || event.type === "text_delta") emit(event);
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) consume(line);
    if (done) break;
  }
  consume(buffer);

  const completed = complete as RunComplete | null;
  if (!completed) throw new Error("Modal Claude runner returned no completion event.");
  emit({
    type: "trace",
    event: {
      id: "remote-structured-output",
      kind: "message",
      label: "Structured output",
      detail: "Claude Agent SDK returned schema-validated output.",
      source: "sdk",
      status: "Complete",
      payload: completed.result,
    },
  });
  return completed;
}
