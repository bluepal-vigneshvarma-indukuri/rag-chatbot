import { useState } from "react";
import {
  X, Eye, EyeOff, CheckCircle2, AlertCircle, Loader2, Zap,
} from "lucide-react";
import { getAccessToken } from "../lib/supabase";
import {
  URL_PRESETS,
  EMBED_URL_PRESETS,
  isLocalUrl,
} from "../hooks/useProviderSettings";

const BACKEND = import.meta.env.VITE_BACKEND_URL || "http://localhost:8000";

const CHAT_MODEL_HINT = "Model name as expected by your API server (e.g. gpt-4o-mini, llama-3.3-70b-versatile)";
const EMBED_MODEL_HINT = "Embedding model name (e.g. text-embedding-3-small, nomic-embed-text)";
const URL_HINT = "OpenAI-compatible base URL, e.g. https://api.groq.com/openai/v1";

function canTestChat(settings) {
  if (!settings.chatBaseUrl?.trim() || !settings.chatModel?.trim()) return false;
  if (settings.chatApiKey) return true;
  return isLocalUrl(settings.chatBaseUrl);
}

function canTestEmbed(settings) {
  if (settings.embedDisabled) return true;
  if (!settings.embedBaseUrl?.trim() || !settings.embedModel?.trim()) return false;
  if (settings.embedApiKey) return true;
  return isLocalUrl(settings.embedBaseUrl);
}

export default function SettingsPanel({ settings, onUpdate, isOpen, onClose }) {
  const [showChatKey, setShowChatKey]   = useState(false);
  const [showEmbedKey, setShowEmbedKey] = useState(false);
  const [testing, setTesting]           = useState(false);
  const [testResult, setTestResult]     = useState(null);

  if (!isOpen) return null;

  function applyChatPreset(preset) {
    onUpdate({
      chatBaseUrl: preset.url,
      chatModel: preset.model,
    });
    setTestResult(null);
  }

  function applyEmbedPreset(preset) {
    onUpdate({
      embedBaseUrl: preset.url,
      embedModel: preset.model,
      embedDisabled: false,
    });
    setTestResult(null);
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const token = await getAccessToken();
      const res = await fetch(`${BACKEND}/validate/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          chat_base_url:  settings.chatBaseUrl,
          chat_model:     settings.chatModel,
          chat_api_key:   settings.chatApiKey,
          embed_base_url: settings.embedBaseUrl,
          embed_model:    settings.embedModel,
          embed_api_key:  settings.embedApiKey,
          embed_disabled: settings.embedDisabled,
        }),
      });
      const data = await res.json();
      setTestResult(data);
    } catch (err) {
      setTestResult({ _error: err.message });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end">
      <div
        className="absolute inset-0 bg-black/30 backdrop-blur-sm"
        onClick={onClose}
      />

      <div className="relative w-full max-w-md h-full bg-white border-l border-gray-200 overflow-y-auto flex flex-col shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 sticky top-0 bg-white z-10">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-blue-600" />
            <span className="font-semibold text-gray-900">API Settings</span>
          </div>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700 transition-colors rounded-lg p-1"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 px-5 py-6 space-y-8">
          <Section title="Chat / Answering" description="Used to answer your questions">
            <PresetRow presets={URL_PRESETS} onSelect={applyChatPreset} />

            <Field label="API Base URL">
              <input
                type="url"
                value={settings.chatBaseUrl}
                onChange={(e) => { onUpdate({ chatBaseUrl: e.target.value }); setTestResult(null); }}
                placeholder="https://api.groq.com/openai/v1"
                className={inputCls}
              />
              <p className="text-xs text-gray-500 mt-1">{URL_HINT}</p>
            </Field>

            <Field label="Model">
              <input
                type="text"
                value={settings.chatModel}
                onChange={(e) => { onUpdate({ chatModel: e.target.value }); setTestResult(null); }}
                placeholder="llama-3.3-70b-versatile"
                className={inputCls}
              />
              <p className="text-xs text-gray-500 mt-1">{CHAT_MODEL_HINT}</p>
            </Field>

            <Field label="API Key">
              <PasswordInput
                value={settings.chatApiKey}
                onChange={(v) => { onUpdate({ chatApiKey: v }); setTestResult(null); }}
                show={showChatKey}
                onToggleShow={() => setShowChatKey((p) => !p)}
                placeholder={
                  isLocalUrl(settings.chatBaseUrl)
                    ? "Optional for local servers"
                    : "Your API key"
                }
              />
              {testResult?.chat && (
                <StatusBadge result={testResult.chat} />
              )}
            </Field>
          </Section>

          <Section
            title="Embedding"
            description="Used to understand document meaning for semantic search"
          >
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-800">
              Changing embedding settings after uploading documents may reduce search quality. Re-upload documents to apply a new embedding model.
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.embedDisabled}
                onChange={(e) => {
                  onUpdate({ embedDisabled: e.target.checked });
                  setTestResult(null);
                }}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm text-gray-700">Text search only (no embeddings)</span>
            </label>

            {!settings.embedDisabled && (
              <>
                <PresetRow presets={EMBED_URL_PRESETS} onSelect={applyEmbedPreset} />

                <Field label="API Base URL">
                  <input
                    type="url"
                    value={settings.embedBaseUrl}
                    onChange={(e) => { onUpdate({ embedBaseUrl: e.target.value }); setTestResult(null); }}
                    placeholder="https://api.openai.com/v1"
                    className={inputCls}
                  />
                  <p className="text-xs text-gray-500 mt-1">{URL_HINT}</p>
                </Field>

                <Field label="Model">
                  <input
                    type="text"
                    value={settings.embedModel}
                    onChange={(e) => { onUpdate({ embedModel: e.target.value }); setTestResult(null); }}
                    placeholder="text-embedding-3-small"
                    className={inputCls}
                  />
                  <p className="text-xs text-gray-500 mt-1">{EMBED_MODEL_HINT}</p>
                </Field>

                <Field label="API Key">
                  <PasswordInput
                    value={settings.embedApiKey}
                    onChange={(v) => { onUpdate({ embedApiKey: v }); setTestResult(null); }}
                    show={showEmbedKey}
                    onToggleShow={() => setShowEmbedKey((p) => !p)}
                    placeholder={
                      isLocalUrl(settings.embedBaseUrl)
                        ? "Optional for local servers"
                        : "Your embedding API key"
                    }
                  />
                  {testResult?.embed && (
                    <StatusBadge result={testResult.embed} />
                  )}
                </Field>
              </>
            )}

            {settings.embedDisabled && testResult?.embed && (
              <StatusBadge result={testResult.embed} />
            )}
          </Section>

          <div className="space-y-3">
            <button
              onClick={handleTest}
              disabled={testing || !canTestChat(settings) || !canTestEmbed(settings)}
              className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm font-medium px-4 py-2.5 rounded-xl transition-colors"
            >
              {testing ? (
                <><Loader2 className="w-4 h-4 animate-spin" /> Testing…</>
              ) : (
                <><Zap className="w-4 h-4" /> Test Connection</>
              )}
            </button>

            {testResult?._error && (
              <div className="flex items-start gap-2 text-red-600 text-xs bg-red-50 border border-red-200 rounded-lg p-3">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                {testResult._error}
              </div>
            )}
          </div>

          <p className="text-xs text-gray-400 text-center pb-4">
            Keys are stored only in your browser and sent directly to the backend. They are never stored on any server.
          </p>
        </div>
      </div>
    </div>
  );
}

const inputCls =
  "w-full bg-white border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500";

function Section({ title, description, children }) {
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
        {description && <p className="text-xs text-gray-500 mt-0.5">{description}</p>}
      </div>
      {children}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-gray-500 uppercase tracking-wide">
        {label}
      </label>
      {children}
    </div>
  );
}

function PresetRow({ presets, onSelect }) {
  return (
    <div className="flex flex-wrap gap-2">
      {presets.map((preset) => (
        <button
          key={preset.label}
          type="button"
          onClick={() => onSelect(preset)}
          className="text-xs px-2.5 py-1 rounded-lg border border-gray-300 text-gray-600 hover:text-gray-900 hover:border-blue-400 transition-colors"
        >
          {preset.label}
        </button>
      ))}
    </div>
  );
}

function PasswordInput({ value, onChange, show, onToggleShow, placeholder }) {
  return (
    <div className="relative">
      <input
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`${inputCls} pr-10`}
        autoComplete="off"
      />
      <button
        type="button"
        onClick={onToggleShow}
        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
        tabIndex={-1}
      >
        {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );
}

function StatusBadge({ result }) {
  if (result.status === "ok") {
    return (
      <div className="flex items-center gap-1.5 text-emerald-600 text-xs mt-1.5">
        <CheckCircle2 className="w-3.5 h-3.5" />
        {result.message || "Connected successfully"}
      </div>
    );
  }
  const codeMessages = {
    invalid_api_key: "Invalid or expired API key.",
    model_not_found: "Model not found — check the model name.",
    missing_api_key: "No API key provided.",
    rate_limit: "Rate limit reached. Try again shortly.",
    invalid_base_url: "Enter a valid API server URL (http:// or https://).",
    connection_failed: "Could not reach the API server. Check the base URL.",
  };
  return (
    <div className="flex items-start gap-1.5 text-red-600 text-xs mt-1.5">
      <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
      {codeMessages[result.code] || result.message || "Connection failed."}
    </div>
  );
}
