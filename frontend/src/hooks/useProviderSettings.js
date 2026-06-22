import { useState, useCallback } from "react";

const STORAGE_KEY = "ragbot_provider_settings";

const LEGACY_CHAT_URLS = {
  groq: "https://api.groq.com/openai/v1",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai/",
  cohere: "https://api.cohere.com/compatibility/v1",
  anthropic: "https://api.anthropic.com/v1",
};

const LEGACY_EMBED_URLS = {
  openai: "https://api.openai.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai/",
  cohere: "https://api.cohere.com/compatibility/v1",
  none: "",
};

export const URL_PRESETS = [
  { label: "Groq", url: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile" },
  { label: "OpenAI", url: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { label: "OpenRouter", url: "https://openrouter.ai/api/v1", model: "meta-llama/llama-3.3-70b-instruct" },
];

export const DEFAULT_SETTINGS = {
  chatBaseUrl: "",
  chatModel: "",
  chatApiKey: "",
  embedBaseUrl: "",
  embedModel: "",
  embedApiKey: "",
  embedDisabled: false,
};

function migrateSettings(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...raw };

  if (!raw.chatBaseUrl && raw.chatProvider) {
    merged.chatBaseUrl = LEGACY_CHAT_URLS[raw.chatProvider] || DEFAULT_SETTINGS.chatBaseUrl;
  }
  if (!raw.embedBaseUrl && raw.embedProvider) {
    merged.embedBaseUrl = LEGACY_EMBED_URLS[raw.embedProvider] ?? DEFAULT_SETTINGS.embedBaseUrl;
    if (raw.embedProvider === "none") {
      merged.embedDisabled = true;
    }
  }

  delete merged.chatProvider;
  delete merged.embedProvider;

  return merged;
}

export function isLocalUrl(url) {
  try {
    const host = new URL(url.trim()).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0";
  } catch {
    return false;
  }
}

export function displayHost(url) {
  try {
    return new URL(url.trim()).host || url;
  } catch {
    return url;
  }
}

export function useProviderSettings() {
  const [settings, setSettings] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved ? migrateSettings(JSON.parse(saved)) : DEFAULT_SETTINGS;
    } catch {
      return DEFAULT_SETTINGS;
    }
  });

  const updateSettings = useCallback((updates) => {
    setSettings((prev) => {
      const next = { ...prev, ...updates };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  return [settings, updateSettings];
}
