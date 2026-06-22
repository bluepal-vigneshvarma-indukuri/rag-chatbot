"""Chat endpoints — /chat/stream with SSE."""
import json
import uuid
import asyncio
from typing import List, Optional
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import psycopg2
import psycopg2.extras

from auth.middleware import get_current_user
from config import get_settings
from .agent import run_agent, AgentError
from retrieval.retriever import get_chunk_detail
from grounding.validator import validate_answer

router = APIRouter(prefix="/chat", tags=["chat"])


class ChatRequest(BaseModel):
    question: str
    conversation_id: Optional[str] = None
    document_ids: Optional[List[str]] = None
    # API settings — supplied by the frontend from user's settings
    chat_base_url: str = ""
    chat_model: str = ""
    chat_api_key: str = ""
    embed_base_url: str = ""
    embed_model: str = ""
    embed_api_key: str = ""
    embed_disabled: bool = False


@router.post("/stream")
async def chat_stream(
    req: ChatRequest,
    user: dict = Depends(get_current_user),
):
    """Stream a chat response with citations."""
    if not req.question.strip():
        raise HTTPException(status_code=400, detail="Question cannot be empty")

    user_id = user["id"]

    async def event_stream():
        settings = get_settings()

        # Ensure/create conversation
        conversation_id = req.conversation_id
        conn = psycopg2.connect(settings.database_url)
        try:
            if not conversation_id:
                conversation_id = str(uuid.uuid4())
                title = req.question[:60]
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        INSERT INTO public.conversations (id, user_id, title, document_ids, updated_at)
                        VALUES (%s, %s, %s, %s::uuid[], now())
                        """,
                        (conversation_id, user_id, title, req.document_ids or []),
                    )
                conn.commit()

            # Save user message
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO public.messages (conversation_id, role, content) VALUES (%s, %s, %s)",
                    (conversation_id, "user", req.question),
                )
            conn.commit()
        except Exception as e:
            conn.close()
            yield _sse("error", {"message": f"DB error: {e}"})
            return
        finally:
            conn.close()

        # Send conversation_id to frontend
        yield _sse("conversation_id", {"conversation_id": conversation_id})
        yield _sse("status", {"message": "Searching documents..."})

        # Run agent in thread pool (all provider SDKs are sync)
        loop = asyncio.get_event_loop()
        try:
            result = await loop.run_in_executor(
                None,
                lambda: run_agent(
                    question=req.question,
                    user_id=user_id,
                    document_ids=req.document_ids,
                    chat_base_url=req.chat_base_url,
                    chat_model=req.chat_model,
                    chat_api_key=req.chat_api_key,
                    embed_base_url=req.embed_base_url,
                    embed_model=req.embed_model,
                    embed_api_key=req.embed_api_key,
                    embed_disabled=req.embed_disabled,
                ),
            )
        except AgentError as e:
            yield _sse("error", {"code": e.code, "message": e.message})
            return
        except Exception as e:
            yield _sse("error", {"code": "unknown", "message": f"Agent error: {str(e)}"})
            return

        yield _sse("status", {"message": "Validating citations..."})

        # Grounding validation
        validation = validate_answer(
            answer=result["answer"],
            citations=result["citations"],
            retrieved_chunks=result["retrieved_chunks"],
        )

        if not validation["valid"] and result["citations"]:
            yield _sse("error", {
                "message": "Answer could not be verified against source documents.",
                "details": validation["errors"],
            })
            return

        # Stream answer token by token (simple word-level streaming)
        yield _sse("answer_start", {})
        words = result["answer"].split(" ")
        chunk_buf = ""
        for word in words:
            chunk_buf += word + " "
            if len(chunk_buf) > 30:
                yield _sse("token", {"text": chunk_buf})
                chunk_buf = ""
                await asyncio.sleep(0.01)
        if chunk_buf:
            yield _sse("token", {"text": chunk_buf})

        # Send citations
        yield _sse("citations", {
            "citations": result["citations"],
            "insufficient_evidence": result["insufficient_evidence"],
        })

        # Persist assistant message
        conn = psycopg2.connect(settings.database_url)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO public.messages (conversation_id, role, content, citations)
                    VALUES (%s, %s, %s, %s)
                    """,
                    (
                        conversation_id,
                        "assistant",
                        result["answer"],
                        json.dumps(result["citations"]),
                    ),
                )
            conn.commit()
        except Exception:
            pass
        finally:
            conn.close()

        yield _sse("done", {})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/chunks/{chunk_id}")
async def get_chunk(
    chunk_id: str,
    user: dict = Depends(get_current_user),
):
    """Return full chunk text and metadata for the source context panel."""
    settings = get_settings()
    detail = get_chunk_detail(chunk_id, user["id"], settings.database_url)
    if not detail:
        raise HTTPException(status_code=404, detail="Chunk not found")
    return detail


@router.get("/conversations")
async def list_conversations(user: dict = Depends(get_current_user)):
    settings = get_settings()
    conn = psycopg2.connect(settings.database_url)
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT id, title, document_ids, created_at, updated_at
                FROM public.conversations
                WHERE user_id = %s
                ORDER BY updated_at DESC
                LIMIT 50
                """,
                (user["id"],),
            )
            return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


@router.get("/conversations/{conversation_id}/messages")
async def get_messages(
    conversation_id: str,
    user: dict = Depends(get_current_user),
):
    settings = get_settings()
    conn = psycopg2.connect(settings.database_url)
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            # Verify ownership
            cur.execute(
                "SELECT id FROM public.conversations WHERE id = %s AND user_id = %s",
                (conversation_id, user["id"]),
            )
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Conversation not found")

            cur.execute(
                """
                SELECT id, role, content, citations, created_at
                FROM public.messages
                WHERE conversation_id = %s
                ORDER BY created_at ASC
                """,
                (conversation_id,),
            )
            return [dict(r) for r in cur.fetchall()]
    finally:
        conn.close()


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"
