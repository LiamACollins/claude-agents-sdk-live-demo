#!/usr/bin/env python3
"""Export a reproducible, permissively licensed PMC sample from local Postgres."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path


DEFAULT_CONTAINER = "claude-agents-demo-liam-collins-postgres-1"
DEFAULT_SEED = "novamind-pmc-500-v1"
DEFAULT_BATCH = "local-pmc-random-500-v1"
PERMISSIVE_LICENSES = (
    "https://creativecommons.org/licenses/by/4.0/",
    "https://creativecommons.org/licenses/by/3.0/",
    "https://creativecommons.org/licenses/by/2.0/",
    "https://creativecommons.org/publicdomain/mark/1.0/",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--exclude-pmcids", type=Path)
    parser.add_argument("--count", type=int, default=500)
    parser.add_argument("--seed", default=DEFAULT_SEED)
    parser.add_argument("--batch", default=DEFAULT_BATCH)
    parser.add_argument("--container", default=DEFAULT_CONTAINER)
    return parser.parse_args()


def validate_label(value: str, label: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9:_-]+", value):
        raise ValueError(f"{label} may contain only letters, digits, colon, underscore, and hyphen.")
    return value


def quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def psql_lines(container: str, sql: str):
    process = subprocess.Popen(
        [
            "docker",
            "exec",
            container,
            "psql",
            "-U",
            "literature",
            "-d",
            "literature",
            "-At",
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            sql,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )
    assert process.stdout is not None
    for line in process.stdout:
        if line.strip():
            yield line
    stderr = process.stderr.read() if process.stderr else ""
    return_code = process.wait()
    if return_code:
        raise RuntimeError(stderr.strip() or f"psql exited with {return_code}")


def load_exclusions(path: Path | None) -> list[str]:
    if path is None:
        return []
    values = sorted({line.strip() for line in path.read_text().splitlines() if line.strip()})
    if any(not re.fullmatch(r"PMC\d+", value) for value in values):
        raise ValueError("Every excluded identifier must use the PMC123 form.")
    return values


def selection_cte(count: int, seed: str, exclusions: list[str]) -> str:
    licenses = ", ".join(quote(value) for value in PERMISSIVE_LICENSES)
    exclusion = ""
    if exclusions:
        exclusion = f"AND pmcid NOT IN ({', '.join(quote(value) for value in exclusions)})"
    return f"""
WITH selected AS (
  SELECT pmcid
  FROM documents
  WHERE license IN ({licenses})
    {exclusion}
  ORDER BY md5(pmcid || {quote(':' + seed)})
  LIMIT {count}
)
"""


def write_documents(output: Path, container: str, cte: str, batch: str) -> list[dict]:
    sql = cte + f"""
SELECT jsonb_build_object(
  'pmcid', d.pmcid,
  'pmid', d.pmid,
  'doi', COALESCE(d.doi, ''),
  'title', d.title,
  'journal', COALESCE(d.journal, ''),
  'publicationDate', COALESCE(d.publication_date::text, ''),
  'license', d.license,
  'sourceUrl', d.source_url,
  'primaryBucket', d.primary_bucket,
  'matchedBuckets', to_jsonb(d.matched_buckets),
  'retrievedAt', COALESCE(d.metadata->>'retrieved_at', ''),
  'corpusBatch', {quote(batch)}
)::text
FROM documents d JOIN selected s USING (pmcid)
ORDER BY d.pmcid;
"""
    documents = []
    with output.open("w", encoding="utf-8") as handle:
        for line in psql_lines(container, sql):
            document = json.loads(line)
            documents.append(document)
            handle.write(json.dumps(document, ensure_ascii=False, separators=(",", ":")) + "\n")
    return documents


def write_passages(output: Path, container: str, cte: str, documents: list[dict], batch: str):
    titles = {document["pmcid"]: document["title"] for document in documents}
    metadata = {document["pmcid"]: document for document in documents}
    sql = cte + """
SELECT jsonb_build_object(
  'passageId', c.id,
  'pmcid', c.pmcid,
  'chunkIndex', c.chunk_index,
  'sectionPath', to_jsonb(c.section_path),
  'contextPrefix', c.context_prefix,
  'text', c.content,
  'contentHash', c.content_hash,
  'tokenCount', c.token_count
)::text
FROM chunks c JOIN selected s USING (pmcid)
ORDER BY c.pmcid, c.chunk_index;
"""
    count = 0
    token_count = 0
    digest = hashlib.sha256()
    with output.open("w", encoding="utf-8") as handle:
        for line in psql_lines(container, sql):
            passage = json.loads(line)
            document = metadata[passage["pmcid"]]
            passage["searchText"] = "\n".join(
                [
                    document["title"],
                    document["journal"],
                    document["pmcid"],
                    document["pmid"],
                    document["doi"],
                    document["publicationDate"],
                    passage["contextPrefix"],
                    passage["text"],
                ]
            )
            passage["embeddingInput"] = f"title: {titles[passage['pmcid']]} | text: {passage['text']}"
            passage["corpusBatch"] = batch
            encoded = json.dumps(passage, ensure_ascii=False, separators=(",", ":"))
            handle.write(encoded + "\n")
            digest.update((passage["passageId"] + ":" + passage["contentHash"] + "\n").encode())
            count += 1
            token_count += passage["tokenCount"]
    return count, token_count, digest.hexdigest()


def main() -> None:
    args = parse_args()
    if args.count < 1 or args.count > 10_000:
        raise ValueError("count must be between 1 and 10,000")
    seed = validate_label(args.seed, "seed")
    batch = validate_label(args.batch, "batch")
    exclusions = load_exclusions(args.exclude_pmcids)
    args.output.mkdir(parents=True, exist_ok=True)
    cte = selection_cte(args.count, seed, exclusions)
    documents_path = args.output / "documents.jsonl"
    passages_path = args.output / "passages.source.jsonl"
    documents = write_documents(documents_path, args.container, cte, batch)
    if len(documents) != args.count:
        raise RuntimeError(f"Expected {args.count} documents, exported {len(documents)}.")
    passage_count, token_count, lineage_digest = write_passages(
        passages_path, args.container, cte, documents, batch
    )
    if passage_count == 0:
        raise RuntimeError("The selected documents produced no passages.")
    pmcids = [document["pmcid"] for document in documents]
    manifest = {
        "corpusBatch": batch,
        "selectionSeed": seed,
        "documentCount": len(documents),
        "passageCount": passage_count,
        "sourceTokenCount": token_count,
        "excludedPmcids": exclusions,
        "selectedPmcids": pmcids,
        "selectedPmcidsSha256": hashlib.sha256(("\n".join(pmcids) + "\n").encode()).hexdigest(),
        "passageLineageSha256": lineage_digest,
        "embeddingModel": "gemini-embedding-2",
        "embeddingDimensions": 768,
    }
    (args.output / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(
        f"Exported {len(documents)} documents and {passage_count} passages "
        f"({token_count:,} source tokens) to {args.output}."
    )


if __name__ == "__main__":
    main()
