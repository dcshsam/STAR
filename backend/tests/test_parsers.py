"""
Extraction tests for all four STAR parsers.

Each test builds a minimal synthetic file that mimics a real SAP export, runs it
through the parser, and asserts the expected form fields and summary keys come out.
We also verify extension-agnostic behaviour: the parsers must accept files whose
extension has been renamed (or is blank) because the API no longer rejects by
extension.
"""
import io
import zipfile

import openpyxl
import pytest

from app.engine.atc import parse_atc
from app.engine.ewa import parse_ewa
from app.engine.readiness import parse_zip
from app.engine.simplification import parse_simplification


# ── helpers ──────────────────────────────────────────────────────────────────

def _make_xlsx(rows: list[list]) -> bytes:
    """Create a minimal single-sheet XLSX from a list of row lists."""
    wb = openpyxl.Workbook()
    ws = wb.active
    for row in rows:
        ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _make_zip(**files: bytes) -> bytes:
    """Create a ZIP in memory. Keys are member filenames, values are their bytes."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in files.items():
            zf.writestr(name, data)
    return buf.getvalue()


# ── RC / Readiness Check ──────────────────────────────────────────────────────

def _rc_zip(
    product="SAP ERP 6.0 EHP8",
    db_type="HDB",
    unicode="Yes",
    system_id="PRD",
    db_size_txt="Data used size on disk: 750",
    custom_rows=50,
    iface_rfc_rows=30,
):
    tech_xlsx = _make_xlsx([
        ["Analyzed System", system_id],
        ["Installed Product Version", product],
        ["Database System Type", db_type],
        ["Unicode", unicode],
        ["Target Product Version", "SAP S/4HANA 2023"],
    ])
    sizing_txt = f"Net data volume size on disk\n{db_size_txt}\n".encode()
    custom_xlsx = _make_xlsx(
        [["Object Name", "In Scope", "Severity"]]
        + [[f"Z_OBJ_{i}", 1, "error"] for i in range(custom_rows)]
    )
    rfc_xlsx = _make_xlsx(
        [["Interface", "Type"]]
        + [[f"RFC_{i}", "RFC"] for i in range(iface_rfc_rows)]
    )
    return _make_zip(
        **{
            "TechnicalProperties.xlsx": tech_xlsx,
            "hana_sizing.txt": sizing_txt,
            "CustomCode.xlsx": custom_xlsx,
            "InterfaceImpactAnalysisRFC.xlsx": rfc_xlsx,
        }
    )


class TestReadinessParser:
    def test_basic_extraction(self):
        result = parse_zip(_rc_zip())
        form = result["form"]
        assert form["product_release"] == "soh"   # HDB but not S/4HANA → Suite on HANA
        assert form["unicode_status"] == "unicode"
        assert form["system_id"] == "PRD"
        assert form["db_size_band"] == "500gb_1tb"  # 750 GB
        assert form["custom_objects_band"] in ("lt_500", "500_2k")
        assert form["interface_count_band"] == "20_50"   # 30 RFC interfaces
        assert "facts" in result["summary"]
        assert "review" in result["summary"]

    def test_s4hana_product(self):
        result = parse_zip(_rc_zip(product="SAP S/4HANA 2023"))
        assert result["form"]["product_release"] == "s4hana"

    def test_non_unicode(self):
        result = parse_zip(_rc_zip(unicode="No"))
        assert result["form"]["unicode_status"] == "non_unicode"

    def test_large_db(self):
        result = parse_zip(_rc_zip(db_size_txt="Data used size on disk: 6000"))
        assert result["form"]["db_size_band"] == "5_10tb"

    def test_many_interfaces(self):
        # 250 RFC interfaces → gt_200 band; complexity thresholds are >500 (complex) / >2000 (very_complex)
        result = parse_zip(_rc_zip(iface_rfc_rows=250))
        assert result["form"]["interface_count_band"] == "gt_200"
        assert result["form"]["interface_complexity"] == "medium"

    def test_very_complex_interfaces(self):
        result = parse_zip(_rc_zip(iface_rfc_rows=2001))
        assert result["form"]["interface_complexity"] == "very_complex"

    def test_extension_agnostic(self):
        """parse_zip works on ZIP bytes regardless of what the caller named the file."""
        data = _rc_zip()
        # The API passes raw bytes; filename is irrelevant to parse_zip
        result = parse_zip(data)
        assert "product_release" in result["form"]


# ── ATC / Custom Code ─────────────────────────────────────────────────────────

def _atc_xlsx(n_errors=20, n_warnings=15, n_objects=100) -> bytes:
    rows = [["Object Name", "Object Type", "Severity", "In Scope", "Used"]]
    for i in range(n_errors):
        rows.append([f"Z_ERR_{i}", "PROG", "error", 1, 1])
    for i in range(n_warnings):
        rows.append([f"Z_WARN_{i}", "PROG", "warning", 1, 0])
    extras = n_objects - n_errors - n_warnings
    for i in range(max(extras, 0)):
        rows.append([f"Z_INFO_{i}", "PROG", "info", 0, 0])
    return _make_xlsx(rows)


class TestAtcParser:
    def test_bare_xlsx(self):
        result = parse_atc(_atc_xlsx(), "export.xlsx")
        form = result["form"]
        assert "custom_objects_band" in form
        assert form["overall_customization"] in ("Low", "Med", "High")
        assert "modifications_to_standard" in form
        assert result["insights"]["kind"] == "atc"

    def test_zip_containing_xlsx(self):
        xlsx = _atc_xlsx()
        zipped = _make_zip(**{"atc_export.xlsx": xlsx})
        result = parse_atc(zipped, "export.zip")
        assert "custom_objects_band" in result["form"]

    def test_extension_agnostic_bare_xlsx(self):
        """An XLSX uploaded as .dat or no extension must parse correctly."""
        result = parse_atc(_atc_xlsx(), "atc_export.dat")
        assert "custom_objects_band" in result["form"]

    def test_extension_agnostic_zip(self):
        """A ZIP containing XLSX uploaded with a non-.zip extension must work."""
        xlsx = _atc_xlsx()
        zipped = _make_zip(**{"atc.xlsx": xlsx})
        result = parse_atc(zipped, "export.bak")   # wrong extension
        assert "custom_objects_band" in result["form"]

    def test_high_error_count_advisory(self):
        result = parse_atc(_atc_xlsx(n_errors=50))
        assert result["summary"]["advisory"] is not None
        assert "error" in result["summary"]["advisory"].lower()

    def test_overall_customization_levels(self):
        assert parse_atc(_atc_xlsx(n_errors=0, n_warnings=0, n_objects=5))["form"]["overall_customization"] == "Low"
        assert parse_atc(_atc_xlsx(n_errors=15, n_warnings=0))["form"]["overall_customization"] == "Med"
        assert parse_atc(_atc_xlsx(n_errors=45))["form"]["overall_customization"] == "High"

    def test_empty_raises(self):
        empty = _make_xlsx([])
        with pytest.raises(ValueError, match="empty"):
            parse_atc(empty, "empty.xlsx")


# ── Simplification Item Check ─────────────────────────────────────────────────

def _si_xlsx(n_high=5, n_medium=10, n_low=8) -> bytes:
    rows = [["Item ID", "Title", "Priority", "Status", "Effort"]]
    for i in range(n_high):
        rows.append([f"SI-H{i}", f"Mandatory Item {i}", "Mandatory", "Error", 2])
    for i in range(n_medium):
        rows.append([f"SI-M{i}", f"Recommended Item {i}", "Recommended", "OK", 1])
    for i in range(n_low):
        rows.append([f"SI-L{i}", f"Check Item {i}", "Check", "OK", 0.5])
    return _make_xlsx(rows)


class TestSimplificationParser:
    def test_bare_xlsx(self):
        result = parse_simplification(_si_xlsx(), "si_export.xlsx")
        assert result["insights"]["kind"] == "simplification"
        assert result["insights"]["total"] == 23   # 5+10+8
        assert result["insights"]["errors"] > 0    # items with "Error" status

    def test_zip_containing_xlsx(self):
        xlsx = _si_xlsx()
        zipped = _make_zip(**{"simplification.xlsx": xlsx})
        result = parse_simplification(zipped, "export.zip")
        assert result["insights"]["total"] == 23

    def test_extension_agnostic_xlsx(self):
        result = parse_simplification(_si_xlsx(), "renamed.csv")
        assert "total" in result["insights"]

    def test_extension_agnostic_zip(self):
        zipped = _make_zip(**{"si.xlsx": _si_xlsx()})
        result = parse_simplification(zipped, "upload")
        assert result["insights"]["total"] == 23

    def test_mandatory_advisory(self):
        result = parse_simplification(_si_xlsx(n_high=5))
        assert result["summary"]["advisory"] is not None

    def test_no_mandatory_no_advisory(self):
        result = parse_simplification(_si_xlsx(n_high=0))
        assert result["summary"]["advisory"] is None

    def test_form_empty(self):
        """SI parser intentionally returns no form fields."""
        result = parse_simplification(_si_xlsx())
        assert result["form"] == {}

    def test_empty_raises(self):
        with pytest.raises(ValueError):
            parse_simplification(_make_xlsx([]), "empty.xlsx")


# ── EarlyWatch Alert ──────────────────────────────────────────────────────────

_EWA_HTML_TEMPLATE = """
<html><body>
<h1>EarlyWatch Alert Report</h1>
<p>Database Size: {db_size} GB</p>
<p>Database growth: {growth}% per year</p>
<p>Performance Overview: {perf}</p>
<p>Average Dialog Response Time: 350 ms</p>
{dual_stack_text}
</body></html>
"""


def _ewa_html(db_size=800, growth=8, perf="Good", dual_stack=False) -> bytes:
    ds = "<p>Dual-stack ABAP+Java detected</p>" if dual_stack else ""
    html = _EWA_HTML_TEMPLATE.format(
        db_size=db_size, growth=growth, perf=perf, dual_stack_text=ds
    )
    return html.encode("utf-8")


def _ewa_xlsx(db_size=800, growth=8) -> bytes:
    rows = [
        ["EarlyWatch Alert"],
        ["Database Size", f"{db_size} GB"],
        ["Database growth", f"{growth}%"],
        ["Performance", "Good"],
        ["Average Dialog Response Time", "350 ms"],
    ]
    return _make_xlsx(rows)


class TestEwaParser:
    def test_html_extraction(self):
        result = parse_ewa(_ewa_html(), "ewa.html")
        form = result["form"]
        assert form["db_size_band"] == "500gb_1tb"   # 800 GB
        assert form["stack_type"] == "single_stack"
        assert "db" in result["insights"]

    def test_html_dual_stack(self):
        result = parse_ewa(_ewa_html(dual_stack=True), "ewa.html")
        assert result["form"]["stack_type"] == "dual_stack"

    def test_html_growth_advisory(self):
        result = parse_ewa(_ewa_html(growth=10), "ewa.html")
        assert result["summary"]["advisory"] is not None

    def test_xlsx_extraction(self):
        result = parse_ewa(_ewa_xlsx(), "ewa.xlsx")
        assert "db_size_band" in result["form"]

    def test_extension_agnostic_html(self):
        """HTML content with no extension (or wrong extension) should parse."""
        result = parse_ewa(_ewa_html(), "ewa_report.txt")
        assert "db_size_band" in result["form"]

    def test_extension_agnostic_xlsx(self):
        result = parse_ewa(_ewa_xlsx(), "ewa_export.dat")
        assert "db_size_band" in result["form"]

    def test_pdf_rejected(self):
        fake_pdf = b"%PDF-1.4 fake pdf content"
        with pytest.raises(ValueError, match="PDF"):
            parse_ewa(fake_pdf, "ewa.pdf")

    def test_no_metrics_raises(self):
        junk = b"<html><body>Hello world, no SAP content here</body></html>"
        with pytest.raises(ValueError, match="No EarlyWatch"):
            parse_ewa(junk, "junk.html")

    def test_large_db(self):
        result = parse_ewa(_ewa_html(db_size=6000), "ewa.html")
        assert result["form"]["db_size_band"] == "5_10tb"
