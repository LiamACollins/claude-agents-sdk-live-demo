"use node";

import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { EMBEDDING_MODEL, embedTexts, formatDocument } from "./embeddings";
import { demoDocuments, demoPassages } from "./seedData";

type SeedResult = {
  documents: number;
  passages: number;
  embedded: number;
  skipped: boolean;
};

const EMBEDDING_BATCH_SIZE = 24;
const MUTATION_BATCH_SIZE = 40;

function batches<T>(items: T[], size: number) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  );
}

export const demoCorpus = action({
  args: {
    secret: v.string(),
    force: v.optional(v.boolean()),
  },
  handler: async (ctx, { secret, force = false }): Promise<SeedResult> => {
    const expectedSecret = process.env.DEMO_SEED_KEY;
    if (!expectedSecret || secret !== expectedSecret) {
      throw new Error("Unauthorized seed request.");
    }

    const state: Array<{ passageId: string; contentHash: string; embeddingModel: string }> = await ctx.runQuery(
      internal.corpus.getSeedState,
      {},
    );

    const documents = new Map(demoDocuments.map((document) => [document.pmcid, document]));
    const existing = new Map(state.map((passage) => [passage.passageId, passage]));
    const searchTexts = demoPassages.map((passage) => {
      const document = documents.get(passage.pmcid);
      if (!document) throw new Error(`Missing document for ${passage.passageId}.`);
      return {
        passageId: passage.passageId,
        searchText: [
          document.title,
          document.journal,
          document.pmcid,
          document.pmid,
          document.doi,
          document.publicationDate,
          passage.contextPrefix,
          passage.text,
        ].join("\n"),
      };
    });
    const searchTextByPassage = new Map(
      searchTexts.map(({ passageId, searchText }) => [passageId, searchText]),
    );
    const pending = [];
    for (const passage of demoPassages) {
      const document = documents.get(passage.pmcid);
      if (!document) throw new Error(`Missing document for ${passage.passageId}.`);
      const current = existing.get(passage.passageId);
      const unchanged =
        current?.contentHash === passage.contentHash && current.embeddingModel === EMBEDDING_MODEL;
      if (!force && unchanged) continue;
      pending.push({ passage, document });
    }

    let result = await ctx.runMutation(internal.corpus.upsertDemoCorpus, {
      documents: demoDocuments.map((document) => ({ ...document })),
      passages: [],
      searchTexts: [],
    });
    for (const searchTextBatch of batches(searchTexts, MUTATION_BATCH_SIZE)) {
      result = await ctx.runMutation(internal.corpus.upsertDemoCorpus, {
        documents: [],
        passages: [],
        searchTexts: searchTextBatch,
      });
    }
    for (const pendingBatch of batches(pending, EMBEDDING_BATCH_SIZE)) {
      const embeddings = await embedTexts(
        pendingBatch.map(({ passage, document }) =>
          formatDocument(document.title, passage.text),
        ),
      );
      const passages = pendingBatch.map(({ passage }, index) => ({
        ...passage,
        sectionPath: [...passage.sectionPath],
        searchText: searchTextByPassage.get(passage.passageId)!,
        embedding: embeddings[index],
        embeddingModel: EMBEDDING_MODEL,
      }));
      result = await ctx.runMutation(internal.corpus.upsertDemoCorpus, {
        documents: [],
        passages,
        searchTexts: passages.map(({ passageId, searchText }) => ({ passageId, searchText })),
      });
    }
    return {
      ...result,
      embedded: pending.length,
      skipped: pending.length === 0,
    };
  },
});
