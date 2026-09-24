#!/usr/bin/env node

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";

const MODEL = "gemini-embedding-2";
const DIMENSIONS = 768;
const BATCH_SIZE = 24;
const MAX_ATTEMPTS = 8;

function parseArgs() {
  const args = process.argv.slice(2);
  const directoryIndex = args.indexOf("--directory");
  if (directoryIndex === -1 || !args[directoryIndex + 1]) {
    throw new Error("Usage: embed-corpus-import.mjs --directory <export-directory> [--concurrency 4]");
  }
  const concurrencyIndex = args.indexOf("--concurrency");
  const concurrency = Number(concurrencyIndex === -1 ? 4 : args[concurrencyIndex + 1]);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 12) {
    throw new Error("concurrency must be an integer between 1 and 12");
  }
  return { directory: resolve(args[directoryIndex + 1]), concurrency };
}

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

async function embedBatch(apiKey, rows, attempt = 1) {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:batchEmbedContents`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        requests: rows.map(({ embeddingInput }) => ({
          model: `models/${MODEL}`,
          content: { parts: [{ text: embeddingInput }] },
          output_dimensionality: DIMENSIONS,
        })),
      }),
    },
  );
  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < MAX_ATTEMPTS) {
      const retryAfterHeader = response.headers.get("retry-after");
      const retryAfter = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1_000
        : Math.min(60_000, 750 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
      await delay(backoff);
      return embedBatch(apiKey, rows, attempt + 1);
    }
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Gemini embedding request failed (${response.status}): ${detail}`);
  }
  const body = await response.json();
  const embeddings = body.embeddings?.map(({ values }) => values);
  if (
    !embeddings ||
    embeddings.length !== rows.length ||
    embeddings.some(
      (embedding) =>
        embedding?.length !== DIMENSIONS || embedding.some((value) => !Number.isFinite(value)),
    )
  ) {
    throw new Error(`Gemini returned an invalid embedding batch of ${rows.length}.`);
  }
  return embeddings;
}

async function readRows(path) {
  const rows = [];
  const input = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of input) {
    if (line.trim()) rows.push(JSON.parse(line));
  }
  return rows;
}

async function isCompleteBatch(path, expectedCount) {
  try {
    const lines = (await readFile(path, "utf8")).trim().split("\n").filter(Boolean);
    if (lines.length !== expectedCount) return false;
    return lines.every((line) => {
      const row = JSON.parse(line);
      return row.embeddingModel === MODEL && row.embedding?.length === DIMENSIONS;
    });
  } catch {
    return false;
  }
}

async function writeBatch(path, rows, embeddings) {
  const temporary = `${path}.tmp`;
  const lines = rows.map((row, index) => {
    const { embeddingInput: _embeddingInput, ...passage } = row;
    return JSON.stringify({
      ...passage,
      embedding: embeddings[index],
      embeddingModel: MODEL,
    });
  });
  await writeFile(temporary, lines.join("\n") + "\n", "utf8");
  await rename(temporary, path);
}

async function mergeBatches(directory, batchFiles, outputPath) {
  const temporary = `${outputPath}.tmp`;
  const output = createWriteStream(temporary, { encoding: "utf8" });
  for (const file of batchFiles) {
    const input = createReadStream(join(directory, file));
    for await (const chunk of input) {
      if (!output.write(chunk)) await once(output, "drain");
    }
  }
  output.end();
  await once(output, "finish");
  await rename(temporary, outputPath);
}

async function main() {
  const { directory, concurrency } = parseArgs();
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is required.");
  const manifestPath = join(directory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const rows = await readRows(join(directory, "passages.source.jsonl"));
  if (rows.length !== manifest.passageCount) {
    throw new Error(`Manifest expects ${manifest.passageCount} passages; found ${rows.length}.`);
  }
  const batchDirectory = join(directory, "embedding-batches");
  await mkdir(batchDirectory, { recursive: true });
  const batches = Array.from({ length: Math.ceil(rows.length / BATCH_SIZE) }, (_, index) => ({
    index,
    rows: rows.slice(index * BATCH_SIZE, (index + 1) * BATCH_SIZE),
    file: `${String(index).padStart(5, "0")}.jsonl`,
  }));
  let cursor = 0;
  let completed = 0;
  async function worker() {
    while (cursor < batches.length) {
      const batch = batches[cursor++];
      const path = join(batchDirectory, batch.file);
      if (!(await isCompleteBatch(path, batch.rows.length))) {
        const embeddings = await embedBatch(apiKey, batch.rows);
        await writeBatch(path, batch.rows, embeddings);
      }
      completed += 1;
      if (completed % 25 === 0 || completed === batches.length) {
        console.log(`Embedded ${Math.min(completed * BATCH_SIZE, rows.length)}/${rows.length} passages.`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const batchFiles = (await readdir(batchDirectory)).filter((file) => file.endsWith(".jsonl")).sort();
  if (batchFiles.length !== batches.length) {
    throw new Error(`Expected ${batches.length} batch files; found ${batchFiles.length}.`);
  }
  const outputPath = join(directory, "passages.jsonl");
  await mergeBatches(batchDirectory, batchFiles, outputPath);
  const outputBytes = (await stat(outputPath)).size;
  await writeFile(
    manifestPath,
    JSON.stringify({ ...manifest, embeddedAt: new Date().toISOString(), outputBytes }, null, 2) + "\n",
  );
  console.log(`Wrote ${rows.length} embedded passages to ${outputPath} (${outputBytes} bytes).`);
}

await main();
