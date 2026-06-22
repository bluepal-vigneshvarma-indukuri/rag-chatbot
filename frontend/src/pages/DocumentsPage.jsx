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
  const fileInputRef = useRef(null);
  const navigate = useNavigate();

  const [settings, updateSettings] = useProviderSettings();

  useEffect(() => {
    loadDocuments();
    const interval = setInterval(loadDocuments, 5000);
    return () => clearInterval(interval);
  }, []);

  async function loadDocuments() {
    const token = await getAccessToken();
    if (!token) return;
    try {
      const res = await fetch(`${BACKEND}/documents/`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) setDocuments(await res.json());
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
          setError(data.detail || "Upload failed");
        }
      } catch (err) {
        setError("Upload failed — is the backend running?");
      }
    }
    setUploading(false);
    fileInputRef.current.value = "";
    await loadDocuments();
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
        {/* Upload zone */}
        <div
          onClick={() => fileInputRef.current?.click()}
          className="border-2 border-dashed border-gray-700 hover:border-indigo-500 rounded-2xl p-10 flex flex-col items-center gap-3 cursor-pointer transition-colors mb-8 group"
        >
          <div className="w-14 h-14 rounded-2xl bg-gray-800 group-hover:bg-indigo-950 flex items-center justify-center transition-colors">
            {uploading ? (
              <Loader2 className="w-7 h-7 text-indigo-400 animate-spin" />
            ) : (
              <Upload className="w-7 h-7 text-gray-400 group-hover:text-indigo-400 transition-colors" />
            )}
          </div>
          <div className="text-center">
            <p className="text-white font-medium">
              {uploading ? "Uploading…" : "Upload documents"}
            </p>
            <p className="text-sm text-gray-500 mt-1">
              PDF, DOCX, XLSX, CSV, HTML, TXT, code files — up to 20 MB each
            </p>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
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
                onClick={() =>
                  navigate("/chat", { state: { documentIds: selected.length ? selected : null } })
                }
                className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium px-4 py-2 rounded-xl transition-colors"
              >
                <MessageSquare className="w-4 h-4" />
                {selected.length ? `Chat with ${selected.length} selected` : "Start chatting"}
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
                className={`flex items-center gap-4 p-4 rounded-xl border transition-colors ${
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
                    <p className="text-xs text-red-400 mt-0.5 truncate">{doc.error_message}</p>
                  )}
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  {STATUS_ICONS[doc.status]}
                  <span className="text-xs text-gray-400">{STATUS_LABELS[doc.status]}</span>
                </div>
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
