// Thin client for the STAR FastAPI backend.
// Set NEXT_PUBLIC_API_URL to enable; otherwise the app runs standalone with mock auth.
const API = process.env.NEXT_PUBLIC_API_URL || "";

function token() {
  try { return localStorage.getItem("star_token"); } catch { return null; }
}
function authHeaders() {
  const t = token();
  return t ? { Authorization: "Bearer " + t } : {};
}

export async function apiLogin(username, password) {
  const body = new URLSearchParams();
  body.set("username", username);
  body.set("password", password);
  const r = await fetch(API + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) return null;
  const j = await r.json();
  return j.access_token || null;
}

export async function apiMe() {
  const r = await fetch(API + "/api/auth/me", { headers: { ...authHeaders() } });
  if (!r.ok) return null;
  return r.json();
}

export async function getPortfolio() {
  const r = await fetch(API + "/api/star/portfolio", { headers: { ...authHeaders() } });
  if (!r.ok) return null;
  return r.json();
}

export async function putPortfolio(data) {
  const r = await fetch(API + "/api/star/portfolio", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(data),
  });
  return r.ok;
}

export async function assess(form) {
  const r = await fetch(API + "/api/star/assess", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(form),
  });
  if (!r.ok) return null;
  return r.json();
}

// kind: "readiness" | "atc" | "simplification" | "ewa"
export async function importSource(kind, file) {
  const ENDPOINT = {
    readiness: "/api/star/assess/import-readiness",
    atc: "/api/star/assess/import-atc",
    simplification: "/api/star/assess/import-simplification",
    ewa: "/api/star/assess/import-ewa",
  };
  const url = ENDPOINT[kind];
  if (!url) throw new Error("Unknown import kind: " + kind);
  const fd = new FormData();
  fd.append("file", file);
  const r = await fetch(API + url, { method: "POST", headers: { ...authHeaders() }, body: fd });
  if (!r.ok) {
    const detail = await r.json().catch(() => null);
    throw new Error((detail && detail.detail) || `Import failed (${r.status})`);
  }
  return r.json(); // {form, summary: {facts, review, advisory}, insights}
}

export const apiConfigured = () => Boolean(API);
