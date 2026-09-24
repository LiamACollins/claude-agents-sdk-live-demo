import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  documents: defineTable({
    pmcid: v.string(),
    pmid: v.string(),
    doi: v.string(),
    title: v.string(),
    journal: v.string(),
    publicationDate: v.string(),
    license: v.string(),
    sourceUrl: v.string(),
    primaryBucket: v.optional(v.string()),
    matchedBuckets: v.optional(v.array(v.string())),
    retrievedAt: v.optional(v.string()),
    corpusBatch: v.optional(v.string()),
  }).index("by_pmcid", ["pmcid"]),

  passages: defineTable({
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
    corpusBatch: v.optional(v.string()),
  })
    .index("by_passage_id", ["passageId"])
    .index("by_pmcid", ["pmcid"])
    .searchIndex("search_text", {
      searchField: "searchText",
      filterFields: ["pmcid"],
    })
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 768,
      filterFields: ["pmcid"],
    }),
});
