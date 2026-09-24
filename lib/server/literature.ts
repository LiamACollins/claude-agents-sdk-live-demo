import "server-only";

import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import {
  RunEvidenceLedger,
  type LiteraturePassage,
  type LiteratureSearchResult,
} from "@/lib/evidence-ledger";
import type { Citation, RuntimeResult } from "@/lib/run-events";

export { RunEvidenceLedger };
export type { LiteraturePassage, LiteratureSearchResult };

function convexClient() {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is not configured.");
  return new ConvexHttpClient(url);
}

export async function searchLiterature(question: string, limit = 5) {
  return (await convexClient().action(api.search.literature, {
    question,
    limit,
  })) as LiteratureSearchResult;
}

export async function getLiteraturePassages(passageIds: string[]) {
  return (await convexClient().query(api.corpus.getByPassageIds, {
    passageIds,
  })) as LiteraturePassage[];
}

export async function searchAndRecordLiterature(
  ledger: RunEvidenceLedger,
  question: string,
  limit = 5,
) {
  const reservation = ledger.startSearch(question);
  const search = await searchLiterature(reservation.query, limit);
  ledger.completeSearch(reservation, search);
  return search;
}

export function verifyCitations(
  citations: Citation[],
  evidence: LiteraturePassage[],
) {
  const passages = new Map(evidence.map((passage) => [passage.passageId, passage]));
  const checks = citations.map((citation) => {
    const passage = passages.get(citation.passageId);
    return {
      passageId: citation.passageId,
      valid: Boolean(passage && passage.source.url === citation.url),
      sourceTitle: passage?.source.title ?? null,
    };
  });

  return {
    valid: checks.length > 0 && checks.every((check) => check.valid),
    checks,
  };
}

const jsonFence = /^```(?:json)?\s*|\s*```$/g;

export function parseRuntimeResult(text: string): RuntimeResult {
  const trimmed = text.trim().replace(jsonFence, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The model did not return JSON.");

  const value = JSON.parse(trimmed.slice(start, end + 1)) as Partial<RuntimeResult>;
  if (
    typeof value.title !== "string" ||
    typeof value.answer !== "string" ||
    !Array.isArray(value.citations)
  ) {
    throw new Error("The model result did not match the shared output contract.");
  }

  const citations = value.citations.filter(
    (citation): citation is Citation =>
      Boolean(
        citation &&
          typeof citation.passageId === "string" &&
          typeof citation.label === "string" &&
          typeof citation.url === "string",
      ),
  );

  return { title: value.title, answer: value.answer, citations };
}

export function compactEvidence(search: LiteratureSearchResult) {
  return search.results.map((passage) => ({
    passageId: passage.passageId,
    title: passage.source.title,
    publicationDate: passage.source.publicationDate,
    url: passage.source.url,
    section: passage.sectionPath.join(" > "),
    text: passage.text,
  }));
}

export function compactLedgerEvidence(ledger: RunEvidenceLedger) {
  return ledger.entries().map(({ passage, retrievals }) => ({
    passageId: passage.passageId,
    title: passage.source.title,
    publicationDate: passage.source.publicationDate,
    url: passage.source.url,
    section: passage.sectionPath.join(" > "),
    text: passage.text,
    retrievals,
  }));
}
