#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";

function parseArgs() {
  const args = process.argv.slice(2);
  const value = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  const directory = value("--directory");
  if (!directory) {
    throw new Error(
      "Usage: verify-convex-corpus-upload.mjs --directory <path> " +
        "--expected-total-documents <n> --expected-total-passages <n>",
    );
  }
  const expectedTotalDocuments = Number(value("--expected-total-documents"));
  const expectedTotalPassages = Number(value("--expected-total-passages"));
  if (!Number.isInteger(expectedTotalDocuments) || !Number.isInteger(expectedTotalPassages)) {
    throw new Error("Expected deployment totals must be integers.");
  }
  return { directory: resolve(directory), expectedTotalDocuments, expectedTotalPassages };
}

async function forEachJsonLine(stream, callback) {
  const input = createInterface({ input: stream, crlfDelay: Infinity });
  let count = 0;
  for await (const line of input) {
    if (!line.trim()) continue;
    await callback(JSON.parse(line), count++);
  }
  return count;
}

async function localRows(path, project) {
  const rows = new Map();
  await forEachJsonLine(createReadStream(path), (row) => {
    const key = project(row);
    if (rows.has(key.id)) throw new Error(`Duplicate local identifier: ${key.id}`);
    rows.set(key.id, key);
  });
  return rows;
}

async function convexRows(table, limit, callback) {
  const child = spawn(
    "npx",
    ["convex", "data", table, "--limit", String(limit), "--format", "jsonl"],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const count = await forEachJsonLine(child.stdout, callback);
  const [code] = await new Promise((resolveExit) => child.once("close", (...args) => resolveExit(args)));
  if (code !== 0) throw new Error(`Convex data read for ${table} exited with ${code}.`);
  return count;
}

const { directory, expectedTotalDocuments, expectedTotalPassages } = parseArgs();
const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
const expectedDocuments = await localRows(join(directory, "documents.jsonl"), (row) => ({
  id: row.pmcid,
  title: row.title,
  license: row.license,
  corpusBatch: row.corpusBatch,
}));
const expectedPassages = await localRows(join(directory, "passages.source.jsonl"), (row) => ({
  id: row.passageId,
  pmcid: row.pmcid,
  contentHash: row.contentHash,
}));

const deployedDocumentIds = new Set();
let matchedDocuments = 0;
const documentCount = await convexRows("documents", expectedTotalDocuments + 100, (row) => {
  if (deployedDocumentIds.has(row.pmcid)) throw new Error(`Duplicate deployed document: ${row.pmcid}`);
  deployedDocumentIds.add(row.pmcid);
  const expected = expectedDocuments.get(row.pmcid);
  if (!expected) return;
  if (
    row.title !== expected.title ||
    row.license !== expected.license ||
    row.corpusBatch !== expected.corpusBatch
  ) {
    throw new Error(`Deployed document mismatch: ${row.pmcid}`);
  }
  expectedDocuments.delete(row.pmcid);
  matchedDocuments += 1;
});
if (documentCount !== expectedTotalDocuments) {
  throw new Error(`Expected ${expectedTotalDocuments} deployed documents; found ${documentCount}.`);
}
if (expectedDocuments.size) throw new Error(`${expectedDocuments.size} selected documents are missing.`);

const deployedPassageIds = new Set();
let matchedPassages = 0;
const passageCount = await convexRows("passages", expectedTotalPassages + 100, (row) => {
  if (deployedPassageIds.has(row.passageId)) {
    throw new Error(`Duplicate deployed passage: ${row.passageId}`);
  }
  deployedPassageIds.add(row.passageId);
  const expected = expectedPassages.get(row.passageId);
  if (!expected) return;
  if (
    row.pmcid !== expected.pmcid ||
    row.contentHash !== expected.contentHash ||
    row.corpusBatch !== manifest.corpusBatch ||
    row.embeddingModel !== manifest.embeddingModel ||
    row.embedding?.length !== manifest.embeddingDimensions ||
    row.embedding.some((value) => !Number.isFinite(value))
  ) {
    throw new Error(`Deployed passage mismatch: ${row.passageId}`);
  }
  const lineage = createHash("sha256").update(`${row.contextPrefix}\n\n${row.text}`).digest("hex");
  if (lineage !== row.contentHash) throw new Error(`Deployed lineage mismatch: ${row.passageId}`);
  expectedPassages.delete(row.passageId);
  matchedPassages += 1;
});
if (passageCount !== expectedTotalPassages) {
  throw new Error(`Expected ${expectedTotalPassages} deployed passages; found ${passageCount}.`);
}
if (expectedPassages.size) throw new Error(`${expectedPassages.size} selected passages are missing.`);

if (matchedDocuments !== manifest.documentCount || matchedPassages !== manifest.passageCount) {
  throw new Error("The uploaded batch counts do not match the manifest.");
}
console.log(
  `Verified development Convex readback: ${documentCount} total documents, ${passageCount} total ` +
    `passages; batch ${manifest.corpusBatch} contains ${matchedDocuments} documents and ` +
    `${matchedPassages} valid ${manifest.embeddingDimensions}-dimension vectors.`,
);
