"""Parse an SAP Readiness Check export (.zip of .xlsx + sizing txt) into a
pre-filled STAR intake plus an extraction summary.

Notes from real exports:
- The SAP-generated .xlsx set a wrong <dimension>, so openpyxl read_only mode
  under-reads. We load non-streaming (read_only=False) which reads all rows.
- Interface objects live in InterfaceImpactAnalysis{RFC,WEB,OData,BWE,IDOC}.xlsx,
  one object per data row.
"""
import io
import re
import zipfile
from typing import Optional

from openpyxl import load_workbook

# upper bound (GiB) -> STAR band
_DB_BANDS = [
    (500, "lt_500gb"), (1000, "500gb_1tb"), (3000, "1_3tb"), (5000, "3_5tb"),
    (10000, "5_10tb"), (20000, "10_20tb"), (40000, "20_40tb"), (10 ** 12, "gt_40tb"),
]


def _band_from_gb(gb: float) -> str:
    for lim, name in _DB_BANDS:
        if gb < lim:
            return name
    return "gt_40tb"


def _rows(xlsx_bytes: bytes) -> list:
    wb = load_workbook(io.BytesIO(xlsx_bytes), read_only=False, data_only=True)
    ws = wb.worksheets[0]
    return [r for r in ws.iter_rows(values_only=True)
            if any(c is not None and str(c).strip() for c in r)]


def _interface_band(total: int) -> str:
    if total < 20:
        return "lt_20"
    if total < 50:
        return "20_50"
    if total < 100:
        return "50_100"
    if total <= 200:
        return "100_200"
    return "gt_200"


def parse_zip(data: bytes) -> dict:
    """Return {'form': {...partial intake...}, 'summary': {...}}."""
    z = zipfile.ZipFile(io.BytesIO(data))
    names = z.namelist()

    def find(substr: str) -> Optional[str]:
        for n in names:
            if substr.lower() in n.lower():
                return n
        return None

    form: dict = {}
    facts: list = []
    review = ["SAP vs non-SAP interface split", "Middleware (PI/PO vs point-to-point)",
              "Business modules in scope",
              "Business inputs: driver, go-live, budget, risk, sovereignty, basis capability"]
    advisory: Optional[str] = None

    # --- system identity ---
    tp = find("TechnicalProperties")
    if tp:
        props = {}
        for r in _rows(z.read(tp)):
            if len(r) >= 2 and r[0]:
                props[str(r[0]).strip()] = (str(r[1]).strip() if r[1] is not None else "")
        inst = props.get("Installed Product Version", "")
        dbt = props.get("Database System Type", "")
        uni = props.get("Unicode", "")
        tgt = props.get("Target Product Version", "")
        sysid = (props.get("Analyzed System", "") or "SYS").split(" ")[0]
        is_hana = dbt.upper() in ("HDB", "HANA") or "hana" in dbt.lower()
        form["system_id"] = sysid
        form["unicode_status"] = "unicode" if uni.lower().startswith("y") else "non_unicode"
        if "S/4HANA" in inst:
            form["product_release"] = "s4hana"
        elif is_hana:
            form["product_release"] = "soh"
        elif "6.0" in inst or "ERP 6" in inst:
            form["product_release"] = "ecc6_ehp"
        else:
            form["product_release"] = "ecc6"
        soh_tag = " already on HANA (Suite on HANA)" if is_hana and "S/4HANA" not in inst else ""
        facts.append(f"System {sysid} — {inst}{soh_tag}")
        facts.append(f"Unicode: {uni or 'n/a'} · Target: {tgt or 'n/a'}")

    # --- HANA sizing -> DB band ---
    sz = find("hana_sizing")
    if sz:
        txt = z.read(sz).decode("latin-1", "ignore")
        gb = None
        m = re.search(r"Data used size on disk[^\d]*(\d+)", txt)
        if m:
            gb = float(m.group(1))
        else:
            m = re.search(r"Net data volume size on disk\s+([\d.,]+)", txt)
            if m:
                gb = float(m.group(1).replace(".", "").replace(",", "."))
        if gb:
            form["db_size_band"] = _band_from_gb(gb)
            facts.append(f"HANA data size ≈ {int(gb)} GB")

    # --- custom code ---
    cc = find("CustomCode")
    if cc:
        rows = _rows(z.read(cc))
        findings = max(len(rows) - 1, 0)
        in_scope_total = 0
        try:
            hdr = [str(h).replace("\n", " ") for h in rows[0]]
            idx = next(i for i, h in enumerate(hdr) if "In Scope" in h)
            for r in rows[1:]:
                v = r[idx]
                try:
                    in_scope_total += int(float(str(v).replace(",", "").strip()))
                except (TypeError, ValueError):
                    pass
        except Exception:
            pass
        if in_scope_total >= 10000:
            form["custom_objects_band"] = "gt_10k"
        elif in_scope_total >= 2000:
            form["custom_objects_band"] = "2k_10k"
        elif in_scope_total >= 500:
            form["custom_objects_band"] = "500_2k"
        else:
            form["custom_objects_band"] = "lt_500"
        form["overall_customization"] = "High" if findings >= 40 else ("Med" if findings >= 12 else "Low")
        form["modifications_to_standard"] = "true"
        facts.append(f"Custom code: {findings} simplification findings, ~{in_scope_total} impacted objects in scope")

    # --- interfaces ---
    total_if = 0
    breakdown = []
    for tech, key in [("RFC", "RFC"), ("WEB", "Web"), ("OData", "OData"), ("BWE", "BWE"), ("IDOC", "IDoc")]:
        n = find(f"InterfaceImpactAnalysis{tech}")
        if n:
            c = max(len(_rows(z.read(n))) - 1, 0)
            total_if += c
            if c:
                breakdown.append(f"{c} {key}")
    if total_if:
        form["interface_count_band"] = _interface_band(total_if)
        form["interface_complexity"] = "very_complex" if total_if > 2000 else ("complex" if total_if > 500 else "medium")
        facts.append(f"Interfaces: ≈ {total_if} ({' · '.join(breakdown)})")

    # --- simplification items ---
    si = find("RelevantSimplificationItems")
    if si:
        n = max(len(_rows(z.read(si))) - 1, 0)
        if n:
            facts.append(f"Simplification items: {n} relevant")

    # --- add-on compatibility (conversion blocker) ---
    ad = find("AddonCompat")
    if ad:
        rows = _rows(z.read(ad))
        incompat = 0
        try:
            hdr = [str(h) for h in rows[0]]
            si2 = hdr.index("Status")
            incompat = sum(1 for r in rows[1:] if r[si2] and str(r[si2]).strip().lower() == "incompatible")
        except Exception:
            pass
        if incompat:
            advisory = (f"SAP Readiness Check flagged {incompat} incompatible add-on(s) — these block the "
                        f"SUM conversion and must be remediated or uninstalled as a prerequisite.")
            facts.append(f"Add-ons: {incompat} incompatible — conversion prerequisite")

    return {"form": form, "summary": {"facts": facts, "review": review, "advisory": advisory}}
