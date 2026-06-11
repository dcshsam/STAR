"use client";

import { useState, useEffect } from "react";
import { getPortfolio, putPortfolio, importSource, apiConfigured } from "@/lib/api";

/* ============================================================
   STAR — Selection Screen (demo) · guided wizard
   One section per step. Next unlocks only when the current
   section is complete. Final step produces the recommendation.
   Fiori Horizon-styled React; deterministic engine (port of
   star_scoring.py) runs client-side. In production scoring runs
   in Python/FastAPI on BTP; the LLM (Gen AI Hub) adds narrative.
   ============================================================ */

/* ---------------- Decision engine (JS port) ---------------- */
const A = ["GREENFIELD", "BROWNFIELD", "BLUEFIELD"];
const D = ["RISE_PRIVATE", "HYPERSCALER_SELF", "ON_PREM"];
const DISQ = -999;

function deriveIntensity(x) {
  const base = { lt_500: 1, "500_2k": 2, "2k_10k": 3, gt_10k: 4 }[x.custom_objects_band] ?? 2;
  const lv = { Low: 1, Med: 2, High: 3 };
  const vals = Object.values(x.customization_level_per_module || {});
  const avg = vals.length ? vals.reduce((a, v) => a + (lv[v] ?? 2), 0) / vals.length : 2;
  let raw = base + (avg - 2);
  if (typeof x.pct_active_estimate === "number" && x.pct_active_estimate < 40) raw -= 1;
  return raw <= 2 ? "low" : raw <= 3.5 ? "med" : "high";
}

function deriveIntegration(x) {
  const base = { lt_20: 1, "20_50": 2, "50_100": 3, "100_200": 4, gt_200: 5 }[x.interface_count_band] ?? 2;
  const cx = { simple: -1, medium: 0, complex: 1, very_complex: 2 }[x.interface_complexity] ?? 0;
  const ns = { low: 0, medium: 0.5, high: 1 }[x.non_sap_share] ?? 0;
  const mw = { point_to_point: 1, sap_pi_po: 0.5, third_party: 0.25, mixed: 0.5, sap_integration_suite: 0 }[x.middleware] ?? 0;
  const raw = base + cx + ns + mw;
  return raw <= 2 ? "low" : raw <= 4 ? "med" : "high";
}

function buildAdvisories(x, integ) {
  const a = [];
  if (x.middleware === "sap_pi_po") a.push("SAP PI/PO reaches end of mainstream maintenance on 31 Dec 2027 (paid extension to 2030). Plan a migration to SAP Integration Suite in parallel with this transformation.");
  if (x.middleware === "point_to_point") a.push("Point-to-point interfaces (no central middleware) raise regression risk and effort — consider consolidating onto SAP Integration Suite during the transition.");
  if (x.non_sap_share === "high") a.push("Most interfaces are non-SAP — budget for third-party coordination, connectivity and end-to-end integration testing across system owners.");
  if (integ.index === "high") a.push("Integration complexity is high and is a leading effort/risk driver — run an interface inventory and SAP-Migration-Assessment-style T-shirt sizing (S/M/L/XL) before committing to the timeline.");
  return a;
}

const APPROACH_FACTORS = [
  ["process_reengineering_appetite", "Process re-engineering appetite", 3.0, {
    redesign_to_standard: { GREENFIELD: 1 }, preserve: { BROWNFIELD: 1 }, selective: { BLUEFIELD: 1 } }],
  ["product_release", "DB transition (HANA readiness)", 1.5, {
    soh: { BROWNFIELD: 0.8, BLUEFIELD: 0.3 } }],
  ["customization_intensity", "Customization intensity", 2.5, {
    low: { BROWNFIELD: 0.8 }, med: { BLUEFIELD: 0.6, GREENFIELD: 0.2 }, high: { GREENFIELD: 0.8, BLUEFIELD: 0.3 } }],
  ["integration_complexity", "Integration complexity", 1.5, {
    low: { BROWNFIELD: 0.6 }, med: { BLUEFIELD: 0.3, BROWNFIELD: 0.2 }, high: { BLUEFIELD: 0.6, GREENFIELD: 0.3 } }],
  ["landscape_intent", "Landscape intent", 2.5, {
    keep_single: { BROWNFIELD: 0.5 }, consolidate_multiple: { GREENFIELD: 1 }, carve_out: { BLUEFIELD: 1 } }],
  ["primary_driver", "Primary business driver", 2.0, {
    burning_platform_2027: { BROWNFIELD: 1 }, business_transformation: { GREENFIELD: 1 },
    cost_optimization: { BROWNFIELD: 0.6 }, m_and_a: { GREENFIELD: 0.6, BLUEFIELD: 0.5 }, innovation: { GREENFIELD: 0.8 } }],
  ["target_golive", "Target go-live", 2.0, {
    lt_12mo: { BROWNFIELD: 1 }, "12_18mo": { BROWNFIELD: 0.6 }, "18_24mo": { BLUEFIELD: 0.3 }, gt_24mo: { GREENFIELD: 0.7 } }],
  ["data_quality", "Data quality", 2.0, {
    poor: { GREENFIELD: 0.8, BLUEFIELD: 0.4 }, mixed: { BLUEFIELD: 0.4 }, good: { BROWNFIELD: 0.8 } }],
  ["history_retention", "History retention", 1.5, {
    full: { BROWNFIELD: 0.8, BLUEFIELD: 0.4 }, partial: { BLUEFIELD: 0.7 }, minimal_ok: { GREENFIELD: 0.8 } }],
  ["risk_disruption_tolerance", "Risk / disruption tolerance", 1.5, {
    minimize: { BROWNFIELD: 0.9 }, balanced: { BLUEFIELD: 0.4 }, accept_for_value: { GREENFIELD: 0.8 } }],
  ["budget_posture", "Budget posture", 1.5, {
    constrained: { BROWNFIELD: 0.8 }, moderate: { BLUEFIELD: 0.3 }, significant: { GREENFIELD: 0.7 } }],
  ["modifications_to_standard", "Modifications to standard", 1.0, {
    true: { GREENFIELD: 0.5, BLUEFIELD: 0.3 }, false: { BROWNFIELD: 0.4 } }],
  ["change_mgmt_maturity", "Change-mgmt maturity", 1.0, {
    none: { BROWNFIELD: 0.6 }, developing: { BLUEFIELD: 0.2 }, mature: { GREENFIELD: 0.6 } }],
];

const DEPLOY_FACTORS = [
  ["basis_ops_capability", "Basis/Ops capability", 3.0, {
    strong_retain: { HYPERSCALER_SELF: 1 }, strong_offload: { RISE_PRIVATE: 1 }, limited: { RISE_PRIVATE: 0.9 } }],
  ["target_deployment_pref", "Stated preference", 2.5, {
    rise_private: { RISE_PRIVATE: 1 }, hyperscaler_self: { HYPERSCALER_SELF: 1 }, on_prem: { ON_PREM: 0.8 }, undecided: {} }],
  ["existing_hyperscaler", "Existing hyperscaler", 2.0, {
    azure: { HYPERSCALER_SELF: 0.9, RISE_PRIVATE: 0.3 }, aws: { HYPERSCALER_SELF: 0.9, RISE_PRIVATE: 0.3 },
    gcp: { HYPERSCALER_SELF: 0.9, RISE_PRIVATE: 0.3 }, private_cloud: { ON_PREM: 0.6, HYPERSCALER_SELF: 0.3 }, none: { RISE_PRIVATE: 0.5 } }],
  ["data_sovereignty_strictness", "Data sovereignty", 2.0, {
    strict: { ON_PREM: 0.7, RISE_PRIVATE: 0.5 }, moderate: {}, flexible: { RISE_PRIVATE: 0.4, HYPERSCALER_SELF: 0.2 } }],
  ["db_size_band", "Database size", 1.0, {
    lt_500gb: {}, "500gb_1tb": {}, "1_3tb": {}, "3_5tb": { RISE_PRIVATE: 0.1 },
    "5_10tb": { RISE_PRIVATE: 0.2 }, "10_20tb": { HYPERSCALER_SELF: 0.4, RISE_PRIVATE: 0.3 },
    "20_40tb": { HYPERSCALER_SELF: 0.6, RISE_PRIVATE: 0.4 }, gt_40tb: { HYPERSCALER_SELF: 0.8, RISE_PRIVATE: 0.5 } }],
];

const COUPLING = {
  GREENFIELD: { RISE_PRIVATE: 1.0, HYPERSCALER_SELF: 0.4 },
  BROWNFIELD: { RISE_PRIVATE: 1.5, HYPERSCALER_SELF: 0.8 },
  BLUEFIELD: { RISE_PRIVATE: 1.0, HYPERSCALER_SELF: 0.8 },
  UPGRADE: { RISE_PRIVATE: 1.0, HYPERSCALER_SELF: 0.6 },
};
const WAVES = {
  GREENFIELD: ["Discover & Fit-to-Standard", "Design & Build", "Data Migration", "Test", "Cutover", "Hypercare"],
  BROWNFIELD: ["Readiness Check & Prep", "Custom-code Remediation", "Conversion (SUM/DMO)", "Test", "Cutover", "Hypercare"],
  BLUEFIELD: ["Scope & Selection", "Build redesigned areas", "Selective Data Transition", "Integrate & Test", "Cutover", "Hypercare"],
};
const S4_VERSIONS = ["1503", "1511", "1610", "1709", "1809", "1909", "2020", "2021", "2022", "2023", "2025"];
const LATEST_S4 = "2025";
const S4_RANK = Object.fromEntries(S4_VERSIONS.map((v, i) => [v, i]));
const UPGRADE_WAVES = ["Upgrade planning & Readiness", "Custom-code & add-on check", "Release Upgrade (SUM)", "Test", "Cutover", "Hypercare"];
const CURRENT_WAVES = ["Adopt latest FPS & innovations", "Regression Test", "Cutover", "Hypercare"];

function scoreSet(factors, x, targets) {
  const s = Object.fromEntries(targets.map((t) => [t, 0]));
  const trace = [];
  for (const [key, label, weight, map] of factors) {
    let ans = x[key];
    if (ans === undefined || ans === null) continue;
    ans = typeof ans === "boolean" ? String(ans) : String(ans);
    const sig = map[ans] || {};
    const contrib = {};
    for (const t of targets) { const c = +((weight * (sig[t] || 0)).toFixed(3)); s[t] += c; if (c) contrib[t] = c; }
    if (Object.keys(contrib).length) trace.push({ factor: label, answer: x[key], contribution: contrib });
  }
  return [s, trace];
}

function gates(x) {
  const b = [];
  if (String(x.unicode_status).toLowerCase() === "non_unicode")
    b.push({ gate: "Unicode", message: "Non-Unicode system — a Unicode conversion is mandatory before any single-step conversion.",
      prerequisite: "Combined Upgrade & Unicode Conversion (CU&UC)", penalty: { BROWNFIELD: -4, BLUEFIELD: -2 } });
  if (x.dual_stack === true)
    b.push({ gate: "Stack type", message: "Dual-stack system — a dual-stack split is required first.",
      prerequisite: "Dual-stack split prior to conversion", penalty: { BROWNFIELD: -3, BLUEFIELD: -1.5 } });
  const rel = String(x.product_release || "ecc6").toLowerCase();
  if (!["ecc6", "ecc6_ehp", "soh", "s4hana"].includes(rel))
    b.push({ gate: "Release level", message: "Release '" + rel + "' is below the single-step conversion baseline (ECC 6.0).",
      prerequisite: "Upgrade to ECC 6.0 (+Unicode) first, or choose greenfield", penalty: { BROWNFIELD: DISQ, BLUEFIELD: -5 } });
  return b;
}

function confidence(s) {
  const vals = Object.values(s).filter((v) => v > DISQ / 2).sort((a, b) => b - a);
  if (vals.length < 2) return "High";
  const spread = (vals[0] - vals[vals.length - 1]) || 1;
  const r = (vals[0] - vals[1]) / spread;
  return r >= 0.3 ? "High" : r >= 0.12 ? "Medium" : "Low";
}

function recommend(x) {
  const rel = String(x.product_release).toLowerCase();
  const integration = { count_band: x.interface_count_band, complexity_input: x.interface_complexity, non_sap_share: x.non_sap_share, middleware: x.middleware, index: deriveIntegration(x) };
  const advisories = buildAdvisories(x, integration);

  if (rel === "s4hana") {
    const cur = x.s4_version || "unknown";
    const behind = S4_RANK[cur] === undefined || S4_RANK[cur] < S4_RANK[LATEST_S4];
    let [ds, dt] = scoreSet(DEPLOY_FACTORS, x, D);
    for (const [t, v] of Object.entries(COUPLING.UPGRADE)) { ds[t] += v; dt.push({ factor: "Approach coupling", answer: "UPGRADE", contribution: { [t]: v } }); }
    const deployment = D.reduce((m, t) => (ds[t] > ds[m] ? t : m), D[0]);
    const note = behind
      ? "System is already on SAP S/4HANA " + cur + ". The transformation is a release upgrade to the latest release (" + LATEST_S4 + ") via SUM — not a greenfield or brownfield conversion."
      : "System is already on the latest release (SAP S/4HANA " + LATEST_S4 + "). No version upgrade required; focus on adopting the newest Feature Pack Stack and innovations.";
    return { approach: "UPGRADE", deployment, approachConf: "High", deployConf: confidence(ds),
      upgrade: true, currentVersion: cur, targetVersion: LATEST_S4, behind,
      approachScores: null, deployScores: ds, intensity: null, blockers: [], prereq: [],
      waves: behind ? UPGRADE_WAVES : CURRENT_WAVES, dbNote: note, soh: false, trace: dt,
      integration, advisories, system_id: x.system_id, entity_name: x.entity_name, brand_name: x.brand_name,
      system_owner_customer: x.system_owner_customer, sparc_owner: x.sparc_owner, gtp_owner: x.gtp_owner, modules: x.modules_implemented || [] };
  }

  const e = { ...x, customization_intensity: deriveIntensity(x), integration_complexity: integration.index };
  let [as, at] = scoreSet(APPROACH_FACTORS, e, A);
  const blockers = gates(x); const prereq = [];
  for (const g of blockers) {
    for (const [t, p] of Object.entries(g.penalty)) as[t] = p === DISQ ? DISQ : as[t] + p;
    if (g.prerequisite) prereq.push(g.prerequisite);
    at.push({ factor: "GATE: " + g.gate, answer: g.message, contribution: g.penalty });
  }
  const approach = A.reduce((m, t) => (as[t] > as[m] ? t : m), A[0]);
  let [ds, dt] = scoreSet(DEPLOY_FACTORS, x, D);
  for (const [t, v] of Object.entries(COUPLING[approach] || {})) { ds[t] += v; dt.push({ factor: "Approach coupling", answer: approach, contribution: { [t]: v } }); }
  const deployment = D.reduce((m, t) => (ds[t] > ds[m] ? t : m), D[0]);
  const soh = rel === "soh";
  let waves = WAVES[approach];
  let dbNote = null;
  if (soh) {
    waves = waves.map((w) => (w === "Conversion (SUM/DMO)" ? "Conversion (SUM, no DMO)" : w));
    if (approach === "BROWNFIELD" || approach === "BLUEFIELD")
      dbNote = "Already on SAP HANA (Suite on HANA): conversion is application-only — SUM runs without DMO, so there is no AnyDB→HANA database migration step. Lower effort, downtime, and risk.";
  }
  return { approach, deployment, approachConf: confidence(as), deployConf: confidence(ds),
    approachScores: as, deployScores: ds, intensity: e.customization_intensity, blockers, prereq,
    waves, dbNote, soh, trace: [...at, ...dt], integration, advisories, system_id: x.system_id, entity_name: x.entity_name, brand_name: x.brand_name,
    system_owner_customer: x.system_owner_customer, sparc_owner: x.sparc_owner, gtp_owner: x.gtp_owner,
    modules: x.modules_implemented || [] };
}

/* ---------------- presentation config ---------------- */
const C = {
  blue: "#7c5cff", blueDark: "#6536e0", ink: "#15171c", sub: "#6b7280", line: "#e7e5df",
  card: "#ffffff", green: "#1f9d55", brown: "#b45309", indigo: "#2563eb",
  grey: "#94a3b8", warnBg: "#fff7ed", warnLine: "#c2410c", teal: "#0d9488",
  bg: "#f6f5f1", panel: "#ffffff", panel2: "#eef0f3", border: "#e7e5df", tint: "#f4f1fe",
};
const APPROACH_META = {
  GREENFIELD: { label: "Greenfield", sub: "New implementation", color: C.green },
  BROWNFIELD: { label: "Brownfield", sub: "System conversion", color: C.brown },
  BLUEFIELD: { label: "Bluefield", sub: "Selective data transition", color: C.blue },
  UPGRADE: { label: "Release Upgrade", sub: "S/4HANA version upgrade", color: C.teal },
};
const DEPLOY_META = {
  RISE_PRIVATE: { label: "RISE — Private Cloud", color: C.blue },
  HYPERSCALER_SELF: { label: "Hyperscaler (self-managed)", color: C.indigo },
  ON_PREM: { label: "On-premise", color: C.grey },
};
const SWING = new Set(["process_reengineering_appetite", "custom_objects_band", "landscape_intent", "primary_driver", "target_golive", "basis_ops_capability", "interface_complexity"]);
const PRESET_MODULES = ["FI", "CO", "MM", "SD", "PP", "QM", "PM / EAM", "WM", "EWM", "TM", "PS", "HCM", "FSCM", "SRM", "GRC", "RE", "VC / AVC", "JIT / JIS", "VMS", "Ariba", "SuccessFactors"];
const INTERFACE_COUNT_LABEL = { lt_20: "<20", "20_50": "20–50", "50_100": "50–100", "100_200": "100–200", gt_200: ">200" };
const ICOMPLEX_LABEL = { simple: "Simple", medium: "Medium", complex: "Complex", very_complex: "Very complex" };
const NONSAP_LABEL = { low: "<25% non-SAP", medium: "25–60% non-SAP", high: ">60% non-SAP" };
const MIDDLEWARE_LABEL = { sap_pi_po: "SAP PI/PO", sap_integration_suite: "SAP Integration Suite", third_party: "Third-party MW", point_to_point: "Point-to-point", mixed: "Mixed MW" };
const intgLabel = (g) => (g ? [(INTERFACE_COUNT_LABEL[g.count_band] || "?") + " interfaces", ICOMPLEX_LABEL[g.complexity_input], NONSAP_LABEL[g.non_sap_share], MIDDLEWARE_LABEL[g.middleware]].filter(Boolean).join(" · ") : "");

const TECH_KEYS = ["product_release", "unicode_status", "stack_type", "db_size_band", "custom_objects_band", "overall_customization", "pct_active_estimate", "modifications_to_standard", "interface_count_band", "interface_complexity", "non_sap_share", "middleware", "modules_implemented", "fiori_apps_in_scope", "fiori_activation_level"];

// Static source metadata only \u2014 form/facts/advisory/insights come from the backend parser.
const SOURCES = {
  readiness: {
    label: "SAP Readiness Check", code: "RC", accept: "*",
    confident: ["system_id", "product_release", "s4_version", "unicode_status", "db_size_band", "interface_count_band", "interface_complexity", "middleware", "custom_objects_band", "overall_customization", "pct_active_estimate", "modifications_to_standard", "fiori_apps_in_scope", "fiori_activation_level"],
  },
  atc: {
    label: "ATC / Custom Code", code: "ATC", accept: "*",
    // Full RC ZIPs are auto-detected on the backend and parsed via the RC parser,
    // so the ATC tile can also confidently populate system/interface/Fiori fields.
    confident: ["custom_objects_band", "overall_customization", "pct_active_estimate", "modifications_to_standard", "modules_implemented", "process_reengineering_appetite", "system_id", "product_release", "s4_version", "unicode_status", "interface_count_band", "interface_complexity", "middleware", "fiori_apps_in_scope", "fiori_activation_level"],
  },
  simplification: {
    label: "Simplification Item Check", code: "SI", accept: "*",
    confident: ["modules_implemented", "process_reengineering_appetite"],
  },
  ewa: {
    label: "EarlyWatch Alert", code: "EWA", accept: "*",
    confident: ["db_size_band", "stack_type"],
  },
};
const FUSE_ORDER = ["simplification", "ewa", "readiness", "atc"];

// Form field → exact-number key returned by the backend `extracted` dict, plus display metadata.
const EXTRACT_MAP = {
  interface_count_band:    { key: "interface_count",    unit: "interfaces",          icon: "🔌" },
  custom_objects_band:     { key: "custom_objects",     unit: "custom objects",      icon: "🧩" },
  fiori_apps_in_scope:     { key: "fiori_apps",         unit: "Fiori apps",          icon: "📱" },
  fiori_activation_level:  { key: "fiori_activation_pct", unit: "% currently on Fiori", icon: "⚡" },
  db_size_band:            { key: "db_size_gb",         unit: "GB on disk",          icon: "💾" },
};

// Fields whose values from multiple sources should be unioned (deduped) rather
// than overwritten — only `modules_implemented` today, since each report shows a
// partial view of the system's footprint and a later source must not erase
// modules the earlier source uniquely detected.
const UNION_KEYS = new Set(["modules_implemented"]);

// Fuse real backend-parsed data (keyed by source kind) into a merged form + provenance + extracted exact numbers.
function fuseSources(kinds, dataByKind) {
  const form = {}; const prov = {}; const exact = {};
  FUSE_ORDER.forEach((k) => {
    if (!kinds.includes(k)) return;
    const src = SOURCES[k];
    const parsed = (dataByKind && dataByKind[k]) || {};
    Object.entries(parsed.form || {}).forEach(([key, val]) => {
      if (UNION_KEYS.has(key) && Array.isArray(val)) {
        const prev = Array.isArray(form[key]) ? form[key] : [];
        const merged = prev.slice();
        val.forEach((m) => { if (!merged.includes(m)) merged.push(m); });
        form[key] = merged;
        // Provenance: keep the highest-priority source that contributed.
        if (!prov[key]) prov[key] = { code: src.code, label: src.label, assumed: !src.confident.includes(key) };
      } else {
        form[key] = val;
        prov[key] = { code: src.code, label: src.label, assumed: !src.confident.includes(key) };
      }
    });
    Object.entries(parsed.extracted || {}).forEach(([key, val]) => { exact[key] = val; });
  });
  return { form, prov, exact };
}
const ICONS = {
  account: "M16 8a4 4 0 11-8 0 4 4 0 018 0zM4 21v-1a6 6 0 0112 0v1",
  system: "M3 5h18v5H3zM3 14h18v5H3zM6 7.5h3M6 16.5h3",
  functional: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  technical: "M9 8l-4 4 4 4M15 8l4 4-4 4",
  data: "M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6",
  approach: "M5 3v18M5 4h12l-2.5 3.5L17 11H5",
  infra: "M7 18a4 4 0 010-8 5 5 0 019.6-1.5A3.5 3.5 0 1117 18H7z",
};

const O = (a) => a.map(([v, l]) => ({ v, l }));
const SECTIONS = [
  { title: "System Identity", icon: "system", desc: "Technical baseline of the system.", fields: [
    { k: "system_id", label: "System ID", type: "text", ph: "e.g. PRD-ECC-DE01" },
    { k: "product_release", label: "Product & Release", type: "select", opts: O([["ecc6_ehp", "ECC 6.0 + EHP (AnyDB)"], ["ecc6", "ECC 6.0 (no EHP, AnyDB)"], ["soh", "ECC on Suite on HANA (HANA DB)"], ["s4hana", "Already S/4HANA"], ["pre_ecc6", "Pre-ECC 6.0 / R3"]]) },
    { k: "s4_version", label: "S/4HANA version", type: "select", showIf: (f) => f.product_release === "s4hana", opts: O([["1503", "S/4HANA 1503"], ["1511", "S/4HANA 1511"], ["1610", "S/4HANA 1610"], ["1709", "S/4HANA 1709"], ["1809", "S/4HANA 1809"], ["1909", "S/4HANA 1909"], ["2020", "S/4HANA 2020"], ["2021", "S/4HANA 2021"], ["2022", "S/4HANA 2022"], ["2023", "S/4HANA 2023"], ["2025", "S/4HANA 2025 (latest)"]]) },
    { k: "unicode_status", label: "Unicode Status", type: "select", opts: O([["unicode", "Unicode"], ["non_unicode", "Non-Unicode"]]) },
    { k: "stack_type", label: "Stack type", type: "select", showIf: (f) => f.product_release !== "s4hana", opts: O([["single_stack", "Single-stack (ABAP)"], ["dual_stack", "Dual-stack (ABAP + Java)"]]) },
    { k: "db_size_band", label: "Database Size", type: "select", opts: O([["lt_500gb", "< 500 GB"], ["500gb_1tb", "500 GB – 1 TB"], ["1_3tb", "1–3 TB"], ["3_5tb", "3–5 TB"], ["5_10tb", "5–10 TB"], ["10_20tb", "10–20 TB"], ["20_40tb", "20–40 TB"], ["gt_40tb", "> 40 TB"]]) },
  ]},
  { title: "Functional", icon: "functional", desc: "Modules in use and process posture.", fields: [
    { k: "modules_implemented", label: "SAP modules implemented", type: "modules" },
    { k: "process_reengineering_appetite", label: "Process re-engineering appetite", type: "select", opts: O([["redesign_to_standard", "Redesign to S/4 standard"], ["preserve", "Preserve current processes"], ["selective", "Selective"]]) },
  ]},
  { title: "Technical & Integration", icon: "technical", desc: "Custom-code volume, complexity, interface landscape and Fiori readiness.", fields: [
    { k: "custom_objects_band", label: "Custom objects (Z/Y)", type: "select", opts: O([["lt_500", "< 500"], ["500_2k", "500–2k"], ["2k_10k", "2k–10k"], ["gt_10k", "> 10k"]]) },
    { k: "overall_customization", label: "Overall customization level", type: "select", opts: O([["Low", "Low"], ["Med", "Medium"], ["High", "High"]]) },
    { k: "pct_active_estimate", label: "Active custom code", type: "range" },
    { k: "modifications_to_standard", label: "Modifications to SAP standard", type: "select", opts: O([["false", "No"], ["true", "Yes"]]) },
    { k: "interface_count_band", label: "Number of interfaces", type: "select", opts: O([["lt_20", "< 20"], ["20_50", "20–50"], ["50_100", "50–100"], ["100_200", "100–200"], ["gt_200", "> 200"]]) },
    { k: "interface_complexity", label: "Interface complexity (predominant)", type: "select", opts: O([["simple", "Simple (S) — standard IDoc/RFC"], ["medium", "Medium (M) — some mappings"], ["complex", "Complex (L) — multi-mapping / orchestration"], ["very_complex", "Very complex (XL) — B2B/EDI, heavy orchestration"]]) },
    { k: "non_sap_share", label: "SAP vs non-SAP mix", type: "select", opts: O([["low", "Mostly SAP (< 25% non-SAP)"], ["medium", "Mixed (25–60% non-SAP)"], ["high", "Mostly non-SAP (> 60%)"]]) },
    { k: "middleware", label: "Primary middleware", type: "select", opts: O([["sap_pi_po", "SAP PI / PO"], ["sap_integration_suite", "SAP Integration Suite (CPI)"], ["third_party", "Third-party (MuleSoft, Boomi, webMethods…)"], ["point_to_point", "Point-to-point / IDoc-RFC (none)"], ["mixed", "Mixed"]]) },
    { k: "_fiori_header", label: "Fiori & UX Modernisation", type: "section" },
    { k: "fiori_apps_in_scope", label: "Recommended Fiori apps (RC export)", type: "select", opts: O([["lt_500", "< 500 apps"], ["500_1000", "500–1,000 apps"], ["1000_2000", "1,000–2,000 apps"], ["gt_2000", "> 2,000 apps"]]) },
    { k: "fiori_activation_level", label: "Current Fiori activation level", type: "select", opts: O([["not_started", "Not started (0%)"], ["initial", "Initial (< 25% activated)"], ["expanding", "Expanding (25–75%)"], ["established", "Established (> 75%)"]]) },
  ]},
  { title: "Data & Landscape", icon: "data", desc: "Data quality, history and landscape intent.", fields: [
    { k: "data_quality", label: "Data quality", type: "select", opts: O([["good", "Good"], ["mixed", "Mixed"], ["poor", "Poor"]]) },
    { k: "history_retention", label: "History retention", type: "select", opts: O([["full", "Retain full history"], ["partial", "Partial"], ["minimal_ok", "Minimal acceptable"]]) },
    { k: "landscape_intent", label: "Landscape intent", type: "select", opts: O([["keep_single", "Keep single system"], ["consolidate_multiple", "Consolidate multiple"], ["carve_out", "Carve out / phase part"]]) },
  ]},
  { title: "Approach & Program", icon: "approach", desc: "Drivers, timeline, risk and budget.", fields: [
    { k: "primary_driver", label: "Primary driver", type: "select", opts: O([["burning_platform_2027", "Burning platform (2027)"], ["business_transformation", "Business transformation"], ["cost_optimization", "Cost optimization"], ["m_and_a", "M&A / reorg"], ["innovation", "Innovation"]]) },
    { k: "target_golive", label: "Target go-live", type: "select", opts: O([["lt_12mo", "< 12 months"], ["12_18mo", "12–18 months"], ["18_24mo", "18–24 months"], ["gt_24mo", "> 24 months"]]) },
    { k: "risk_disruption_tolerance", label: "Risk / disruption tolerance", type: "select", opts: O([["minimize", "Minimize disruption"], ["balanced", "Balanced"], ["accept_for_value", "Accept for value"]]) },
    { k: "budget_posture", label: "Budget posture", type: "select", opts: O([["constrained", "Constrained"], ["moderate", "Moderate"], ["significant", "Significant"]]) },
    { k: "change_mgmt_maturity", label: "Change-mgmt maturity", type: "select", opts: O([["mature", "Mature OCM"], ["developing", "Developing"], ["none", "None"]]) },
  ]},
  { title: "Infrastructure & Deployment", icon: "infra", desc: "Capability, hyperscaler, sovereignty and target.", fields: [
    { k: "basis_ops_capability", label: "Basis/Ops capability", type: "select", opts: O([["strong_retain", "Strong — retain control"], ["strong_offload", "Strong — offload"], ["limited", "Limited"]]) },
    { k: "existing_hyperscaler", label: "Existing hyperscaler", type: "select", opts: O([["azure", "Azure"], ["aws", "AWS"], ["gcp", "GCP"], ["private_cloud", "Private cloud / own DC"], ["none", "None"]]) },
    { k: "data_sovereignty_strictness", label: "Data sovereignty", type: "select", opts: O([["strict", "Strict"], ["moderate", "Moderate"], ["flexible", "Flexible"]]) },
    { k: "target_deployment_pref", label: "Deployment preference", type: "select", opts: O([["undecided", "Undecided"], ["rise_private", "RISE Private"], ["hyperscaler_self", "Hyperscaler (self-managed)"], ["on_prem", "On-prem"]]) },
  ]},
];

const DEFAULTS = {
  system_id: "PRD-ECC-DE01",
  product_release: "ecc6_ehp", unicode_status: "unicode", db_size_band: "5_10tb", s4_version: "2020", stack_type: "single_stack",
  modules_implemented: ["FI", "CO", "MM", "SD", "PP"],
  process_reengineering_appetite: "preserve", custom_objects_band: "500_2k", overall_customization: "Med", pct_active_estimate: 65, modifications_to_standard: "false",
  interface_count_band: "50_100", interface_complexity: "medium", non_sap_share: "medium", middleware: "sap_pi_po",
  fiori_apps_in_scope: "lt_500", fiori_activation_level: "not_started",
  data_quality: "good", history_retention: "full", landscape_intent: "keep_single",
  primary_driver: "burning_platform_2027", target_golive: "lt_12mo", risk_disruption_tolerance: "minimize", budget_posture: "constrained", change_mgmt_maturity: "developing",
  basis_ops_capability: "strong_offload", existing_hyperscaler: "azure", data_sovereignty_strictness: "moderate", target_deployment_pref: "undecided",
};

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');
.star *{box-sizing:border-box}
.star{font-family:'Plus Jakarta Sans','Segoe UI',system-ui,Arial,sans-serif;background:radial-gradient(900px 480px at 82% -8%, rgba(124,92,255,.10), transparent 60%), ${C.bg};color:${C.ink};min-height:100%}
.star-shell{display:flex;align-items:center;gap:14px;background:rgba(246,245,241,.82);backdrop-filter:blur(10px);padding:0 26px;height:58px;border-bottom:1px solid ${C.border};position:sticky;top:0;z-index:10}
.star-logo{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,${C.blue},${C.blueDark});color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px;box-shadow:0 6px 18px rgba(124,92,255,.35)}
.star-shell h1{font-size:15px;font-weight:800;margin:0;letter-spacing:-.2px;color:${C.ink}}
.star-shell .crumb{font-size:11.5px;color:${C.sub};margin-top:1px}
.eyebrow{font-size:11px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:${C.blue};margin-bottom:7px}
.wiz{max-width:1080px;margin:32px auto;padding:0 24px 56px;display:grid;grid-template-columns:248px 1fr;gap:28px;align-items:start}
@media (max-width:860px){.wiz{grid-template-columns:1fr;gap:16px}}
.rail{position:sticky;top:82px}
.rail-prog{font-size:11px;font-weight:800;color:${C.sub};letter-spacing:1px;text-transform:uppercase;margin-bottom:10px}
.rail-bar{height:6px;border-radius:6px;background:#e7e5df;overflow:hidden;margin-bottom:20px}
.rail-fill{height:100%;background:linear-gradient(90deg,${C.blue},${C.blueDark});border-radius:6px;transition:width .4s cubic-bezier(.2,.7,.2,1)}
.rail-steps{display:flex;flex-direction:column;gap:3px}
@media (max-width:860px){.rail-steps{flex-direction:row;overflow-x:auto;gap:6px;padding-bottom:6px}}
.rail-step{display:flex;align-items:center;gap:11px;padding:10px 11px;border:1px solid transparent;background:transparent;border-radius:12px;cursor:pointer;font-family:inherit;text-align:left;width:100%;transition:all .15s;color:${C.sub}}
.rail-step:hover:not(:disabled){background:#fff}
.rail-step.on{background:#fff;border-color:${C.border};color:${C.ink};box-shadow:0 6px 18px rgba(20,20,40,.07)}
.rail-step:disabled{cursor:default;opacity:.55}
.rs-n{flex:none;width:25px;height:25px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;background:#e7e5df;color:${C.sub};transition:all .15s}
.rail-step.on .rs-n{background:linear-gradient(135deg,${C.blue},${C.blueDark});color:#fff;box-shadow:0 3px 10px rgba(124,92,255,.4)}
.rail-step.done .rs-n{background:${C.green};color:#fff}
.rs-t{font-size:12.5px;font-weight:600;white-space:nowrap}
.card{background:${C.card};border:1px solid ${C.border};border-radius:18px;box-shadow:0 6px 26px rgba(20,20,40,.06)}
.step-card{padding:30px 30px;animation:stepIn .35s cubic-bezier(.2,.7,.2,1) both}
.step-head{display:flex;align-items:flex-start;gap:16px;padding-bottom:20px;margin-bottom:22px;border-bottom:1px solid ${C.border}}
.step-icon{flex:none;width:50px;height:50px;border-radius:14px;background:linear-gradient(135deg,#efeaff,#e6dcff);color:${C.blue};display:flex;align-items:center;justify-content:center;border:1px solid #e6dcff}
.step-title{font-size:24px;font-weight:800;letter-spacing:-.6px;line-height:1.08;color:${C.ink}}
.step-desc{font-size:13px;color:${C.sub};margin-top:5px}
.step-body{display:grid;grid-template-columns:1fr 1fr;gap:18px 22px}
@media (max-width:560px){.step-body{grid-template-columns:1fr}}
.fld{display:flex;flex-direction:column;gap:7px;min-width:0}
.fld.full{grid-column:1/-1}
.fld label{font-size:12px;color:${C.sub};font-weight:600;display:flex;align-items:center;gap:7px}
.swing{font-size:8.5px;font-weight:800;color:${C.blue};background:#f1ecff;border:1px solid #e0d4ff;border-radius:20px;padding:2px 8px;letter-spacing:.4px}
.ctl{height:42px;border:1px solid #d7d4cc;border-radius:11px;padding:0 14px;font-size:13.5px;color:${C.ink};background:#fff;width:100%;outline:none;transition:border-color .15s,box-shadow .15s;font-family:inherit}
select.ctl{appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath d='M2 4l4 4 4-4' stroke='%236b7280' stroke-width='1.6' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 13px center;padding-right:34px;cursor:pointer}
.ctl::placeholder{color:#a7adb6}
.ctl:focus{border-color:${C.blue};box-shadow:0 0 0 3px rgba(124,92,255,.18)}
.ctl.miss{border-color:#e0a35c;background:#fff8ef}
.range-row{display:flex;align-items:center;gap:12px}
input[type=range]{flex:1;accent-color:${C.blue};height:4px}
.range-val{font-size:13px;font-weight:800;color:${C.blue};min-width:42px;text-align:right}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:2px}
.chip{font-size:12px;font-weight:600;padding:7px 13px;border-radius:22px;border:1px solid #d7d4cc;background:#fff;color:${C.sub};cursor:pointer;transition:all .12s;user-select:none}
.chip:hover{border-color:${C.blue};color:${C.blue}}
.chip.on{background:linear-gradient(135deg,${C.blue},${C.blueDark});border-color:transparent;color:#fff;box-shadow:0 4px 12px rgba(124,92,255,.35)}
.chip .x{margin-left:6px;opacity:.85}
.addrow{display:flex;gap:8px;margin-top:11px}
.addrow .ctl{height:38px}
.add-btn{height:38px;padding:0 16px;border-radius:11px;border:1px solid ${C.blue};background:#fff;color:${C.blue};font-weight:700;font-size:12px;cursor:pointer;white-space:nowrap}
.modhint{font-size:11.5px;color:${C.warnLine};margin-top:8px}
.step-actions{display:flex;justify-content:space-between;gap:12px;margin-top:26px;padding-top:20px;border-top:1px solid ${C.border}}
.btn{height:44px;padding:0 24px;border-radius:12px;border:none;font-size:13.5px;font-weight:800;cursor:pointer;font-family:inherit;transition:transform .1s,filter .15s,opacity .15s}
.btn-primary{background:linear-gradient(135deg,${C.blue},${C.blueDark});color:#fff;box-shadow:0 8px 20px rgba(124,92,255,.4)}
.btn-primary:hover:not(:disabled){filter:brightness(1.06)}.btn-primary:active:not(:disabled){transform:translateY(1px)}
.btn-primary:disabled{opacity:.4;cursor:not-allowed;box-shadow:none}
.btn-ghost{background:#fff;color:${C.sub};border:1px solid #d7d4cc}
.btn-ghost:hover:not(:disabled){border-color:${C.blue};color:${C.blue}}
.btn-ghost:disabled{opacity:.4;cursor:not-allowed}
.hint{text-align:right;font-size:11.5px;color:${C.warnLine};margin-top:11px;padding-right:4px}
.result-wrap{max-width:1080px;margin:32px auto;padding:0 24px 56px}
.topline{display:flex;align-items:center;gap:12px;margin-bottom:18px;flex-wrap:wrap}
.back{height:40px;padding:0 16px;border-radius:12px;border:1px solid #d7d4cc;background:#fff;color:${C.sub};font-weight:700;font-size:12.5px;cursor:pointer;font-family:inherit}
.back:hover{border-color:${C.blue};color:${C.blue}}
.rtitle{font-size:17px;font-weight:800;color:${C.ink}}.rtitle span{font-weight:600;color:${C.sub};font-size:13px;margin-left:8px}
.rtitle .mods{font-weight:600;color:${C.sub};font-size:11.5px;display:block;margin-top:3px;margin-left:0}
.rec-row{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:18px}
.rec-tile{flex:1;min-width:250px;padding:22px 24px;border-radius:18px;color:#fff;animation:pop .4s both;box-shadow:0 12px 30px rgba(20,20,40,.16);position:relative;overflow:hidden}
.rec-tile:before{content:"";position:absolute;inset:0;background:radial-gradient(400px 200px at 90% -20%, rgba(255,255,255,.25), transparent 60%);pointer-events:none}
.rec-tile .k{font-size:10.5px;text-transform:uppercase;letter-spacing:1px;opacity:.92;font-weight:800}
.rec-tile .v{font-size:27px;font-weight:800;margin-top:5px;letter-spacing:-.4px}
.rec-tile .s{font-size:12.5px;opacity:.94;margin-top:3px}
.badge{display:inline-block;font-size:10px;font-weight:800;padding:3px 11px;border-radius:20px;background:rgba(255,255,255,.25);margin-top:12px;letter-spacing:.5px}
.res-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start}
@media (max-width:820px){.res-grid{grid-template-columns:1fr}}
.card-h{padding:16px 20px;border-bottom:1px solid ${C.border};font-weight:700;font-size:13px;display:flex;align-items:center;gap:9px;color:${C.ink}}
.card-h .dot{width:7px;height:7px;border-radius:50%;background:${C.blue}}
.card-b{padding:18px 20px}
.barrow{margin-bottom:12px}
.barrow .top{display:flex;justify-content:space-between;font-size:12px;margin-bottom:5px}
.barrow .top b{font-weight:700}.barrow .top span{color:${C.sub};font-variant-numeric:tabular-nums}
.track{height:10px;background:#eef0f3;border-radius:6px;overflow:hidden}
.fill{height:100%;border-radius:6px;transition:width .7s cubic-bezier(.2,.7,.2,1)}
.gated{font-size:11px;color:${C.grey};font-style:italic}
.warn{background:#fff7ed;border:1px solid #fcd9b0;border-left:3px solid ${C.warnLine};border-radius:12px;padding:14px 16px;font-size:12px;margin-bottom:14px;color:#7c3a12}
.warn b{color:${C.warnLine}}.warn ul{margin:6px 0 0;padding-left:18px}.warn li{margin:2px 0}
.info{background:#eefaf2;border:1px solid #bfe8cd;border-left:3px solid ${C.green};border-radius:12px;padding:14px 16px;font-size:12px;margin-bottom:14px;color:#14532d}
.vpath{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:4px 0 10px}
.vbox{font-size:13px;font-weight:800;padding:11px 17px;border-radius:12px;border:1.5px solid #d7d4cc;color:${C.sub};background:#fff}
.vbox.tgt{border-color:${C.teal};color:${C.teal};background:#e6f7f5}
.varrow{font-size:20px;font-weight:800;color:${C.teal}}
.vnote{font-size:12px;color:${C.sub}}
.steps{display:flex;flex-wrap:wrap;gap:7px;align-items:center}
.step{font-size:11px;background:#f1ecff;color:${C.blueDark};border:1px solid #e0d4ff;border-radius:20px;padding:5px 12px;font-weight:600}
.sep{color:${C.sub};font-size:11px}
.trace{font-size:11.5px;border-top:1px solid ${C.border};padding:9px 0;display:flex;justify-content:space-between;gap:10px}
.trace:first-child{border-top:none}
.trace .f{color:${C.ink};font-weight:600}.trace .a{color:${C.sub};font-size:10.5px}
.trace .c{color:${C.blue};font-weight:700;white-space:nowrap;font-variant-numeric:tabular-nums}
.note{font-size:10.5px;color:${C.sub};text-align:center;margin-top:18px;line-height:1.5}
.rpt-btn{background:linear-gradient(135deg,#f1ecff,#e6dcff);border-color:#e0d4ff;color:${C.blueDark};font-weight:800}
.narr p{font-size:13.5px;line-height:1.7;color:#3a3f4a;margin:0 0 12px}.narr p:last-child{margin:0}
.stack-row{display:flex;align-items:center;gap:12px;margin-bottom:11px;padding:6px 8px;border-radius:10px}
.stack-row.win{background:${C.tint}}
.stack-label{width:96px;flex:none;font-size:12px;font-weight:800}
.stack-track{flex:1;height:26px;border-radius:9px;background:#eef0f3;display:flex;overflow:hidden}
.stack-seg{height:100%;transition:width .6s cubic-bezier(.2,.7,.2,1)}
.stack-total{width:42px;text-align:right;font-size:13px;font-weight:800;font-variant-numeric:tabular-nums}
.legend{display:flex;flex-wrap:wrap;gap:11px;margin-top:14px;padding-top:14px;border-top:1px solid ${C.border}}
.legend span{font-size:11px;color:${C.sub};display:inline-flex;align-items:center;gap:6px}
.legend i{width:11px;height:11px;border-radius:3px;display:inline-block}
.drv-row{display:flex;align-items:center;gap:12px;margin-bottom:11px}
.drv-label{width:170px;flex:none;font-size:11.5px;font-weight:700;line-height:1.3;color:${C.ink}}
.drv-track{flex:1;height:12px;background:#eef0f3;border-radius:6px;overflow:hidden}
.drv-fill{height:100%;border-radius:6px;transition:width .6s cubic-bezier(.2,.7,.2,1)}
.drv-val{width:38px;text-align:right;font-size:12px;font-weight:800;color:${C.ink};font-variant-numeric:tabular-nums}
.tlbar{display:flex;gap:5px;margin-bottom:9px}
.tlseg{flex:1;height:32px;border-radius:9px;color:#fff;font-size:12px;font-weight:800;display:flex;align-items:center;justify-content:center}
.tllabels{display:flex;gap:5px}
.tllbl{flex:1;text-align:center;font-size:10.5px;color:${C.sub};line-height:1.3}
.home{max-width:1080px;margin:32px auto;padding:0 24px 56px}
.home-head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;margin-bottom:24px}
.home-title{font-size:30px;font-weight:800;letter-spacing:-.8px;color:${C.ink};line-height:1.05}
.home-sub{font-size:13px;color:${C.sub};margin-top:6px;max-width:540px}
.empty{background:${C.card};border:1px dashed #d7d4cc;border-radius:16px;padding:46px 24px;text-align:center;color:${C.sub};font-size:13.5px}
.proj-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}
.proj-card{background:${C.card};border:1px solid ${C.border};border-radius:16px;padding:18px 20px;cursor:pointer;transition:transform .12s,box-shadow .15s,border-color .15s;box-shadow:0 4px 18px rgba(20,20,40,.05)}
.proj-card:hover{transform:translateY(-2px);box-shadow:0 12px 30px rgba(20,20,40,.1);border-color:#d8cffb}
.proj-card-top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
.proj-name{font-size:16px;font-weight:800;color:${C.ink};letter-spacing:-.2px}
.proj-actions{display:flex;gap:4px}
.icon-btn{width:30px;height:30px;border-radius:9px;border:1px solid ${C.border};background:#fff;color:${C.sub};cursor:pointer;font-size:13px;display:flex;align-items:center;justify-content:center;transition:all .12s}
.icon-btn:hover{border-color:${C.blue};color:${C.blue}}
.icon-btn.danger:hover{border-color:#e11d48;color:#e11d48}
.proj-meta{font-size:12.5px;color:${C.ink};font-weight:600;margin-top:10px}
.proj-owners{font-size:11.5px;color:${C.sub};margin-top:3px}
.proj-foot{display:flex;justify-content:space-between;align-items:center;margin-top:14px;padding-top:12px;border-top:1px solid ${C.border}}
.pill-count{font-size:11px;font-weight:800;color:${C.blue};background:#f1ecff;border:1px solid #e0d4ff;border-radius:20px;padding:3px 10px}
.proj-date{font-size:11px;color:${C.grey}}
.proj-detail-meta{display:flex;flex-wrap:wrap;gap:12px 26px;margin:14px 0 26px}
.proj-detail-meta span{font-size:13px;color:${C.ink};font-weight:700}
.proj-detail-meta b{color:${C.sub};font-weight:600;font-size:10.5px;text-transform:uppercase;letter-spacing:.6px;display:block;margin-bottom:2px}
.sec-head{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:14px}
.sec-title{font-size:18px;font-weight:800;color:${C.ink};letter-spacing:-.3px}
.asmt-table{overflow:hidden;padding:0}
.asmt-row{display:grid;grid-template-columns:1.4fr .6fr 1.2fr 1.4fr .7fr .9fr 1fr;align-items:center;gap:10px;padding:13px 18px;border-bottom:1px solid ${C.border};font-size:12.5px}
.asmt-row:last-child{border-bottom:none}
.asmt-h{background:#faf9f6;font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;color:${C.sub}}
.asmt-sys{font-weight:800;color:${C.ink}}
.tag{font-size:11px;font-weight:800;padding:3px 10px;border-radius:20px;border:1px solid;display:inline-block}
.asmt-dep{color:${C.sub}}
.asmt-date{color:${C.grey};font-size:11.5px}
.asmt-acts{display:flex;gap:5px;justify-content:flex-end}
.modal-overlay{position:fixed;inset:0;background:rgba(20,18,30,.42);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;z-index:50;padding:20px;animation:pop .2s both}
.modal{background:${C.card};border:1px solid ${C.border};border-radius:20px;box-shadow:0 30px 80px rgba(20,20,40,.3);width:100%;max-width:460px;overflow:hidden}
.modal-title{font-size:18px;font-weight:800;color:${C.ink};padding:20px 22px 4px}
.modal-body{padding:12px 22px;display:flex;flex-direction:column;gap:13px;max-height:62vh;overflow:auto}
.modal-actions{display:flex;justify-content:flex-end;gap:10px;padding:16px 22px;border-top:1px solid ${C.border}}
@media (max-width:680px){.asmt-row{grid-template-columns:1.3fr 1.1fr 1.3fr .7fr}.asmt-row>div:nth-child(2),.asmt-row>div:nth-child(5),.asmt-row>div:nth-child(6){display:none}}
.advis{background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;font-size:12.5px;font-weight:600;border-radius:12px;padding:11px 14px;margin-bottom:10px;line-height:1.5}
.choose-wrap,.parse-wrap{max-width:920px;margin:24px auto;padding:0 24px 48px}
.choose-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:22px}
.choose-card{background:${C.card};border:1px solid ${C.border};border-radius:18px;padding:24px 22px;cursor:pointer;transition:transform .12s,box-shadow .15s,border-color .15s;display:flex;flex-direction:column;gap:8px;box-shadow:0 4px 18px rgba(20,20,40,.05)}
.choose-card:hover{transform:translateY(-2px);box-shadow:0 14px 32px rgba(20,20,40,.1);border-color:#d8cffb}
.choose-card.accent{border-color:#d8cffb;background:linear-gradient(180deg,#faf8ff,#fff)}
.cc-ic{width:44px;height:44px;border-radius:13px;background:#f1ecff;color:${C.blue};display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:800}
.cc-h{font-size:16px;font-weight:800;color:${C.ink};margin-top:6px}
.cc-d{font-size:12.5px;color:${C.sub};line-height:1.55;flex:1}
.cc-go{font-size:12.5px;font-weight:800;color:${C.blue};margin-top:6px}
.parse-card{display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center;padding:48px 28px}
.parse-title{font-size:18px;font-weight:800;color:${C.ink}}
.parse-sub{font-size:12px;color:${C.sub};max-width:540px;line-height:1.6}
.spinner{width:38px;height:38px;border-radius:50%;border:3px solid #ece9f6;border-top-color:${C.blue};animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.impbar{background:linear-gradient(180deg,#f4fbf6,#fff);border:1px solid #bbe7c9;border-radius:14px;padding:14px 16px;margin-bottom:16px}
.impbar-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.impbar-tag{font-size:12.5px;font-weight:800;color:#15803d}
.impbar-src{font-size:11.5px;color:${C.sub};font-weight:600}
.impbar-toggle{margin-left:auto;font-size:11.5px;font-weight:700;color:${C.blue};background:#fff;border:1px solid ${C.border};border-radius:9px;padding:5px 11px;cursor:pointer;font-family:inherit}
.impbar-note{font-size:12px;color:${C.ink};margin-top:7px;line-height:1.5}
.impbar-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px 22px;margin-top:12px;padding-top:12px;border-top:1px solid #d6efde}
.impbar-h{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:${C.sub};margin-bottom:6px}
.impbar-grid ul{margin:0;padding-left:16px}
.impbar-grid li{font-size:12px;color:${C.ink};line-height:1.6}
@media (max-width:640px){.choose-grid,.impbar-grid{grid-template-columns:1fr}}
.sec-divider{display:flex;align-items:center;gap:10px;margin:14px 0 2px;color:${C.blue};font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}.sec-divider::before,.sec-divider::after{content:"";flex:1;height:1px;background:#e9e4f8}
.fld.from-report .ctl,.fld.from-report .range-row,.fld.from-report .chips{border-color:#9fd9b4;box-shadow:0 0 0 2px rgba(34,197,94,.08);border-radius:8px;padding:6px}
.fld.needs-confirm .ctl,.fld.needs-confirm .range-row,.fld.needs-confirm .chips{border-color:#f3c879;box-shadow:0 0 0 2px rgba(245,158,11,.08);border-radius:8px;padding:6px}
.chip.imported{box-shadow:0 0 0 2px #9fd9b4;position:relative}
.chip.imported::after{content:"✓";position:absolute;top:-5px;right:-5px;font-size:8px;background:#22c55e;color:#fff;border-radius:50%;width:13px;height:13px;display:flex;align-items:center;justify-content:center;font-weight:900}
.src-badge{display:inline-block;margin-left:8px;font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;color:#15803d;background:#e7f7ed;border:1px solid #bbe7c9;border-radius:20px;padding:2px 8px;vertical-align:middle}
.confirm-badge{display:inline-block;margin-left:8px;font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;color:#9a6700;background:#fff7e6;border:1px solid #f3d28a;border-radius:20px;padding:2px 8px;vertical-align:middle}
.exact-wrap{display:flex;align-items:center;justify-content:space-between;gap:10px;background:linear-gradient(0deg,#f6f3ff,#fff);border:1px solid #d8ccff;border-radius:10px;padding:10px 12px;min-height:42px}
.exact-val{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.exact-ic{font-size:16px;line-height:1}
.exact-n{font-size:22px;font-weight:800;color:${C.blue};letter-spacing:-.01em;font-variant-numeric:tabular-nums}
.exact-u{font-size:12px;font-weight:600;color:#4a4762;text-transform:lowercase}
.exact-band{font-size:10.5px;font-weight:700;color:#7b7596;background:#ece6ff;border:1px solid #d8ccff;border-radius:20px;padding:2px 8px;text-transform:lowercase;letter-spacing:.3px;margin-left:4px}
.exact-edit{appearance:none;background:transparent;border:1px solid #d8ccff;color:${C.blue};font-size:10.5px;font-weight:700;padding:5px 10px;border-radius:8px;cursor:pointer;letter-spacing:.3px}
.exact-edit:hover{background:#ece6ff}
.exact-restore{display:inline-block;margin-top:6px;appearance:none;background:transparent;border:none;color:${C.blue};font-size:11px;font-weight:600;cursor:pointer;padding:0}
.exact-restore:hover{text-decoration:underline}
.qf-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}
.qf-tile{position:relative;padding:16px 16px 14px;border-radius:12px;border:1px solid;display:flex;flex-direction:column;gap:2px}
.qf-tile.qf-ok{background:linear-gradient(0deg,#e7f7ed,#ffffff);border-color:#bbe7c9}
.qf-tile.qf-no{background:linear-gradient(0deg,#fff1ec,#ffffff);border-color:#f3c3aa}
.qf-tile .qf-ic{font-size:20px;line-height:1;margin-bottom:4px}
.qf-tile .qf-num{font-size:30px;font-weight:800;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.qf-tile.qf-ok .qf-num{color:#15803d}
.qf-tile.qf-no .qf-num{color:#c0392b}
.qf-tile .qf-lbl{font-size:12px;font-weight:700;color:#2c2740;letter-spacing:.01em;text-transform:uppercase}
.qf-tile .qf-sub{font-size:11px;color:#6b6580;margin-top:4px}
.qf-bar{display:flex;height:10px;border-radius:6px;overflow:hidden;background:#f0ede8;border:1px solid #ebe5dc}
.qf-bar-fill{height:100%}
.qf-bar-fill.ok{background:#22a06b}
.qf-bar-fill.no{background:#e26a4a}
.impbar-legend{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;color:${C.sub};margin-top:9px}
.lg-pill{font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;border-radius:20px;padding:2px 8px}
.lg-pill.green{color:#15803d;background:#e7f7ed;border:1px solid #bbe7c9}
.lg-pill.amber{color:#9a6700;background:#fff7e6;border:1px solid #f3d28a}
.src-grid{grid-template-columns:1fr 1fr}
.src-tile{position:relative}
.src-tile.loaded{border-color:#9fd9b4;background:linear-gradient(180deg,#f4fbf6,#fff)}
.src-tile-top{display:flex;align-items:center;justify-content:space-between}
.src-code{font-size:11px;font-weight:800;letter-spacing:.5px;color:${C.blue};background:#f1ecff;border:1px solid #e0d4ff;border-radius:8px;padding:3px 9px}
.src-code.big{font-size:13px;padding:4px 11px}
.src-tick{color:#15803d;font-weight:800}
.loaded-bar{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-top:16px;background:${C.card};border:1px solid ${C.border};border-radius:14px;padding:12px 14px}
.loaded-chips{display:flex;gap:8px;flex-wrap:wrap}
.src-chip{font-size:11.5px;font-weight:700;color:${C.ink};background:#f4f1fe;border:1px solid #e0d4ff;border-radius:20px;padding:5px 10px;display:inline-flex;align-items:center;gap:7px}
.src-x{cursor:pointer;color:${C.sub};font-weight:800}
.src-x:hover{color:#e11d48}
.choose-or{text-align:center;color:${C.grey};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin:18px 0}
.src-section{display:flex;align-items:center;gap:10px;margin:24px 0 12px}
.src-section-h{font-size:16px;font-weight:800;color:${C.ink}}
.src-section-f{font-size:11.5px;color:${C.sub};margin-left:auto}
.rk-facts{display:flex;flex-wrap:wrap;gap:12px 26px}
.rk-facts span{font-size:13px;color:${C.ink};font-weight:700}
.rk-facts b{display:block;color:${C.sub};font-weight:600;font-size:10.5px;text-transform:uppercase;letter-spacing:.6px;margin-bottom:2px}
.rk-bar-row{display:grid;grid-template-columns:1.5fr 2.2fr auto;align-items:center;gap:10px;margin-bottom:9px;font-size:12px}
.rk-bar-label{color:${C.ink};font-weight:600}
.rk-bar-track{background:#eee9f7;border-radius:8px;height:12px;overflow:hidden}
.rk-bar-fill{height:100%;border-radius:8px;background:linear-gradient(90deg,${C.blue},${C.blueDark})}
.rk-bar-fill.alt{background:linear-gradient(90deg,#2bb673,#1f9d63)}
.rk-bar-fill.vio{background:linear-gradient(90deg,#a06bff,#7c5cff)}
.rk-bar-val{font-weight:800;color:${C.ink};font-size:11.5px;min-width:46px;text-align:right}
.rk-note{font-size:11.5px;color:${C.sub};margin-top:8px;line-height:1.5}
.rk-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.rk-stat{background:#faf9f6;border:1px solid ${C.border};border-radius:12px;padding:12px 14px}
.rk-stat .v{font-size:17px;font-weight:800;color:${C.ink}}
.rk-stat .k{font-size:10px;color:${C.sub};text-transform:uppercase;letter-spacing:.5px;font-weight:700;margin-top:2px}
.addon-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:9px 0;border-bottom:1px solid ${C.border};font-size:12.5px;color:${C.ink}}
.addon-row:last-of-type{border-bottom:none}
.addon-pill{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;border-radius:20px;padding:3px 10px;white-space:nowrap}
.addon-pill.red{color:#b91c1c;background:#fef2f2;border:1px solid #fecaca}
.addon-pill.green{color:#15803d;background:#e7f7ed;border:1px solid #bbe7c9}
.addon-pill.amber{color:#9a6700;background:#fff7e6;border:1px solid #f3d28a}
@media (max-width:680px){.rk-stats{grid-template-columns:1fr 1fr}.src-grid{grid-template-columns:1fr}}
.user-area{margin-left:auto;display:flex;align-items:center;gap:12px}
.user-chip{display:flex;align-items:center;gap:8px;background:#fff;border:1px solid ${C.border};border-radius:22px;padding:4px 12px 4px 4px}
.user-av{width:26px;height:26px;border-radius:50%;background:linear-gradient(135deg,${C.blue},${C.blueDark});color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800}
.user-name{font-size:12.5px;font-weight:700;color:${C.ink}}
.user-role{font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:${C.blue};background:#f1ecff;border:1px solid #e0d4ff;border-radius:10px;padding:2px 7px}
.signout{font-size:12px;font-weight:700;color:${C.sub};background:#fff;border:1px solid ${C.border};border-radius:10px;padding:7px 13px;cursor:pointer;font-family:inherit;transition:all .12s}
.signout:hover{border-color:${C.blue};color:${C.blue}}
@media (max-width:560px){.user-name,.user-role{display:none}}
@keyframes stepIn{from{opacity:0;transform:translateX(14px)}to{opacity:1;transform:none}}
@keyframes pop{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:none}}
`;

function I({ name }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={ICONS[name]} />
    </svg>
  );
}

function Bars({ scores, meta }) {
  const vals = Object.values(scores).filter((v) => v > DISQ / 2);
  const max = Math.max(...vals, 1);
  return (
    <div>
      {Object.keys(scores).map((k) => {
        const m = meta[k]; if (!m) return null;
        const v = scores[k]; const gated = v <= DISQ / 2;
        const pct = gated ? 0 : Math.max((v / max) * 100, v > 0 ? 4 : 0);
        return (
          <div className="barrow" key={k}>
            <div className="top"><b style={{ color: m.color }}>{m.label}</b>
              {gated ? <span className="gated">gated</span> : <span>{v.toFixed(1)}</span>}</div>
            <div className="track"><div className="fill" style={{ width: pct + "%", background: m.color }} /></div>
          </div>
        );
      })}
    </div>
  );
}

const FACTOR_PALETTE = ["#7c5cff", "#1f9d55", "#b45309", "#2563eb", "#e11d48", "#0d9488", "#c026d3", "#0891b2", "#16a34a", "#d97706", "#7c3aed", "#0e7490"];

function buildNarrative(result) {
  const am = APPROACH_META[result.approach];
  const dm = DEPLOY_META[result.deployment];
  if (result.upgrade) {
    return [
      "STAR recommends a " + am.label + " for " + result.system_id + ", deployed on " + dm.label + ".",
      result.behind
        ? "The system already runs SAP S/4HANA " + result.currentVersion + ". Because that is below the latest release (" + result.targetVersion + "), the transformation is a standard SUM release upgrade — not a greenfield or brownfield conversion. This is materially lower-risk and lower-cost than re-platforming."
        : "The system already runs the latest release (SAP S/4HANA " + result.targetVersion + "). No version upgrade is required; the focus shifts to adopting the latest Feature Pack Stack and new innovations.",
      "Deployment leans to " + dm.label + " based on the operating-model capability, hyperscaler footprint and data-sovereignty inputs.",
    ];
  }
  const aTrace = result.trace.filter((t) => Object.keys(t.contribution).some((k) => A.includes(k)));
  const drivers = aTrace.map((t) => ({ factor: t.factor, answer: t.answer, val: t.contribution[result.approach] || 0 }))
    .filter((d) => d.val > 0).sort((a, b) => b.val - a.val);
  const topTxt = drivers.slice(0, 3).map((d) => d.factor.toLowerCase() + " (" + String(d.answer) + ")").join(", ");
  const others = A.filter((a) => a !== result.approach).map((a) => APPROACH_META[a].label + " " + result.approachScores[a].toFixed(1)).join(" and ");
  const paras = [
    "STAR recommends a " + am.label + " approach (" + am.sub + ") for " + result.system_id + ", deployed on " + dm.label + ", with " + result.approachConf + " confidence (score " + result.approachScores[result.approach].toFixed(1) + ").",
    "The recommendation is driven primarily by " + topTxt + ". Together these outweigh the alternative paths (" + others + ").",
    "On deployment, " + dm.label + " scores highest given the basis / operating-model capability, the existing hyperscaler footprint and the data-sovereignty inputs.",
  ];
  if (result.soh && result.dbNote)
    paras.push("Because the system is already on SAP HANA (Suite on HANA), the conversion is application-only — SUM runs without DMO, removing the database-migration step and reducing effort, downtime and risk.");
  if (result.blockers.length)
    paras.push("Mandatory technical prerequisites were detected (" + result.blockers.map((b) => b.gate).join(", ") + "). These must be addressed first: " + result.prereq.join("; ") + ".");
  return paras;
}

const STORE_KEY = "star_projects_v1";
const uid = () => Math.random().toString(36).slice(2, 9);
function loadLocal() { try { if (typeof window === "undefined") return []; const r = window.localStorage.getItem(STORE_KEY); return r ? JSON.parse(r) : []; } catch (e) { return []; } }
function saveLocal(ps) { try { if (typeof window !== "undefined") window.localStorage.setItem(STORE_KEY, JSON.stringify(ps)); } catch (e) {} }
// When a backend is configured, the portfolio is the per-user document served by
// GET/PUT /api/star/portfolio; otherwise (standalone/demo) it lives in localStorage.
// Both paths fall back to localStorage if the backend is unreachable.
async function loadProjects() {
  if (apiConfigured()) {
    try { const pf = await getPortfolio(); if (pf) return pf.projects || []; } catch (e) {}
  }
  return loadLocal();
}
async function saveProjects(ps) {
  if (apiConfigured()) {
    try { if (await putPortfolio({ projects: ps })) return; } catch (e) {}
  }
  saveLocal(ps);
}

function StarApp({ user, onLogout }) {
  const [projects, setProjects] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState("projects");
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [activeAssessmentId, setActiveAssessmentId] = useState(null);
  const [projModal, setProjModal] = useState(null);

  const [form, setForm] = useState(DEFAULTS);
  const [step, setStep] = useState(0);
  const [maxStep, setMaxStep] = useState(0);
  const [showResult, setShowResult] = useState(false);
  const [showReport, setShowReport] = useState(false);
  const [result, setResult] = useState(null);
  const [customMod, setCustomMod] = useState("");
  const [chooser, setChooser] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [importSummary, setImportSummary] = useState(null);
  const [impOpen, setImpOpen] = useState(true);
  const [provenance, setProvenance] = useState({});
  const [extracted, setExtracted] = useState({});   // exact numbers from imports, keyed by EXTRACT_MAP keys
  const [editingExact, setEditingExact] = useState({});  // form-field-key → true if user overrode the extracted value
  const [sources, setSources] = useState([]);
  const [sourceFiles, setSourceFiles] = useState({});
  const [parsingLabel, setParsingLabel] = useState("");
  const [showInsights, setShowInsights] = useState(false);
  const [insightsBundle, setInsightsBundle] = useState(null);
  const [importError, setImportError] = useState(null);
  // Real parsed backend data per source kind: { readiness: {form,summary,insights}, ... }
  const [sourceData, setSourceData] = useState({});
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => { (async () => { setProjects(await loadProjects()); setLoaded(true); })(); }, []);
  const persist = (next) => { setProjects(next); saveProjects(next); };
  const activeProject = projects.find((p) => p.id === activeProjectId) || null;

  const openNewProject = () => setProjModal({ mode: "new", data: { name: "", system_owner_customer: "", entity_name: "", brand_name: "", sparc_owner: "", gtp_owner: "" } });
  const openEditProject = (p) => setProjModal({ mode: "edit", data: { ...p } });
  const saveProject = () => {
    const d = projModal.data; if (!d.name.trim()) return;
    if (projModal.mode === "new") {
      const proj = { id: uid(), name: d.name, system_owner_customer: d.system_owner_customer, entity_name: d.entity_name, brand_name: d.brand_name, sparc_owner: d.sparc_owner, gtp_owner: d.gtp_owner, createdAt: Date.now(), assessments: [] };
      persist([proj, ...projects]); setProjModal(null); setActiveProjectId(proj.id); setView("project");
    } else { persist(projects.map((p) => (p.id === d.id ? { ...p, ...d } : p))); setProjModal(null); }
  };
  const deleteProject = (id) => { if (typeof confirm !== "undefined" && !confirm("Delete this project and all its assessments?")) return; persist(projects.filter((p) => p.id !== id)); if (activeProjectId === id) { setActiveProjectId(null); setView("projects"); } };

  const _clearSources = () => { setSources([]); setSourceFiles({}); setSourceData({}); setImportError(null); setExtracted({}); setEditingExact({}); };
  const newAssessment = () => { setForm(DEFAULTS); setStep(0); setMaxStep(0); setResult(null); setShowResult(false); setShowReport(false); setActiveAssessmentId(null); setImportSummary(null); setProvenance({}); _clearSources(); setInsightsBundle(null); setShowInsights(false); setChooser(true); setParsing(false); setView("assessment"); };
  const chooseManual = () => { setForm(DEFAULTS); setImportSummary(null); setProvenance({}); _clearSources(); setChooser(false); setStep(0); setMaxStep(0); };

  const recompute = (kinds, files, data) => {
    const fused = fuseSources(kinds, data);
    setForm({ ...DEFAULTS, ...fused.form });
    setProvenance(fused.prov);
    setExtracted(fused.exact);
    setEditingExact({});
    const facts = [];
    kinds.forEach((k) => { const d = data[k]; if (d && d.summary) d.summary.facts.forEach((x) => facts.push([SOURCES[k].code, x])); });
    const advisories = kinds.map((k) => { const d = data[k]; return d && d.summary && d.summary.advisory; }).filter(Boolean);
    setImportSummary({ sources: kinds.map((k) => ({ code: SOURCES[k].code, label: SOURCES[k].label, file: files[k] })), facts, advisories });
  };

  const onSourceFile = (kind, e) => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    setParsingLabel(SOURCES[kind].label); setParsing(true); setImportError(null);
    const files = { ...sourceFiles, [kind]: f.name };
    const kinds = sources.includes(kind) ? sources : [...sources, kind];
    if (apiConfigured()) {
      importSource(kind, f).then((parsed) => {
        const data = { ...sourceData, [kind]: parsed };
        setSources(kinds); setSourceFiles(files); setSourceData(data);
        recompute(kinds, files, data); setParsing(false); setImpOpen(true);
      }).catch((err) => {
        setParsing(false);
        setImportError(`${SOURCES[kind].label}: ${err.message}`);
      });
    } else {
      // No backend configured — show the file name but no parsed data.
      const data = { ...sourceData };
      setSources(kinds); setSourceFiles(files); setSourceData(data);
      recompute(kinds, files, data); setParsing(false); setImpOpen(true);
    }
  };

  const removeSource = (kind) => {
    const kinds = sources.filter((k) => k !== kind);
    const files = { ...sourceFiles }; delete files[kind];
    const data = { ...sourceData }; delete data[kind];
    setSources(kinds); setSourceFiles(files); setSourceData(data);
    if (kinds.length) recompute(kinds, files, data);
    else { setForm(DEFAULTS); setProvenance({}); setImportSummary(null); setExtracted({}); setEditingExact({}); }
  };
  const proceedReview = () => { setChooser(false); setStep(0); setMaxStep(SECTIONS.length - 1); setImpOpen(true); };
  const editAssessment = (a) => { setForm(a.form); setStep(0); setMaxStep(SECTIONS.length - 1); setResult(null); setShowResult(false); setShowReport(false); setActiveAssessmentId(a.id); setChooser(false); setImportSummary(null); setProvenance({}); _clearSources(); setExtracted(a.extracted || {}); setEditingExact({}); setInsightsBundle(a.insightsBundle || null); setShowInsights(false); setView("assessment"); };
  const viewAssessment = (a) => { setForm(a.form); setResult(a.result); setActiveAssessmentId(a.id); setShowResult(true); setShowReport(false); setChooser(false); setImportSummary(null); setProvenance({}); _clearSources(); setExtracted(a.extracted || {}); setEditingExact({}); setInsightsBundle(a.insightsBundle || null); setShowInsights(false); setView("assessment"); };
  const deleteAssessment = (aid) => { if (typeof confirm !== "undefined" && !confirm("Delete this assessment?")) return; persist(projects.map((p) => (p.id === activeProjectId ? { ...p, assessments: p.assessments.filter((a) => a.id !== aid) } : p))); };

  const toggleMod = (m) => setForm((f) => ({ ...f, modules_implemented: f.modules_implemented.includes(m) ? f.modules_implemented.filter((x) => x !== m) : [...f.modules_implemented, m] }));
  const addCustomMod = () => { const v = customMod.trim(); if (v && !form.modules_implemented.includes(v)) set("modules_implemented", [...form.modules_implemented, v]); setCustomMod(""); };

  const visibleFields = (sec) => sec.fields.filter((f) => !f.showIf || f.showIf(form));
  const fieldFilled = (f) => { if (f.type === "section") return true; if (f.type === "modules") return form.modules_implemented.length > 0; if (f.type === "text") return String(form[f.k] ?? "").trim() !== ""; if (f.type === "range") return true; return form[f.k] != null && form[f.k] !== ""; };
  const sectionValid = (sec) => visibleFields(sec).every(fieldFilled);

  const cur = SECTIONS[step];
  const valid = sectionValid(cur);
  const isLast = step === SECTIONS.length - 1;

  const generate = () => {
    const proj = activeProject || {};
    const intake = { ...form, pct_active_estimate: Number(form.pct_active_estimate), customization_level_per_module: { OVERALL: form.overall_customization }, dual_stack: form.stack_type === "dual_stack", entity_name: proj.entity_name, brand_name: proj.brand_name, system_owner_customer: proj.system_owner_customer, sparc_owner: proj.sparc_owner, gtp_owner: proj.gtp_owner };
    let res = recommend(intake);
    const adv = sources.map((k) => { const d = sourceData[k]; return d && d.summary && d.summary.advisory; }).filter(Boolean);
    if (adv.length) res = { ...res, advisories: [...(res.advisories || []), ...adv] };
    const prior = ((activeProject && activeProject.assessments) || []).find((a) => a.id === activeAssessmentId);
    const bundle = sources.length ? { sources: sources.map((k) => {
      const d = sourceData[k] || {};
      return { kind: k, code: SOURCES[k].code, label: SOURCES[k].label, file: sourceFiles[k], facts: (d.summary && d.summary.facts) || [], insights: d.insights || null };
    }) } : (prior && prior.insightsBundle ? prior.insightsBundle : null);
    const now = Date.now(); let aid = activeAssessmentId;
    const next = projects.map((p) => {
      if (p.id !== activeProjectId) return p;
      if (aid) return { ...p, assessments: p.assessments.map((a) => (a.id === aid ? { ...a, form, result: res, insightsBundle: bundle, extracted, updatedAt: now } : a)) };
      aid = uid(); return { ...p, assessments: [...p.assessments, { id: aid, form, result: res, insightsBundle: bundle, extracted, createdAt: now, updatedAt: now }] };
    });
    persist(next); setActiveAssessmentId(aid); setResult(res); setInsightsBundle(bundle); setShowInsights(false); setShowResult(true);
  };
  const goNext = () => { if (!valid) return; if (isLast) generate(); else { const n = step + 1; setStep(n); setMaxStep((m) => Math.max(m, n)); } };
  const goBack = () => { if (step > 0) setStep(step - 1); else setView("project"); };
  const jumpTo = (i) => { if (i <= maxStep) setStep(i); };

  const renderField = (f) => {
    if (f.type === "section") return (
      <div className="fld full sec-divider" key={f.k}><span>{f.label}</span></div>
    );
    const filled = fieldFilled(f);
    return (
      <div className={"fld" + (f.type === "range" || f.type === "modules" ? " full" : "") + ((provenance[f.k] && !provenance[f.k].assumed) ? " from-report" : (Object.keys(provenance).length > 0 && TECH_KEYS.includes(f.k) && (!provenance[f.k] || provenance[f.k].assumed)) ? " needs-confirm" : "")} key={f.k}>
        <label>{f.label}{provenance[f.k] && !provenance[f.k].assumed && <span className="src-badge">✓ {provenance[f.k].code}</span>}{Object.keys(provenance).length > 0 && TECH_KEYS.includes(f.k) && (!provenance[f.k] || provenance[f.k].assumed) && <span className="confirm-badge">confirm</span>}{SWING.has(f.k) && <span className="swing">KEY DRIVER</span>}</label>
        {f.type === "text" && <input className={"ctl" + (filled ? "" : " miss")} placeholder={f.ph || ""} value={form[f.k]} onChange={(e) => set(f.k, e.target.value)} />}
        {f.type === "select" && (() => {
          const ext = EXTRACT_MAP[f.k];
          const exactVal = ext ? extracted[ext.key] : null;
          if (exactVal != null && !editingExact[f.k]) {
            const bandLabel = (f.opts.find((o) => o.v === form[f.k]) || {}).l || "";
            return (
              <div className="exact-wrap">
                <div className="exact-val">
                  <span className="exact-ic">{ext.icon}</span>
                  <span className="exact-n">{Number(exactVal).toLocaleString()}</span>
                  <span className="exact-u">{ext.unit}</span>
                  {bandLabel && <span className="exact-band">band: {bandLabel}</span>}
                </div>
                <button type="button" className="exact-edit" onClick={() => setEditingExact((e) => ({ ...e, [f.k]: true }))}>✏ override</button>
              </div>
            );
          }
          return (
            <div>
              <select className="ctl" value={form[f.k]} onChange={(e) => set(f.k, e.target.value)}>{f.opts.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
              {ext && exactVal != null && editingExact[f.k] && (
                <button type="button" className="exact-restore" onClick={() => setEditingExact((e) => { const c = { ...e }; delete c[f.k]; return c; })}>↶ use extracted: {Number(exactVal).toLocaleString()} {ext.unit}</button>
              )}
            </div>
          );
        })()}
        {f.type === "range" && (<div className="range-row"><input type="range" min="0" max="100" value={form[f.k]} onChange={(e) => set(f.k, e.target.value)} /><span className="range-val">{form[f.k]}%</span></div>)}
        {f.type === "modules" && (
          <div>
            <div className="chips">
              {PRESET_MODULES.map((m) => {
                const active = form.modules_implemented.includes(m);
                const fromImport = active && provenance["modules_implemented"] && !provenance["modules_implemented"].assumed;
                return <span key={m} className={"chip" + (active ? " on" : "") + (fromImport ? " imported" : "")} onClick={() => toggleMod(m)}>SAP {m}</span>;
              })}
              {form.modules_implemented.filter((m) => !PRESET_MODULES.includes(m)).map((m) => {
                const fromImport = provenance["modules_implemented"] && !provenance["modules_implemented"].assumed;
                return <span key={m} className={"chip on" + (fromImport ? " imported" : "")} onClick={() => toggleMod(m)}>{m}<span className="x">×</span></span>;
              })}
            </div>
            <div className="addrow">
              <input className="ctl" placeholder="Add another module (e.g. SAP TRM, IS-Auto)…" value={customMod} onChange={(e) => setCustomMod(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addCustomMod(); }} />
              <button className="add-btn" onClick={addCustomMod}>+ Add</button>
            </div>
            {form.modules_implemented.length === 0 && <div className="modhint">Select at least one module to continue.</div>}
          </div>
        )}
      </div>
    );
  };

  const am = result && APPROACH_META[result.approach];
  const dm = result && DEPLOY_META[result.deployment];

  return (
    <div className="star">
      <style>{CSS}</style>
      <div className="star-shell">
        <div className="star-logo" onClick={() => setView("projects")} style={{ cursor: "pointer" }}>★</div>
        <div>
          <h1>STAR — SAP Transformation Accelerator Roadmap <span style={{ fontSize: "0.55em", fontWeight: 500, color: "#7c5cff", marginLeft: 8 }}>build v2.1 · RC+Fiori</span></h1>
          <div className="crumb">{view === "projects" ? "Portfolio" : activeProject ? activeProject.name : "Assessment"}</div>
        </div>
        <div className="user-area">
          <div className="user-chip"><span className="user-av">{(user?.username || "U").slice(0, 1).toUpperCase()}</span><span className="user-name">{user?.username || "user"}</span><span className="user-role">{user?.role || ""}</span></div>
          <button className="signout" onClick={onLogout}>Sign out</button>
        </div>
      </div>

      {view === "projects" && (
        <div className="home">
          <div className="home-head">
            <div>
              <div className="eyebrow">STAR Portfolio</div>
              <div className="home-title">Projects</div>
              <div className="home-sub">Create a project with its account details, then record and manage multiple system assessments under it.</div>
            </div>
            <button className="btn btn-primary" onClick={openNewProject}>+ New Project</button>
          </div>
          {!loaded ? <div className="empty">Loading…</div> : projects.length === 0 ? (
            <div className="empty">No projects yet. Create your first project to begin.</div>
          ) : (
            <div className="proj-grid">
              {projects.map((p) => (
                <div className="proj-card" key={p.id} onClick={() => { setActiveProjectId(p.id); setView("project"); }}>
                  <div className="proj-card-top">
                    <div className="proj-name">{p.name}</div>
                    <div className="proj-actions" onClick={(e) => e.stopPropagation()}>
                      <button className="icon-btn" title="Edit" onClick={() => openEditProject(p)}>✎</button>
                      <button className="icon-btn danger" title="Delete" onClick={() => deleteProject(p.id)}>🗑</button>
                    </div>
                  </div>
                  <div className="proj-meta">{p.brand_name || "—"}{p.entity_name ? " · " + p.entity_name : ""}</div>
                  <div className="proj-owners">SPARC: {p.sparc_owner || "—"} · GTP: {p.gtp_owner || "—"}</div>
                  <div className="proj-foot"><span className="pill-count">{p.assessments.length} assessment{p.assessments.length === 1 ? "" : "s"}</span><span className="proj-date">{new Date(p.createdAt).toLocaleDateString()}</span></div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {view === "project" && activeProject && (
        <div className="result-wrap">
          <div className="topline">
            <button className="back" onClick={() => { setActiveProjectId(null); setView("projects"); }}>← All projects</button>
            <button className="back" onClick={() => openEditProject(activeProject)}>✎ Edit project</button>
          </div>
          <div className="eyebrow">Project</div>
          <div className="home-title">{activeProject.name}</div>
          <div className="proj-detail-meta">
            <span><b>Brand</b>{activeProject.brand_name || "—"}</span>
            <span><b>Entity</b>{activeProject.entity_name || "—"}</span>
            <span><b>Customer Owner</b>{activeProject.system_owner_customer || "—"}</span>
            <span><b>SPARC Owner</b>{activeProject.sparc_owner || "—"}</span>
            <span><b>GTP Owner</b>{activeProject.gtp_owner || "—"}</span>
          </div>
          <div className="sec-head">
            <div className="sec-title">Assessments</div>
            <button className="btn btn-primary" onClick={newAssessment}>+ New Assessment</button>
          </div>
          {activeProject.assessments.length === 0 ? (
            <div className="empty">No assessments yet. Add one to run a system through STAR.</div>
          ) : (
            <div className="asmt-table card">
              <div className="asmt-row asmt-h"><div>System</div><div>Modules</div><div>Approach</div><div>Deployment</div><div>Conf.</div><div>Updated</div><div></div></div>
              {activeProject.assessments.map((a) => {
                const aa = APPROACH_META[a.result.approach]; const dd = DEPLOY_META[a.result.deployment];
                return (
                  <div className="asmt-row" key={a.id}>
                    <div className="asmt-sys">{a.result.system_id}</div>
                    <div>{a.result.modules.length}</div>
                    <div><span className="tag" style={{ background: aa.color + "1a", color: aa.color, borderColor: aa.color + "55" }}>{aa.label}</span></div>
                    <div className="asmt-dep">{dd.label}</div>
                    <div>{a.result.approachConf}</div>
                    <div className="asmt-date">{new Date(a.updatedAt).toLocaleDateString()}</div>
                    <div className="asmt-acts">
                      <button className="icon-btn" title="View" onClick={() => viewAssessment(a)}>&#128065;</button>
                      <button className="icon-btn" title="Edit" onClick={() => editAssessment(a)}>&#9998;</button>
                      <button className="icon-btn danger" title="Delete" onClick={() => deleteAssessment(a.id)}>&#128465;</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {view === "assessment" && !showResult && parsing && (
        <div className="parse-wrap">
          <div className="card parse-card">
            <div className="spinner" />
            <div className="parse-title">Extracting {parsingLabel || "SAP analysis file"}…</div>
            <div className="parse-sub">Parsing the export and mapping values into the STAR intake…</div>
          </div>
        </div>
      )}

      {importError && (
        <div style={{ background: "#fff0f0", border: "1px solid #e8a0a0", borderRadius: 8, padding: "10px 16px", margin: "12px 0", color: "#c0392b", fontSize: "0.88rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>⚠ {importError}</span>
          <span style={{ cursor: "pointer", fontWeight: 700, marginLeft: 12 }} onClick={() => setImportError(null)}>✕</span>
        </div>
      )}

      {view === "assessment" && !showResult && !parsing && chooser && (
        <div className="choose-wrap">
          <div className="topline"><button className="back" onClick={() => setView("project")}>← Back to project</button></div>
          <div className="eyebrow">New assessment</div>
          <div className="home-title">How do you want to start?</div>
          <div className="home-sub">Upload one or more SAP analysis exports to auto-fill the technical inputs — or enter everything by hand. You'll review every value (tagged with its source) before scoring.</div>
          <div className="choose-grid src-grid">
            {[["readiness", "Readiness Check (recommended)", "Upload the full RC .zip — system, sizing, interfaces, custom code, Fiori, add-ons"], ["atc", "ATC / Custom Code", "CustomCode.xlsx alone — custom-object counts, findings & effort"], ["simplification", "Simplification Item Check", "Mandatory functional conversions & effort"], ["ewa", "EarlyWatch Alert", "DB size & growth, performance, top tables"]].map(([k, h, d]) => (
              <label className={"choose-card src-tile" + (sources.includes(k) ? " loaded" : "")} key={k}>
                <input type="file" accept={SOURCES[k].accept} style={{ display: "none" }} onChange={(e) => onSourceFile(k, e)} />
                <div className="src-tile-top"><span className="src-code">{SOURCES[k].code}</span>{sources.includes(k) && <span className="src-tick">✓</span>}</div>
                <div className="cc-h">{h}</div>
                <div className="cc-d">{d}</div>
                <div className="cc-go">{sources.includes(k) ? sourceFiles[k] : "Choose file…"}</div>
              </label>
            ))}
          </div>
          {sources.length > 0 && (
            <div className="loaded-bar">
              <div className="loaded-chips">{sources.map((k) => (<span className="src-chip" key={k}>{SOURCES[k].code} · {sourceFiles[k]}<span className="src-x" onClick={() => removeSource(k)}>✕</span></span>))}</div>
              <button className="btn btn-primary" onClick={proceedReview}>Review prefilled assessment →</button>
            </div>
          )}
          <div className="choose-or">or</div>
          <div className="choose-card manual-card" onClick={chooseManual}>
            <div className="cc-ic">✎</div>
            <div className="cc-h">Enter manually</div>
            <div className="cc-d">Fill in the assessment steps yourself. Best when you don't have an export to hand.</div>
            <div className="cc-go">Start manual entry →</div>
          </div>
        </div>
      )}

      {view === "assessment" && !showResult && !parsing && !chooser && (
        <div className="wiz">
          <aside className="rail">
            <div className="rail-prog">Step {step + 1} of {SECTIONS.length}</div>
            <div className="rail-bar"><div className="rail-fill" style={{ width: (step / (SECTIONS.length - 1)) * 100 + "%" }} /></div>
            <div className="rail-steps">
              {SECTIONS.map((s, i) => {
                const done = i !== step && i <= maxStep && sectionValid(s);
                const active = i === step;
                return (
                  <button key={s.title} className={"rail-step" + (active ? " on" : "") + (done ? " done" : "")} onClick={() => jumpTo(i)} disabled={i > maxStep}>
                    <span className="rs-n">{done ? "✓" : i + 1}</span><span className="rs-t">{s.title}</span>
                  </button>
                );
              })}
            </div>
          </aside>
          <main>
            {importSummary && (
              <div className="impbar">
                <div className="impbar-top">
                  <span className="impbar-tag">✓ Prefilled from {importSummary.sources.length} source{importSummary.sources.length === 1 ? "" : "s"}</span>
                  <span className="impbar-src">{importSummary.sources.map((x) => x.code).join(" · ")}</span>
                  <button className="impbar-toggle" onClick={() => setImpOpen((o) => !o)}>{impOpen ? "Hide details" : "What was detected?"}</button>
                </div>
                <div className="impbar-note">Each pre-filled field is tagged with its source code. Review the technical values and complete the business inputs; amber fields need your confirmation.</div>
                <div className="impbar-legend"><span className="lg-pill green">✓ RC</span> source on the field<span className="lg-pill amber">confirm</span> not derivable — please verify</div>
                {impOpen && (
                  <div className="impbar-grid">
                    <div><div className="impbar-h">Detected</div><ul>{importSummary.facts.map((x, i) => <li key={i}><b>{x[0]}</b> {x[1]}</li>)}</ul></div>
                    <div><div className="impbar-h">Advisories</div><ul>{importSummary.advisories.map((x, i) => <li key={i}>{x}</li>)}</ul></div>
                  </div>
                )}
              </div>
            )}
            <div className="card step-card" key={step}>
              <div className="step-head">
                <div className="step-icon"><I name={cur.icon} /></div>
                <div>
                  <div className="eyebrow">Step {step + 1} of {SECTIONS.length} · Assessment</div>
                  <div className="step-title">{cur.title}</div>
                  <div className="step-desc">{cur.desc}</div>
                </div>
              </div>
              <div className="step-body">{visibleFields(cur).map(renderField)}</div>
              <div className="step-actions">
                <button className="btn btn-ghost" onClick={goBack}>{step === 0 ? "← Cancel" : "← Back"}</button>
                <button className="btn btn-primary" onClick={goNext} disabled={!valid}>{isLast ? "Generate Recommendation →" : "Next →"}</button>
              </div>
            </div>
            {!valid && <div className="hint">Complete all fields to continue.</div>}
          </main>
        </div>
      )}

      {view === "assessment" && showResult && result && !showReport && !showInsights && (
        <div className="result-wrap">
          <div className="topline">
            <button className="back" onClick={() => setView("project")}>← Back to project</button>
            <button className="back" onClick={() => setShowResult(false)}>✎ Edit answers</button>
            <button className="back" onClick={newAssessment}>＋ New assessment</button>
            <button className="back rpt-btn" onClick={() => { setShowReport(true); setShowInsights(false); }}>📊 View detailed report →</button>
            {insightsBundle && <button className="back rpt-btn" onClick={() => { setShowInsights(true); setShowReport(false); }}>📑 Source insights →</button>}
            <div className="rtitle">Recommendation · {result.system_id}
              <span>{result.brand_name}{result.entity_name ? " · " + result.entity_name : ""}</span>
              <span className="mods">{result.modules.length} modules: {result.modules.map((m) => (PRESET_MODULES.includes(m) ? "SAP " + m : m)).join(", ")}</span>
              {result.integration && <span className="mods">Integration: {intgLabel(result.integration)}</span>}
            </div>
          </div>
          <div className="rec-row">
            <div className="rec-tile" style={{ background: "linear-gradient(135deg, " + am.color + ", " + am.color + "cc)" }}>
              <div className="k">Recommended Approach</div><div className="v">{am.label}</div>
              <div className="s">{result.upgrade ? ("S/4HANA " + result.currentVersion + " → " + result.targetVersion) : am.sub}</div>
              <span className="badge">Confidence: {result.approachConf}</span>
            </div>
            <div className="rec-tile" style={{ background: "linear-gradient(135deg, " + dm.color + ", " + dm.color + "cc)" }}>
              <div className="k">Recommended Deployment</div><div className="v">{dm.label}</div><div className="s">&nbsp;</div>
              <span className="badge">Confidence: {result.deployConf}</span>
            </div>
          </div>
          {result.dbNote && (<div className="info">✓ {result.dbNote}</div>)}
          {result.advisories && result.advisories.map((a, i) => (<div className="advis" key={i}>⚠ {a}</div>))}
          {result.blockers.length > 0 && (
            <div className="warn"><b>⚠ Technical gates triggered</b>
              <ul>{result.blockers.map((b, i) => <li key={i}><b>{b.gate}:</b> {b.message}</li>)}</ul>
              {result.prereq.length > 0 && <div style={{ marginTop: 6 }}><b>Prerequisites:</b><ul>{result.prereq.map((p, i) => <li key={i}>{p}</li>)}</ul></div>}
            </div>
          )}
          <div className="res-grid">
            <div>
              <div className="card" style={{ marginBottom: 16 }}><div className="card-h"><span className="dot" />{result.upgrade ? "Upgrade path" : "Approach scores"}</div>
                <div className="card-b">
                  {result.upgrade ? (
                    <div>
                      <div className="vpath"><span className="vbox cur">S/4HANA {result.currentVersion}</span><span className="varrow">→</span><span className="vbox tgt">S/4HANA {result.targetVersion}</span></div>
                      <div className="vnote">{result.behind ? "Current release is behind the latest — release upgrade recommended." : "Already on the latest release."}</div>
                    </div>
                  ) : <Bars scores={result.approachScores} meta={APPROACH_META} />}
                </div></div>
              <div className="card"><div className="card-h"><span className="dot" />Deployment scores</div><div className="card-b"><Bars scores={result.deployScores} meta={DEPLOY_META} /></div></div>
            </div>
            <div>
              <div className="card" style={{ marginBottom: 16 }}><div className="card-h"><span className="dot" />Indicative roadmap</div>
                <div className="card-b"><div className="steps">{result.waves.map((w, i) => (<span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><span className="step">{w}</span>{i < result.waves.length - 1 && <span className="sep">›</span>}</span>))}</div></div></div>
              <div className="card"><div className="card-h"><span className="dot" />Why — rationale trace</div>
                <div className="card-b">{result.trace.filter((t) => Object.keys(t.contribution).length).slice(0, 10).map((t, i) => (<div className="trace" key={i}><div><div className="f">{t.factor}</div><div className="a">{String(t.answer)}</div></div><div className="c">{Object.entries(t.contribution).map(([k, v]) => k.slice(0, 4) + " " + v).join(" · ")}</div></div>))}</div></div>
            </div>
          </div>
          <div className="note">Saved to project. In production this runs in Python on SAP BTP; the LLM (Claude via Gen AI Hub) turns this trace into the steering-committee narrative.</div>
        </div>
      )}

      {view === "assessment" && showResult && result && showReport && !showInsights && (() => {
        const narrative = buildNarrative(result);
        const aTrace = result.trace.filter((t) => Object.keys(t.contribution).some((k) => A.includes(k)));
        const factorLabels = [...new Set(aTrace.filter((t) => A.some((a) => t.contribution[a] > 0)).map((t) => t.factor))];
        const fColor = {}; factorLabels.forEach((l, i) => { fColor[l] = FACTOR_PALETTE[i % FACTOR_PALETTE.length]; });
        const maxTotal = Math.max(...A.map((a) => Math.max(result.approachScores ? result.approachScores[a] : 0, 0)), 1);
        const winColor = APPROACH_META[result.approach].color;
        const winnerDrivers = aTrace.map((t) => ({ factor: t.factor, answer: t.answer, val: t.contribution[result.approach] || 0 })).filter((d) => d.val > 0).sort((a, b) => b.val - a.val);
        const maxDriver = Math.max(...winnerDrivers.map((d) => d.val), 1);
        return (
          <div className="result-wrap">
            <div className="topline">
              <button className="back" onClick={() => setShowReport(false)}>← Back to summary</button>
              <button className="back" onClick={() => setView("project")}>⌂ Back to project</button>
              <div className="rtitle">Detailed Report · {result.system_id}
                <span>{result.brand_name}{result.entity_name ? " · " + result.entity_name : ""}</span>
                <span className="mods">Customer owner: {result.system_owner_customer || "—"} · SPARC: {result.sparc_owner || "—"} · GTP: {result.gtp_owner || "—"}</span>
                {result.integration && <span className="mods">Integration: {intgLabel(result.integration)}</span>}
              </div>
            </div>
            <div className="rec-row">
              <div className="rec-tile" style={{ background: "linear-gradient(135deg, " + am.color + ", " + am.color + "cc)" }}><div className="k">Recommended Approach</div><div className="v">{am.label}</div><div className="s">{result.upgrade ? ("S/4HANA " + result.currentVersion + " → " + result.targetVersion) : am.sub}</div><span className="badge">Confidence: {result.approachConf}</span></div>
              <div className="rec-tile" style={{ background: "linear-gradient(135deg, " + dm.color + ", " + dm.color + "cc)" }}><div className="k">Recommended Deployment</div><div className="v">{dm.label}</div><div className="s">&nbsp;</div><span className="badge">Confidence: {result.deployConf}</span></div>
            </div>
            <div className="card" style={{ marginBottom: 16 }}><div className="card-h"><span className="dot" />Why STAR recommends this</div><div className="card-b narr">{narrative.map((p, i) => <p key={i}>{p}</p>)}</div></div>
            {result.advisories && result.advisories.length > 0 && (
              <div className="card" style={{ marginBottom: 16 }}><div className="card-h"><span className="dot" />Integration advisories</div><div className="card-b">{result.advisories.map((a, i) => (<div className="advis" key={i}>⚠ {a}</div>))}</div></div>
            )}
            {!result.upgrade && (
              <div className="card" style={{ marginBottom: 16 }}><div className="card-h"><span className="dot" />Decision composition — how the factors stack up</div>
                <div className="card-b">
                  {A.map((a) => {
                    const segs = aTrace.filter((t) => t.contribution[a] > 0).map((t) => ({ factor: t.factor, val: t.contribution[a] }));
                    return (
                      <div className={"stack-row" + (a === result.approach ? " win" : "")} key={a}>
                        <span className="stack-label" style={{ color: APPROACH_META[a].color }}>{APPROACH_META[a].label}</span>
                        <div className="stack-track">{segs.map((s, i) => <div key={i} className="stack-seg" title={s.factor + " +" + s.val} style={{ width: (s.val / maxTotal) * 100 + "%", background: fColor[s.factor] || "#9aa7b4" }} />)}</div>
                        <span className="stack-total" style={{ color: a === result.approach ? winColor : C.sub }}>{result.approachScores[a].toFixed(1)}</span>
                      </div>
                    );
                  })}
                  <div className="legend">{factorLabels.map((l) => <span key={l}><i style={{ background: fColor[l] }} />{l}</span>)}</div>
                </div>
              </div>
            )}
            {!result.upgrade && winnerDrivers.length > 0 && (
              <div className="card" style={{ marginBottom: 16 }}><div className="card-h"><span className="dot" />Top drivers for {am.label}</div>
                <div className="card-b">{winnerDrivers.map((d, i) => (<div className="drv-row" key={i}><span className="drv-label">{d.factor}<br /><span style={{ color: C.sub, fontWeight: 400 }}>{String(d.answer)}</span></span><div className="drv-track"><div className="drv-fill" style={{ width: (d.val / maxDriver) * 100 + "%", background: winColor }} /></div><span className="drv-val">+{d.val}</span></div>))}</div>
              </div>
            )}
            {result.upgrade && (
              <div className="card" style={{ marginBottom: 16 }}><div className="card-h"><span className="dot" />Upgrade path</div><div className="card-b"><div className="vpath"><span className="vbox cur">S/4HANA {result.currentVersion}</span><span className="varrow">→</span><span className="vbox tgt">S/4HANA {result.targetVersion}</span></div><div className="vnote">{result.behind ? "Release upgrade via SUM — standard and low-risk." : "Already current — adopt the latest FPS & innovations."}</div></div></div>
            )}
            <div className="card" style={{ marginBottom: 16 }}><div className="card-h"><span className="dot" />Deployment scoring</div><div className="card-b"><Bars scores={result.deployScores} meta={DEPLOY_META} /></div></div>
            {result.blockers.length > 0 && (
              <div className="warn"><b>⚠ Technical gates & prerequisites</b><ul>{result.blockers.map((b, i) => <li key={i}><b>{b.gate}:</b> {b.message}</li>)}</ul><div style={{ marginTop: 6 }}><b>Prerequisites:</b><ul>{result.prereq.map((p, i) => <li key={i}>{p}</li>)}</ul></div></div>
            )}
            <div className="card"><div className="card-h"><span className="dot" />Indicative roadmap</div><div className="card-b"><div className="tlbar">{result.waves.map((w, i) => <div className="tlseg" key={i} style={{ background: "hsl(258,72%," + (64 - i * 5) + "%)" }}>{i + 1}</div>)}</div><div className="tllabels">{result.waves.map((w, i) => <div className="tllbl" key={i}>{w}</div>)}</div></div></div>
            <div className="note">Detailed report generated from the deterministic engine trace. In production the LLM (Claude via Gen AI Hub) expands this into a full narrative document.</div>
          </div>
        );
      })()}

      {view === "assessment" && showResult && result && showInsights && insightsBundle && (
        <div className="result-wrap">
          <div className="topline">
            <button className="back" onClick={() => setShowInsights(false)}>← Back to recommendation</button>
            <button className="back" onClick={() => setView("project")}>⌂ Back to project</button>
            <button className="back rpt-btn" onClick={() => { setShowReport(true); setShowInsights(false); }}>📊 Detailed report →</button>
            <div className="rtitle">Source Insights · {result.system_id}
              <span>{insightsBundle.sources.map((d) => d.code + " · " + d.file).join("    |    ")}</span>
            </div>
          </div>
          {insightsBundle.sources.map((d, di) => {
            const ins = d.insights;
            return (
              <div key={di}>
                <div className="src-section"><span className="src-code big">{d.code}</span><span className="src-section-h">{d.label}</span><span className="src-section-f">{d.file}</span></div>
                {!ins && <div className="rk-note" style={{ padding: "12px 0" }}>No detailed insights extracted for this source — facts are shown in the import summary.</div>}
                {ins && ins.kind === "readiness_docx" && (
                  <div className="card" style={{ marginBottom: 16 }}>
                    <div className="card-h"><span className="dot" />Extracted from narrative report</div>
                    <div className="card-b">
                      {(ins.facts || []).map((f, i) => <div key={i} style={{ fontSize: 13, padding: "5px 0", borderBottom: "1px solid #f0ede8" }}>{f}</div>)}
                    </div>
                  </div>
                )}
                {ins && ins.kind === "readiness_zip" && (() => {
                  const ifaces = ins.interfaces || [];
                  const ifMax  = Math.max(...ifaces.map((x) => x[1]), 1);
                  const fiori  = ins.fioriByArea || [];
                  const fMax   = Math.max(...fiori.map((x) => x[1]), 1);
                  return (
                    <div>
                      {ifaces.length > 0 && (
                        <div className="card" style={{ marginBottom: 16 }}>
                          <div className="card-h"><span className="dot" />Interfaces — {ins.interfaceTotal?.toLocaleString()} total</div>
                          <div className="card-b">
                            {ifaces.map((x, i) => (
                              <div className="rk-bar-row" key={i}>
                                <span className="rk-bar-label">{x[0]}</span>
                                <div className="rk-bar-track"><div className="rk-bar-fill" style={{ width: (x[1] / ifMax) * 100 + "%" }} /></div>
                                <span className="rk-bar-val">{x[1].toLocaleString()}</span>
                              </div>
                            ))}
                            {ins.addonsIncompat > 0 && <div className="rk-note" style={{ color: "#c0392b", marginTop: 8 }}>{ins.addonsIncompat} incompatible add-on(s) — conversion blocker</div>}
                          </div>
                        </div>
                      )}
                      {ins.customCode && ins.customCode.quickFix && (ins.customCode.quickFix.objectsAvailable > 0 || ins.customCode.quickFix.topicsNotAvail > 0) && (() => {
                        const qf = ins.customCode.quickFix;
                        const total = qf.objectsAvailable + qf.objectsManual || 1;
                        const availPct = Math.round((qf.objectsAvailable / total) * 100);
                        return (
                          <div className="card" style={{ marginBottom: 16 }}>
                            <div className="card-h"><span className="dot" />Quick Fix Coverage — {qf.coveragePct}% of in-scope objects auto-fixable</div>
                            <div className="card-b">
                              <div className="qf-grid">
                                <div className="qf-tile qf-ok">
                                  <div className="qf-ic">⚡</div>
                                  <div className="qf-num">{qf.objectsAvailable.toLocaleString()}</div>
                                  <div className="qf-lbl">objects · Quick Fix Available</div>
                                  <div className="qf-sub">{qf.topicsAvailable} topic(s) supported</div>
                                </div>
                                <div className="qf-tile qf-no">
                                  <div className="qf-ic">🛠</div>
                                  <div className="qf-num">{qf.objectsManual.toLocaleString()}</div>
                                  <div className="qf-lbl">objects · Manual remediation</div>
                                  <div className="qf-sub">{qf.topicsNotAvail} topic(s) without Quick Fix</div>
                                </div>
                              </div>
                              <div className="qf-bar">
                                <div className="qf-bar-fill ok" style={{ width: availPct + "%" }} />
                                <div className="qf-bar-fill no" style={{ width: (100 - availPct) + "%" }} />
                              </div>
                              <div className="rk-note" style={{ marginTop: 10 }}>
                                Remediation estimate ≈ {ins.customCode.totals.effort} · {ins.customCode.totals.errors.toLocaleString()} errors + {ins.customCode.totals.warnings.toLocaleString()} warnings across {ins.customCode.totals.topics} topics
                              </div>
                            </div>
                          </div>
                        );
                      })()}
                      {fiori.length > 0 && (
                        <div className="card" style={{ marginBottom: 16 }}>
                          <div className="card-h"><span className="dot" />Fiori — {ins.fioriTotal?.toLocaleString()} recommended apps by functional area</div>
                          <div className="card-b">
                            {fiori.map((x, i) => (
                              <div className="rk-bar-row" key={i}>
                                <span className="rk-bar-label">{x[0]}</span>
                                <div className="rk-bar-track"><div className="rk-bar-fill vio" style={{ width: (x[1] / fMax) * 100 + "%" }} /></div>
                                <span className="rk-bar-val">{x[1]}</span>
                              </div>
                            ))}
                            {ins.siCount > 0 && <div className="rk-note" style={{ marginTop: 8 }}>{ins.siCount} relevant Simplification Items in this export</div>}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}
                {ins && ins.kind === "readiness" && (() => {
                  const ifMax = Math.max(...ins.interfaces.map((x) => x[1]), 1);
                  const ccMax = Math.max(...ins.customCode.top.map((x) => x[1]), 1);
                  const pill = (st) => (st === "Incompatible" ? "red" : st === "Compatible" ? "green" : "amber");
                  return (
                    <div>
                      <div className="card" style={{ marginBottom: 16 }}><div className="card-h"><span className="dot" />System &amp; sizing</div><div className="card-b"><div className="rk-facts">{ins.system.map((kv, i) => (<span key={i}><b>{kv[0]}</b>{kv[1]}</span>))}</div><div className="rk-stats" style={{ marginTop: 14 }}><div className="rk-stat"><div className="v">{ins.sizing.dataUsed} GB</div><div className="k">Data on disk</div></div><div className="rk-stat"><div className="v">{ins.sizing.memory} GB</div><div className="k">Memory</div></div><div className="rk-stat"><div className="v">{ins.sizing.cpu}</div><div className="k">CPU cat.</div></div><div className="rk-stat"><div className="v">No DMO</div><div className="k">SoH path</div></div></div></div></div>
                      <div className="res-grid">
                        <div className="card" style={{ marginBottom: 16 }}><div className="card-h"><span className="dot" />Interfaces</div><div className="card-b">{ins.interfaces.map((x, i) => (<div className="rk-bar-row" key={i}><span className="rk-bar-label">{x[0]}</span><div className="rk-bar-track"><div className="rk-bar-fill" style={{ width: (x[1] / ifMax) * 100 + "%" }} /></div><span className="rk-bar-val">{x[1].toLocaleString()}</span></div>))}</div></div>
                        <div className="card" style={{ marginBottom: 16 }}><div className="card-h"><span className="dot" />Custom code · {ins.customCode.findings} findings</div><div className="card-b">{ins.customCode.top.map((x, i) => (<div className="rk-bar-row" key={i}><span className="rk-bar-label">{x[0]}</span><div className="rk-bar-track"><div className="rk-bar-fill alt" style={{ width: (x[1] / ccMax) * 100 + "%" }} /></div><span className="rk-bar-val">{x[1]}</span></div>))}</div></div>
                      </div>
                      <div className="card" style={{ marginBottom: 16 }}><div className="card-h"><span className="dot" />Add-on compatibility — {ins.addons.incompatible} blockers</div><div className="card-b">{ins.addons.items.map((x, i) => (<div className="addon-row" key={i}><span>{x[0]}</span><span className={"addon-pill " + pill(x[1])}>{x[1]}</span></div>))}</div></div>
                    </div>
                  );
                })()}
                {ins && ins.kind === "atc" && (() => {
                  const isRcCc = ins.format === "rc_cc";
                  const cats   = ins.byCategory  || [];
                  const byComp = ins.byComponent  || [];
                  const catMax  = Math.max(...cats.map((x) => x[1]),  1);
                  const compMax = Math.max(...byComp.map((x) => x[1]), 1);
                  return (
                    <div>
                      <div className="card" style={{ marginBottom: 16 }}>
                        <div className="card-h"><span className="dot" />{isRcCc ? "RC Custom Code — topic summary" : "Custom-code findings"}</div>
                        <div className="card-b">
                          <div className="rk-stats">
                            {isRcCc && <div className="rk-stat"><div className="v">{ins.totals.topics}</div><div className="k">Topics</div></div>}
                            <div className="rk-stat"><div className="v">{ins.totals.objects.toLocaleString()}</div><div className="k">Objects</div></div>
                            <div className="rk-stat"><div className="v">{ins.totals.inScope.toLocaleString()}</div><div className="k">In scope</div></div>
                            <div className="rk-stat"><div className="v">{ins.totals.errors.toLocaleString()}</div><div className="k">Errors</div></div>
                            {isRcCc
                              ? <div className="rk-stat"><div className="v">{ins.totals.unresolved.toLocaleString()}</div><div className="k">Unresolved</div></div>
                              : <div className="rk-stat"><div className="v">{ins.totals.usedPct != null ? ins.totals.usedPct + "%" : "—"}</div><div className="k">Used</div></div>}
                          </div>
                          {isRcCc && ins.totals.functionalRedesign > 0 && (
                            <div className="rk-note" style={{ color: "#c0392b", marginTop: 10 }}>
                              {ins.totals.functionalRedesign} topic(s) require Functional Redesign · {ins.totals.unavailable} Functionality Unavailable
                            </div>
                          )}
                          <div className="rk-note" style={{ marginTop: 8 }}>Estimated remediation ≈ {ins.totals.effort}</div>
                        </div>
                      </div>
                      {isRcCc && ins.quickFix && (ins.quickFix.objectsAvailable > 0 || ins.quickFix.topicsNotAvail > 0) && (() => {
                        const qf = ins.quickFix;
                        const total = qf.objectsAvailable + qf.objectsManual || 1;
                        const availPct = Math.round((qf.objectsAvailable / total) * 100);
                        return (
                          <div className="card" style={{ marginBottom: 16 }}>
                            <div className="card-h"><span className="dot" />Quick Fix Coverage — {qf.coveragePct}% of in-scope objects auto-fixable</div>
                            <div className="card-b">
                              <div className="qf-grid">
                                <div className="qf-tile qf-ok">
                                  <div className="qf-ic">⚡</div>
                                  <div className="qf-num">{qf.objectsAvailable.toLocaleString()}</div>
                                  <div className="qf-lbl">objects · Quick Fix Available</div>
                                  <div className="qf-sub">{qf.topicsAvailable} topic(s) supported</div>
                                </div>
                                <div className="qf-tile qf-no">
                                  <div className="qf-ic">🛠</div>
                                  <div className="qf-num">{qf.objectsManual.toLocaleString()}</div>
                                  <div className="qf-lbl">objects · Manual remediation</div>
                                  <div className="qf-sub">{qf.topicsNotAvail} topic(s) without Quick Fix</div>
                                </div>
                              </div>
                              <div className="qf-bar">
                                <div className="qf-bar-fill ok" style={{ width: availPct + "%" }} title={"Quick Fix · " + availPct + "%"} />
                                <div className="qf-bar-fill no" style={{ width: (100 - availPct) + "%" }} title={"Manual · " + (100 - availPct) + "%"} />
                              </div>
                              <div className="rk-note" style={{ marginTop: 10 }}>
                                High Quick Fix coverage materially cuts remediation effort — current model assumes up to 70% saving on the auto-fixable share.
                              </div>
                            </div>
                          </div>
                        );
                      })()}
                      {cats.length > 0 && (
                        <div className="card" style={{ marginBottom: 16 }}>
                          <div className="card-h"><span className="dot" />{isRcCc ? "By Remediation Type" : "By Check Category"}</div>
                          <div className="card-b">
                            {cats.map((x, i) => (
                              <div className="rk-bar-row" key={i}>
                                <span className="rk-bar-label">{x[0]}</span>
                                <div className="rk-bar-track"><div className="rk-bar-fill alt" style={{ width: (x[1] / catMax) * 100 + "%" }} /></div>
                                <span className="rk-bar-val">{x[1]}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {byComp.length > 0 && (
                        <div className="card" style={{ marginBottom: 16 }}>
                          <div className="card-h"><span className="dot" />By Application Component</div>
                          <div className="card-b">
                            {byComp.map((x, i) => (
                              <div className="rk-bar-row" key={i}>
                                <span className="rk-bar-label">{x[0]}</span>
                                <div className="rk-bar-track"><div className="rk-bar-fill vio" style={{ width: (x[1] / compMax) * 100 + "%" }} /></div>
                                <span className="rk-bar-val">{x[1]}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}
                {ins && ins.kind === "simplification" && (() => {
                  // Support both new shape (lob_breakdown/items) and legacy (effort/mandatory)
                  const isNew = Array.isArray(ins.lob_breakdown);
                  const priorityRows = isNew
                    ? [["High – Unavailable", ins.high], ["Medium – Change/Deprecated", ins.medium], ["Check", ins.low]]
                    : (ins.effort || []);
                  const prMax = Math.max(...priorityRows.map((x) => x[1]), 1);
                  const lobRows = isNew ? (ins.lob_breakdown || []) : [];
                  const lobMax = Math.max(...lobRows.map((x) => x[1]), 1);
                  const pill = (p) => p === "High" ? "red" : p === "Medium" ? "amber" : "green";
                  const items = isNew ? (ins.items || []) : (ins.mandatory || []).map(([t, l]) => ({ title: t, priority: l }));
                  return (
                    <div>
                      <div className="res-grid" style={{ marginBottom: 0 }}>
                        <div className="card" style={{ marginBottom: 16 }}>
                          <div className="card-h"><span className="dot" />Priority · {ins.total} items</div>
                          <div className="card-b">
                            {priorityRows.map((x, i) => (
                              <div className="rk-bar-row" key={i}>
                                <span className="rk-bar-label">{x[0]}</span>
                                <div className="rk-bar-track"><div className="rk-bar-fill vio" style={{ width: (x[1] / prMax) * 100 + "%" }} /></div>
                                <span className="rk-bar-val">{x[1]}</span>
                              </div>
                            ))}
                            {ins.errors > 0 && <div className="rk-note" style={{ color: "#c0392b" }}>{ins.errors} consistency error(s) — fix before conversion freeze.</div>}
                          </div>
                        </div>
                        {lobRows.length > 0 && (
                          <div className="card" style={{ marginBottom: 16 }}>
                            <div className="card-h"><span className="dot" />By Line of Business</div>
                            <div className="card-b">
                              {lobRows.map((x, i) => (
                                <div className="rk-bar-row" key={i}>
                                  <span className="rk-bar-label">{x[0]}</span>
                                  <div className="rk-bar-track"><div className="rk-bar-fill alt" style={{ width: (x[1] / lobMax) * 100 + "%" }} /></div>
                                  <span className="rk-bar-val">{x[1]}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                      <div className="card" style={{ marginBottom: 16 }}>
                        <div className="card-h"><span className="dot" />Simplification Items</div>
                        <div className="card-b">
                          {items.map((x, i) => (
                            <div key={i} style={{ borderBottom: "1px solid #eee", paddingBottom: 10, marginBottom: 10 }}>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                                <span style={{ fontWeight: 600, fontSize: 13 }}>{x.title}</span>
                                <span className={"addon-pill " + pill(x.priority)} style={{ whiteSpace: "nowrap" }}>{x.priority}</span>
                              </div>
                              {isNew && (
                                <div style={{ fontSize: 11, color: "#888", marginTop: 3 }}>
                                  {x.lob && <span style={{ marginRight: 8 }}>{x.lob}</span>}
                                  {x.id && <span style={{ fontFamily: "monospace" }}>{x.id}</span>}
                                </div>
                              )}
                              {isNew && x.summary && (
                                <div style={{ fontSize: 12, color: "#555", marginTop: 4, fontStyle: "italic" }}>{x.summary}</div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })()}
                {ins && ins.kind === "ewa" && (() => {
                  const m = Math.max(...ins.topTables.map((x) => x[1]), 1);
                  return (
                    <div className="res-grid">
                      <div className="card" style={{ marginBottom: 16 }}><div className="card-h"><span className="dot" />System health</div><div className="card-b"><div className="rk-stats"><div className="rk-stat"><div className="v">{ins.db.sizeGb} GB</div><div className="k">DB size</div></div><div className="rk-stat"><div className="v">{ins.db.growthPct}%/yr</div><div className="k">Growth</div></div><div className="rk-stat"><div className="v">{ins.perf.rating}</div><div className="k">Performance</div></div><div className="rk-stat"><div className="v">{ins.perf.dialogMs} ms</div><div className="k">Avg dialog</div></div></div></div></div>
                      <div className="card" style={{ marginBottom: 16 }}><div className="card-h"><span className="dot" />Top growth tables (GB)</div><div className="card-b">{ins.topTables.map((x, i) => (<div className="rk-bar-row" key={i}><span className="rk-bar-label">{x[0]}</span><div className="rk-bar-track"><div className="rk-bar-fill" style={{ width: (x[1] / m) * 100 + "%" }} /></div><span className="rk-bar-val">{x[1]}</span></div>))}</div></div>
                    </div>
                  );
                })()}
              </div>
            );
          })}
          <div className="note">Insights extracted from the uploaded SAP analysis exports. STAR fuses these into the intake and recomputes the recommendation; figures are point-in-time from each report.</div>
        </div>
      )}

      {projModal && (
        <div className="modal-overlay" onClick={() => setProjModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">{projModal.mode === "new" ? "New Project" : "Edit Project"}</div>
            <div className="modal-body">
              <div className="fld"><label>Project Name</label><input className="ctl" placeholder="e.g. Brand-A S/4HANA Transformation" value={projModal.data.name} onChange={(e) => setProjModal({ ...projModal, data: { ...projModal.data, name: e.target.value } })} /></div>
              {[["system_owner_customer", "System Owner (Customer Side)"], ["entity_name", "Entity Name"], ["brand_name", "Brand Name"], ["sparc_owner", "SPARC Owner"], ["gtp_owner", "GTP Owner"]].map(([k, l]) => (
                <div className="fld" key={k}><label>{l}</label><input className="ctl" value={projModal.data[k]} onChange={(e) => setProjModal({ ...projModal, data: { ...projModal.data, [k]: e.target.value } })} /></div>
              ))}
            </div>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setProjModal(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={saveProject} disabled={!projModal.data.name.trim()}>{projModal.mode === "new" ? "Create Project" : "Save"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}



export default StarApp;
