"""Unified LLM client for STAR — ported from the CoreVantage `LLMClient`.

Supports SAP AI Core (Gen AI Hub), GROQ, Anthropic and OpenAI behind one
`complete(system_prompt, user_message)` call with retry/backoff. Provider SDKs
are imported lazily, so only the provider you actually use needs to be installed.

STAR uses this for *narrative only* — per the engine's golden rule, the LLM never
changes scores, gates, confidence or the recommended path. See `narrative.py`.

SAP AI Core note (from CoreVantage): we build `AICoreV2Client` ourselves to avoid
the `client_type` incompatibility between generative-ai-hub-sdk 3.x and
ai-api-client-sdk 2.6+. Anthropic models on AI Core use a direct `/invoke`
endpoint rather than the OpenAI-compatible chat/completions path.
"""
from __future__ import annotations

import logging
import os
import time

_DEFAULT_TEMPERATURE = 0.1
_DEFAULT_MAX_TOKENS = 4096
_MAX_RETRIES = 2
_RETRY_BACKOFF = 2.0

logger = logging.getLogger(__name__)

PROVIDER_LABELS = {
    "sap_ai_core": "SAP AI Core",
    "groq": "GROQ",
    "anthropic": "Anthropic",
    "openai": "OpenAI",
}


class LLMClient:
    """Provider-agnostic chat-completion wrapper.

    client = LLMClient(provider="anthropic", api_key="sk-ant-...", model="claude-sonnet-4-6")
    text   = client.complete("system prompt", "user message")
    """

    def __init__(self, provider: str = "anthropic", **kwargs):
        self.provider = (provider or "anthropic").lower()
        self._init_provider(**kwargs)

    # ── Initialisers ──────────────────────────────────────────────────────────

    def _init_provider(self, **kwargs):
        dispatch = {
            "sap_ai_core": self._init_sap,
            "groq": self._init_groq,
            "anthropic": self._init_anthropic,
            "openai": self._init_openai,
        }
        fn = dispatch.get(self.provider)
        if not fn:
            raise ValueError(
                f"Unknown provider '{self.provider}'. Choose: sap_ai_core | groq | anthropic | openai")
        fn(**kwargs)

    def _init_sap(self, **kwargs):
        try:
            from ai_core_sdk.ai_core_v2_client import AICoreV2Client
            from gen_ai_hub.proxy.core.proxy_clients import get_proxy_client
            from gen_ai_hub.proxy.native.openai import OpenAI
        except ImportError:
            raise ImportError("Run: pip install generative-ai-hub-sdk")

        client_kwargs: dict = {}
        if kwargs.get("client_id"):
            client_kwargs["client_id"] = kwargs["client_id"]
        if kwargs.get("client_secret"):
            client_kwargs["client_secret"] = kwargs["client_secret"]
        if kwargs.get("auth_url"):
            client_kwargs["auth_url"] = kwargs["auth_url"]
        if kwargs.get("base_url"):
            raw = kwargs["base_url"].rstrip("/")
            client_kwargs["base_url"] = raw if raw.endswith("/v2") else f"{raw}/v2"
        if kwargs.get("resource_group"):
            client_kwargs["resource_group"] = kwargs["resource_group"]

        ai_core_client = AICoreV2Client.from_env(**client_kwargs)
        self._proxy_client = get_proxy_client("gen-ai-hub", ai_core_client=ai_core_client)

        self.model = (kwargs.get("model_name")
                      or os.getenv("AICORE_MODEL")
                      or os.getenv("SAP_AI_CORE_MODEL_NAME")
                      or "gpt-4o")
        self._sap_is_anthropic = self.model.lower().startswith("anthropic--")

        if self._sap_is_anthropic:
            # Accept both AICORE_* (CoreVantage style) and SAP_AI_CORE_* (legacy style).
            raw_base = (os.getenv("AICORE_BASE_URL") or os.getenv("SAP_AI_CORE_API_URL") or "").rstrip("/")
            self._sap_base_url = raw_base if raw_base.endswith("/v2") else f"{raw_base}/v2"
            self._sap_auth_url = (os.getenv("AICORE_AUTH_URL") or os.getenv("SAP_AI_CORE_AUTH_URL") or "").rstrip("/")
            self._sap_client_id = os.getenv("AICORE_CLIENT_ID") or os.getenv("SAP_AI_CORE_CLIENT_ID") or ""
            self._sap_client_secret = os.getenv("AICORE_CLIENT_SECRET") or os.getenv("SAP_AI_CORE_CLIENT_SECRET") or ""
            self._sap_deployment_id = (
                os.getenv("SAP_AI_CORE_DEPLOYMENT_ID") or os.getenv("AICORE_DEPLOYMENT_ID") or ""
            ).strip()
            self._sap_resource_group = (
                os.getenv("AICORE_RESOURCE_GROUP") or os.getenv("SAP_AI_CORE_RESOURCE_GROUP") or "default"
            )
            self._sap_token = None
            self._sap_token_expiry = 0.0
        else:
            self._sap_client = OpenAI(proxy_client=self._proxy_client)

        self.display_name = f"SAP AI Core | {self.model}"
        logger.info("SAP AI Core initialised — model: %s", self.model)

    def _get_sap_token(self) -> str:
        import requests as _req
        if self._sap_token and time.time() < self._sap_token_expiry - 60:
            return self._sap_token
        r = _req.post(
            f"{self._sap_auth_url}/oauth/token",
            data={"grant_type": "client_credentials",
                  "client_id": self._sap_client_id,
                  "client_secret": self._sap_client_secret},
            timeout=15,
        )
        r.raise_for_status()
        data = r.json()
        self._sap_token = data["access_token"]
        self._sap_token_expiry = time.time() + data.get("expires_in", 3600)
        return self._sap_token

    def _init_groq(self, **kwargs):
        try:
            from groq import Groq
        except ImportError:
            raise ImportError("Run: pip install groq")
        api_key = kwargs.get("api_key") or os.getenv("GROQ_API_KEY")
        if not api_key:
            raise ValueError("GROQ_API_KEY not set.")
        self.model = kwargs.get("model", "llama-3.3-70b-versatile")
        self._client = Groq(api_key=api_key)
        self.display_name = f"GROQ | {self.model}"

    def _init_anthropic(self, **kwargs):
        try:
            import anthropic as _a
        except ImportError:
            raise ImportError("Run: pip install anthropic")
        api_key = kwargs.get("api_key") or os.getenv("ANTHROPIC_API_KEY")
        if not api_key:
            raise ValueError("ANTHROPIC_API_KEY not set.")
        self.model = kwargs.get("model", "claude-sonnet-4-6")
        self._client = _a.Anthropic(api_key=api_key)
        self.display_name = f"Anthropic | {self.model}"

    def _init_openai(self, **kwargs):
        try:
            from openai import OpenAI
        except ImportError:
            raise ImportError("Run: pip install openai")
        api_key = kwargs.get("api_key") or os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise ValueError("OPENAI_API_KEY not set.")
        self.model = kwargs.get("model", "gpt-4o")
        self._client = OpenAI(api_key=api_key)
        self.display_name = f"OpenAI | {self.model}"

    # ── Core API ──────────────────────────────────────────────────────────────

    def complete(
        self,
        system_prompt: str,
        user_message: str,
        max_tokens: int = _DEFAULT_MAX_TOKENS,
        temperature: float = _DEFAULT_TEMPERATURE,
    ) -> str:
        dispatch = {
            "sap_ai_core": self._complete_sap,
            "groq": self._complete_groq,
            "anthropic": self._complete_anthropic,
            "openai": self._complete_openai,
        }
        fn, last_error = dispatch[self.provider], None
        for attempt in range(1, _MAX_RETRIES + 2):
            try:
                return fn(system_prompt, user_message, max_tokens, temperature)
            except Exception as exc:
                last_error = exc
                if attempt <= _MAX_RETRIES:
                    wait = _RETRY_BACKOFF * attempt
                    logger.warning("Attempt %d failed: %s — retrying in %.1fs", attempt, exc, wait)
                    time.sleep(wait)
        raise RuntimeError(
            f"LLM failed after {_MAX_RETRIES + 1} attempts. Last: {last_error}") from last_error

    def _complete_sap(self, sys_p, user_p, max_tok, temp):
        if self._sap_is_anthropic:
            import requests as _req
            token = self._get_sap_token()
            url = f"{self._sap_base_url}/inference/deployments/{self._sap_deployment_id}/invoke"
            r = _req.post(url, json={
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": max_tok,
                "system": sys_p,
                "messages": [{"role": "user", "content": user_p}],
            }, headers={
                "Authorization": f"Bearer {token}",
                "AI-Resource-Group": self._sap_resource_group,
                "Content-Type": "application/json",
            }, timeout=120)
            r.raise_for_status()
            return r.json()["content"][0]["text"]
        r = self._sap_client.chat.completions.create(
            model=self.model,
            messages=[{"role": "system", "content": sys_p}, {"role": "user", "content": user_p}],
            temperature=temp, max_tokens=max_tok,
        )
        return r.choices[0].message.content

    def _complete_groq(self, sys_p, user_p, max_tok, temp):
        r = self._client.chat.completions.create(
            model=self.model,
            messages=[{"role": "system", "content": sys_p}, {"role": "user", "content": user_p}],
            temperature=temp, max_tokens=max_tok,
        )
        return r.choices[0].message.content

    def _complete_anthropic(self, sys_p, user_p, max_tok, temp):
        m = self._client.messages.create(
            model=self.model, max_tokens=max_tok, temperature=temp,
            system=sys_p, messages=[{"role": "user", "content": user_p}],
        )
        return m.content[0].text

    def _complete_openai(self, sys_p, user_p, max_tok, temp):
        r = self._client.chat.completions.create(
            model=self.model,
            messages=[{"role": "system", "content": sys_p}, {"role": "user", "content": user_p}],
            temperature=temp, max_tokens=max_tok,
        )
        return r.choices[0].message.content

    def ping(self) -> str:
        return self.complete(
            "You are a helpful assistant.", "Reply with exactly one word: OK", max_tokens=5).strip()

    def __repr__(self):
        return f"LLMClient(provider={self.provider!r}, model={getattr(self, 'display_name', '?')!r})"
