"""STAR domain schemas: the assessment intake, the engine result, and the
per-user portfolio (projects -> assessments)."""
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field


class IntakeForm(BaseModel):
    """Single-system intake. Account fields are merged in from the parent
    project by the frontend before calling /assess."""
    system_id: str = Field(min_length=1, max_length=64)
    product_release: Literal["ecc6_ehp", "ecc6", "soh", "s4hana", "pre_ecc6"]
    s4_version: Optional[str] = None
    unicode_status: Literal["unicode", "non_unicode"]
    stack_type: Literal["single_stack", "dual_stack"] = "single_stack"
    db_size_band: str

    modules_implemented: List[str] = Field(default_factory=list)
    process_reengineering_appetite: str
    custom_objects_band: str
    overall_customization: Literal["Low", "Med", "High"]
    pct_active_estimate: float = 50
    modifications_to_standard: str = "false"

    # interface / integration landscape
    interface_count_band: str = "50_100"
    interface_complexity: str = "medium"
    non_sap_share: str = "medium"
    middleware: str = "sap_pi_po"

    data_quality: str
    history_retention: str
    landscape_intent: str

    primary_driver: str
    target_golive: str
    risk_disruption_tolerance: str
    budget_posture: str
    change_mgmt_maturity: str

    basis_ops_capability: str
    existing_hyperscaler: str
    data_sovereignty_strictness: str
    target_deployment_pref: str

    # account context (carried for the report; not used by scoring math)
    entity_name: Optional[str] = None
    brand_name: Optional[str] = None
    system_owner_customer: Optional[str] = None
    sparc_owner: Optional[str] = None
    gtp_owner: Optional[str] = None


class Recommendation(BaseModel):
    """Engine output. Mirrors the object the React UI renders."""
    approach: str
    deployment: str
    approachConf: str
    deployConf: str
    approachScores: Optional[Dict[str, float]] = None
    deployScores: Dict[str, float]
    intensity: Optional[str] = None
    blockers: List[Dict[str, Any]] = Field(default_factory=list)
    prereq: List[str] = Field(default_factory=list)
    waves: List[str] = Field(default_factory=list)
    dbNote: Optional[str] = None
    soh: bool = False
    trace: List[Dict[str, Any]] = Field(default_factory=list)
    upgrade: bool = False
    currentVersion: Optional[str] = None
    targetVersion: Optional[str] = None
    behind: Optional[bool] = None
    narrative: List[str] = Field(default_factory=list)
    system_id: Optional[str] = None
    entity_name: Optional[str] = None
    brand_name: Optional[str] = None
    system_owner_customer: Optional[str] = None
    sparc_owner: Optional[str] = None
    gtp_owner: Optional[str] = None
    modules: List[str] = Field(default_factory=list)


class PortfolioRead(BaseModel):
    projects: List[dict] = Field(default_factory=list)
    updated_at: Optional[str] = None


class PortfolioWrite(BaseModel):
    projects: List[dict] = Field(default_factory=list)
