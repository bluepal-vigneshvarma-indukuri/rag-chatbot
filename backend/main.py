"""FastAPI application entry point."""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
import os

# Load .env from project root (one level up from backend/)
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), "..", ".env"))

from config import get_settings
from ingest.router import router as ingest_router
from chat.router import router as chat_router

settings = get_settings()

app = FastAPI(
    title="Hybrid RAG Chatbot API",
    description="Upload documents and ask questions. Answers are grounded in retrieved evidence.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_url, "http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(ingest_router)
app.include_router(chat_router)


@app.get("/health")
def health():
    return {"status": "ok"}
