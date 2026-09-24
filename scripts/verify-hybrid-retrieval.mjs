import assert from "node:assert/strict";
import { reciprocalRankFuse } from "../convex/retrieval.ts";

const results = reciprocalRankFuse(
  [
    ["shared", "semantic-only"],
    ["shared", "lexical-only"],
  ],
  3,
);

assert.equal(results[0]?.id, "shared");
assert.deepEqual(
  new Set(results.map(({ id }) => id)),
  new Set(["shared", "semantic-only", "lexical-only"]),
);
assert.ok(results[0].score > results[1].score);

console.log("Verified reciprocal-rank fusion for lexical and semantic results.");
