"""
Groq-powered agent with tool calling for hybrid RAG retrieval.
Tools: search_documents, read_chunks
"""
import json
from typing import List, Optional
from groq import Groq
from config import get_settings
from retrieval.retriever import hybrid_search, get_chunks_by_ids

GROQ_MODEL = "llama-3.3-70b-versatile"
MAX_TOOL_ROUNDS = 4
TOTAL_CONTEXT_CAP = 12000  # max chars of passages sent to model


TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "search_documents",
            "description": (
                "Search uploaded documents using hybrid keyword + semantic search. "
                "Call this first when you need to find relevant information. "
                "Returns passages with chunk IDs for citation."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query — rephrase for best results",
                    },
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_chunks",
            "description": "Fetch full text for specific chunk IDs when you need more detail.",
            "parameters": {
                "type": "object",
                "properties": {
                    "chunk_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "List of chunk UUIDs to read in full",
                    },
                },
                "required": ["chunk_ids"],
            },
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


def run_agent(
    question: str,
    user_id: str,
    document_ids: Optional[List[str]] = None,
) -> dict:
    """
    Run the agent loop: search → reason → cite → return structured answer.

    Returns:
        {
            "answer": str,
            "citations": list[dict],
            "retrieved_chunks": list[dict],   # all chunks seen this turn
            "insufficient_evidence": bool,
        }
    """
    settings = get_settings()
    client = Groq(api_key=settings.groq_api_key)

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": question},
    ]

    retrieved_chunks: List[dict] = []
    turn = 0

    while turn < MAX_TOOL_ROUNDS:
        turn += 1
        response = client.chat.completions.create(
            model=GROQ_MODEL,
            messages=messages,
            tools=TOOLS,
            tool_choice="auto",
            max_tokens=4096,
            temperature=0.1,
        )

        msg = response.choices[0].message

        # No tool call → final answer
        if not msg.tool_calls:
            answer_text = msg.content or ""
            return _parse_answer(answer_text, retrieved_chunks)

        # Append assistant message with tool calls
        messages.append({
            "role": "assistant",
            "content": msg.content or "",
            "tool_calls": [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {"name": tc.function.name, "arguments": tc.function.arguments},
                }
                for tc in msg.tool_calls
            ],
        })

        # Execute each tool call
        for tc in msg.tool_calls:
            tool_result = _execute_tool(
                tc.function.name,
                tc.function.arguments,
                user_id,
                document_ids,
                settings,
                retrieved_chunks,
            )
            messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": tool_result,
            })

    # Exceeded max rounds — ask model to summarise with what it has
    messages.append({
        "role": "user",
        "content": "Please provide your best answer based on what you have found so far.",
    })
    final = client.chat.completions.create(
        model=GROQ_MODEL,
        messages=messages,
        max_tokens=4096,
        temperature=0.1,
    )
    answer_text = final.choices[0].message.content or ""
    return _parse_answer(answer_text, retrieved_chunks)


def _execute_tool(
    name: str,
    arguments_json: str,
    user_id: str,
    document_ids,
    settings,
    retrieved_chunks: list,
) -> str:
    try:
        args = json.loads(arguments_json)
    except json.JSONDecodeError:
        return json.dumps({"error": "Invalid tool arguments"})

    if name == "search_documents":
        query = args.get("query", "")
        if not query:
            return json.dumps({"error": "query is required"})

        # Optional: embed query for vector search
        query_embedding = _embed_query(query, settings)

        chunks = hybrid_search(
            query=query,
            user_id=user_id,
            document_ids=document_ids,
            query_embedding=query_embedding,
            db_url=settings.database_url,
        )

        # Register in turn registry
        seen_ids = {c["chunk_id"] for c in retrieved_chunks}
        for c in chunks:
            if c["chunk_id"] not in seen_ids:
                retrieved_chunks.append(c)
                seen_ids.add(c["chunk_id"])

        if not chunks:
            return json.dumps({"message": "No relevant passages found", "passages": []})

        passages = [
            {
                "chunk_id": c["chunk_id"],
                "filename": c["filename"],
                "excerpt": c["excerpt"],
            }
            for c in chunks
        ]

        # Cap total context
        total = 0
        capped = []
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

        chunks = get_chunks_by_ids(chunk_ids, settings.database_url)

        seen_ids = {c["chunk_id"] for c in retrieved_chunks}
        for c in chunks:
            if c["chunk_id"] not in seen_ids:
                retrieved_chunks.append(c)
                seen_ids.add(c["chunk_id"])

        return json.dumps({"passages": chunks})

    return json.dumps({"error": f"Unknown tool: {name}"})


def _embed_query(query: str, settings) -> Optional[List[float]]:
    if not settings.openai_api_key:
        return None
    try:
        from openai import OpenAI
        client = OpenAI(api_key=settings.openai_api_key)
        resp = client.embeddings.create(
            model="text-embedding-3-small",
            input=query,
        )
        return resp.data[0].embedding
    except Exception:
        return None


def _parse_answer(text: str, retrieved_chunks: List[dict]) -> dict:
    """Extract the answer text and citations JSON from the model's response."""
    import re
    citations = []
    answer = text

    # Try to extract JSON citations block
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
