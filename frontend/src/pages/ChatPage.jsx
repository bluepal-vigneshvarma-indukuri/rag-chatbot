import { useState, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { getAccessToken } from "../lib/supabase";
import {
  Send, ArrowLeft, MessageSquare, Loader2, AlertCircle,
  FileText, ExternalLink, ChevronDown, ChevronUp
} from "lucide-react";

const BACKEND = import.meta.env.VITE_BACKEND_URL || "http://localhost:8000";

export default function ChatPage({ session }) {
  const location = useLocation();
  const navigate = useNavigate();
  const documentIds = location.state?.documentIds || null;

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [conversationId, setConversationId] = useState(null);
  const [error, setError] = useState("");
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function sendMessage(e) {
    e.preventDefault();
    const question = input.trim();
    if (!question || streaming) return;

    setInput("");
    setError("");
    setStreaming(true);

    const userMsg = { role: "user", content: question };
    setMessages((prev) => [...prev, userMsg]);

    const assistantMsg = {
      role: "assistant",
      content: "",
      citations: [],
      status: "streaming",
    };
    setMessages((prev) => [...prev, assistantMsg]);

    const token = await getAccessToken();

    try {
      const res = await fetch(`${BACKEND}/chat/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          question,
          conversation_id: conversationId,
          document_ids: documentIds,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.detail || "Request failed");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split("\n\n");
        buffer = parts.pop();

        for (const part of parts) {
          const eventMatch = part.match(/^event: (.+)/m);
          const dataMatch = part.match(/^data: (.+)/ms);
          if (!eventMatch || !dataMatch) continue;

          const event = eventMatch[1].trim();
          let data;
          try { data = JSON.parse(dataMatch[1].trim()); } catch { continue; }

          if (event === "conversation_id") {
            setConversationId(data.conversation_id);
          } else if (event === "token") {
            setMessages((prev) => {
              const msgs = [...prev];
              msgs[msgs.length - 1] = {
                ...msgs[msgs.length - 1],
                content: msgs[msgs.length - 1].content + data.text,
              };
              return msgs;
            });
          } else if (event === "citations") {
            setMessages((prev) => {
              const msgs = [...prev];
              msgs[msgs.length - 1] = {
                ...msgs[msgs.length - 1],
                citations: data.citations,
                insufficient_evidence: data.insufficient_evidence,
                status: "done",
              };
              return msgs;
            });
          } else if (event === "error") {
            setMessages((prev) => {
              const msgs = [...prev];
              msgs[msgs.length - 1] = {
                ...msgs[msgs.length - 1],
                status: "error",
                errorMsg: data.message,
              };
              return msgs;
            });
          }
        }
      }
    } catch (err) {
      setError(err.message);
      setMessages((prev) => {
        const msgs = [...prev];
        msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], status: "error", errorMsg: err.message };
        return msgs;
      });
    } finally {
      setStreaming(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="border-b border-gray-800 px-4 py-3 flex items-center gap-3">
        <button
          onClick={() => navigate("/documents")}
          className="text-gray-400 hover:text-white transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-indigo-600 flex items-center justify-center">
            <MessageSquare className="w-3.5 h-3.5 text-white" />
          </div>
          <span className="font-medium text-white">RAG Chatbot</span>
        </div>
        {documentIds && (
          <span className="text-xs bg-indigo-950 text-indigo-300 border border-indigo-800 rounded-full px-2.5 py-1 ml-1">
            {documentIds.length} doc{documentIds.length > 1 ? "s" : ""} selected
          </span>
        )}
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="max-w-3xl mx-auto space-y-6">
          {messages.length === 0 && (
            <div className="text-center py-24 text-gray-600">
              <MessageSquare className="w-12 h-12 mx-auto mb-3 opacity-30" />
              <p className="text-lg">Ask anything about your documents</p>
              <p className="text-sm mt-1">Answers include cited sources</p>
            </div>
          )}

          {messages.map((msg, i) => (
            <ChatMessage key={i} message={msg} />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-gray-800 px-4 py-4">
        <form onSubmit={sendMessage} className="max-w-3xl mx-auto flex gap-3">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask a question about your documents…"
            disabled={streaming}
            className="flex-1 bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!input.trim() || streaming}
            className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white px-4 py-3 rounded-xl transition-colors"
          >
            {streaming ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Send className="w-5 h-5" />
            )}
          </button>
        </form>
      </div>
    </div>
  );
}

function ChatMessage({ message }) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-lg bg-indigo-600 text-white rounded-2xl rounded-tr-sm px-4 py-3 text-sm">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="max-w-3xl bg-gray-900 border border-gray-800 rounded-2xl rounded-tl-sm px-5 py-4">
        {/* Error state */}
        {message.status === "error" && (
          <div className="flex items-start gap-2 text-red-400 text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            {message.errorMsg || "Something went wrong"}
          </div>
        )}

        {/* Streaming indicator */}
        {message.status === "streaming" && !message.content && (
          <div className="flex items-center gap-2 text-gray-500 text-sm">
            <Loader2 className="w-4 h-4 animate-spin" />
            Searching and reasoning…
          </div>
        )}

        {/* Answer text */}
        {message.content && (
          <div className="prose-chat text-sm text-gray-200 whitespace-pre-wrap leading-relaxed">
            {renderWithCitations(message.content)}
            {message.status === "streaming" && (
              <span className="inline-block w-1.5 h-4 bg-indigo-400 ml-0.5 animate-pulse rounded-sm" />
            )}
          </div>
        )}

        {/* Insufficient evidence */}
        {message.insufficient_evidence && (
          <p className="text-xs text-yellow-500 mt-3">
            The documents may not contain enough information to fully answer this question.
          </p>
        )}
      </div>

      {/* Citations */}
      {message.citations && message.citations.length > 0 && (
        <CitationList citations={message.citations} />
      )}
    </div>
  );
}

function renderWithCitations(text) {
  const parts = text.split(/(\[\d+\])/g);
  return parts.map((part, i) => {
    const match = part.match(/^\[(\d+)\]$/);
    if (match) {
      return (
        <span
          key={i}
          className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-600 text-white text-xs font-bold mx-0.5 align-middle"
        >
          {match[1]}
        </span>
      );
    }
    return part;
  });
}

function CitationList({ citations }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="space-y-2">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-xs text-gray-500 hover:text-gray-300 transition-colors"
      >
        <FileText className="w-3.5 h-3.5" />
        {citations.length} source{citations.length > 1 ? "s" : ""}
        {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
      </button>

      {expanded && (
        <div className="space-y-2">
          {citations.map((c, i) => (
            <div key={i} className="bg-gray-900 border border-gray-800 rounded-xl p-3">
              <div className="flex items-center gap-2 mb-2">
                <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-600 text-white text-xs font-bold shrink-0">
                  {c.citation_index}
                </span>
                <span className="text-xs text-gray-400 font-mono truncate">
                  {c.chunk_id?.slice(0, 8)}…
                </span>
              </div>
              <blockquote className="text-xs text-gray-400 italic border-l-2 border-indigo-700 pl-3 leading-relaxed">
                "{c.excerpt}"
              </blockquote>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
