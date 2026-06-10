# STAR — SAP Transformation Accelerator Roadmap

A two-part app that recommends an SAP transformation path for a single system:

- **`frontend/`** — Next.js (App Router) + React 18 UI and the deterministic decision engine.
- **`backend/`** — FastAPI: JWT/OAuth2 auth, RBAC, the Python engine, and the Readiness Check parser.

> New to the codebase (or pointing Claude Code at it)? Start with **`CLAUDE.md`** — it
> explains the architecture and the rules the engine must keep.

## Run it

**Frontend (standalone, no backend needed):**
```bash
cd frontend
npm install
npm run dev            # http://localhost:3000
```
Sign in with `architect / star2026` (or `admin / ChangeMe!2026`).

**Backend:**
```bash
cd backend
python -m venv .venv && source .venv/bin/activate     # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                                   # edit; never commit .env
uvicorn app.main:app --reload --port 8000              # http://localhost:8000/docs
```

**Connect the two:** in `frontend/`, `cp .env.local.example .env.local` and set
`NEXT_PUBLIC_API_URL=http://localhost:8000`. Login and (once wired) the portfolio then use
the API.

## Using Claude Code on this project

1. Install Claude Code (see official setup: https://code.claude.com/docs/en/setup).
2. Open the **`star/`** folder in VS Code.
3. In the integrated terminal, run `claude` from the `star/` root so it picks up `CLAUDE.md`.

Good first prompts:
- "Read CLAUDE.md, then wire the frontend portfolio to the backend using lib/api.js."
- "Add a real EarlyWatch Alert parser in backend/app/engine and an import endpoint for it."
- "The JS and Python engines must match — diff scoring.py against the engine in StarApp.jsx."
