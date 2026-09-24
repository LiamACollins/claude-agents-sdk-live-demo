"use node";

import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { embedText, formatQuestion } from "./embeddings";
import { reciprocalRankFuse } from "./retrieval";

type LiteratureResult = {
  score: number;
  passageId: string;
  sectionPath: string[];
  contextPrefix: string;
  text: string;
  contentHash: string;
  source: {
    pmcid: string;
    pmid: string;
    doi: string;
    title: string;
    publicationDate: string;
    license: string;
    url: string;
  };
};

type LiteratureResponse = {
  question: string;
  results: LiteratureResult[];
};

export const literature = action({
  args: {
    question: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { question, limit }): Promise<LiteratureResponse> => {
    const normalizedQuestion = question.trim();
    if (normalizedQuestion.length < 8 || normalizedQuestion.length > 2_000) {
      throw new Error("Question must contain between 8 and 2,000 characters.");
    }

    const resultLimit = Math.max(1, Math.min(12, Math.floor(limit ?? 8)));
    const candidateLimit = Math.min(32, resultLimit * 3);
    const [embedding, lexicalIds] = await Promise.all([
      embedText(formatQuestion(normalizedQuestion)),
      ctx.runQuery(internal.corpus.searchLexical, {
        query: normalizedQuestion,
        limit: candidateLimit,
      }),
    ]);
    const matches = await ctx.vectorSearch("passages", "by_embedding", {
      vector: embedding,
      limit: candidateLimit,
    });

    const ids = new Map(
      [...lexicalIds, ...matches.map(({ _id }) => _id)].map((id) => [String(id), id]),
    );
    const fused = reciprocalRankFuse(
      [lexicalIds.map(String), matches.map(({ _id }) => String(_id))],
      resultLimit,
    );

    const results: LiteratureResult[] = await ctx.runQuery(internal.corpus.hydrateSearchResults, {
      matches: fused.map(({ id, score }) => ({ id: ids.get(id)!, score })),
    });

    return {
      question: normalizedQuestion,
      results,
    };
  },
});
