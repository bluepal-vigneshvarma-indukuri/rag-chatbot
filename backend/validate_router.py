"""
/validate endpoint — tests API base URL + model + key before the user starts chatting.
Returns structured { chat: {...}, embed: {...} } results.
"""
import asyncio
from fastapi import APIRouter, Depends
from pydantic import BaseModel

from auth.middleware import get_current_user
from providers.openai_compat import (
    display_host,
    is_localhost,
    normalize_base_url,
    validate_base_url,
)

router = APIRouter(prefix="/validate", tags=["validate"])


class ValidateRequest(BaseModel):
    chat_base_url: str = ""
    chat_model: str = ""
    chat_api_key: str = ""
    embed_base_url: str = ""
    embed_model: str = ""
    embed_api_key: str = ""
    embed_disabled: bool = False


@router.post("/")
async def validate_providers(
    req: ValidateRequest,
    user: dict = Depends(get_current_user),
):
    """Test both chat and embedding endpoints. Returns ok/error per section."""
    loop = asyncio.get_event_loop()
    chat_result, embed_result = await asyncio.gather(
        loop.run_in_executor(None, lambda: _test_chat(req)),
        loop.run_in_executor(None, lambda: _test_embed(req)),
    )
    return {"chat": chat_result, "embed": embed_result}


# ── Chat validation ───────────────────────────────────────────────────────────

def _test_chat(req: ValidateRequest) -> dict:
    url_err = validate_base_url(req.chat_base_url)
    if url_err:
        return {"status": "error", "code": "invalid_base_url", "message": url_err}

    if not req.chat_model.strip():
        return {"status": "error", "code": "model_not_found", "message": "Model name is required."}

    if not req.chat_api_key and not is_localhost(req.chat_base_url):
        return {"status": "error", "code": "missing_api_key", "message": "No API key provided."}

    host = display_host(req.chat_base_url)
    try:
        from openai import OpenAI
        client = OpenAI(
            api_key=req.chat_api_key or "not-needed",
            base_url=normalize_base_url(req.chat_base_url),
        )
        client.chat.completions.create(
            model=req.chat_model,
            messages=[{"role": "user", "content": "hi"}],
            max_tokens=1,
        )
        return {"status": "ok", "message": f"Connected to {host} / {req.chat_model}"}

    except Exception as exc:
        return _classify_error(exc, req.chat_model, host)


# ── Embed validation ──────────────────────────────────────────────────────────

def _test_embed(req: ValidateRequest) -> dict:
    if req.embed_disabled:
        return {"status": "ok", "message": "Text-only search — no embedding needed."}

    url_err = validate_base_url(req.embed_base_url)
    if url_err:
        return {"status": "error", "code": "invalid_base_url", "message": url_err}

    if not req.embed_model.strip():
        return {"status": "error", "code": "model_not_found", "message": "Embedding model name is required."}

    if not req.embed_api_key and not is_localhost(req.embed_base_url):
        return {"status": "error", "code": "missing_api_key", "message": "No embedding API key provided."}

    host = display_host(req.embed_base_url)
    try:
        from openai import OpenAI
        client = OpenAI(
            api_key=req.embed_api_key or "not-needed",
            base_url=normalize_base_url(req.embed_base_url),
        )
        client.embeddings.create(model=req.embed_model, input="test")
        return {"status": "ok", "message": f"Connected to {host} / {req.embed_model}"}

    except Exception as exc:
        return _classify_error(exc, req.embed_model, host)


# ── Error classifier ──────────────────────────────────────────────────────────

def _classify_error(exc: Exception, model: str, host: str) -> dict:
    try:
        from openai import AuthenticationError, NotFoundError, BadRequestError, RateLimitError
        if isinstance(exc, AuthenticationError):
            return {"status": "error", "code": "invalid_api_key",
                    "message": f"Invalid or expired API key for '{host}'."}
        if isinstance(exc, NotFoundError):
            return {"status": "error", "code": "model_not_found",
                    "message": f"Model '{model}' not found for '{host}'."}
        if isinstance(exc, BadRequestError):
            if "model" in str(exc).lower():
                return {"status": "error", "code": "model_not_found",
                        "message": f"Model '{model}' is not available for '{host}'."}
        if isinstance(exc, RateLimitError):
            return {"status": "error", "code": "rate_limit",
                    "message": f"Rate limit reached for '{host}'. Try again shortly."}
    except ImportError:
        pass

    msg = str(exc).lower()
    if any(k in msg for k in ("connection", "connect", "refused", "timeout", "name or service", "unreachable")):
        return {"status": "error", "code": "connection_failed",
                "message": f"Could not reach API server at '{host}'. Check the URL."}
    if any(k in msg for k in ("auth", "api key", "unauthorized", "invalid_api_key", "incorrect api")):
        return {"status": "error", "code": "invalid_api_key",
                "message": f"Invalid or expired API key for '{host}'."}
    if any(k in msg for k in ("model", "not found", "does not exist")):
        return {"status": "error", "code": "model_not_found",
                "message": f"Model '{model}' was not found for '{host}'."}

    return {"status": "error", "code": "unknown", "message": str(exc)[:300]}
