import assert from "node:assert/strict";
import { RunEvidenceLedger } from "../lib/evidence-ledger.ts";

function passage(passageId, text = `Evidence for ${passageId}`) {
  return {
    score: 1,
    passageId,
    sectionPath: ["Results"],
    contextPrefix: `Title: ${passageId}`,
    text,
    contentHash: `hash-${text}`,
    source: {
      pmcid: passageId.split(":")[0],
      title: `Paper ${passageId}`,
      publicationDate: "2026-01-01",
      url: `https://pmc.ncbi.nlm.nih.gov/articles/${passageId.split(":")[0]}/`,
    },
  };
}

function complete(ledger, question, results) {
  const reservation = ledger.startSearch(question);
  ledger.completeSearch(reservation, { question: reservation.query, results });
}

const ledger = new RunEvidenceLedger();
complete(ledger, "first distinct evidence query", [passage("PMC1:0001"), passage("PMC2:0001")]);
complete(ledger, "second distinct evidence query", [
  { ...passage("PMC2:0001"), score: 0.5 },
  passage("PMC3:0001"),
]);

assert.deepEqual(
  ledger.passages().map(({ passageId }) => passageId),
  ["PMC1:0001", "PMC2:0001", "PMC3:0001"],
  "later searches must accumulate rather than replace evidence",
);
assert.deepEqual(
  ledger.entries()[1].retrievals.map(({ query, callIndex, rank, score }) => ({
    query,
    callIndex,
    rank,
    score,
  })),
  [
    { query: "first distinct evidence query", callIndex: 1, rank: 2, score: 1 },
    { query: "second distinct evidence query", callIndex: 2, rank: 1, score: 0.5 },
  ],
  "duplicate passages must retain per-query rank and score provenance",
);

const conflictLedger = new RunEvidenceLedger();
complete(conflictLedger, "initial query", [passage("PMC1:0001")]);
assert.throws(
  () => complete(conflictLedger, "conflicting query", [passage("PMC1:0001", "changed")]),
  /Conflicting immutable content/,
  "a passage ID must never resolve to different immutable content within a run",
);
assert.equal(conflictLedger.passages()[0].text, "Evidence for PMC1:0001");

const duplicateLedger = new RunEvidenceLedger();
assert.throws(
  () => complete(duplicateLedger, "duplicate result query", [
    passage("PMC1:0001"),
    passage("PMC1:0001"),
  ]),
  /Duplicate passage/,
  "a malformed search response must not create duplicate provenance",
);
assert.equal(duplicateLedger.passages().length, 0);

const concurrentLedger = new RunEvidenceLedger();
const firstReservation = concurrentLedger.startSearch("slower first query");
const secondReservation = concurrentLedger.startSearch("faster second query");
concurrentLedger.completeSearch(secondReservation, {
  question: secondReservation.query,
  results: [passage("PMC2:0001")],
});
concurrentLedger.completeSearch(firstReservation, {
  question: firstReservation.query,
  results: [passage("PMC1:0001")],
});
assert.deepEqual(
  concurrentLedger.passages().map(({ passageId }) => passageId),
  ["PMC1:0001", "PMC2:0001"],
  "parallel search completion order must not change ledger order",
);

const repeatedSearchLedger = new RunEvidenceLedger();
for (let index = 1; index <= 6; index += 1) {
  complete(repeatedSearchLedger, `query ${index}`, [passage("PMC1:0001")]);
}
assert.equal(repeatedSearchLedger.searchCount, 6, "the ledger must not cap valid searches");
assert.equal(
  repeatedSearchLedger.entries()[0].retrievals.length,
  6,
  "every search must retain provenance after the old three-search ceiling",
);

const expandedEvidenceLedger = new RunEvidenceLedger();
for (let index = 1; index <= 20; index += 1) {
  complete(expandedEvidenceLedger, `evidence query ${index}`, [passage(`PMC${index}:0001`)]);
}
assert.equal(
  expandedEvidenceLedger.passages().length,
  20,
  "the ledger must retain evidence beyond the old 15-passage ceiling",
);
console.log("Evidence ledger verification passed.");
