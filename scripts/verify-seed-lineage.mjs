import { createHash } from "node:crypto";
import { demoPassages } from "../convex/seedData.ts";

const passageIds = new Set();

for (const passage of demoPassages) {
  if (passageIds.has(passage.passageId)) {
    throw new Error(`Duplicate passage ID: ${passage.passageId}`);
  }
  passageIds.add(passage.passageId);

  const contentHash = createHash("sha256")
    .update(`${passage.contextPrefix}\n\n${passage.text}`)
    .digest("hex");

  if (contentHash !== passage.contentHash) {
    throw new Error(`Lineage hash mismatch: ${passage.passageId}`);
  }
}

console.log(`Verified ${demoPassages.length} unique passage lineage hashes.`);
