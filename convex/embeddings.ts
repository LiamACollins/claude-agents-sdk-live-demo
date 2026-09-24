"use node";

export const EMBEDDING_DIMENSIONS = 768;
export const EMBEDDING_MODEL = "gemini-embedding-2";

type EmbedResponse = {
  embedding?: {
    values?: number[];
  };
};

type BatchEmbedResponse = {
  embeddings?: Array<{ values?: number[] }>;
};

export function formatDocument(title: string, text: string) {
  return `title: ${title} | text: ${text}`;
}

export function formatQuestion(question: string) {
  return `task: question answering | query: ${question}`;
}

export async function embedText(text: string) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured in Convex.");

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        content: { parts: [{ text }] },
        output_dimensionality: EMBEDDING_DIMENSIONS,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Gemini embedding request failed with HTTP ${response.status}.`);
  }

  const body = (await response.json()) as EmbedResponse;
  const embedding = body.embedding?.values;
  if (!embedding || embedding.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`Expected a ${EMBEDDING_DIMENSIONS}-dimension embedding.`);
  }
  return embedding;
}

export async function embedTexts(texts: string[]) {
  if (texts.length === 0) return [];
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured in Convex.");

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        requests: texts.map((text) => ({
          model: `models/${EMBEDDING_MODEL}`,
          content: { parts: [{ text }] },
          output_dimensionality: EMBEDDING_DIMENSIONS,
        })),
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Gemini batch embedding request failed with HTTP ${response.status}.`);
  }
  const body = (await response.json()) as BatchEmbedResponse;
  const embeddings = body.embeddings?.map(({ values }) => values);
  if (
    !embeddings ||
    embeddings.length !== texts.length ||
    embeddings.some((embedding) => embedding?.length !== EMBEDDING_DIMENSIONS)
  ) {
    throw new Error(`Expected ${texts.length} ${EMBEDDING_DIMENSIONS}-dimension embeddings.`);
  }
  return embeddings as number[][];
}
