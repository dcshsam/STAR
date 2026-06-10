"""Narrative generation for the steering-committee report.

`build_narrative` is the always-available deterministic fallback (no network).
`llm_narrative` is the production path: reads LLM settings from config, builds an
LLMClient (same provider/model logic as CoreVantage), and returns 3-5 paragraphs.
It is OFF by default (USE_LLM_NARRATIVE=false) and falls back to the deterministic
narrative on any error — so the app always runs offline.

GOLDEN RULE: the LLM writes prose only. It must never change scores, gates,
confidence, or the recommended approach/deployment. Those come from the engine.
"""
import logging
from typing import List

logger = logging.getLogger(__name__)

APPROACH_LABEL = {
    "GREENFIELD": "Greenfield (new implementation)",
    "BROWNFIELD": "Brownfield (system conversion)",
    "BLUEFIELD": "Bluefield (selective data transition)",
    "UPGRADE": "S/4HANA release upgrade",
}
DEPLOY_LABEL = {
    "RISE_PRIVATE": "RISE with SAP, Private Cloud Edition",
    "HYPERSCALER_SELF": "self-managed on a hyperscaler",
    "ON_PREM": "on-premise",
}


def build_narrative(r: dict) -> List[str]:
    """Deterministic, copy-safe narrative paragraphs derived from the trace."""
    out: List[str] = []
    sysid = r.get("system_id") or "the system"
    appr = APPROACH_LABEL.get(r["approach"], r["approach"])
    dep = DEPLOY_LABEL.get(r["deployment"], r["deployment"])

    if r.get("upgrade"):
        if r.get("behind"):
            out.append(
                f"{sysid} is already running SAP S/4HANA {r.get('currentVersion')}, so the "
                f"transformation is a release upgrade to S/4HANA {r.get('targetVersion')} via SUM "
                f"— not a greenfield or brownfield conversion.")
        else:
            out.append(
                f"{sysid} is already on the latest SAP S/4HANA release "
                f"({r.get('targetVersion')}). No version upgrade is required; the focus shifts to "
                f"adopting the newest Feature Pack Stack and innovations.")
        out.append(
            f"For deployment, STAR recommends {dep} (confidence: {r.get('deployConf')}), driven by "
            f"the operating-model and infrastructure inputs in the assessment.")
        return out

    out.append(
        f"STAR recommends a {appr} for {sysid}, with {dep} as the target deployment. "
        f"Approach confidence is {r.get('approachConf')} and deployment confidence is "
        f"{r.get('deployConf')}.")

    drivers = [t for t in r.get("trace", [])
               if isinstance(t.get("contribution"), dict)
               and t["contribution"].get(r["approach"], 0) > 0]
    drivers.sort(key=lambda t: t["contribution"].get(r["approach"], 0), reverse=True)
    if drivers:
        top = ", ".join(f"{d['factor'].lower()} ({d['answer']})" for d in drivers[:3])
        out.append(f"The strongest factors pointing to this approach were {top}.")

    if r.get("dbNote"):
        out.append(r["dbNote"])

    if r.get("blockers"):
        gates = "; ".join(b["gate"] for b in r["blockers"])
        out.append(
            f"Technical gates were triggered ({gates}). These must be resolved as prerequisites "
            f"before the conversion can proceed: " + "; ".join(r.get("prereq", [])) + ".")

    out.append(
        "This recommendation is produced by a deterministic, weighted scoring model — every score "
        "above is traceable to a specific input, so it can be defended to a steering committee.")
    return out


def _client_for_provider(provider: str, model: str):
    """Build an LLMClient for the given provider+model. Returns None if credentials
    are missing or the SDK is not installed."""
    from app.core.config import settings
    from app.engine.llm_client import LLMClient

    p = provider.lower()

    if p == "anthropic":
        key = settings.ANTHROPIC_API_KEY
        if not key:
            logger.warning("LLM provider 'anthropic' selected but ANTHROPIC_API_KEY is not set")
            return None
        kwargs: dict = {"model": model or "claude-sonnet-4-6", "api_key": key}

    elif p == "openai":
        key = settings.OPENAI_API_KEY
        if not key:
            logger.warning("LLM provider 'openai' selected but OPENAI_API_KEY is not set")
            return None
        kwargs = {"model": model or "gpt-4o", "api_key": key}

    elif p == "groq":
        key = settings.GROQ_API_KEY
        if not key:
            logger.warning("LLM provider 'groq' selected but GROQ_API_KEY is not set")
            return None
        kwargs = {"model": model or "llama-3.3-70b-versatile", "api_key": key}

    elif p == "sap_ai_core":
        # Credentials are read from env vars by AICoreV2Client.from_env(); we just
        # need at least one of the client ID vars to be set to know it's configured.
        import os
        cid = (settings.AICORE_CLIENT_ID
               or os.getenv("SAP_AI_CORE_CLIENT_ID", ""))
        if not cid:
            logger.warning("LLM provider 'sap_ai_core' selected but AICORE_CLIENT_ID is not set")
            return None
        kwargs = {"model_name": model or settings.AICORE_MODEL or "gpt-4o"}

    else:
        logger.warning("Unknown LLM provider '%s'", provider)
        return None

    try:
        return LLMClient(provider=p, **kwargs)
    except Exception as exc:
        logger.warning("LLMClient(%s) init failed: %s", provider, exc)
        return None


def _build_llm_client():
    """Try the primary provider; if it can't be initialised, try the fallback.
    Returns None only if both are unavailable."""
    from app.core.config import settings

    client = _client_for_provider(settings.LLM_PROVIDER, settings.LLM_MODEL)
    if client is not None:
        return client

    fb = settings.LLM_FALLBACK_PROVIDER
    if fb and fb.lower() != settings.LLM_PROVIDER.lower():
        logger.info("Primary LLM provider '%s' unavailable — trying fallback '%s'",
                    settings.LLM_PROVIDER, fb)
        client = _client_for_provider(fb, settings.LLM_FALLBACK_MODEL)
        if client is not None:
            return client

    return None


def llm_narrative(r: dict) -> List[str]:
    """Production narrative via the configured LLM provider.
    Falls back to the deterministic narrative if disabled or unavailable."""
    from app.core.config import settings

    if not settings.USE_LLM_NARRATIVE:
        return build_narrative(r)

    client = _build_llm_client()
    if client is None:
        return build_narrative(r)

    system = (
        "You are a senior SAP enterprise architect writing a concise steering-committee "
        "narrative that explains a system transformation recommendation. "
        "Use ONLY the supplied decision trace and scores — do NOT invent facts, change "
        "the recommended path, alter scores, or add risks not present in the trace. "
        "Return exactly 3-5 short paragraphs with no bullet points or headers.")

    msg = (
        f"System: {r.get('system_id', 'unknown')}. "
        f"Approach: {r['approach']} (confidence {r.get('approachConf')}). "
        f"Deployment: {r['deployment']} (confidence {r.get('deployConf')}). "
        f"Score trace: {r.get('trace', [])}. "
        f"Hard gates triggered: {r.get('blockers', [])}. "
        f"Prerequisites: {r.get('prereq', [])}. "
        f"DB note: {r.get('dbNote', '')}. "
        f"Upgrade path: {r.get('upgrade', False)}.")

    try:
        text = client.complete(system, msg,
                               max_tokens=settings.LLM_MAX_TOKENS,
                               temperature=settings.LLM_TEMPERATURE)
        logger.info("LLM narrative generated via %s", client.display_name)
        paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
        return paragraphs if paragraphs else build_narrative(r)

    except Exception as exc:
        logger.warning("LLM narrative runtime error (%s): %s — falling back to deterministic",
                       client.display_name, exc)
        # If the primary provider errored at runtime (e.g. network/quota), try Anthropic directly.
        fb = settings.LLM_FALLBACK_PROVIDER
        if fb and fb.lower() != settings.LLM_PROVIDER.lower() and settings.ANTHROPIC_API_KEY:
            try:
                fallback = _client_for_provider(fb, settings.LLM_FALLBACK_MODEL)
                if fallback:
                    text = fallback.complete(system, msg,
                                             max_tokens=settings.LLM_MAX_TOKENS,
                                             temperature=settings.LLM_TEMPERATURE)
                    logger.info("LLM narrative generated via fallback %s", fallback.display_name)
                    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
                    return paragraphs if paragraphs else build_narrative(r)
            except Exception as fb_exc:
                logger.warning("Fallback LLM also failed: %s", fb_exc)
        return build_narrative(r)
