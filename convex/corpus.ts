import { internalMutation, internalQuery, query } from "./_generated/server";
import { v } from "convex/values";

const document = v.object({
  pmcid: v.string(),
  pmid: v.string(),
  doi: v.string(),
  title: v.string(),
  journal: v.string(),
  publicationDate: v.string(),
  license: v.string(),
  sourceUrl: v.string(),
});

const passage = v.object({
  passageId: v.string(),
  pmcid: v.string(),
  chunkIndex: v.number(),
  sectionPath: v.array(v.string()),
  contextPrefix: v.string(),
  text: v.string(),
  searchText: v.string(),
  contentHash: v.string(),
  tokenCount: v.number(),
  embedding: v.array(v.float64()),
  embeddingModel: v.string(),
});

export const getStatus = query({
  args: {},
  handler: async (ctx) => {
    const documents = await ctx.db.query("documents").collect();
    const passages = await ctx.db.query("passages").collect();
    return {
      documents: documents.length,
      passages: passages.length,
      embeddingModels: [...new Set(passages.map(({ embeddingModel }) => embeddingModel))],
    };
  },
});

export const getByPassageIds = query({
  args: { passageIds: v.array(v.string()) },
  handler: async (ctx, { passageIds }) => {
    const uniqueIds = [...new Set(passageIds)].slice(0, 50);
    const rows = await Promise.all(
      uniqueIds.map(async (passageId) => {
        const hit = await ctx.db
          .query("passages")
          .withIndex("by_passage_id", (q) => q.eq("passageId", passageId))
          .unique();
        if (!hit) return null;
        const source = await ctx.db
          .query("documents")
          .withIndex("by_pmcid", (q) => q.eq("pmcid", hit.pmcid))
          .unique();
        if (!source) return null;
        return {
          score: 1,
          passageId: hit.passageId,
          sectionPath: hit.sectionPath,
          contextPrefix: hit.contextPrefix,
          text: hit.text,
          contentHash: hit.contentHash,
          source: {
            pmcid: source.pmcid,
            pmid: source.pmid,
            doi: source.doi,
            title: source.title,
            publicationDate: source.publicationDate,
            license: source.license,
            url: source.sourceUrl,
          },
        };
      }),
    );
    return rows.filter((row) => row !== null);
  },
});

export const getSeedState = internalQuery({
  args: {},
  handler: async (ctx) => {
    const passages = await ctx.db.query("passages").collect();
    return passages.map(({ passageId, contentHash, embeddingModel }) => ({
      passageId,
      contentHash,
      embeddingModel,
    }));
  },
});

export const upsertDemoCorpus = internalMutation({
  args: {
    documents: v.array(document),
    passages: v.array(passage),
    searchTexts: v.array(v.object({ passageId: v.string(), searchText: v.string() })),
  },
  handler: async (ctx, args) => {
    for (const row of args.documents) {
      const existing = await ctx.db
        .query("documents")
        .withIndex("by_pmcid", (q) => q.eq("pmcid", row.pmcid))
        .unique();
      if (existing) await ctx.db.patch(existing._id, row);
      else await ctx.db.insert("documents", row);
    }

    for (const row of args.searchTexts) {
      const existing = await ctx.db
        .query("passages")
        .withIndex("by_passage_id", (q) => q.eq("passageId", row.passageId))
        .unique();
      if (existing) await ctx.db.patch(existing._id, { searchText: row.searchText });
    }

    for (const row of args.passages) {
      const existing = await ctx.db
        .query("passages")
        .withIndex("by_passage_id", (q) => q.eq("passageId", row.passageId))
        .unique();
      if (existing) await ctx.db.patch(existing._id, row);
      else await ctx.db.insert("passages", row);
    }

    const [documents, passages] = await Promise.all([
      ctx.db.query("documents").collect(),
      ctx.db.query("passages").collect(),
    ]);
    return { documents: documents.length, passages: passages.length };
  },
});

export const searchLexical = internalQuery({
  args: {
    query: v.string(),
    limit: v.number(),
  },
  handler: async (ctx, { query, limit }) => {
    const matches = await ctx.db
      .query("passages")
      .withSearchIndex("search_text", (q) => q.search("searchText", query))
      .take(limit);
    return matches.map(({ _id }) => _id);
  },
});

export const hydrateSearchResults = internalQuery({
  args: {
    matches: v.array(v.object({ id: v.id("passages"), score: v.float64() })),
  },
  handler: async (ctx, { matches }) => {
    const hydrated = await Promise.all(
      matches.map(async ({ id, score }) => {
        const hit = await ctx.db.get(id);
        if (!hit) return null;
        const source = await ctx.db
          .query("documents")
          .withIndex("by_pmcid", (q) => q.eq("pmcid", hit.pmcid))
          .unique();
        if (!source) return null;
        return {
          score,
          passageId: hit.passageId,
          sectionPath: hit.sectionPath,
          contextPrefix: hit.contextPrefix,
          text: hit.text,
          contentHash: hit.contentHash,
          source: {
            pmcid: source.pmcid,
            pmid: source.pmid,
            doi: source.doi,
            title: source.title,
            publicationDate: source.publicationDate,
            license: source.license,
            url: source.sourceUrl,
          },
        };
      }),
    );
    return hydrated.filter((row) => row !== null);
  },
});
