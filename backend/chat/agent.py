"""
OpenAI-compatible RAG agent with tool calling.

Any server exposing OpenAI-style chat + embeddings APIs is supported via base URL.
"""
import json
from typing import List, Optional

from config import get_settings
from providers.openai_compat import display_host, is_localhost, normalize_base_url
from retrieval.retriever import hybrid_search, get_chunks_by_ids

MAX_TOOL_ROUNDS = 4
TOTAL_CONTEXT_CAP = 12000

# ── Tool schemas ──────────────────────────────────────────────────────────────

_SEARCH_TOOL_PARAMS = {
    "type": "object",
    "properties": {
        "query": {
            "type": "string",
            "description": "The search query — rephrase for best results",
        },
    },
    "required": ["query"],
}

_READ_TOOL_PARAMS = {
    "type": "object",
    "properties": {
        "chunk_ids": {
            "type": "array",
            "items": {"type": "string"},
            "description": "List of chunk UUIDs to read in full",
        },
    },
    "required": ["chunk_ids"],
}

TOOLS_OPENAI = [
    {
        "type": "function",
        "function": {
            "name": "search_documents",
            "description": (
                "Search uploaded documents using hybrid keyword + semantic search. "
                "Call this first when you need to find relevant information. "
                "Returns passages with chunk IDs for citation."
            ),
            "parameters": _SEARCH_TOOL_PARAMS,
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_chunks",
            "description": "Fetch full text for specific chunk IDs when you need more detail.",
            "parameters": _READ_TOOL_PARAMS,
        },
    },
]

SYSTEM_PROMPT = """You are a precise document assistant. Answer questions using ONLY the content retrieved from the user's uploaded documents.

Rules:
1. Always call search_documents first before answering.
2. If initial results are insufficient, call search_documents again with a different query or call read_chunks for specific passages.
3. Base your answer ONLY on retrieved passages — never invent information.
4. For every claim, add a citation marker [1], [2], etc.
5. At the end, include a JSON block (CITATIONS section) listing each citation with its chunk_id and verbatim excerpt.
6. If the documents don't contain enough information, say so clearly.

Citation format in your answer:
... the system uses role-based access control [1]. Admins can manage users [2].

CITATIONS:
```json
[
  {"citation_index": 1, "chunk_id": "uuid-here", "excerpt": "verbatim text from chunk"},
  {"citation_index": 2, "chunk_id": "uuid-here", "excerpt": "verbatim text from chunk"}
]
```
"""


# ── Custom exception ──────────────────────────────────────────────────────────

class AgentError(Exception):
    """Structured error returned to the chat router and frontend."""
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


# ── Public entry point ────────────────────────────────────────────────────────

def run_agent(
    question: str,
    user_id: str,
    document_ids: Optional[List[str]] = None,
    chat_base_url: str = "https://api.groq.com/openai/v1",
    chat_model: str = "llama-3.3-70b-versatile",
    chat_api_key: str = "",
    embed_base_url: str = "https://api.openai.com/v1",
    embed_model: str = "text-embedding-3-small",
    embed_api_key: str = "",
    embed_disabled: bool = False,
) -> dict:
    """
    Run the RAG agent and return:
      { answer, citations, retrieved_chunks, insufficient_evidence }
    Raises AgentError on provider-level failures.
    """
    settings = get_settings()

    # Fall back to .env keys when the user didn't supply their own
    if not chat_api_key:
        if is_localhost(chat_base_url):
            chat_api_key = "not-needed"
        elif "groq.com" in chat_base_url:
            chat_api_key = settings.groq_api_key
        elif "openai.com" in chat_base_url:
            chat_api_key = settings.openai_api_key

    if not embed_api_key and not embed_disabled:
        if embed_base_url and is_localhost(embed_base_url):
            embed_api_key = "not-needed"
        elif "openai.com" in (embed_base_url or ""):
            embed_api_key = settings.openai_api_key

    if not chat_api_key:
        raise AgentError(
            "missing_api_key",
            "No API key provided. Please enter your API key in Settings.",
        )

    db_url = settings.database_url
    return _run_openai_compat_agent(
        question, user_id, document_ids,
        chat_base_url, chat_model, chat_api_key,
        embed_base_url, embed_model, embed_api_key, embed_disabled,
        db_url,
    )


# ── OpenAI-compatible agent ───────────────────────────────────────────────────

def _run_openai_compat_agent(
    question, user_id, document_ids,
    base_url, model, api_key,
    embed_base_url, embed_model, embed_api_key, embed_disabled,
    db_url,
):
    from openai import OpenAI
    from openai import AuthenticationError, NotFoundError, BadRequestError, RateLimitError

    host = display_host(base_url)
    try:
        client = OpenAI(api_key=api_key, base_url=normalize_base_url(base_url))
    except Exception as exc:
        raise AgentError("client_error", str(exc))

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": question},
    ]
    retrieved_chunks: List[dict] = []

    try:
        for _ in range(MAX_TOOL_ROUNDS):
            response = client.chat.completions.create(
                model=model,
                messages=messages,
                tools=TOOLS_OPENAI,
                tool_choice="auto",
                max_tokens=4096,
                temperature=0.1,
            )
            msg = response.choices[0].message

            if not msg.tool_calls:
                return _parse_answer(msg.content or "", retrieved_chunks)

            messages.append({
                "role": "assistant",
                "content": msg.content or "",
                "tool_calls": [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.function.name,
                            "arguments": tc.function.arguments,
                        },
                    }
                    for tc in msg.tool_calls
                ],
            })

            for tc in msg.tool_calls:
                result = _execute_tool(
                    tc.function.name, tc.function.arguments,
                    user_id, document_ids,
                    embed_base_url, embed_model, embed_api_key, embed_disabled,
                    retrieved_chunks, db_url,
                )
                messages.append({"role": "tool", "tool_call_id": tc.id, "content": result})

        messages.append({
            "role": "user",
            "content": "Please provide your best answer based on what you have found so far.",
        })
        final = client.chat.completions.create(
            model=model, messages=messages, max_tokens=4096, temperature=0.1,
        )
        return _parse_answer(final.choices[0].message.content or "", retrieved_chunks)

    except AuthenticationError:
        raise AgentError(
            "invalid_api_key",
            f"Invalid or expired API key for '{host}'. Please check your key in Settings.",
        )
    except NotFoundError:
        raise AgentError(
            "model_not_found",
            f"Model '{model}' was not found at '{host}'. Please check the model name in Settings.",
        )
    except BadRequestError as exc:
        if "model" in str(exc).lower():
            raise AgentError(
                "model_not_found",
                f"Model '{model}' is not available at '{host}'. Please check the model name in Settings.",
            )
        raise AgentError("bad_request", str(exc))
    except RateLimitError:
        raise AgentError(
            "rate_limit",
            f"Rate limit reached for '{host}'. Please wait a moment and try again.",
        )


# ── Tool executor ─────────────────────────────────────────────────────────────

def _execute_tool(
    name: str,
    arguments_json: str,
    user_id: str,
    document_ids,
    embed_base_url: str,
    embed_model: str,
    embed_api_key: str,
    embed_disabled: bool,
    retrieved_chunks: list,
    db_url: str,
) -> str:
    try:
        args = json.loads(arguments_json)
    except json.JSONDecodeError:
        return json.dumps({"error": "Invalid tool arguments"})

    if name == "search_documents":
        query = args.get("query", "")
        if not query:
            return json.dumps({"error": "query is required"})

        query_embedding = _embed_query(
            query, embed_base_url, embed_model, embed_api_key, embed_disabled,
        )

        chunks = hybrid_search(
            query=query,
            user_id=user_id,
            document_ids=document_ids,
            query_embedding=query_embedding,
            db_url=db_url,
        )

        seen_ids = {c["chunk_id"] for c in retrieved_chunks}
        for c in chunks:
            if c["chunk_id"] not in seen_ids:
                retrieved_chunks.append(c)
                seen_ids.add(c["chunk_id"])

        if not chunks:
            return json.dumps({"message": "No relevant passages found", "passages": []})

        passages = [
            {"chunk_id": c["chunk_id"], "filename": c["filename"], "excerpt": c["excerpt"]}
            for c in chunks
        ]

        total, capped = 0, []
        for p in passages:
            total += len(p["excerpt"])
            capped.append(p)
            if total >= TOTAL_CONTEXT_CAP:
                break

        return json.dumps({"passages": capped})

    elif name == "read_chunks":
        chunk_ids = args.get("chunk_ids", [])
        if not chunk_ids:
            return json.dumps({"error": "chunk_ids required"})

        chunks = get_chunks_by_ids(chunk_ids, db_url)

        seen_ids = {c["chunk_id"] for c in retrieved_chunks}
        for c in chunks:
            if c["chunk_id"] not in seen_ids:
                retrieved_chunks.append(c)
                seen_ids.add(c["chunk_id"])

        return json.dumps({"passages": chunks})

    return json.dumps({"error": f"Unknown tool: {name}"})


# ── Embedding helper ──────────────────────────────────────────────────────────

def _embed_query(
    query: str,
    base_url: str,
    model: str,
    api_key: str,
    embed_disabled: bool,
) -> Optional[List[float]]:
    """Embed a query string for vector search. Returns None on failure (falls back to FTS)."""
    if embed_disabled or not base_url or not api_key or not model:
        return None
    try:
        from openai import OpenAI
        client = OpenAI(api_key=api_key, base_url=normalize_base_url(base_url))
        resp = client.embeddings.create(model=model, input=query)
        return resp.data[0].embedding
    except Exception:
        return None


# ── Answer parser ─────────────────────────────────────────────────────────────

def _parse_answer(text: str, retrieved_chunks: List[dict]) -> dict:
    import re
    citations = []
    answer = text

    json_match = re.search(r"CITATIONS:\s*```json\s*(\[.*?\])\s*```", text, re.DOTALL)
    if json_match:
        try:
            citations = json.loads(json_match.group(1))
            answer = text[: json_match.start()].strip()
        except json.JSONDecodeError:
            pass

    insufficient = (
        "don't have" in text.lower()
        or "not found" in text.lower()
        or "no information" in text.lower()
        or "cannot find" in text.lower()
        or "insufficient" in text.lower()
        or (not citations and not re.search(r"\[\d+\]", text))
    )

    return {
        "answer": answer,
        "citations": citations,
        "retrieved_chunks": retrieved_chunks,
        "insufficient_evidence": insufficient and not citations,
    }
