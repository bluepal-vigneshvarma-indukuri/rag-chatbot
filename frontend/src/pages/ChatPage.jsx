import { useState, useEffect, useRef, useCallback } from "react";
import { supabase, getAccessToken } from "../lib/supabase";
import {
  Send, MessageSquare, Loader2, AlertCircle, Settings,
  Plus, Paperclip,   Pin, ChevronDown, LogOut, FileText,
  CheckCircle2,
} from "lucide-react";
import SettingsPanel from "../components/SettingsPanel";
import SourcePanel from "../components/SourcePanel";
import { useProviderSettings, isLocalUrl } from "../hooks/useProviderSettings";

const BACKEND = import.meta.env.VITE_BACKEND_URL || "http://localhost:8000";

const ERROR_MESSAGES = {
  invalid_api_key:   "Your API key is invalid or has expired. Please update it in Settings.",
  model_not_found:   "The model name was not found for this API server. Please check it in Settings.",
  missing_api_key:   "No API key configured. Please open Settings and enter your API key.",
  rate_limit:        "Rate limit reached. Please wait a moment and try again.",
  invalid_base_url:  "Enter a valid API server URL in Settings.",
  connection_failed: "Could not reach the API server. Check the base URL in Settings.",
};

function groupConversations(conversations) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const groups = [];
  const buckets = { Today: [], Yesterday: [], Earlier: [] };

  for (const c of conversations) {
    const d = new Date(c.updated_at || c.created_at);
    d.setHours(0, 0, 0, 0);
    if (d.getTime() === today.getTime()) buckets.Today.push(c);
    else if (d.getTime() === yesterday.getTime()) buckets.Yesterday.push(c);
    else buckets.Earlier.push(c);
  }

  for (const [label, items] of Object.entries(buckets)) {
    if (items.length) groups.push({ label, items });
  }
  return groups;
}

function parseCitations(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw); } catch { return []; }
}

export default function ChatPage({ session }) {
  const [messages, setMessages]               = useState([]);
  const [input, setInput]                     = useState("");
  const [streaming, setStreaming]             = useState(false);
  const [conversationId, setConversationId]   = useState(null);
  const [conversations, setConversations]     = useState([]);
  const [documents, setDocuments]             = useState([]);
  const [pinnedDocIds, setPinnedDocIds]       = useState([]);
  const [showSettings, setShowSettings]       = useState(false);
  const [showPinMenu, setShowPinMenu]         = useState(false);
  const [uploading, setUploading]             = useState(false);
  const [activeCitation, setActiveCitation]   = useState(null);
  const [settings, updateSettings]            = useProviderSettings();

  const bottomRef    = useRef(null);
  const fileInputRef = useRef(null);
  const pinMenuRef   = useRef(null);

  const loadConversations = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) return;
    try {
      const res = await fetch(`${BACKEND}/chat/conversations`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setConversations(await res.json());
    } catch { /* ignore */ }
  }, []);

  const loadDocuments = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) return;
    try {
      const res = await fetch(`${BACKEND}/documents/`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setDocuments(await res.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadConversations();
    loadDocuments();
    const interval = setInterval(() => {
      loadConversations();
      loadDocuments();
    }, 8000);
    return () => clearInterval(interval);
  }, [loadConversations, loadDocuments]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (!settings.chatApiKey && !isLocalUrl(settings.chatBaseUrl)) {
      setShowSettings(true);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    function handleClick(e) {
      if (pinMenuRef.current && !pinMenuRef.current.contains(e.target)) {
        setShowPinMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function startNewChat() {
    setConversationId(null);
    setMessages([]);
    setActiveCitation(null);
  }

  async function loadConversation(conv) {
    const token = await getAccessToken();
    try {
      const res = await fetch(`${BACKEND}/chat/conversations/${conv.id}/messages`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const msgs = await res.json();
      setConversationId(conv.id);
      setActiveCitation(null);
      setMessages(
        msgs.map((m) => ({
          role: m.role,
          content: m.content,
          citations: parseCitations(m.citations),
          status: "done",
        }))
      );
      if (conv.document_ids?.length) {
        setPinnedDocIds(conv.document_ids);
      }
    } catch { /* ignore */ }
  }

  async function handleUpload(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setUploading(true);
    const token = await getAccessToken();

    for (const file of files) {
      const form = new FormData();
      form.append("file", file);
      form.append("embed_base_url", settings.embedBaseUrl);
      form.append("embed_model", settings.embedModel);
      form.append("embed_api_key", settings.embedApiKey);
      form.append("embed_disabled", settings.embedDisabled ? "true" : "false");
      try {
        const res = await fetch(`${BACKEND}/documents/upload`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: form,
        });
        if (res.ok) {
          const data = await res.json();
          setPinnedDocIds((prev) => [...new Set([...prev, data.document_id])]);
        }
      } catch { /* ignore */ }
    }

    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
    await loadDocuments();
  }

  function togglePin(docId) {
    setPinnedDocIds((prev) =>
      prev.includes(docId) ? prev.filter((id) => id !== docId) : [...prev, docId]
    );
  }

  async function sendMessage(e) {
    e.preventDefault();
    const question = input.trim();
    if (!question || streaming) return;

    setInput("");
    setStreaming(true);
    setActiveCitation(null);

    setMessages((prev) => [
      ...prev,
      { role: "user", content: question },
      { role: "assistant", content: "", citations: [], status: "streaming" },
    ]);

    const token = await getAccessToken();
    const docIds = pinnedDocIds.length ? pinnedDocIds : null;

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
          document_ids: docIds,
          chat_base_url: settings.chatBaseUrl,
          chat_model: settings.chatModel,
          chat_api_key: settings.chatApiKey,
          embed_base_url: settings.embedBaseUrl,
          embed_model: settings.embedModel,
          embed_api_key: settings.embedApiKey,
          embed_disabled: settings.embedDisabled,
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
          const dataMatch  = part.match(/^data: (.+)/ms);
          if (!eventMatch || !dataMatch) continue;

          const event = eventMatch[1].trim();
          let data;
          try { data = JSON.parse(dataMatch[1].trim()); } catch { continue; }

          if (event === "conversation_id") {
            setConversationId(data.conversation_id);
            loadConversations();
          } else if (event === "token") {
            setMessages((prev) => {
              const msgs = [...prev];
              const last = msgs[msgs.length - 1];
              msgs[msgs.length - 1] = { ...last, content: last.content + data.text };
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
            const friendlyMsg = ERROR_MESSAGES[data.code] || data.message || "Something went wrong.";
            setMessages((prev) => {
              const msgs = [...prev];
              msgs[msgs.length - 1] = {
                ...msgs[msgs.length - 1],
                status: "error",
                errorMsg: friendlyMsg,
                needsSettings: ["invalid_api_key", "model_not_found", "missing_api_key",
                  "invalid_base_url", "connection_failed"].includes(data.code),
              };
              return msgs;
            });
          }
        }
      }
    } catch (err) {
      setMessages((prev) => {
        const msgs = [...prev];
        msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], status: "error", errorMsg: err.message };
        return msgs;
      });
    } finally {
      setStreaming(false);
    }
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
  }

  function openCitation(citation) {
    setActiveCitation({
      chunkId: citation.chunk_id,
      citationIndex: citation.citation_index,
    });
  }

  const convGroups = groupConversations(conversations);
  const readyDocs = documents.filter((d) => d.status === "ready");
  const activeQuestion = [...messages].reverse().find((m) => m.role === "user")?.content;

  return (
    <div className="h-screen flex bg-white overflow-hidden">
      <SettingsPanel
        settings={settings}
        onUpdate={updateSettings}
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
      />

      {/* ── Left sidebar ── */}
      <aside className="w-64 shrink-0 border-r border-gray-200 bg-gray-50 flex flex-col">
        <div className="px-4 py-5 border-b border-gray-200">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center">
              <MessageSquare className="w-4 h-4 text-white" />
            </div>
            <div>
              <p className="font-semibold text-gray-900 text-sm leading-tight">Document Copilot</p>
              <p className="text-xs text-gray-500">RAG assistant</p>
            </div>
          </div>
        </div>

        <div className="px-3 py-3 space-y-1">
          <button
            onClick={startNewChat}
            className="w-full flex items-center gap-2 text-sm font-medium text-gray-700 hover:bg-gray-200/70 rounded-lg px-3 py-2 transition-colors"
          >
            <Plus className="w-4 h-4" />
            New chat
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className="w-full flex items-center gap-2 text-sm text-gray-600 hover:bg-gray-200/70 rounded-lg px-3 py-2 transition-colors"
          >
            <Settings className="w-4 h-4" />
            Settings
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-2">
          {convGroups.map((group) => (
            <div key={group.label} className="mb-4">
              <p className="text-xs font-medium text-gray-400 uppercase tracking-wide px-2 mb-1">
                {group.label}
              </p>
              {group.items.map((conv) => (
                <button
                  key={conv.id}
                  onClick={() => loadConversation(conv)}
                  className={`w-full text-left text-sm rounded-lg px-3 py-2 truncate transition-colors ${
                    conversationId === conv.id
                      ? "bg-white text-gray-900 shadow-sm border border-gray-200"
                      : "text-gray-600 hover:bg-gray-200/60"
                  }`}
                >
                  {conv.title || "Untitled chat"}
                </button>
              ))}
            </div>
          ))}
          {conversations.length === 0 && (
            <p className="text-xs text-gray-400 px-2 py-4">No previous chats yet</p>
          )}
        </div>

        <div className="border-t border-gray-200 px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-semibold shrink-0">
              {(session.user.email?.[0] || "U").toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs text-gray-900 truncate">{session.user.email}</p>
              <p className="text-xs text-gray-400">Signed in</p>
            </div>
            <button
              onClick={handleSignOut}
              className="text-gray-400 hover:text-gray-700 p-1 rounded transition-colors"
              title="Sign out"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </aside>

      {/* ── Center + right ── */}
      <div className="flex-1 flex min-w-0">
        <main className="flex-1 flex flex-col min-w-0 bg-white">
          {activeQuestion && messages.length > 0 && (
            <div className="px-8 pt-6 pb-2 border-b border-gray-100">
              <p className="text-sm font-medium text-gray-900 line-clamp-2">{activeQuestion}</p>
            </div>
          )}

          <div className="flex-1 overflow-y-auto px-8 py-6">
            <div className="max-w-3xl mx-auto space-y-8">
              {messages.length === 0 && (
                <div className="text-center py-24">
                  <MessageSquare className="w-10 h-10 mx-auto mb-4 text-gray-300" />
                  <p className="text-lg font-medium text-gray-800">Ask anything about your documents</p>
                  <p className="text-sm text-gray-500 mt-1">
                    Upload files below and pin them to focus your search
                  </p>
                </div>
              )}

              {messages.map((msg, i) => (
                <ChatMessage
                  key={i}
                  message={msg}
                  onOpenSettings={() => setShowSettings(true)}
                  onCitationClick={openCitation}
                  activeChunkId={activeCitation?.chunkId}
                />
              ))}
              <div ref={bottomRef} />
            </div>
          </div>

          {/* ── Input bar ── */}
          <div className="border-t border-gray-200 px-6 py-4 bg-white">
            <form onSubmit={sendMessage} className="max-w-3xl mx-auto">
              <div className="flex items-center gap-2 mb-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-800 border border-gray-200 rounded-lg px-2.5 py-1.5 hover:bg-gray-50 transition-colors disabled:opacity-50"
                  title="Upload document"
                >
                  {uploading ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Paperclip className="w-3.5 h-3.5" />
                  )}
                  Upload
                </button>

                <div className="relative" ref={pinMenuRef}>
                  <button
                    type="button"
                    onClick={() => setShowPinMenu((p) => !p)}
                    className={`flex items-center gap-1.5 text-xs border rounded-lg px-2.5 py-1.5 transition-colors ${
                      pinnedDocIds.length
                        ? "text-blue-700 border-blue-200 bg-blue-50 hover:bg-blue-100"
                        : "text-gray-500 border-gray-200 hover:bg-gray-50 hover:text-gray-800"
                    }`}
                  >
                    <Pin className="w-3.5 h-3.5" />
                    {pinnedDocIds.length
                      ? `${pinnedDocIds.length} pinned`
                      : "Pin documents"}
                    <ChevronDown className="w-3 h-3" />
                  </button>

                  {showPinMenu && (
                    <div className="absolute bottom-full left-0 mb-2 w-72 bg-white border border-gray-200 rounded-xl shadow-lg z-20 max-h-64 overflow-y-auto">
                      <div className="px-3 py-2 border-b border-gray-100">
                        <p className="text-xs font-medium text-gray-700">
                          Pin documents for this chat
                        </p>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {pinnedDocIds.length ? "Search limited to pinned docs" : "No pins = search all docs"}
                        </p>
                      </div>
                      {readyDocs.length === 0 ? (
                        <p className="text-xs text-gray-400 px-3 py-4">No ready documents. Upload first.</p>
                      ) : (
                        readyDocs.map((doc) => (
                          <button
                            key={doc.id}
                            type="button"
                            onClick={() => togglePin(doc.id)}
                            className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50 transition-colors"
                          >
                            <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                              pinnedDocIds.includes(doc.id)
                                ? "bg-blue-600 border-blue-600"
                                : "border-gray-300"
                            }`}>
                              {pinnedDocIds.includes(doc.id) && (
                                <CheckCircle2 className="w-3 h-3 text-white" />
                              )}
                            </span>
                            <span className="truncate text-gray-700">{doc.filename}</span>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>

                {documents.some((d) => d.status === "processing") && (
                  <span className="text-xs text-gray-400 flex items-center gap-1">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Processing…
                  </span>
                )}
              </div>

              <div className="flex gap-2 items-end border border-gray-300 rounded-2xl px-4 py-3 shadow-sm focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-blue-500">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendMessage(e);
                    }
                  }}
                  placeholder="Ask about your documents…"
                  disabled={streaming}
                  rows={1}
                  className="flex-1 resize-none text-sm text-gray-900 placeholder-gray-400 focus:outline-none bg-transparent disabled:opacity-50 max-h-32"
                />
                <button
                  type="submit"
                  disabled={!input.trim() || streaming}
                  className="bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white p-2 rounded-xl transition-colors shrink-0"
                >
                  {streaming ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Send className="w-4 h-4" />
                  )}
                </button>
              </div>
              <p className="text-xs text-gray-400 text-center mt-2">
                Answers are grounded in your documents. Verify citations before relying on them.
              </p>
            </form>

            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".pdf,.docx,.xlsx,.csv,.txt,.md,.html,.htm,.py,.js,.ts,.jsx,.tsx,.java,.cpp,.c,.cs,.go,.rs,.rb,.php,.css,.json,.yaml,.yml,.xml,.sql"
              className="hidden"
              onChange={handleUpload}
            />
          </div>
        </main>

        {activeCitation && (
          <SourcePanel
            chunkId={activeCitation.chunkId}
            citationIndex={activeCitation.citationIndex}
            onClose={() => setActiveCitation(null)}
          />
        )}
      </div>
    </div>
  );
}

function ChatMessage({ message, onOpenSettings, onCitationClick, activeChunkId }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-xl bg-gray-100 text-gray-900 rounded-2xl rounded-tr-sm px-4 py-3 text-sm leading-relaxed">
          {message.content}
        </div>
      </div>
    );
  }

  const citationMap = {};
  (message.citations || []).forEach((c) => {
    citationMap[String(c.citation_index)] = c;
  });

  return (
    <div className="space-y-4">
      <div className="text-sm text-gray-800 leading-relaxed">
        {message.status === "error" && (
          <div className="space-y-2 mb-3 p-3 bg-red-50 border border-red-200 rounded-xl">
            <div className="flex items-start gap-2 text-red-700 text-sm">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{message.errorMsg}</span>
            </div>
            {message.needsSettings && (
              <button
                onClick={onOpenSettings}
                className="flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-800 ml-6"
              >
                <Settings className="w-3.5 h-3.5" />
                Open Settings
              </button>
            )}
          </div>
        )}

        {message.status === "streaming" && !message.content && (
          <div className="flex items-center gap-2 text-gray-400 text-sm">
            <Loader2 className="w-4 h-4 animate-spin" />
            Searching and reasoning…
          </div>
        )}

        {message.content && (
          <div className="prose-chat whitespace-pre-wrap">
            {renderWithCitations(message.content, citationMap, onCitationClick, activeChunkId)}
            {message.status === "streaming" && (
              <span className="inline-block w-0.5 h-4 bg-blue-500 ml-0.5 animate-pulse" />
            )}
          </div>
        )}

        {message.insufficient_evidence && (
          <p className="text-xs text-amber-600 mt-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            The documents may not contain enough information to fully answer this question.
          </p>
        )}
      </div>

      {message.citations?.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {message.citations.map((c) => (
            <button
              key={c.citation_index}
              onClick={() => onCitationClick(c)}
              className={`inline-flex items-center gap-1.5 text-xs border rounded-full px-3 py-1.5 transition-colors ${
                activeChunkId === c.chunk_id
                  ? "bg-blue-50 border-blue-400 text-blue-800"
                  : "bg-white border-gray-300 text-gray-600 hover:border-blue-300 hover:text-blue-700"
              }`}
            >
              <FileText className="w-3 h-3" />
              <span className="font-medium">{c.citation_index}</span>
              <span className="truncate max-w-[180px]">
                {(c.excerpt || "").slice(0, 40)}{(c.excerpt || "").length > 40 ? "…" : ""}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function renderWithCitations(text, citationMap, onCitationClick, activeChunkId) {
  const parts = text.split(/(\[\d+\])/g);
  return parts.map((part, i) => {
    const match = part.match(/^\[(\d+)\]$/);
    if (match) {
      const citation = citationMap[match[1]];
      const isActive = citation && activeChunkId === citation.chunk_id;
      return (
        <button
          key={i}
          type="button"
          onClick={() => citation && onCitationClick(citation)}
          className={`inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded text-xs font-semibold mx-0.5 align-super transition-colors ${
            isActive
              ? "bg-blue-600 text-white"
              : "bg-blue-100 text-blue-700 hover:bg-blue-200"
          }`}
        >
          {match[1]}
        </button>
      );
    }
    return <span key={i}>{part}</span>;
  });
}
