"""STAR decision engine — deterministic, auditable, no LLM.

Faithful port of the client-side JS engine. Given a single-system intake it
returns the recommended approach (Greenfield / Brownfield / Bluefield, or a
release Upgrade for systems already on S/4HANA) and deployment, with a full
score trace. The LLM (Claude via Gen AI Hub) only turns this trace into prose
— see narrative.py. It never changes the decision.
"""
from typing import Any, Dict, List, Optional, Tuple

A = ["GREENFIELD", "BROWNFIELD", "BLUEFIELD"]
D = ["RISE_PRIVATE", "HYPERSCALER_SELF", "ON_PREM"]
DISQ = -999

# (key, label, weight, {answer: {target: signal}})
APPROACH_FACTORS: List[Tuple[str, str, float, dict]] = [
    ("process_reengineering_appetite", "Process re-engineering appetite", 3.0, {
        "redesign_to_standard": {"GREENFIELD": 1}, "preserve": {"BROWNFIELD": 1}, "selective": {"BLUEFIELD": 1}}),
    ("product_release", "DB transition (HANA readiness)", 1.5, {
        "soh": {"BROWNFIELD": 0.8, "BLUEFIELD": 0.3}}),
    ("customization_intensity", "Customization intensity", 2.5, {
        "low": {"BROWNFIELD": 0.8}, "med": {"BLUEFIELD": 0.6, "GREENFIELD": 0.2},
        "high": {"GREENFIELD": 0.8, "BLUEFIELD": 0.3}}),
    ("integration_complexity", "Integration complexity", 1.5, {
        "low": {"BROWNFIELD": 0.6}, "med": {"BLUEFIELD": 0.3, "BROWNFIELD": 0.2},
        "high": {"BLUEFIELD": 0.6, "GREENFIELD": 0.3}}),
    ("landscape_intent", "Landscape intent", 2.5, {
        "keep_single": {"BROWNFIELD": 0.5}, "consolidate_multiple": {"GREENFIELD": 1},
        "carve_out": {"BLUEFIELD": 1}}),
    ("primary_driver", "Primary business driver", 2.0, {
        "burning_platform_2027": {"BROWNFIELD": 1}, "business_transformation": {"GREENFIELD": 1},
        "cost_optimization": {"BROWNFIELD": 0.6}, "m_and_a": {"GREENFIELD": 0.6, "BLUEFIELD": 0.5},
        "innovation": {"GREENFIELD": 0.8}}),
    ("target_golive", "Target go-live", 2.0, {
        "lt_12mo": {"BROWNFIELD": 1}, "12_18mo": {"BROWNFIELD": 0.6},
        "18_24mo": {"BLUEFIELD": 0.3}, "gt_24mo": {"GREENFIELD": 0.7}}),
    ("data_quality", "Data quality", 2.0, {
        "poor": {"GREENFIELD": 0.8, "BLUEFIELD": 0.4}, "mixed": {"BLUEFIELD": 0.4},
        "good": {"BROWNFIELD": 0.8}}),
    ("history_retention", "History retention", 1.5, {
        "full": {"BROWNFIELD": 0.8, "BLUEFIELD": 0.4}, "partial": {"BLUEFIELD": 0.7},
        "minimal_ok": {"GREENFIELD": 0.8}}),
    ("risk_disruption_tolerance", "Risk / disruption tolerance", 1.5, {
        "minimize": {"BROWNFIELD": 0.9}, "balanced": {"BLUEFIELD": 0.4},
        "accept_for_value": {"GREENFIELD": 0.8}}),
    ("budget_posture", "Budget posture", 1.5, {
        "constrained": {"BROWNFIELD": 0.8}, "moderate": {"BLUEFIELD": 0.3},
        "significant": {"GREENFIELD": 0.7}}),
    ("modifications_to_standard", "Modifications to standard", 1.0, {
        "true": {"GREENFIELD": 0.5, "BLUEFIELD": 0.3}, "false": {"BROWNFIELD": 0.4}}),
    ("change_mgmt_maturity", "Change-mgmt maturity", 1.0, {
        "none": {"BROWNFIELD": 0.6}, "developing": {"BLUEFIELD": 0.2}, "mature": {"GREENFIELD": 0.6}}),
]

DEPLOY_FACTORS: List[Tuple[str, str, float, dict]] = [
    ("basis_ops_capability", "Basis/Ops capability", 3.0, {
        "strong_retain": {"HYPERSCALER_SELF": 1}, "strong_offload": {"RISE_PRIVATE": 1},
        "limited": {"RISE_PRIVATE": 0.9}}),
    ("target_deployment_pref", "Stated preference", 2.5, {
        "rise_private": {"RISE_PRIVATE": 1}, "hyperscaler_self": {"HYPERSCALER_SELF": 1},
        "on_prem": {"ON_PREM": 0.8}, "undecided": {}}),
    ("existing_hyperscaler", "Existing hyperscaler", 2.0, {
        "azure": {"HYPERSCALER_SELF": 0.9, "RISE_PRIVATE": 0.3},
        "aws": {"HYPERSCALER_SELF": 0.9, "RISE_PRIVATE": 0.3},
        "gcp": {"HYPERSCALER_SELF": 0.9, "RISE_PRIVATE": 0.3},
        "private_cloud": {"ON_PREM": 0.6, "HYPERSCALER_SELF": 0.3}, "none": {"RISE_PRIVATE": 0.5}}),
    ("data_sovereignty_strictness", "Data sovereignty", 2.0, {
        "strict": {"ON_PREM": 0.7, "RISE_PRIVATE": 0.5}, "moderate": {},
        "flexible": {"RISE_PRIVATE": 0.4, "HYPERSCALER_SELF": 0.2}}),
    ("db_size_band", "Database size", 1.0, {
        "lt_500gb": {}, "500gb_1tb": {}, "1_3tb": {}, "3_5tb": {"RISE_PRIVATE": 0.1},
        "5_10tb": {"RISE_PRIVATE": 0.2}, "10_20tb": {"HYPERSCALER_SELF": 0.4, "RISE_PRIVATE": 0.3},
        "20_40tb": {"HYPERSCALER_SELF": 0.6, "RISE_PRIVATE": 0.4},
        "gt_40tb": {"HYPERSCALER_SELF": 0.8, "RISE_PRIVATE": 0.5}}),
]

COUPLING = {
    "GREENFIELD": {"RISE_PRIVATE": 1.0, "HYPERSCALER_SELF": 0.4},
    "BROWNFIELD": {"RISE_PRIVATE": 1.5, "HYPERSCALER_SELF": 0.8},
    "BLUEFIELD": {"RISE_PRIVATE": 1.0, "HYPERSCALER_SELF": 0.8},
    "UPGRADE": {"RISE_PRIVATE": 1.0, "HYPERSCALER_SELF": 0.6},
}
WAVES = {
    "GREENFIELD": ["Discover & Fit-to-Standard", "Design & Build", "Data Migration", "Test", "Cutover", "Hypercare"],
    "BROWNFIELD": ["Readiness Check & Prep", "Custom-code Remediation", "Conversion (SUM/DMO)", "Test", "Cutover", "Hypercare"],
    "BLUEFIELD": ["Scope & Selection", "Build redesigned areas", "Selective Data Transition", "Integrate & Test", "Cutover", "Hypercare"],
}
S4_VERSIONS = ["1503", "1511", "1610", "1709", "1809", "1909", "2020", "2021", "2022", "2023", "2025"]
LATEST_S4 = "2025"
S4_RANK = {v: i for i, v in enumerate(S4_VERSIONS)}
UPGRADE_WAVES = ["Upgrade planning & Readiness", "Custom-code & add-on check", "Release Upgrade (SUM)", "Test", "Cutover", "Hypercare"]
CURRENT_WAVES = ["Adopt latest FPS & innovations", "Regression Test", "Cutover", "Hypercare"]


def derive_intensity(x: dict) -> str:
    base = {"lt_500": 1, "500_2k": 2, "2k_10k": 3, "gt_10k": 4}.get(x.get("custom_objects_band"), 2)
    lv = {"Low": 1, "Med": 2, "High": 3}
    vals = list((x.get("customization_level_per_module") or {}).values())
    avg = sum(lv.get(v, 2) for v in vals) / len(vals) if vals else 2
    raw = base + (avg - 2)
    pct = x.get("pct_active_estimate")
    if isinstance(pct, (int, float)) and pct < 40:
        raw -= 1
    return "low" if raw <= 2 else ("med" if raw <= 3.5 else "high")


def derive_integration(x: dict) -> str:
    base = {"lt_20": 1, "20_50": 2, "50_100": 3, "100_200": 4, "gt_200": 5}.get(x.get("interface_count_band"), 2)
    cx = {"simple": -1, "medium": 0, "complex": 1, "very_complex": 2}.get(x.get("interface_complexity"), 0)
    ns = {"low": 0, "medium": 0.5, "high": 1}.get(x.get("non_sap_share"), 0)
    mw = {"point_to_point": 1, "sap_pi_po": 0.5, "third_party": 0.25, "mixed": 0.5,
          "sap_integration_suite": 0}.get(x.get("middleware"), 0)
    raw = base + cx + ns + mw
    return "low" if raw <= 2 else ("med" if raw <= 4 else "high")


def build_advisories(x: dict, integ: dict) -> List[str]:
    a: List[str] = []
    if x.get("middleware") == "sap_pi_po":
        a.append("SAP PI/PO reaches end of mainstream maintenance on 31 Dec 2027 (paid extension to 2030). "
                 "Plan a migration to SAP Integration Suite in parallel with this transformation.")
    if x.get("middleware") == "point_to_point":
        a.append("Point-to-point interfaces (no central middleware) raise regression risk and effort — "
                 "consider consolidating onto SAP Integration Suite during the transition.")
    if x.get("non_sap_share") == "high":
        a.append("Most interfaces are non-SAP — budget for third-party coordination, connectivity and "
                 "end-to-end integration testing across system owners.")
    if integ.get("index") == "high":
        a.append("Integration complexity is high and is a leading effort/risk driver — run an interface "
                 "inventory and SAP-Migration-Assessment-style T-shirt sizing (S/M/L/XL) before committing "
                 "to the timeline.")
    return a


def _score_set(factors, x: dict, targets: List[str]) -> Tuple[Dict[str, float], List[dict]]:
    s = {t: 0.0 for t in targets}
    trace: List[dict] = []
    for key, label, weight, mapping in factors:
        ans = x.get(key)
        if ans is None:
            continue
        ans = str(ans).lower() if isinstance(ans, bool) else str(ans)
        sig = mapping.get(ans, {})
        contrib = {}
        for t in targets:
            c = round(weight * sig.get(t, 0), 3)
            s[t] += c
            if c:
                contrib[t] = c
        if contrib:
            trace.append({"factor": label, "answer": x.get(key), "contribution": contrib})
    return s, trace


def _gates(x: dict) -> List[dict]:
    b: List[dict] = []
    if str(x.get("unicode_status")).lower() == "non_unicode":
        b.append({"gate": "Unicode",
                  "message": "Non-Unicode system — a Unicode conversion is mandatory before any single-step conversion.",
                  "prerequisite": "Combined Upgrade & Unicode Conversion (CU&UC)",
                  "penalty": {"BROWNFIELD": -4, "BLUEFIELD": -2}})
    if x.get("dual_stack") is True:
        b.append({"gate": "Stack type",
                  "message": "Dual-stack system — a dual-stack split is required first.",
                  "prerequisite": "Dual-stack split prior to conversion",
                  "penalty": {"BROWNFIELD": -3, "BLUEFIELD": -1.5}})
    rel = str(x.get("product_release") or "ecc6").lower()
    if rel not in ("ecc6", "ecc6_ehp", "soh", "s4hana"):
        b.append({"gate": "Release level",
                  "message": f"Release '{rel}' is below the single-step conversion baseline (ECC 6.0).",
                  "prerequisite": "Upgrade to ECC 6.0 (+Unicode) first, or choose greenfield",
                  "penalty": {"BROWNFIELD": DISQ, "BLUEFIELD": -5}})
    return b


def _confidence(s: Dict[str, float]) -> str:
    vals = sorted([v for v in s.values() if v > DISQ / 2], reverse=True)
    if len(vals) < 2:
        return "High"
    spread = (vals[0] - vals[-1]) or 1
    r = (vals[0] - vals[1]) / spread
    return "High" if r >= 0.3 else ("Medium" if r >= 0.12 else "Low")


def _argmax(scores: Dict[str, float], order: List[str]) -> str:
    best = order[0]
    for t in order:
        if scores[t] > scores[best]:
            best = t
    return best


def recommend(x: dict) -> dict:
    """Main entry point. `x` is the intake dict (with customization_level_per_module
    and dual_stack already derived). Returns the recommendation dict."""
    rel = str(x.get("product_release")).lower()
    account = {
        "system_id": x.get("system_id"), "entity_name": x.get("entity_name"),
        "brand_name": x.get("brand_name"), "system_owner_customer": x.get("system_owner_customer"),
        "sparc_owner": x.get("sparc_owner"), "gtp_owner": x.get("gtp_owner"),
        "modules": x.get("modules_implemented") or [],
    }
    integration = {"count_band": x.get("interface_count_band"), "complexity_input": x.get("interface_complexity"),
                   "non_sap_share": x.get("non_sap_share"), "middleware": x.get("middleware"),
                   "index": derive_integration(x)}
    advisories = build_advisories(x, integration)
    extra = {"integration": integration, "advisories": advisories}

    if rel == "s4hana":
        cur = x.get("s4_version") or "unknown"
        # Unknown versions (e.g. older than list) are treated as behind, not current.
        behind = cur not in S4_RANK or S4_RANK[cur] < S4_RANK[LATEST_S4]
        ds, dt = _score_set(DEPLOY_FACTORS, x, D)
        for t, v in COUPLING["UPGRADE"].items():
            ds[t] += v
            dt.append({"factor": "Approach coupling", "answer": "UPGRADE", "contribution": {t: v}})
        deployment = _argmax(ds, D)
        note = (f"System is already on SAP S/4HANA {cur}. The transformation is a release "
                f"upgrade to the latest release ({LATEST_S4}) via SUM — not a greenfield or "
                f"brownfield conversion.") if behind else (
                f"System is already on the latest release (SAP S/4HANA {LATEST_S4}). No version "
                f"upgrade required; focus on adopting the newest Feature Pack Stack and innovations.")
        return {"approach": "UPGRADE", "deployment": deployment, "approachConf": "High",
                "deployConf": _confidence(ds), "upgrade": True, "currentVersion": cur,
                "targetVersion": LATEST_S4, "behind": behind, "approachScores": None,
                "deployScores": ds, "intensity": None, "blockers": [], "prereq": [],
                "waves": UPGRADE_WAVES if behind else CURRENT_WAVES, "dbNote": note, "soh": False,
                "trace": dt, **account, **extra}

    e = {**x, "customization_intensity": derive_intensity(x), "integration_complexity": integration["index"]}
    a_s, a_t = _score_set(APPROACH_FACTORS, e, A)
    blockers = _gates(x)
    prereq: List[str] = []
    for g in blockers:
        for t, p in g["penalty"].items():
            a_s[t] = p if p == DISQ else a_s[t] + p
        if g.get("prerequisite"):
            prereq.append(g["prerequisite"])
        a_t.append({"factor": "GATE: " + g["gate"], "answer": g["message"], "contribution": g["penalty"]})
    approach = _argmax(a_s, A)

    ds, dt = _score_set(DEPLOY_FACTORS, x, D)
    for t, v in COUPLING.get(approach, {}).items():
        ds[t] += v
        dt.append({"factor": "Approach coupling", "answer": approach, "contribution": {t: v}})
    deployment = _argmax(ds, D)

    soh = rel == "soh"
    waves = list(WAVES[approach])
    db_note: Optional[str] = None
    if soh:
        waves = ["Conversion (SUM, no DMO)" if w == "Conversion (SUM/DMO)" else w for w in waves]
        if approach in ("BROWNFIELD", "BLUEFIELD"):
            db_note = ("Already on SAP HANA (Suite on HANA): conversion is application-only — SUM "
                       "runs without DMO, so there is no AnyDB->HANA database migration step. "
                       "Lower effort, downtime, and risk.")

    return {"approach": approach, "deployment": deployment, "approachConf": _confidence(a_s),
            "deployConf": _confidence(ds), "approachScores": a_s, "deployScores": ds,
            "intensity": e["customization_intensity"], "blockers": blockers, "prereq": prereq,
            "waves": waves, "dbNote": db_note, "soh": soh, "trace": a_t + dt, "upgrade": False, **account, **extra}
