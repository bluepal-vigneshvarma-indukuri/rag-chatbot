import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { supabase, getAccessToken } from "../lib/supabase";
import {
  Upload, FileText, MessageSquare, Trash2, CheckCircle2,
  Clock, AlertCircle, Loader2, LogOut, Plus, Settings,
} from "lucide-react";
import SettingsPanel from "../components/SettingsPanel";
import { useProviderSettings } from "../hooks/useProviderSettings";

const BACKEND = import.meta.env.VITE_BACKEND_URL || "http://localhost:8000";

const STATUS_ICONS = {
  ready: <CheckCircle2 className="w-4 h-4 text-emerald-400" />,
  processing: <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />,
  pending: <Clock className="w-4 h-4 text-yellow-400" />,
  failed: <AlertCircle className="w-4 h-4 text-red-400" />,
};

const STATUS_LABELS = {
  ready: "Ready",
  processing: "Processing…",
  pending: "Pending",
  failed: "Failed",
};

export default function DocumentsPage({ session }) {
  const [documents, setDocuments] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState([]);
  const [showSettings, setShowSettings] = useState(false);
  const [notification, setNotification] = useState(null);
  const [notifiedDocs, setNotifiedDocs] = useState(new Set());
  const initialLoadDone = useRef(false);
  const fileInputRef = useRef(null);
  const navigate = useNavigate();

  const [settings, updateSettings] = useProviderSettings();

  useEffect(() => {
    loadDocuments();
    const interval = setInterval(loadDocuments, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 5000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  async function loadDocuments() {
    const token = await getAccessToken();
    if (!token) return;
    try {
      const res = await fetch(`${BACKEND}/documents/`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const docs = await res.json();
        setDocuments(docs);

        setNotifiedDocs((prev) => {
          const newNotified = new Set(prev);
          let latestNotification = null;

          docs.forEach((doc) => {
            // We only care about docs that have finished processing
            if (doc.status === "ready" || doc.status === "failed") {
              if (!initialLoadDone.current) {
                // On first load, just mark everything as notified so we don't spam the user
                newNotified.add(doc.id);
              } else if (!newNotified.has(doc.id)) {
                // This document just finished processing in the background!
                newNotified.add(doc.id);
                
                if (doc.status === "failed") {
                  latestNotification = {
                    type: "error",
                    message: `Failed to process "${doc.filename}": ${doc.error_message}`,
                  };
                } else if (doc.error_message && doc.error_message.includes("Embedding")) {
                  latestNotification = {
                    type: "warning",
                    message: `Embeddings failed for "${doc.filename}". Stored for keyword search only.`,
                  };
                } else {
                  latestNotification = {
                    type: "success",
                    message: `Successfully processed "${doc.filename}"!`,
                  };
                }
              }
            }
          });

          if (latestNotification) {
            setNotification(latestNotification);
          }
          
          initialLoadDone.current = true;
          return newNotified;
        });
      }
    } catch {}
  }

  async function handleUpload(e) {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setError("");
    setUploading(true);

    const token = await getAccessToken();
    for (const file of files) {
      const form = new FormData();
      form.append("file", file);
      // Pass embedding settings so chunks are embedded with the user's chosen provider
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
        if (!res.ok) {
          const data = await res.json();
          const isDuplicate = res.status === 409;
          setError(data.detail || "Upload failed");
          setNotification({
            type: isDuplicate ? "warning" : "error",
            message: isDuplicate ? "This file has already been uploaded." : (data.detail || "Upload failed"),
          });
        } else {
          setNotification({
            type: "success",
            message: `"${file.name}" uploaded successfully!`,
          });
        }
      } catch (err) {
        setError("Upload failed — is the backend running?");
        setNotification({
          type: "error",
          message: "Upload failed — is the backend running?",
        });
      }
    }
    setUploading(false);
    fileInputRef.current.value = "";
    await loadDocuments();
  }

  async function handleDelete(e, docId) {
    e.stopPropagation();
    if (!window.confirm("Delete this document and all its chunks? This cannot be undone.")) return;
    const token = await getAccessToken();
    try {
      const res = await fetch(`${BACKEND}/documents/${docId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.detail || "Delete failed");
      } else {
        setSelected((prev) => prev.filter((id) => id !== docId));
        await loadDocuments();
      }
    } catch {
      setError("Delete failed — is the backend running?");
    }
  }

  function toggleSelect(id) {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
  }

  const readyCount = documents.filter((d) => d.status === "ready").length;

  return (
    <div className="min-h-screen flex flex-col">
      {/* Settings panel */}
      <SettingsPanel
        settings={settings}
        onUpdate={updateSettings}
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
      />

      {/* Header */}
      <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center">
            <MessageSquare className="w-4 h-4 text-white" />
          </div>
          <span className="font-semibold text-white">RAG Chatbot</span>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowSettings(true)}
            className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-white transition-colors"
            title="Provider Settings"
          >
            <Settings className="w-4 h-4" /> Settings
          </button>
          <span className="text-sm text-gray-400">{session.user.email}</span>
          <button
            onClick={handleSignOut}
            className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-white transition-colors"
          >
            <LogOut className="w-4 h-4" /> Sign out
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-4xl mx-auto w-full px-6 py-10">
        {(!settings.chatVerified || !settings.embedVerified) && (
          <div className="mb-6 bg-red-950/20 border border-red-800 text-red-300 text-xs px-3 py-2 rounded-xl flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-red-500 shrink-0" />
              <span>
                {!settings.chatVerified && !settings.embedVerified
                  ? "Both Chat and Embedding connections must be verified in Settings to start uploading and chatting."
                  : !settings.chatVerified
                  ? "Chat API connection must be verified in Settings to enable chatting."
                  : "Embedding API connection must be verified in Settings to enable uploading."}
              </span>
            </div>
            <button
              type="button"
              onClick={() => setShowSettings(true)}
              className="text-xs font-semibold text-indigo-400 hover:text-indigo-300 underline shrink-0"
            >
              Configure & Verify
            </button>
          </div>
        )}

        {/* Upload Status Notification Popup (Toast) */}
        {notification && (
          <div className="fixed top-6 right-6 z-50 animate-slide-up shadow-2xl">
            <div className={`p-4 rounded-2xl border flex items-start justify-between gap-4 text-sm max-w-sm ${
              notification.type === 'success' 
                ? 'bg-emerald-950/90 border-emerald-800 text-emerald-300 backdrop-blur-md' 
                : notification.type === 'warning' 
                ? 'bg-amber-950/90 border-amber-800 text-amber-300 backdrop-blur-md' 
                : 'bg-red-950/90 border-red-800 text-red-300 backdrop-blur-md'
            }`}>
              <div className="flex items-start gap-3">
                {notification.type === 'success' && <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />}
                {notification.type === 'warning' && <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />}
                {notification.type === 'error' && <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />}
                <div className="flex flex-col">
                  <span className="font-semibold text-white text-base">
                    {notification.type === 'success' ? 'Success' : notification.type === 'warning' ? 'Attention' : 'Error'}
                  </span>
                  <span className="text-sm mt-1 text-gray-300 whitespace-pre-wrap">{notification.message}</span>
                </div>
              </div>
              <button 
                type="button" 
                onClick={() => setNotification(null)}
                className="text-gray-400 hover:text-white transition-colors shrink-0 p-1 rounded-lg hover:bg-white/10 focus:outline-none"
              >
                ✕
              </button>
            </div>
          </div>
        )}

        {/* Upload zone */}
        <div
          onClick={() => {
            if (settings.embedVerified) {
              fileInputRef.current?.click();
            }
          }}
          className={`border-2 border-dashed rounded-2xl p-10 flex flex-col items-center gap-3 transition-colors mb-8 group ${
            settings.embedVerified
              ? "border-gray-700 hover:border-indigo-500 cursor-pointer"
              : "border-red-950/40 bg-red-950/10 cursor-not-allowed"
          }`}
          title={settings.embedVerified ? "Upload documents" : "Verify embedding API connection in Settings first"}
        >
          <div className="w-14 h-14 rounded-2xl bg-gray-800 group-hover:bg-indigo-950 flex items-center justify-center transition-colors">
            {uploading ? (
              <Loader2 className="w-7 h-7 text-indigo-400 animate-spin" />
            ) : (
              <Upload className={`w-7 h-7 transition-colors ${settings.embedVerified ? "text-gray-400 group-hover:text-indigo-400" : "text-red-400/60"}`} />
            )}
          </div>
          <div className="text-center">
            <p className={`font-medium ${settings.embedVerified ? "text-white" : "text-red-400"}`}>
              {uploading
                ? "Uploading…"
                : settings.embedVerified
                  ? "Upload documents"
                  : "Verify Embedding Connection in Settings first to upload"}
            </p>
            <p className="text-sm text-gray-500 mt-1">
              PDF, DOCX, XLSX, CSV, HTML, TXT, code files — up to 20 MB each
            </p>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            disabled={!settings.embedVerified}
            accept=".pdf,.docx,.xlsx,.csv,.txt,.md,.html,.htm,.py,.js,.ts,.jsx,.tsx,.java,.cpp,.c,.cs,.go,.rs,.rb,.php,.css,.json,.yaml,.yml,.xml,.sql"
            className="hidden"
            onChange={handleUpload}
          />
        </div>

        {error && (
          <div className="flex items-start gap-2 bg-red-950 border border-red-800 text-red-300 text-sm rounded-xl p-3 mb-6">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            {error}
          </div>
        )}

        {/* Action bar */}
        {documents.length > 0 && (
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-white">
              My Documents{" "}
              <span className="text-sm text-gray-500 font-normal">({documents.length})</span>
            </h2>
            {readyCount > 0 && (
              <button
                onClick={() => {
                  if (settings.chatVerified) {
                    navigate("/chat", { state: { documentIds: selected.length ? selected : null } });
                  }
                }}
                disabled={!settings.chatVerified}
                className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-sm font-medium px-4 py-2 rounded-xl transition-colors"
                title={settings.chatVerified ? "Start chatting" : "Verify chat API connection in Settings first"}
              >
                <MessageSquare className="w-4 h-4" />
                {settings.chatVerified
                  ? selected.length ? `Chat with ${selected.length} selected` : "Start chatting"
                  : "Start Chatting (Verify Connection First)"}
              </button>
            )}
          </div>
        )}

        {/* Document list */}
        {documents.length === 0 ? (
          <div className="text-center py-20 text-gray-600">
            <FileText className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>No documents yet. Upload something to get started.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {documents.map((doc) => (
              <div
                key={doc.id}
                onClick={() => doc.status === "ready" && toggleSelect(doc.id)}
                className={`group flex items-center gap-4 p-4 rounded-xl border transition-colors ${
                  doc.status === "ready" ? "cursor-pointer" : "cursor-default"
                } ${
                  selected.includes(doc.id)
                    ? "bg-indigo-950 border-indigo-700"
                    : "bg-gray-900 border-gray-800 hover:border-gray-700"
                }`}
              >
                {/* Checkbox */}
                <div
                  className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
                    selected.includes(doc.id)
                      ? "bg-indigo-600 border-indigo-600"
                      : "border-gray-600"
                  }`}
                >
                  {selected.includes(doc.id) && (
                    <svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none">
                      <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </div>

                <FileText className="w-5 h-5 text-gray-500 shrink-0" />

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate">{doc.filename}</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {doc.chunk_count > 0 && `${doc.chunk_count} chunks • `}
                    {doc.file_size_bytes && `${(doc.file_size_bytes / 1024).toFixed(0)} KB • `}
                    {new Date(doc.created_at).toLocaleDateString()}
                  </p>
                  {doc.error_message && (
                    <p className={`text-xs mt-0.5 truncate ${doc.status === "ready" ? "text-amber-400" : "text-red-400"}`}>
                      {doc.status === "ready" 
                        ? `Embeddings failed (keyword search only): ${doc.error_message}` 
                        : doc.error_message}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  {doc.status === "ready" && doc.error_message && doc.error_message.includes("Embedding") ? (
                    <>
                      <AlertCircle className="w-4 h-4 text-amber-500" />
                      <span className="text-xs text-amber-400 font-medium" title={doc.error_message}>Keyword Only</span>
                    </>
                  ) : (
                    <>
                      {STATUS_ICONS[doc.status]}
                      <span className="text-xs text-gray-400">{STATUS_LABELS[doc.status]}</span>
                    </>
                  )}
                </div>

                {/* Delete button */}
                <button
                  type="button"
                  onClick={(e) => handleDelete(e, doc.id)}
                  className="shrink-0 p-1.5 rounded-lg text-gray-600 hover:text-red-400 hover:bg-red-950/30 transition-colors opacity-0 group-hover:opacity-100"
                  title="Delete document"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        {selected.length > 0 && (
          <p className="text-center text-sm text-gray-500 mt-4">
            {selected.length} document{selected.length > 1 ? "s" : ""} selected — click{" "}
            <span className="text-indigo-400">Start chatting</span> to ask questions about them
          </p>
        )}
      </main>


    </div>
  );
}
