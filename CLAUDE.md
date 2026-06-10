# STAR — SAP Transformation Accelerator Roadmap

STAR assesses a **single SAP system** and recommends a transformation **Approach**
(Greenfield / Brownfield / Bluefield, or a release **Upgrade** if already on S/4HANA)
× **Deployment** (RISE Private / self-managed Hyperscaler / On-prem). Inputs are business
+ technical answers, optionally pre-filled from SAP analysis exports.

This file is context for Claude Code. Read it before making changes.

## Monorepo layout

```
star/
  frontend/   Next.js (App Router) + React 18. The UI and the JS decision engine.
  backend/    FastAPI. JWT/OAuth2 auth, RBAC, the Python decision engine, parsers.
```

## Golden rules (do not violate without asking)

1. **The decision engine is the IP and is deterministic.** Approach/Deployment come from
   a weighted, auditable scoring engine — never from an LLM. An optional LLM (SAP
   Generative AI Hub, Claude) may only generate *narrative*; it must never change the
   recommended path, scores, gates, or confidence.
2. **Two engines must stay in sync.** The JS engine in `frontend/components/StarApp.jsx`
   and the Python engine in `backend/app/engine/scoring.py` implement the same logic.
   If you change factor weights, gates, bands, or labels in one, change the other and say so.
3. **Hard gates stay hard.** Non-Unicode, dual-stack, and pre-ECC6 disqualify a brownfield
   conversion. Suite-on-HANA uses SUM **without DMO** (no DB migration) — lighter brownfield.
4. **Target production runtime is SAP BTP Cloud Foundry, NOT Kyma.** Kyma trial provisioning
   was suspended platform-wide; the backend ships a CF `manifest.yml`.
5. **Never commit secrets.** No `.env`, no BTP/XSUAA service keys, no tokens. If a key is
   ever pasted into a file or chat, treat it as compromised and rotate it.
6. **GROW / Public Cloud is intentionally out of scope.** Don't reintroduce it.

## Decision engine (summary)

- Approach factors (weights): process_reengineering_appetite 3.0, customization_intensity
  2.5, landscape_intent 2.5, primary_driver / target_golive / data_quality 2.0,
  integration_complexity 1.5; product_release gives a Suite-on-HANA boost.
- `integration_complexity` is derived from interface_count_band + interface_complexity +
  non_sap_share + middleware.
- Deployment derived from basis_ops_capability / existing_hyperscaler / data_sovereignty,
  coupled to the chosen approach. Confidence comes from the score margin.

## Four import sources → fusion

The **New assessment** screen accepts any combination of:
`Readiness Check (RC)`, `ATC / Custom Code (ATC)`, `Simplification Item Check (SI)`,
`EarlyWatch Alert (EWA)`. STAR fuses them by priority `FUSE_ORDER`, records per-field
**provenance** (which source set each field), recomputes the recommendation, and shows a
**Source insights** view. Frontend extraction is currently **simulated**; real parsing
belongs in the backend (`backend/app/engine/readiness.py` is the only real parser so far —
ATC / SI / EWA parsers are the next step and need sample files).

## Frontend (`frontend/`)

- Next.js App Router. `app/page.jsx` shows `Login` or `StarApp` based on `useAuth()`.
- `components/StarApp.jsx` is the whole app **and** the JS decision engine + the four-source
  `SOURCES` catalog + `fuseSources()`. It's one large client component by design (the views
  are state-driven, not URL-routed).
- `context/AuthContext.jsx` + `lib/api.js`: login hits the backend when
  `NEXT_PUBLIC_API_URL` is set, else falls back to demo accounts. Portfolio currently
  persists to `localStorage`; swap `loadProjects`/`saveProjects` in `StarApp.jsx` for
  `getPortfolio`/`putPortfolio` in `lib/api.js` to serve it from the backend per-user.
- Styling is the established STAR design (purple accent `#7c5cff`, soft canvas `#f6f5f1`),
  injected by the component. No Tailwind. Preserve this look unless asked to redesign.

Run:
```bash
cd frontend && npm install && npm run dev    # http://localhost:3000
```
Demo login: `architect / star2026` or `admin / ChangeMe!2026`.

## Backend (`backend/`)

FastAPI. Key modules:
- `app/main.py` — app factory, CORS, security headers, `/health`, seeds an admin on startup.
- `app/core/config.py` (env via pydantic-settings), `app/core/security.py` (bcrypt + JWT HS256).
- `app/api/auth.py` (`/login`, `/me`, admin-only `/register`, `/change-password`),
  `app/api/star.py` (per-user `GET/PUT /portfolio`, `POST /assess`, `POST /assess/import-readiness`),
  `app/api/deps.py` (`get_current_user`, `require_role` admin>architect>viewer).
- `app/engine/scoring.py` (Python port — keep in sync with the JS engine),
  `app/engine/narrative.py` (deterministic + optional Gen AI Hub hook),
  `app/engine/readiness.py` (real RC zip parser).
- `app/db/models.py` — SQLModel User + Portfolio (SQLite in dev). `app/schemas/` — Pydantic.

Run:
```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # then edit; never commit .env
uvicorn app.main:app --reload --port 8000
```

## Common tasks
- Add an engine factor → edit `scoring.py` **and** the JS engine in `StarApp.jsx`; keep
  labels/bands identical.
- Add a real ATC/SI/EWA parser → put it in `backend/app/engine/`, return the same intake
  fields the RC parser does, and extend `POST /assess/import-*` with a `kind`.
- Wire portfolio to backend → see the frontend note above.

## Style
- Frontend JS, 2-space indent. Backend Python, type hints, FastAPI dependency-injection.
- Keep changes small and reviewable; explain any engine-logic change in plain terms.
