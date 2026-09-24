export type LiteraturePassage = {
  score: number;
  passageId: string;
  sectionPath: string[];
  contextPrefix: string;
  text: string;
  contentHash?: string;
  source: {
    title: string;
    publicationDate: string;
    url: string;
    pmcid: string;
    pmid?: string;
    doi?: string;
    license?: string;
  };
};

export type LiteratureSearchResult = {
  question: string;
  results: LiteraturePassage[];
};

export type EvidenceRetrieval = {
  query: string;
  callIndex: number;
  rank: number;
  score: number;
};

export type EvidenceLedgerEntry = {
  passage: LiteraturePassage;
  retrievals: EvidenceRetrieval[];
};

export type EvidenceSearchReservation = {
  callIndex: number;
  query: string;
};

function immutablePassageIdentity(passage: LiteraturePassage) {
  return JSON.stringify([
    passage.passageId,
    passage.contentHash ?? null,
    passage.sectionPath,
    passage.contextPrefix,
    passage.text,
    passage.source.pmcid,
    passage.source.pmid ?? null,
    passage.source.doi ?? null,
    passage.source.title,
    passage.source.publicationDate,
    passage.source.license ?? null,
    passage.source.url,
  ]);
}

export class RunEvidenceLedger {
  readonly #entries = new Map<string, EvidenceLedgerEntry>();
  readonly #pendingCalls = new Map<number, string>();
  #searchCount = 0;

  startSearch(question: string): EvidenceSearchReservation {
    const query = question.trim();
    if (!query) throw new Error("Evidence ledger queries cannot be empty.");

    this.#searchCount += 1;
    const reservation = { callIndex: this.#searchCount, query };
    this.#pendingCalls.set(reservation.callIndex, query);
    return reservation;
  }

  completeSearch(
    reservation: EvidenceSearchReservation,
    search: LiteratureSearchResult,
  ): void {
    const pendingQuery = this.#pendingCalls.get(reservation.callIndex);
    if (pendingQuery !== reservation.query) {
      throw new Error(`Unknown or completed literature search call ${reservation.callIndex}.`);
    }
    if (search.question.trim() !== reservation.query) {
      throw new Error("Literature search response query does not match its reservation.");
    }

    const identities = new Map(
      [...this.#entries].map(([passageId, entry]) => [
        passageId,
        immutablePassageIdentity(entry.passage),
      ]),
    );
    const responseIds = new Set<string>();

    for (const passage of search.results) {
      if (responseIds.has(passage.passageId)) {
        throw new Error(`Duplicate passage ${passage.passageId} in one search response.`);
      }
      responseIds.add(passage.passageId);
      const identity = immutablePassageIdentity(passage);
      const knownIdentity = identities.get(passage.passageId);
      if (knownIdentity && knownIdentity !== identity) {
        throw new Error(`Conflicting immutable content for passage ${passage.passageId}.`);
      }
      if (!knownIdentity) {
        identities.set(passage.passageId, identity);
      }
    }

    search.results.forEach((passage, index) => {
      const retrieval = {
        query: reservation.query,
        callIndex: reservation.callIndex,
        rank: index + 1,
        score: passage.score,
      };
      const existing = this.#entries.get(passage.passageId);
      if (existing) existing.retrievals.push(retrieval);
      else this.#entries.set(passage.passageId, { passage, retrievals: [retrieval] });
    });
    this.#pendingCalls.delete(reservation.callIndex);
  }

  passages(): LiteraturePassage[] {
    return this.entries().map(({ passage }) => passage);
  }

  entries(): EvidenceLedgerEntry[] {
    return [...this.#entries.values()]
      .map(({ passage, retrievals }) => ({
        passage,
        retrievals: [...retrievals].sort(
          (left, right) => left.callIndex - right.callIndex || left.rank - right.rank,
        ),
      }))
      .sort((left, right) => {
        const leftFirst = left.retrievals[0];
        const rightFirst = right.retrievals[0];
        return (
          leftFirst.callIndex - rightFirst.callIndex ||
          leftFirst.rank - rightFirst.rank ||
          left.passage.passageId.localeCompare(right.passage.passageId)
        );
      });
  }

  get searchCount() {
    return this.#searchCount;
  }
}
