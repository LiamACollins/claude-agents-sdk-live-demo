import http from "node:http";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { z } from "zod";

const api = anyApi;
const port = Number(process.env.PORT ?? 8000);

const outputSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    answer: { type: "string" },
    citations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          passageId: { type: "string", pattern: "^PMC\\d+:[A-Z0-9]+$" },
          label: { type: "string" },
          url: {
            type: "string",
            pattern: "^https://pmc\\.ncbi\\.nlm\\.nih\\.gov/articles/PMC\\d+/$",
          },
        },
        required: ["passageId", "label", "url"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "answer", "citations"],
  additionalProperties: false,
};

const outputContract = `Return only one JSON object with this exact shape:
{"title":"short finding","answer":"grounded synthesis with limitations","citations":[{"passageId":"exact retrieved id","label":"short evidence label","url":"exact retrieved source url"}]}`;

const searchPlanningInstructions = `Before searching, decompose the experimental input into its distinct evidence needs and formulate a concise initial retrieval query that preserves biomedical entities, aliases, interventions, outcomes, and constraints.
Use each search only to resolve a material evidence gap; reformulate when needed and never repeat an equivalent query.
Choose the ideal search modes from lexical, semantic, metadata, citation-graph, and client-data search, but use only modes the available tool actually supports.
In this demo, the literature tool performs hybrid lexical BM25 plus semantic vector search over stored PMC Open Access passages; article metadata is included in the lexical index. Citation-graph and client-data search are unavailable, so never imply that either was performed.`;

const coordinatorInstructions = `You coordinate a minimal scientific literature search.
This is a read-only evidence-synthesis benchmark. Summarize retrieved publications; do not generate experimental protocols, recommend treatment, or infer beyond the evidence.
You have access to a research specialist and a citation verifier. Delegate to each specialist at least once before returning the final result. Their order and any additional delegations remain your decision, based on the evidence already gathered and unresolved evidence gaps.
Give the citation verifier the complete proposed structured answer after research. If verification identifies an issue, revise or research further and verify the changed answer again before finishing.
Finish only when the available evidence adequately addresses the experimental input, every material claim in the proposed answer has received independent citation review, and the result satisfies the output contract. When verification identifies unsupported, overstated, or incomplete claims, decide whether to revise them, delegate follow-up research, or abstain from the unsupported conclusion.
Never invent a source, URL, passage ID, result, or clinical implication.
Copy every cited passage ID and source URL verbatim from the research result, including the complete suffix after any colon. Never shorten an ID to its article-level PMC identifier.
Use only retrieved evidence. Clearly distinguish preclinical evidence from patient outcomes.
${searchPlanningInstructions}
${outputContract}`;

const researchInstructions = `You are the research specialist.
${searchPlanningInstructions}
Return concise evidence from every search with passage IDs and source URLs copied verbatim from the tool result. Preserve the complete passage-ID suffix after any colon; never shorten an ID to its article-level PMC identifier. Do not add outside knowledge.`;

const verifierInstructions = `You are the citation verification specialist.
You receive a proposed structured answer and the exact retrieved evidence passages.
Inspect every material factual claim in the title and answer. For each claim, decide whether its cited passage directly supports it and whether the wording preserves experimental scope, limitations, and preclinical-versus-clinical status.
Use only the supplied evidence. An existing passage ID or matching URL does not prove that a claim is supported.
Mark the draft invalid when any passage ID or URL is not an exact verbatim match for an item in the evidence ledger, including the complete suffix after any colon.
Return only concise JSON with this shape: {"valid":true,"issues":[{"claim":"exact or abbreviated claim","passageId":"cited passage id or empty","problem":"unsupported, overstated, or incorrectly scoped reason"}]}.
Set valid to true only when every material claim is supported. Do not rewrite the answer.`;

const verifierLedgerInstructions = `${verifierInstructions}
Before judging the draft, call read_evidence exactly once to load the server-controlled accumulated evidence ledger. Treat that tool result as the only evidence source.`;

function send(response, event) {
  response.write(`${JSON.stringify(event)}\n`);
}

function trace(response) {
  let sequence = 0;
  return (kind, label, detail, options = {}) => {
    sequence += 1;
    send(response, {
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

function blockRecord(block) {
  return block && typeof block === "object" ? block : null;
}

function toolCallDetail(block, message) {
  if (block.name === "StructuredOutput") {
    return "Claude Agent SDK schema-output handoff.";
  }
  const input = blockRecord(block.input);
  const delegatedAgent = typeof input?.subagent_type === "string" ? input.subagent_type : null;
  if (block.name === "Agent" && delegatedAgent === "researcher") {
    return "Coordinator delegated to the research agent.";
  }
  if (block.name === "Agent" && delegatedAgent === "citation-verifier") {
    return "Coordinator delegated to the citation verifier.";
  }
  if (message.parent_tool_use_id && message.subagent_type === "researcher") {
    return "Research agent tool call.";
  }
  if (message.parent_tool_use_id && message.subagent_type === "citation-verifier") {
    return "Citation verifier tool call.";
  }
  return message.parent_tool_use_id ? "Sub-agent tool call." : "Coordinator tool call.";
}

function compactEvidence(search) {
  return search.results.map((passage) => ({
    passageId: passage.passageId,
    title: passage.source.title,
    publicationDate: passage.source.publicationDate,
    url: passage.source.url,
    section: passage.sectionPath.join(" > "),
    text: passage.text,
  }));
}

function immutablePassageIdentity(passage) {
  return JSON.stringify([
    passage.passageId,
    passage.contentHash ?? null,
    passage.sectionPath,
    passage.contextPrefix,
    passage.text,
    passage.source.pmcid,
    passage.source.pmid ?? null,
    passage.source.doi ?? null,
    passage.source.title,
    passage.source.publicationDate,
    passage.source.license ?? null,
    passage.source.url,
  ]);
}

class RunEvidenceLedger {
  constructor() {
    this.searchCount = 0;
    this.pendingCalls = new Map();
    this.ledgerEntries = new Map();
  }

  startSearch(question) {
    const query = question.trim();
    if (!query) throw new Error("Evidence ledger queries cannot be empty.");
    this.searchCount += 1;
    const reservation = { callIndex: this.searchCount, query };
    this.pendingCalls.set(reservation.callIndex, query);
    return reservation;
  }

  completeSearch(reservation, search) {
    if (this.pendingCalls.get(reservation.callIndex) !== reservation.query) {
      throw new Error(`Unknown or completed literature search call ${reservation.callIndex}.`);
    }
    if (search.question.trim() !== reservation.query) {
      throw new Error("Literature search response query does not match its reservation.");
    }
    const identities = new Map(
      [...this.ledgerEntries].map(([passageId, entry]) => [
        passageId,
        immutablePassageIdentity(entry.passage),
      ]),
    );
    const responseIds = new Set();
    for (const passage of search.results) {
      if (responseIds.has(passage.passageId)) {
        throw new Error(`Duplicate passage ${passage.passageId} in one search response.`);
      }
      responseIds.add(passage.passageId);
      const identity = immutablePassageIdentity(passage);
      const knownIdentity = identities.get(passage.passageId);
      if (knownIdentity && knownIdentity !== identity) {
        throw new Error(`Conflicting immutable content for passage ${passage.passageId}.`);
      }
      if (!knownIdentity) {
        identities.set(passage.passageId, identity);
      }
    }
    search.results.forEach((passage, index) => {
      const retrieval = {
        query: reservation.query,
        callIndex: reservation.callIndex,
        rank: index + 1,
        score: passage.score,
      };
      const existing = this.ledgerEntries.get(passage.passageId);
      if (existing) existing.retrievals.push(retrieval);
      else this.ledgerEntries.set(passage.passageId, { passage, retrievals: [retrieval] });
    });
    this.pendingCalls.delete(reservation.callIndex);
  }

  passages() {
    return this.entries().map(({ passage }) => passage);
  }

  entries() {
    return [...this.ledgerEntries.values()]
      .map(({ passage, retrievals }) => ({
        passage,
        retrievals: [...retrievals].sort(
          (left, right) => left.callIndex - right.callIndex || left.rank - right.rank,
        ),
      }))
      .sort((left, right) => {
        const leftFirst = left.retrievals[0];
        const rightFirst = right.retrievals[0];
        return (
          leftFirst.callIndex - rightFirst.callIndex ||
          leftFirst.rank - rightFirst.rank ||
          left.passage.passageId.localeCompare(right.passage.passageId)
        );
      });
  }
}

function compactLedgerEvidence(ledger) {
  return ledger.entries().map(({ passage, retrievals }) => ({
    passageId: passage.passageId,
    title: passage.source.title,
    publicationDate: passage.source.publicationDate,
    url: passage.source.url,
    section: passage.sectionPath.join(" > "),
    text: passage.text,
    retrievals,
  }));
}

function verifyCitations(citations, evidence) {
  const passages = new Map(evidence.map((passage) => [passage.passageId, passage]));
  const checks = citations.map((citation) => {
    const passage = passages.get(citation.passageId);
    return {
      passageId: citation.passageId,
      valid: Boolean(passage && passage.source.url === citation.url),
      sourceTitle: passage?.source.title ?? null,
    };
  });
  return { valid: checks.length > 0 && checks.every((check) => check.valid), checks };
}

function parseResult(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The model did not return JSON.");
  const value = JSON.parse(trimmed.slice(start, end + 1));
  if (
    typeof value.title !== "string" ||
    typeof value.answer !== "string" ||
    !Array.isArray(value.citations)
  ) {
    throw new Error("The model result did not match the shared output contract.");
  }
  return value;
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function runClaudeAgent(question, model, response) {
  const startedAt = Date.now();
  const emitTrace = trace(response);
  const convexUrl = process.env.CONVEX_URL;
  if (!convexUrl) throw new Error("CONVEX_URL is not configured.");
  const convex = new ConvexHttpClient(convexUrl);
  const evidence = new RunEvidenceLedger();

  const mcpServer = createSdkMcpServer({
    name: "novamind",
    version: "1.0.0",
    tools: [
      tool(
        "search_literature",
        "Search the Convex literature corpus for exact passages.",
        { question: z.string() },
        async ({ question: toolQuestion }) => {
          const reservation = evidence.startSearch(toolQuestion);
          const search = await convex.action(api.search.literature, {
            question: reservation.query,
            limit: 5,
          });
          evidence.completeSearch(reservation, search);
          return {
            content: [{ type: "text", text: JSON.stringify(compactEvidence(search)) }],
          };
        },
      ),
      tool(
        "read_evidence",
        "Read the immutable accumulated evidence ledger for this run.",
        {},
        async () => ({
          content: [{ type: "text", text: JSON.stringify(compactLedgerEvidence(evidence)) }],
        }),
      ),
    ],
  });

  let resultMessage = null;
  let finalText = "";
  const supportsAdaptiveEffort =
    model === "claude-opus-5" || model === "claude-sonnet-5";
  const stream = query({
    prompt: `Experimental input: ${question}\n\nProduce the strongest evidence-grounded result within the available agent turns. Choose how to use the available specialists, then return the shared JSON output.`,
    options: {
      model,
      systemPrompt: coordinatorInstructions,
      agents: {
        researcher: {
          description: "Searches the literature corpus and returns exact evidence passages.",
          prompt: researchInstructions,
          model,
          tools: ["mcp__novamind__search_literature"],
          maxTurns: 7,
          omitClaudeMd: true,
        },
        "citation-verifier": {
          description: "Checks whether every material claim in a proposed answer is supported by its cited retrieved passage.",
          prompt: verifierLedgerInstructions,
          model,
          tools: ["mcp__novamind__read_evidence"],
          maxTurns: 3,
          omitClaudeMd: true,
        },
      },
      tools: ["Agent"],
      allowedTools: [
        "Agent",
        "mcp__novamind__search_literature",
        "mcp__novamind__read_evidence",
      ],
      mcpServers: { novamind: mcpServer },
      includePartialMessages: true,
      forwardSubagentText: true,
      agentProgressSummaries: true,
      outputFormat: { type: "json_schema", schema: outputSchema },
      settingSources: [],
      permissionPrompts: "none",
      persistSession: false,
      maxTurns: 8,
      maxBudgetUsd: 2,
      thinking: supportsAdaptiveEffort
        ? { type: "adaptive", display: "summarized" }
        : { type: "enabled", budgetTokens: 1_024, display: "summarized" },
      ...(supportsAdaptiveEffort ? { effort: "high" } : {}),
      env: {
        ...process.env,
        CLAUDE_AGENT_SDK_CLIENT_APP: "novamind-sdk-comparison-modal/0.1.0",
        CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: "1",
      },
    },
  });

  for await (const message of stream) {
    if (
      message.type === "system" &&
      (message.subtype === "model_refusal_fallback" ||
        message.subtype === "model_refusal_no_fallback")
    ) {
      const category = message.api_refusal_category ?? "unspecified";
      const fallback =
        message.subtype === "model_refusal_fallback"
          ? `; fallback to ${message.fallback_model} was rejected for benchmark purity`
          : "";
      throw new Error(`Claude ${message.original_model} refusal (${category})${fallback}.`);
    }
    if (message.type === "assistant") {
      for (const rawBlock of message.message.content) {
        const block = blockRecord(rawBlock);
        if (!block) continue;
        if (block.type === "tool_use") {
          emitTrace(
            "tool_call",
            String(block.name ?? "Tool call"),
            toolCallDetail(block, message),
            { payload: block.input },
          );
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          emitTrace("reasoning", "Reasoning summary", block.thinking, { source: "sdk" });
        } else if (block.type === "text" && typeof block.text === "string") {
          if (!message.parent_tool_use_id) finalText += block.text;
          emitTrace(
            "message",
            message.subagent_type ?? "Coordinator response",
            block.text.slice(0, 240),
            { payload: { parentToolUseId: message.parent_tool_use_id } },
          );
        }
      }
      continue;
    }
    if (message.type === "user") {
      const content = Array.isArray(message.message.content) ? message.message.content : [];
      for (const rawBlock of content) {
        const block = blockRecord(rawBlock);
        if (block?.type === "tool_result") {
          emitTrace("tool_result", "Tool result", "Claude Agent SDK returned a tool result.", {
            payload: block.content,
          });
        }
      }
      continue;
    }
    if (message.type === "system" && message.subtype === "task_progress" && message.summary) {
      emitTrace("reasoning", "Sub-agent progress", message.summary, { source: "sdk" });
      continue;
    }
    if (message.type === "tool_use_summary") {
      emitTrace("reasoning", "Tool-use summary", message.summary, { source: "sdk" });
      continue;
    }
    if (message.type === "stream_event" && !message.parent_tool_use_id) {
      const event = message.event;
      const delta = blockRecord(event.delta);
      if (event.type === "content_block_delta" && delta?.type === "text_delta") {
        send(response, { type: "text_delta", text: String(delta.text ?? "") });
      }
      continue;
    }
    if (message.type === "result") resultMessage = message;
  }

  if (!resultMessage) throw new Error("Claude Agent SDK returned no result message.");
  if (resultMessage.subtype !== "success") {
    throw new Error(resultMessage.errors.join(" ") || `Claude run ended: ${resultMessage.subtype}`);
  }

  const result = resultMessage.structured_output ?? parseResult(resultMessage.result || finalText);
  const verification = verifyCitations(result.citations, evidence.passages());
  if (!verification.valid) {
    throw new Error("The returned citations failed deterministic lineage checks.");
  }

  const usage = Object.values(resultMessage.modelUsage).reduce(
    (total, modelUsage) => ({
      input: total.input + modelUsage.inputTokens,
      output: total.output + modelUsage.outputTokens,
      cachedInput: total.cachedInput + modelUsage.cacheReadInputTokens,
      cacheWrite: total.cacheWrite + modelUsage.cacheCreationInputTokens,
      reasoning: total.reasoning + (modelUsage.thinkingTokens ?? 0),
      total: total.total + modelUsage.inputTokens + modelUsage.outputTokens,
    }),
    { input: 0, output: 0, cachedInput: 0, cacheWrite: 0, reasoning: 0, total: 0 },
  );

  send(response, {
    type: "complete",
    result,
    durationMs: Date.now() - startedAt,
    usage,
    costUsd: resultMessage.total_cost_usd,
    costSource: "Claude Agent SDK estimate",
    contextHandling: "SDK modelUsage includes coordinator and sub-agents",
    activity: {
      model: {
        orchestratorTurns: resultMessage.num_turns,
        completeness: "partial",
        note: "Claude Agent SDK main-loop turns; sub-agent and sidechain requests are excluded.",
      },
    },
  });
}

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"ok":true}');
    return;
  }

  const expectedToken = process.env.RUNNER_TOKEN;
  if (
    request.method !== "POST" ||
    !expectedToken ||
    request.headers.authorization !== `Bearer ${expectedToken}`
  ) {
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end('{"error":"Unauthorized"}');
    return;
  }

  response.writeHead(200, {
    "Cache-Control": "no-cache, no-transform",
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });

  try {
    const body = await readJson(request);
    if (
      typeof body.question !== "string" ||
      body.question.trim().length < 8 ||
      typeof body.model !== "string"
    ) {
      throw new Error("Invalid runner request.");
    }
    await runClaudeAgent(body.question, body.model, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Modal runner error";
    console.error("[claude-runner] request failed", { message });
    send(response, {
      type: "error",
      message,
    });
  } finally {
    response.end();
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Claude Agent SDK runner listening on ${port}`);
});
