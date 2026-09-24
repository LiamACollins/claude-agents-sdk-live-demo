import { z } from "zod";

export const PMC_ARTICLE_URL_SOURCE =
  "^https://pmc\\.ncbi\\.nlm\\.nih\\.gov/articles/PMC\\d+/$";
export const PASSAGE_ID_SOURCE = "^PMC\\d+:[A-Z0-9]+$";

export const runtimeResultSchema = z
  .object({
    title: z.string(),
    answer: z.string(),
    citations: z.array(
      z
        .object({
          passageId: z.string().regex(new RegExp(PASSAGE_ID_SOURCE)),
          label: z.string(),
          url: z.string().regex(new RegExp(PMC_ARTICLE_URL_SOURCE)),
        })
        .strict(),
    ),
  })
  .strict();

export const runtimeResultJsonSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    answer: { type: "string" },
    citations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          passageId: { type: "string", pattern: PASSAGE_ID_SOURCE },
          label: { type: "string" },
          url: { type: "string", pattern: PMC_ARTICLE_URL_SOURCE },
        },
        required: ["passageId", "label", "url"],
        additionalProperties: false,
      },
    },
  },
  required: ["title", "answer", "citations"],
  additionalProperties: false,
} as const;
