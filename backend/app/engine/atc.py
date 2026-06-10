"""Parse an SAP ATC / Custom Code Check export (XLSX or ZIP of XLSX) into a
partial STAR intake plus an extraction summary.

ATC exports from transaction SCI/ATC, SAP Readiness Check's Custom Code tab,
or the ABAP Test Cockpit typically contain one row per finding with columns for
object name, object type, finding message, severity, and a UPL-based "active"
flag. We auto-detect the column layout from the header row.

Returns the same contract as the RC parser: ``{"form": {...}, "summary": {...},
"insights": {...}}``.
"""
import io
import zipfile
from typing import Optional

from openpyxl import load_workbook

# ── column-name patterns to logical role ─────────────────────────────────────
_OBJECT_KWS = ["object name", "object", "program", "class", "function", "report"]
_TYPE_KWS = ["object type", "type", "kind"]
_SEV_KWS = ["severity", "status", "prio", "priority", "message type", "check priority"]
_ACTIVE_KWS = ["used", "active", "upl", "in use", "actively used"]
_IN_SCOPE_KWS = ["in scope", "inscope", "scope", "relevant"]

_SEV_MAP = {
    "e": "error", "error": "error", "1": "error",
    "w": "warning", "warning": "warning", "2": "warning",
    "i": "info", "info": "info", "3": "info",
}


def _rows(xlsx_bytes: bytes) -> list:
    wb = load_workbook(io.BytesIO(xlsx_bytes), read_only=False, data_only=True)
    ws = wb.worksheets[0]
    return [r for r in ws.iter_rows(values_only=True)
            if any(c is not None and str(c).strip() for c in r)]


def _col(headers: list, keywords: list) -> Optional[int]:
    for kw in keywords:
        for i, h in enumerate(headers):
            if kw in str(h).lower():
                return i
    return None


def _band(total: int) -> str:
    if total < 500:
        return "lt_500"
    if total < 2000:
        return "500_2k"
    if total <= 10000:
        return "2k_10k"
    return "gt_10k"


def _custom_level(errors: int, total_findings: int) -> str:
    if errors >= 40 or total_findings >= 200:
        return "High"
    if errors >= 12 or total_findings >= 50:
        return "Med"
    return "Low"


def parse_atc(data: bytes, filename: str = "") -> dict:
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
        raise ValueError("ATC export appears empty")

    # Find the header row (first row that looks like column names, not data).
    hdr_idx = 0
    headers: list = []
    for i, row in enumerate(rows[:8]):
        vals = [str(c).strip() for c in row if c is not None]
        # A header row typically has text in several cells and no purely numeric cells
        if len(vals) >= 3 and not any(v.lstrip("-").replace(".", "").isdigit() for v in vals[:4]):
            headers = [str(c).lower().strip() if c else "" for c in row]
            hdr_idx = i
            break

    data_rows = rows[hdr_idx + 1:]

    sev_col = _col(headers, _SEV_KWS)
    obj_col = _col(headers, _OBJECT_KWS)
    scope_col = _col(headers, _IN_SCOPE_KWS)
    active_col = _col(headers, _ACTIVE_KWS)

    errors = warnings = infos = 0
    in_scope_total = 0
    active_total = 0
    total_objects = 0

    for row in data_rows:
        total_objects += 1
        # severity
        sev_raw = str(row[sev_col]).strip().lower() if sev_col is not None and sev_col < len(row) else ""
        mapped = _SEV_MAP.get(sev_raw[:1], _SEV_MAP.get(sev_raw, "info"))
        if mapped == "error":
            errors += 1
        elif mapped == "warning":
            warnings += 1
        else:
            infos += 1

        # in-scope count
        if scope_col is not None and scope_col < len(row):
            v = row[scope_col]
            try:
                in_scope_total += int(float(str(v).replace(",", "").strip()))
            except (TypeError, ValueError):
                if str(v).strip().lower() in ("x", "yes", "true", "1"):
                    in_scope_total += 1

        # active/used
        if active_col is not None and active_col < len(row):
            v = row[active_col]
            try:
                active_total += int(float(str(v).replace(",", "").strip()))
            except (TypeError, ValueError):
                if str(v).strip().lower() in ("x", "yes", "true", "1"):
                    active_total += 1

    # UPL activity percentage
    pct_active = round((active_total / total_objects * 100) if total_objects else 50)

    total_findings = errors + warnings
    form: dict = {
        "custom_objects_band": _band(in_scope_total if in_scope_total else total_objects),
        "overall_customization": _custom_level(errors, total_findings),
        "modifications_to_standard": "true",
    }
    if pct_active and active_col is not None:
        form["pct_active_estimate"] = min(max(pct_active, 0), 100)

    # Estimate effort (from CoreVantage EFFORT_MATRIX heuristic)
    effort_pd = round(errors * 2.5 + warnings * 0.5, 0)
    effort_str = f"{int(effort_pd * 0.8)}–{int(effort_pd * 1.2)} PD" if effort_pd else "< 5 PD"

    facts = [
        f"{total_objects:,} custom objects analysed"
        + (f" · {in_scope_total:,} in scope" if in_scope_total else ""),
        f"{errors:,} error-level + {warnings:,} warning findings",
    ]
    if active_col is not None:
        facts.append(f"≈ {pct_active}% of custom code actively used (UPL)")
    facts.append(f"Remediation estimate ≈ {effort_str}")

    advisory: Optional[str] = None
    if errors >= 40:
        advisory = (f"ATC found {errors:,} mandatory (error-level) findings — schedule "
                    "custom-code remediation before the conversion freeze.")

    insights = {
        "kind": "atc",
        "totals": {
            "objects": total_objects,
            "inScope": in_scope_total,
            "errors": errors,
            "warnings": warnings,
            "usedPct": pct_active if active_col is not None else None,
            "effort": effort_str,
        },
    }

    return {"form": form, "summary": {"facts": facts, "review": [
        "Top error-finding categories and owner teams",
        "Effort estimate breakdown by module",
        "Business inputs: driver, go-live, budget, risk, sovereignty, basis capability",
    ], "advisory": advisory}, "insights": insights}
