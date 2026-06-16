"""Parses models/<family>/REFERENCES.md into structured JSON for the frontend."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODELS_DIR = ROOT / "models"


def _parse_references_md(path: Path) -> list[dict]:
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8")

    entries: list[dict] = []
    chunks = re.split(r"\n###\s+", text)
    for chunk in chunks[1:]:
        lines = chunk.strip().splitlines()
        if not lines:
            continue
        header = lines[0].strip()
        num_match = re.match(r"(\d+)\.\s+(.+)", header)
        if not num_match:
            continue
        num = int(num_match.group(1))
        short_name = num_match.group(2).strip()

        body = "\n".join(lines[1:])
        title_m = re.search(r"\*\*Title:\*\*\s*(.+)", body)
        title = title_m.group(1).strip() if title_m else short_name

        links: list[dict] = []
        for label, pattern in [
            ("PMC", r"\*\*PMC:\*\*\s*(https?://\S+)"),
            ("DOI", r"\*\*DOI:\*\*\s*(https?://\S+)"),
            ("Source", r"\*\*Source:\*\*\s*(https?://\S+)"),
        ]:
            m = re.search(pattern, body)
            if m:
                links.append({"label": label, "url": m.group(1).strip()})
        if not links:
            url_m = re.search(r"(https?://\S+)", body)
            if url_m:
                links.append({"label": "Link", "url": url_m.group(1).strip()})

        journal_m = re.search(r"\*\*Journal:\*\*\s*(.+)", body)
        journal = journal_m.group(1).strip() if journal_m else None

        authors_m = re.search(r"\*\*Authors:\*\*\s*(.+)", body)
        authors = authors_m.group(1).strip() if authors_m else None

        used_lines: list[str] = []
        in_used = False
        for line in body.splitlines():
            if line.strip().startswith("**Used for:**"):
                in_used = True
                continue
            if in_used:
                if line.strip().startswith("---") or line.strip().startswith("###"):
                    break
                bullet = re.sub(r"^-\s*", "", line.strip())
                if bullet:
                    used_lines.append(bullet)

        entries.append({
            "num": num,
            "short_name": short_name,
            "title": title,
            "authors": authors,
            "journal": journal,
            "links": links,
            "used_for": used_lines,
        })
    return entries


def get_references() -> dict:
    result: dict[str, list[dict]] = {}
    for family_dir in MODELS_DIR.iterdir():
        if not family_dir.is_dir():
            continue
        ref_path = family_dir / "REFERENCES.md"
        if ref_path.exists():
            result[family_dir.name] = _parse_references_md(ref_path)
    return result
