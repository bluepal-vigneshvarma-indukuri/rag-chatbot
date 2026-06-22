"""Shared helpers for OpenAI-compatible API clients."""
from urllib.parse import urlparse


def normalize_base_url(url: str) -> str:
    """Strip trailing slashes and accidental endpoint paths."""
    url = url.strip().rstrip("/")
    for suffix in ("/chat/completions", "/embeddings"):
        if url.endswith(suffix):
            url = url[: -len(suffix)]
    return url


def display_host(url: str) -> str:
    """Human-readable host label for error messages."""
    try:
        return urlparse(normalize_base_url(url)).netloc or url
    except Exception:
        return url


def is_localhost(url: str) -> bool:
    try:
        host = urlparse(normalize_base_url(url)).hostname or ""
    except Exception:
        return False
    return host in ("localhost", "127.0.0.1", "0.0.0.0", "::1")


def validate_base_url(url: str) -> str | None:
    """Return an error message if the URL is invalid, else None."""
    if not url or not url.strip():
        return "API base URL is required."
    try:
        parsed = urlparse(url.strip())
        if parsed.scheme not in ("http", "https"):
            return "URL must start with http:// or https://."
        if not parsed.netloc:
            return "Invalid API base URL."
    except Exception:
        return "Invalid API base URL."
    return None
