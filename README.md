# NovaMind SDK comparison

A minimal, hosted comparison of the same agentic literature-search workflow across:

- Claude Agent SDK
- OpenAI Agents SDK
- OpenAI Agents SDK with Gemini through Google's OpenAI-compatible endpoint
- Vercel AI SDK `ToolLoopAgent`

Each run publishes native SDK lifecycle events into a normalized, clickable trajectory. The comparison view standardizes only the semantic label and color; the inspect view preserves each SDK's native event label, type, source, and payload. Encrypted or hidden chain-of-thought is never requested or displayed.

## Harness parity

Every runtime uses the same three roles, prompts, model-per-runtime, tool permissions, and loop ceilings. An eight-turn coordinator autonomously decides when and how often to delegate to a seven-turn research specialist with `search_literature` and a three-turn citation verifier with `read_evidence`; no fixed call order is prescribed. Independent citation review remains a completion criterion. The output contract and deterministic citation-lineage gate are shared.

Reasoning is compared at the provider-native `high` tier, not as an equal token budget. GPT models receive `reasoning.effort: "high"`; Gemini receives the equivalent `reasoning_effort: "high"` through Google's OpenAI-compatible endpoint; Claude Opus 5 and Sonnet 5 receive adaptive thinking with `effort: "high"`. Claude Haiku 4.5 has no effort control, so both Claude harnesses instead use its minimum supported manual thinking budget of 1,024 tokens. The fixed evaluator uses Claude Opus 5 with adaptive thinking at high effort for every run.

- Claude uses Claude Agent SDK `agents` and the native `Agent` delegation tool.
- GPT and Gemini both use the official OpenAI Agents SDK `Runner` and `Agent.asTool()`. GPT uses the Responses API transport; Gemini uses the same runner through Google's OpenAI-compatible Chat Completions endpoint. Both use non-streaming model transport and the SDK's live agent/tool lifecycle hooks. This keeps their runner topology identical while preserving Gemini 3 thought signatures across tool turns; the SDK's streaming Chat Completions converter currently drops that provider extension.
- Vercel uses three native `ToolLoopAgent` instances. The coordinator invokes the research and verifier agents through tools, following Vercel's documented subagent-as-tool pattern.

This app does not use OpenAI's hosted Agents API. The [Agents SDK](https://developers.openai.com/api/docs/guides/agents/sdk) is a code-first runner executed by this application; the [Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview) is a managed Codex harness with OpenAI-hosted sessions, sandboxing, compaction, and orchestration. Using the SDK keeps the GPT and Gemini topology identical; the hosted Agents API would be a different, OpenAI-only system boundary.

The development corpus contains 21,739 passages from 511 PMC Open Access articles. Convex supplies native BM25 full-text ranking and vector similarity; a small reciprocal-rank-fusion step combines both result lists. The agents decompose each experimental input and autonomously issue distinct reformulations when material evidence gaps remain. Unavailable citation-graph and client-data search modes remain explicit rather than simulated.

Each run maintains a private evidence ledger without artificial search-count or passage-count ceilings; the native agent turn limits still bound execution. Repeated passages are deduplicated by passage ID while retaining every query, rank, and score; conflicting content for an existing ID fails closed. Before returning the final answer, a citation-verifier agent receives the complete proposed answer and reads the exact accumulated passage text from that ledger, then checks whether every material claim is supported and correctly scoped. A separate deterministic post-run gate still rejects citation IDs or URLs that do not resolve to the accumulated evidence; that lineage check is not exposed as a model-callable tool.

The final structured outputs appear beneath the trajectories. Five evals follow: structured-output validity, citation-lineage validity, tool success, claim groundedness, and answer relevance. The first three are deterministic. The last two use one fixed Claude judge and grade the final answer against cited passages only.

The hosted Claude Agent SDK runtime executes in Modal because its native Claude Code executable exceeds Vercel's serverless function bundle limit. Vercel proxies the same NDJSON trace contract; the other runtimes execute directly in the Next.js route. Completed runs are logged to Braintrust for score comparison and LangSmith for nested trace inspection, with direct links in each eval card.

## Hosted app

https://novamind-sdk-comparison.vercel.app

## Local development

```bash
pnpm install
pnpm dev
```

Required server environment variables:

- `ANTHROPIC_API_KEY` or `ANTHROPIC_API_KEY_FOR_AGENTS`
- `OPENAI_API_KEY`
- `GEMINI_API_KEY`
- `NEXT_PUBLIC_CONVEX_URL`
- `BRAINTRUST_API_KEY` or `BRAINTRUST_API_KEY_FOR_AGENTS`
- `LANGSMITH_API_KEY` or `LANGSMITH_API_KEY_FOR_AGENTS`

Optional configuration:

- `BRAINTRUST_PROJECT` (default: `NovaMind SDK Comparison`)
- `LANGSMITH_PROJECT` (default: `novamind-sdk-comparison`)
- `NOVAMIND_EVAL_JUDGE_MODEL` (default: `claude-opus-5`)
- `NOVAMIND_EVAL_JUDGE_LABEL` (default: `Claude Opus 5`)

Hosted Claude execution also requires `MODAL_CLAUDE_RUNNER_URL` and `MODAL_RUNNER_TOKEN` on Vercel. The matching Modal secret contains `ANTHROPIC_API_KEY`, `CONVEX_URL`, and `RUNNER_TOKEN`.

## Verification

```bash
pnpm typecheck
pnpm verify:cost
pnpm verify:evidence
pnpm verify:retrieval
pnpm verify:lineage
pnpm verify:trace
pnpm verify:eval
pnpm verify:tools
pnpm verify:harness
pnpm build
```

`verify:cost` checks native-cost precedence, cache accounting, reasoning-token handling, request-level long-context tiers, effective-dated prices, and fail-closed behavior for unknown models. `verify:evidence` checks multi-search accumulation, deduplication, provenance, bounds, and immutable-content conflicts. `verify:retrieval` validates the lexical/semantic rank fusion. `verify:lineage` validates immutable hashes for the 692 committed seed passages; the expanded corpus has separate source, vector, and deployed-readback verification. Every runtime also fails closed when returned passage IDs and source URLs do not match retrieved evidence.

`verify:trace` validates the cross-SDK display taxonomy and confirms that the original SDK event remains attached to every normalized event. `verify:tools` checks native-call classification and the canonical retrieval and verification operation counts.

`verify:harness` prevents the bespoke Gemini loop from returning, verifies that GPT and Gemini share one Agents SDK runner and transport mode, and checks that both OpenAI and Vercel retain coordinator, research, and verifier agent roles.

## Corpus and offline suite

`pnpm corpus:build` fetches the 11 configured seed articles from the official NCBI PMC EFetch XML API, retains source and license metadata, and rebuilds deterministic full-text chunks. The seed corpus is committed so a deployment does not depend on NCBI availability. `seed:demoCorpus` embeds only new or changed seed chunks in Convex.

The development deployment also contains a fixed-seed random sample of 500 additional, permissively licensed articles exported from the local PMC Postgres corpus. Source text, derived chunks, embeddings, and import artifacts remain under ignored `tmp/`; they are never committed. The resumable workflow is:

```bash
pnpm corpus:export-local -- --output tmp/pmc-random-500-v1 --count 500 \
  --exclude-pmcids tmp/pmc-random-500-v1/existing-pmcids.txt
pnpm corpus:embed -- --directory tmp/pmc-random-500-v1
pnpm corpus:verify-import -- --directory tmp/pmc-random-500-v1
npx convex import --append --table documents --format jsonLines \
  tmp/pmc-random-500-v1/documents.jsonl
npx convex import --append --table passages --format jsonLines \
  tmp/pmc-random-500-v1/passages.jsonl
pnpm corpus:verify-upload -- --directory tmp/pmc-random-500-v1 \
  --expected-total-documents 511 --expected-total-passages 21739
```

The offline suite defaults to the inexpensive interactive models. Review that plan without spending credits:

```bash
pnpm eval:offline -- --dry-run
```

Run it against the hosted app only when ready to spend model and judge credits:

```bash
pnpm eval:offline -- --base-url https://novamind-sdk-comparison.vercel.app
```

Use the explicit `top` profile for Claude Opus 5, GPT-5.1, Gemini 3.1 Pro, and Claude Opus 5 on Vercel. The runner rejects any completion not judged by the fixed Claude Opus 5 judge:

```bash
pnpm eval:offline -- --profile top --limit 3 --base-url https://novamind-sdk-comparison.vercel.app
```

Results are written to `tmp/eval-suite/<suite-id>/` as JSONL, JSON, and Markdown. One full pass is 40 runtime runs plus 40 judge calls.

## Measurement boundaries

- Claude Agent SDK supplies its own aggregate cost estimate and cumulative `modelUsage`, including coordinator, sub-agent, sidechain, and internal SDK calls.
- Other paths estimate runtime model-token cost from provider/SDK usage and an exact-model price catalog audited against provider list prices on 2026-09-23. Unknown models and inconsistent token buckets display `—`; they are never assigned a guessed price.
- Input, output, and cached-input tokens remain distinct. Their exact inclusion rules stay provider-native, so they are operational telemetry rather than a normalized billing ledger.
- Cached tokens replace the corresponding uncached-input charge. Reasoning/thinking tokens are not added again because providers include them in output tokens. Gemini long-context tiers are calculated per request, and Gemini 3.8 Flash's dated introductory rate changes automatically on 2027-01-01.
- The displayed estimate covers model tokens in the runtime only. It excludes evaluation calls, infrastructure, taxes, discounts, batch/flex tiers, data-residency uplifts, and context-cache storage charges.
- Price sources: [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing), [OpenAI GPT-5.4 nano](https://developers.openai.com/api/docs/models/gpt-5.4-nano), [OpenAI GPT-5.4 mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini), [OpenAI GPT-5.1](https://developers.openai.com/api/docs/models/gpt-5.1), and [Google Gemini](https://ai.google.dev/gemini-api/docs/pricing).
- Gemini runs through the OpenAI Agents SDK's Chat Completions adapter. When Google emits no readable thought summary, the app does not synthesize one.
- The Vercel ToolLoopAgent uses AI SDK `Output.object()` with the shared Zod contract. Its final `stream.output` is schema-validated before the deterministic citation-lineage check runs.
- The LLM judge receives only the experimental input, final structured answer, and cited passages. It never receives the execution trajectory.
- Tool activity is reported at two levels: unmodified SDK-native call count and canonical retrieval/verification operations. Model-loop turns are separate because SDKs disagree on whether nested sub-agent model requests belong to the parent turn count.
- Braintrust stores comparable scores and usage. LangSmith stores the nested run, phase, and native-event trace. Both integrations fail open so an observability outage does not discard a completed model result.
- No time-to-first-token instrumentation.
