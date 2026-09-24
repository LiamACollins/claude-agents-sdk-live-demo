import "server-only";

import { createAnthropic } from "@ai-sdk/anthropic";
import {
  generateText,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  type LanguageModelUsage,
} from "ai";
import { z } from "zod";
import { conciseEvaluationRationale } from "@/lib/evaluation-format";
import { runtimeResultSchema } from "@/lib/result-contract";
import {
  evaluateRequiredToolStages,
  evaluateToolExecution,
} from "@/lib/trace-presentation";
import type {
  EvaluationScore,
  RuntimeResult,
  TraceEvent,
} from "@/lib/run-events";
import { getLiteraturePassages, verifyCitations } from "@/lib/server/literature";
import { anthropicApiKey } from "@/lib/server/models";

const judgeSchema = z
  .object({
    groundedness: z
      .object({ score: z.number().min(0).max(1), rationale: z.string().describe("One sentence of no more than 18 words.") })
      .strict(),
    relevance: z
      .object({ score: z.number().min(0).max(1), rationale: z.string().describe("One sentence of no more than 18 words.") })
      .strict(),
  })
  .strict();

export type EvaluationRun = {
  scores: EvaluationScore[];
  judgeUsage?: LanguageModelUsage;
  judgeModel?: string;
};

function record(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function refusalFromProviderMetadata(metadata: unknown) {
  const provider = record(metadata);
  const anthropic = record(provider?.anthropic);
  const stopDetails = record(anthropic?.stopDetails);
  if (stopDetails?.type !== "refusal") return null;
  return typeof stopDetails.category === "string" ? stopDetails.category : "unspecified";
}

async function deterministicScores(result: RuntimeResult, trace: TraceEvent[]) {
  const evidence = await getLiteraturePassages(
    result.citations.map(({ passageId }) => passageId),
  );
  const structureValid = runtimeResultSchema.safeParse(result).success;
  const lineage = verifyCitations(result.citations, evidence);
  const tools = evaluateToolExecution(trace);
  const workflow = evaluateRequiredToolStages(trace);

  const scores: EvaluationScore[] = [
    {
      id: "structural_output_valid",
      label: "Structured output",
      score: structureValid ? 1 : 0,
      status: "Complete",
      evaluator: "deterministic",
      source: "Zod output contract",
      rationale: structureValid
        ? "The final object matches the shared JSON contract."
        : "The final object does not match the shared JSON contract.",
    },
    {
      id: "citation_lineage_valid",
      label: "Citation lineage",
      score: lineage.valid ? 1 : 0,
      status: "Complete",
      evaluator: "deterministic",
      source: "Stored Convex corpus IDs and URLs",
      rationale: lineage.valid
        ? "Every citation resolves to the stored passage ID and source URL."
        : "At least one citation does not resolve to the stored passage ID and source URL.",
    },
    {
      id: "tools_succeeded",
      label: "Tools succeeded",
      score: tools.succeeded ? 1 : 0,
      status: "Complete",
      evaluator: "deterministic",
      source: "Native tool call and result events",
      rationale: tools.rationale,
    },
    {
      id: "required_workflow_completed",
      label: "Required workflow",
      score: workflow.succeeded ? 1 : 0,
      status: "Complete",
      evaluator: "deterministic",
      source: "Required research and citation stages",
      rationale: workflow.rationale,
    },
  ];

  return { evidence, scores };
}

export async function evaluateRun(
  question: string,
  result: RuntimeResult,
  trace: TraceEvent[],
): Promise<EvaluationRun> {
  const deterministic = await deterministicScores(result, trace);
  const judgeModel = process.env.NOVAMIND_EVAL_JUDGE_MODEL ?? "claude-opus-5";
  const judgeLabel = process.env.NOVAMIND_EVAL_JUDGE_LABEL ?? "Claude Opus 5";
  let judgeFinishReason: string | undefined;
  let judgeProviderMetadata: unknown;

  try {
    const judge = await generateText({
      model: createAnthropic({ apiKey: anthropicApiKey() })(judgeModel),
      maxOutputTokens: 4_096,
      providerOptions: {
        anthropic: {
          effort: "high",
          thinking: { type: "adaptive", display: "omitted" },
        },
      },
      output: Output.object({ schema: judgeSchema }),
      system: `You are a strict scientific-answer evaluator. Grade only the final structured answer, never the execution trace. Use only the supplied evidence passages. Do not reward outside knowledge.

Groundedness measures whether every material factual claim is directly supported by one of the answer's cited passages and whether preclinical evidence is represented as preclinical. Use these anchors: 1.00 = every material claim is directly supported and correctly scoped; 0.95 = only a trivial wording issue; 0.85 = one meaningful unsupported or overstated claim; 0.70 = multiple meaningful gaps; 0.50 or below = central claims are unsupported or misrepresented.

Relevance measures whether the answer directly and concisely addresses the experimental input. Use these anchors: 1.00 = complete, direct, and free of irrelevant detail; 0.95 = complete with only a trivial focus issue; 0.85 = one requested aspect is missing or meaningful extraneous detail dilutes the answer; 0.70 = partially addresses the input; 0.50 or below = mostly off-target.

Choose the score from the anchors based on the most serious observed issue. Scores may match across answers when they truly merit the same band, but do not default to 0.95. A rationale that identifies a meaningful factual or relevance issue cannot receive 0.95 or 1.00. Each rationale must be exactly one sentence of no more than 18 words; state only the decisive weakness or strongest support.`,
      prompt: JSON.stringify({
        experimentalInput: question,
        finalAnswer: result,
        citedEvidence: deterministic.evidence.map((passage) => ({
          passageId: passage.passageId,
          title: passage.source.title,
          section: passage.sectionPath.join(" > "),
          text: passage.text,
        })),
      }),
      onStepFinish: ({ finishReason, providerMetadata }) => {
        judgeFinishReason = finishReason;
        judgeProviderMetadata = providerMetadata;
      },
    });

    return {
      judgeModel,
      judgeUsage: judge.usage,
      scores: [
        ...deterministic.scores,
        {
          id: "claim_groundedness",
          label: "Claim groundedness",
          score: judge.output.groundedness.score,
          status: "Complete",
          evaluator: "llm",
          source: `${judgeLabel} judge`,
          rationale: conciseEvaluationRationale(judge.output.groundedness.rationale),
        },
        {
          id: "answer_relevance",
          label: "Answer relevance",
          score: judge.output.relevance.score,
          status: "Complete",
          evaluator: "llm",
          source: `${judgeLabel} judge`,
          rationale: conciseEvaluationRationale(judge.output.relevance.rationale),
        },
      ],
    };
  } catch (error) {
    const refusalCategory = refusalFromProviderMetadata(judgeProviderMetadata);
    const rationale = refusalCategory
      ? `${judgeLabel} declined this biomedical evaluation (${refusalCategory}).`
      : NoObjectGeneratedError.isInstance(error)
        ? `${judgeLabel} produced no valid score (${error.finishReason ?? "unknown finish"}).`
        : NoOutputGeneratedError.isInstance(error)
          ? `${judgeLabel} produced no output (${judgeFinishReason ?? "unknown finish"}).`
          : error instanceof Error
            ? error.message
            : "Judge call failed.";
    const failedJudgeScores: EvaluationScore[] = [
      {
        id: "claim_groundedness",
        label: "Claim groundedness",
        score: null,
        status: "Error",
        evaluator: "llm",
        source: `${judgeLabel} judge`,
        rationale,
      },
      {
        id: "answer_relevance",
        label: "Answer relevance",
        score: null,
        status: "Error",
        evaluator: "llm",
        source: `${judgeLabel} judge`,
        rationale,
      },
    ];
    return { judgeModel, scores: [...deterministic.scores, ...failedJudgeScores] };
  }
}
