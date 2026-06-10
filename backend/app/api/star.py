"""Protected business routes: per-user portfolio CRUD and the assessment engine."""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlmodel import Session

from app.api.deps import get_current_user, require_role
from app.db.models import Portfolio, User, get_session
from app.engine.atc import parse_atc
from app.engine.ewa import parse_ewa
from app.engine.narrative import llm_narrative
from app.engine.readiness import parse_zip
from app.engine.simplification import parse_simplification
from app.engine.scoring import recommend
from app.schemas.star import IntakeForm, PortfolioRead, PortfolioWrite, Recommendation

router = APIRouter(tags=["star"])


@router.get("/portfolio", response_model=PortfolioRead)
def get_portfolio(
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    """Return the current user's portfolio (projects -> assessments)."""
    pf = session.get(Portfolio, user.id)
    if not pf:
        return PortfolioRead(projects=[], updated_at=None)
    return PortfolioRead(projects=pf.projects or [], updated_at=pf.updated_at.isoformat())


@router.put("/portfolio", response_model=PortfolioRead)
def save_portfolio(
    payload: PortfolioWrite,
    session: Session = Depends(get_session),
    user: User = Depends(require_role("architect")),
):
    """Replace the current user's portfolio document. Strictly scoped to the
    authenticated owner — a user can never read or write another user's data."""
    pf = session.get(Portfolio, user.id)
    now = datetime.now(timezone.utc)
    if pf:
        pf.projects = payload.projects
        pf.updated_at = now
    else:
        pf = Portfolio(user_id=user.id, projects=payload.projects, updated_at=now)
    session.add(pf)
    session.commit()
    session.refresh(pf)
    return PortfolioRead(projects=pf.projects or [], updated_at=pf.updated_at.isoformat())


@router.post("/assess", response_model=Recommendation)
def assess(
    form: IntakeForm,
    _user: User = Depends(get_current_user),
):
    """Run a single-system assessment through the deterministic engine and
    attach a narrative. Any authenticated user may run an assessment."""
    x = form.model_dump()
    # Derive the two computed inputs the engine expects.
    x["customization_level_per_module"] = {"OVERALL": form.overall_customization}
    x["dual_stack"] = form.stack_type == "dual_stack"
    result = recommend(x)
    result["narrative"] = llm_narrative(result)
    return result


@router.post("/assess/import-readiness")
def import_readiness(
    file: UploadFile = File(...),
    _user: User = Depends(get_current_user),
):
    """Parse an uploaded SAP Readiness Check export (.zip) into a pre-filled
    intake + extraction summary. The architect reviews before scoring."""
    try:
        data = file.file.read()
        return parse_zip(data)
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail=f"Could not parse readiness export: {e}")


@router.post("/assess/import-ewa")
def import_ewa(
    file: UploadFile = File(...),
    _user: User = Depends(get_current_user),
):
    """Parse an uploaded SAP EarlyWatch Alert export (HTML or XLSX) into a
    pre-filled intake + extraction summary, in the same shape as the Readiness
    Check import. The architect reviews before scoring."""
    try:
        data = file.file.read()
        return parse_ewa(data, file.filename)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail=f"Could not parse EarlyWatch export: {e}")


@router.post("/assess/import-atc")
def import_atc(
    file: UploadFile = File(...),
    _user: User = Depends(get_current_user),
):
    """Parse an uploaded SAP ATC / Custom Code Check export (XLSX or ZIP) into
    a pre-filled intake + extraction summary."""
    try:
        data = file.file.read()
        return parse_atc(data, file.filename)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail=f"Could not parse ATC export: {e}")


@router.post("/assess/import-simplification")
def import_simplification(
    file: UploadFile = File(...),
    _user: User = Depends(get_current_user),
):
    """Parse an uploaded SAP Simplification Item Check export (XLSX or ZIP) into
    a pre-filled intake + extraction summary."""
    try:
        data = file.file.read()
        return parse_simplification(data, file.filename)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail=f"Could not parse Simplification Item export: {e}")
