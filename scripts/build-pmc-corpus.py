#!/usr/bin/env python3
"""Build deterministic full-text chunks from the official PMC EFetch XML API."""

from __future__ import annotations

import hashlib
import html
import json
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path


PMCIDS = [
    "PMC13576394",
    "PMC13025216",
    "PMC13513521",
    "PMC11646715",
    "PMC11528210",
    "PMC12302276",
    "PMC10754035",
    "PMC12485160",
    "PMC11536589",
    "PMC9821664",
    "PMC12375097",
]
CURATED_PMCIDS = set(PMCIDS[:6])
OUTPUT = Path(__file__).resolve().parents[1] / "convex" / "fullCorpus.generated.json"
MAX_WORDS = 320
OVERLAP_WORDS = 40


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", html.unescape(value)).strip()


def element_text(element: ET.Element | None) -> str:
    return clean_text(" ".join(element.itertext())) if element is not None else ""


def first_text(element: ET.Element, path: str) -> str:
    return element_text(element.find(path))


def article_id(article: ET.Element, kind: str) -> str:
    for node in article.findall("./front/article-meta/article-id"):
        if node.attrib.get("pub-id-type") == kind:
            return element_text(node)
    return ""


def publication_date(article: ET.Element) -> str:
    dates = article.findall("./front/article-meta/pub-date")
    preferred = next(
        (node for node in dates if node.attrib.get("pub-type") in {"epub", "collection"}),
        dates[0] if dates else None,
    )
    if preferred is None:
        return ""
    year = first_text(preferred, "year")
    month = first_text(preferred, "month")
    day = first_text(preferred, "day")
    if year and month and day:
        return f"{year}-{month.zfill(2)}-{day.zfill(2)}"
    if year and month:
        return f"{year}-{month.zfill(2)}"
    return year


def license_url(article: ET.Element) -> str:
    license_node = article.find("./front/article-meta/permissions/license")
    if license_node is None:
        return ""
    for key, value in license_node.attrib.items():
        if key.endswith("href") and value:
            return value
    license_text = element_text(license_node).lower()
    mappings = [
        ("by-nc-nd", "https://creativecommons.org/licenses/by-nc-nd/4.0/"),
        ("by-nc", "https://creativecommons.org/licenses/by-nc/4.0/"),
        ("by-sa", "https://creativecommons.org/licenses/by-sa/4.0/"),
        ("creative commons attribution", "https://creativecommons.org/licenses/by/4.0/"),
    ]
    return next((url for marker, url in mappings if marker in license_text), license_text)


def paragraph_chunks(text: str) -> list[str]:
    words = clean_text(text).split()
    if len(words) < 20:
        return []
    if len(words) <= MAX_WORDS:
        return [" ".join(words)]
    chunks = []
    start = 0
    while start < len(words):
        end = min(len(words), start + MAX_WORDS)
        chunks.append(" ".join(words[start:end]))
        if end == len(words):
            break
        start = end - OVERLAP_WORDS
    return chunks


def section_paragraphs(section: ET.Element, parent_path: list[str]):
    title = first_text(section, "title")
    path = [*parent_path, title] if title else parent_path
    for child in section:
        if child.tag == "p":
            yield path, element_text(child)
        elif child.tag == "sec":
            yield from section_paragraphs(child, path)


def article_passages(article: ET.Element):
    abstract = article.find("./front/article-meta/abstract")
    if abstract is not None:
        abstract_parts = [element_text(node) for node in abstract.findall(".//p")]
        abstract_text = clean_text(" ".join(part for part in abstract_parts if part))
        if abstract_text:
            yield ["Abstract"], abstract_text

    body = article.find("body")
    if body is None:
        return
    for child in body:
        if child.tag == "p":
            yield ["Body"], element_text(child)
        elif child.tag == "sec":
            yield from section_paragraphs(child, [])


def main() -> None:
    ids = ",".join(pmcid.removeprefix("PMC") for pmcid in PMCIDS)
    query = urllib.parse.urlencode(
        {"db": "pmc", "id": ids, "rettype": "full", "retmode": "xml"}
    )
    request = urllib.request.Request(
        f"https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?{query}",
        headers={"User-Agent": "NovaMind-SDK-comparison/1.0"},
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        root = ET.fromstring(response.read())

    documents = []
    passages = []
    seen_pmcids = set()
    for article in root.findall("article"):
        pmcid = article_id(article, "pmcid") or article_id(article, "pmc")
        if not pmcid.startswith("PMC"):
            pmcid = f"PMC{pmcid}"
        if pmcid not in PMCIDS:
            continue
        seen_pmcids.add(pmcid)
        title = first_text(article, "./front/article-meta/title-group/article-title")
        publication = publication_date(article)
        if pmcid not in CURATED_PMCIDS:
            documents.append(
                {
                    "pmcid": pmcid,
                    "pmid": article_id(article, "pmid"),
                    "doi": article_id(article, "doi"),
                    "title": title,
                    "journal": first_text(article, "./front/journal-meta/journal-title-group/journal-title"),
                    "publicationDate": publication,
                    "license": license_url(article),
                    "sourceUrl": f"https://pmc.ncbi.nlm.nih.gov/articles/{pmcid}/",
                }
            )

        chunk_index = 0
        for section_path, paragraph in article_passages(article):
            for chunk in paragraph_chunks(paragraph):
                context_prefix = (
                    f"Title: {title}\n"
                    f"Section: {' > '.join(section_path) or 'Body'}\n"
                    f"Publication year: {publication[:4]}"
                )
                digest = hashlib.sha256(
                    f"{context_prefix}\n\n{chunk}".encode("utf-8")
                ).hexdigest()
                passages.append(
                    {
                        "passageId": f"{pmcid}:F{chunk_index:04d}",
                        "pmcid": pmcid,
                        "chunkIndex": 10_000 + chunk_index,
                        "sectionPath": section_path or ["Body"],
                        "contextPrefix": context_prefix,
                        "text": chunk,
                        "contentHash": digest,
                        "tokenCount": round(len(chunk.split()) * 1.33),
                    }
                )
                chunk_index += 1

    missing = sorted(set(PMCIDS) - seen_pmcids)
    if missing:
        raise RuntimeError(f"PMC EFetch omitted: {', '.join(missing)}")
    if any(not document["license"] for document in documents):
        raise RuntimeError("Every added document must retain an explicit license.")

    payload = {
        "source": "NCBI PMC EFetch XML",
        "sourceUrl": "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi",
        "generatedFrom": PMCIDS,
        "documents": sorted(documents, key=lambda item: item["pmcid"]),
        "passages": sorted(passages, key=lambda item: item["passageId"]),
    }
    OUTPUT.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {len(documents)} added documents and {len(passages)} full-text passages to {OUTPUT}.")


if __name__ == "__main__":
    main()
