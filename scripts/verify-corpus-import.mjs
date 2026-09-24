#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { resolve, join } from "node:path";

const PERMISSIVE_LICENSES = new Set([
  "https://creativecommons.org/licenses/by/4.0/",
  "https://creativecommons.org/licenses/by/3.0/",
  "https://creativecommons.org/licenses/by/2.0/",
  "https://creativecommons.org/publicdomain/mark/1.0/",
]);

function directoryArg() {
  const index = process.argv.indexOf("--directory");
  if (index === -1 || !process.argv[index + 1]) {
    throw new Error("Usage: verify-corpus-import.mjs --directory <export-directory>");
  }
  return resolve(process.argv[index + 1]);
}

async function forEachJsonLine(path, callback) {
  const input = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let count = 0;
  for await (const line of input) {
    if (!line.trim()) continue;
    await callback(JSON.parse(line), count++);
  }
  return count;
}

const directory = directoryArg();
const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
const documentIds = new Set();
const selectedPmcids = [];
const documentCount = await forEachJsonLine(join(directory, "documents.jsonl"), (document) => {
  if (documentIds.has(document.pmcid)) throw new Error(`Duplicate document: ${document.pmcid}`);
  if (!PERMISSIVE_LICENSES.has(document.license)) {
    throw new Error(`Non-permissive license for ${document.pmcid}: ${document.license}`);
  }
  for (const field of ["pmcid", "pmid", "title", "sourceUrl", "primaryBucket", "retrievedAt"]) {
    if (!document[field]) throw new Error(`Missing ${field} for ${document.pmcid}.`);
  }
  if (document.corpusBatch !== manifest.corpusBatch) {
    throw new Error(`Unexpected corpus batch for ${document.pmcid}.`);
  }
  documentIds.add(document.pmcid);
  selectedPmcids.push(document.pmcid);
});
if (documentCount !== manifest.documentCount) {
  throw new Error(`Expected ${manifest.documentCount} documents; found ${documentCount}.`);
}
const selectedDigest = createHash("sha256").update(selectedPmcids.join("\n") + "\n").digest("hex");
if (selectedDigest !== manifest.selectedPmcidsSha256) throw new Error("Document selection hash mismatch.");

const passageIds = new Set();
const lineage = createHash("sha256");
const passageCount = await forEachJsonLine(join(directory, "passages.jsonl"), (passage) => {
  if (!documentIds.has(passage.pmcid)) throw new Error(`Unknown document for ${passage.passageId}.`);
  if (passageIds.has(passage.passageId)) throw new Error(`Duplicate passage: ${passage.passageId}`);
  if (passage.embeddingModel !== manifest.embeddingModel) {
    throw new Error(`Unexpected embedding model for ${passage.passageId}.`);
  }
  if (
    passage.embedding?.length !== manifest.embeddingDimensions ||
    passage.embedding.some((value) => !Number.isFinite(value))
  ) {
    throw new Error(`Invalid embedding for ${passage.passageId}.`);
  }
  const expectedHash = createHash("sha256")
    .update(`${passage.contextPrefix}\n\n${passage.text}`)
    .digest("hex");
  if (expectedHash !== passage.contentHash) throw new Error(`Lineage mismatch: ${passage.passageId}`);
  if (!passage.searchText.includes(passage.text)) throw new Error(`Incomplete search text: ${passage.passageId}`);
  if (passage.corpusBatch !== manifest.corpusBatch) {
    throw new Error(`Unexpected passage batch for ${passage.passageId}.`);
  }
  passageIds.add(passage.passageId);
  lineage.update(`${passage.passageId}:${passage.contentHash}\n`);
});
if (passageCount !== manifest.passageCount) {
  throw new Error(`Expected ${manifest.passageCount} passages; found ${passageCount}.`);
}
if (lineage.digest("hex") !== manifest.passageLineageSha256) {
  throw new Error("Passage lineage digest mismatch.");
}

console.log(
  `Verified ${documentCount} permissively licensed documents and ${passageCount} unique ` +
    `${manifest.embeddingDimensions}-dimension ${manifest.embeddingModel} passages.`,
);
