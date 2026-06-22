import { useState, useEffect } from "react";
import { X, Loader2, FileText } from "lucide-react";
import { getAccessToken } from "../lib/supabase";

const BACKEND = import.meta.env.VITE_BACKEND_URL || "http://localhost:8000";

const TABS = [
  { id: "chunk", label: (d) => `Chunk ${(d?.chunk_index ?? 0) + 1}` },
  { id: "previous", label: () => "Previous" },
  { id: "next", label: () => "Next" },
];

export default function SourcePanel({ chunkId, citationIndex, onClose }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState("chunk");

  useEffect(() => {
    if (!chunkId) return;
    setLoading(true);
    setDetail(null);
    setTab("chunk");

    (async () => {
      try {
        const token = await getAccessToken();
        const res = await fetch(`${BACKEND}/chat/chunks/${chunkId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) setDetail(await res.json());
      } catch {
        /* ignore */
      } finally {
        setLoading(false);
      }
    })();
  }, [chunkId]);

  if (!chunkId) return null;

  const displayText =
    tab === "chunk"
      ? detail?.text
      : tab === "previous"
        ? detail?.previous_context
        : detail?.next_context;

  return (
    <aside className="w-[420px] shrink-0 border-l border-gray-200 bg-white flex flex-col h-full">
      <div className="px-5 py-4 border-b border-gray-200 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
            Source Context
          </p>
          <h2 className="text-base font-semibold text-gray-900 truncate mt-0.5">
            {detail?.filename || "Loading…"}
          </h2>
          {detail && (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {citationIndex != null && (
                <span className="text-xs bg-blue-50 text-blue-700 border border-blue-200 rounded px-2 py-0.5">
                  Citation {citationIndex}
                </span>
              )}
              <span className="text-xs bg-gray-100 text-gray-600 border border-gray-200 rounded px-2 py-0.5">
                Chunk {(detail.chunk_index ?? 0) + 1}
              </span>
              {detail.uploaded_at && (
                <span className="text-xs bg-gray-100 text-gray-600 border border-gray-200 rounded px-2 py-0.5">
                  {new Date(detail.uploaded_at).toLocaleDateString()}
                </span>
              )}
            </div>
          )}
        </div>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-700 p-1 rounded-lg hover:bg-gray-100 transition-colors shrink-0"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {detail && (
        <div className="px-5 pt-3 flex gap-1 border-b border-gray-100">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`text-xs px-3 py-2 rounded-t-lg transition-colors ${
                tab === t.id
                  ? "bg-gray-50 text-gray-900 font-medium border-b-2 border-blue-600"
                  : "text-gray-500 hover:text-gray-800"
              }`}
            >
              {t.label(detail)}
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-5 py-4">
        {loading && (
          <div className="flex items-center gap-2 text-gray-500 text-sm py-8 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading source…
          </div>
        )}

        {!loading && !detail && (
          <p className="text-sm text-gray-500 py-8 text-center">Source not found.</p>
        )}

        {!loading && detail && (
          <>
            {tab !== "chunk" && !displayText && (
              <p className="text-sm text-gray-500 italic">No {tab} context available.</p>
            )}
            {displayText && (
              <div className="text-sm text-gray-700 leading-relaxed whitespace-pre-wrap">
                {displayText}
              </div>
            )}
            {tab === "chunk" && detail.token_count != null && (
              <p className="text-xs text-gray-400 mt-4 flex items-center gap-1">
                <FileText className="w-3 h-3" />
                ~{detail.token_count} tokens
              </p>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
