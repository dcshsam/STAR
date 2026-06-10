# STAR — SAP Transformation Accelerator Roadmap (Next.js)

The STAR frontend, built on **Next.js (App Router) + React 18**. STAR takes per-system
business and technical inputs — optionally pre-filled from SAP analysis exports — and
recommends a transformation **Approach** (Greenfield / Brownfield / Bluefield, or a
release Upgrade) × **Deployment** (RISE Private / self-managed Hyperscaler / On-prem)
using an auditable, deterministic scoring engine.

## Quick start

```bash
npm install
npm run dev          # http://localhost:3000
```

Sign in with the demo account **architect / star2026** (or **admin / ChangeMe!2026**).

## Project structure

```
star-web/
  app/
    layout.jsx        Root layout; wraps the app in AuthProvider
    page.jsx          Shows <Login/> or <StarApp/> based on auth
    globals.css       Reset + Inter font; STAR injects its own component styles
  components/
    StarApp.jsx       The full STAR application (portfolio, projects, 6-step
                      wizard, multi-source import + fusion, recommendation,
                      detailed report, source insights). Decision engine lives here.
    Login.jsx         Branded sign-in screen
  context/
    AuthContext.jsx   useAuth(): login / logout / current user
  lib/
    api.js            Typed-ish client for the FastAPI backend
```

## Connecting the FastAPI backend

By default the app runs **standalone**: portfolios persist to `localStorage` and login
uses the demo accounts above. To wire it to the STAR backend, copy the env file and set
the API base URL:

```bash
cp .env.local.example .env.local
# .env.local
NEXT_PUBLIC_API_URL=http://localhost:8000
```

When `NEXT_PUBLIC_API_URL` is set, `AuthContext` posts to `POST /api/auth/login`, stores
the JWT, and reads `GET /api/auth/me`. The helpers in `lib/api.js`
(`getPortfolio`, `putPortfolio`, `assess`) are ready to replace the local `loadProjects` /
`saveProjects` calls in `StarApp.jsx` so the portfolio is served per-user from the backend.
Adjust the route prefixes in `lib/api.js` if your backend mounts the routers differently.

## The four import sources

The **New assessment** screen accepts any combination of:

- **Readiness Check** (RC) — system, sizing, interfaces, add-on compatibility
- **ATC / Custom Code** (ATC) — custom-object counts, error/warning findings, effort
- **Simplification Item Check** (SI) — mandatory functional conversions and effort
- **EarlyWatch Alert** (EWA) — DB size and growth, performance, top growth tables

STAR fuses them by priority (with per-field provenance badges), recomputes the
recommendation, and exposes a **Source insights** view. In this build the extractions are
simulated client-side; the production parsers belong in the backend (the Readiness parser
already exists there).

## Notes

- The decision engine is deterministic and auditable; any optional LLM layer is for
  narrative only and never changes the recommended path.
- Styling is the established STAR design (purple accent, soft canvas), injected by the
  component — no Tailwind dependency.
