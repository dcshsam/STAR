"""Parse an SAP Simplification Item Check export (XLSX or ZIP of XLSX) into a
partial STAR intake plus an extraction summary.

The Simplification Item Check (also called "Simplification List Check" in older
SAP Readiness Check versions) exports one row per relevant item with columns for
item ID, description, priority/category, and optionally a consistency check status.
The export comes from SAP Readiness Check or from the standalone SL check in
SAP Solution Manager.

Returns the same contract as the RC parser: ``{"form": {...}, "summary": {...},
"insights": {...}}``.
"""
import io
import re
import zipfile
from typing import Optional

from openpyxl import load_workbook

_PRIORITY_KWS = ["priority", "category", "relevance", "importance", "impact"]
_TITLE_KWS = ["title", "description", "simplification item", "item name", "name", "text"]
_STATUS_KWS = ["status", "check status", "consistency", "result"]
_EFFORT_KWS = ["effort", "workload", "days", "estimated"]

_MANDATORY_TERMS = ["mandatory", "must", "required", "blocking", "high"]
_OPTIONAL_TERMS = ["optional", "recommended", "medium", "low", "check", "should"]

_CONSISTENCY_ERR_TERMS = ["error", "fail", "failed", "incorrect", "inconsistent"]


def _rows(xlsx_bytes: bytes) -> list:
    wb = load_workbook(io.BytesIO(xlsx_bytes), read_only=False, data_only=True)
    ws = wb.worksheets[0]
    return [r for r in ws.iter_rows(values_only=True)
            if any(c is not None and str(c).strip() for c in r)]


def _col(headers: list, keywords: list):
    for kw in keywords:
        for i, h in enumerate(headers):
            if kw in str(h).lower():
                return i
    return None


def _priority_rank(raw: str) -> int:
    """Return 0=high/mandatory, 1=medium, 2=low/check for sorting."""
    r = raw.lower().strip()
    for t in _MANDATORY_TERMS[:3]:
        if t in r:
            return 0
    if "medium" in r or "2" == r:
        return 1
    return 2


def parse_simplification(data: bytes, filename: str = "") -> dict:
    """Return ``{'form': {...}, 'summary': {...}, 'insights': {...}}``."""
    # If the bytes are a ZIP that contains an XLSX inside, extract it.
    # XLSX is also a ZIP, but won't contain .xlsx entries — so this safely
    # distinguishes a ZIP container from a bare XLSX regardless of extension.
    raw = data
    if data[:2] == b"PK":
        try:
            z = zipfile.ZipFile(io.BytesIO(data))
            xlsx_names = [n for n in z.namelist() if n.lower().endswith((".xlsx", ".xlsm"))]
            if xlsx_names:
                raw = z.read(xlsx_names[0])
        except zipfile.BadZipFile:
            pass

    rows = _rows(raw)
    if not rows:
        raise ValueError("Simplification Item export appears empty")

    # Detect header row
    hdr_idx = 0
    headers: list = []
    for i, row in enumerate(rows[:8]):
        vals = [str(c).strip() for c in row if c is not None]
        if len(vals) >= 2 and not any(v.lstrip("-").replace(".", "").isdigit() for v in vals[:3]):
            headers = [str(c).lower().strip() if c else "" for c in row]
            hdr_idx = i
            break

    data_rows = rows[hdr_idx + 1:]

    pri_col = _col(headers, _PRIORITY_KWS)
    title_col = _col(headers, _TITLE_KWS)
    status_col = _col(headers, _STATUS_KWS)
    effort_col = _col(headers, _EFFORT_KWS)

    total = 0
    high = medium = low = 0
    consistency_errors = 0
    effort_days = 0.0
    mandatory_items: list = []
    all_items: list = []

    for row in data_rows:
        total += 1
        pri_raw = str(row[pri_col]).strip() if pri_col is not None and pri_col < len(row) else ""
        title_raw = str(row[title_col]).strip() if title_col is not None and title_col < len(row) else f"Item {total}"
        status_raw = str(row[status_col]).strip().lower() if status_col is not None and status_col < len(row) else ""

        # Classify priority
        rank = _priority_rank(pri_raw)
        if rank == 0:
            high += 1
        elif rank == 1:
            medium += 1
        else:
            low += 1

        # Consistency errors
        if any(t in status_raw for t in _CONSISTENCY_ERR_TERMS):
            consistency_errors += 1

        # Effort
        if effort_col is not None and effort_col < len(row):
            v = row[effort_col]
            try:
                effort_days += float(str(v).replace(",", "").strip())
            except (TypeError, ValueError):
                pass

        # Track mandatory items for insights
        label = "Mandatory" if rank == 0 else ("Recommended" if rank == 1 else "Check")
        all_items.append((title_raw[:60], label, rank))
        if rank == 0 and len(mandatory_items) < 8:
            mandatory_items.append([title_raw[:60], label])

    if total == 0:
        raise ValueError("No simplification items found in the export")

    all_items.sort(key=lambda x: x[2])

    # SI check contributes no form fields (the engine's FUSE_ORDER puts it lowest),
    # but a high mandatory count is a strong signal the architect should note.
    form: dict = {}

    effort_str = f"≈ {int(effort_days)} days" if effort_days >= 1 else ""
    facts = [
        f"{total} relevant Simplification Items ({high} high · {medium} medium · {low} low / check)",
    ]
    if mandatory_items:
        top = ", ".join(x[0] for x in mandatory_items[:4])
        facts.append(f"Mandatory: {top}")
    if consistency_errors:
        facts.append(f"{consistency_errors} consistency errors to fix pre-conversion")
    if effort_str:
        facts.append(f"Effort estimate: {effort_str}")

    advisory: Optional[str] = None
    if high >= 3:
        names = ", ".join(x[0] for x in mandatory_items[:3])
        advisory = (f"Simplification Item Check flags {names} as mandatory functional "
                    "conversions — plan data cleansing and organisational change management.")

    effort_breakdown = [["High", high], ["Medium", medium], ["Low / check", low]]

    insights = {
        "kind": "simplification",
        "total": total,
        "errors": consistency_errors,
        "effort": effort_breakdown,
        "mandatory": mandatory_items,
    }

    return {"form": form, "summary": {"facts": facts, "review": [
        "Mandatory items by module and data-migration impact",
        "Consistency errors — fix before conversion freeze",
        "Business inputs: driver, go-live, budget, risk, sovereignty, basis capability",
    ], "advisory": advisory}, "insights": insights}
