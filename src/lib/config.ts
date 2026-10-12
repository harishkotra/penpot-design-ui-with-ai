import type { Config, Preset } from '../types';

const STORAGE_KEY = 'atelier.config.v1';

export const PRESETS: Preset[] = [
  {
    id: 'particle',
    label: 'Particle.ai',
    baseUrl: 'https://api.particle.ai/v1',
    model: 'deepseek-v4.1-flash',
    hint: 'Default. Needs an API key.',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    baseUrl: 'http://localhost:1234/v1',
    model: 'local-model',
    hint: 'Runs on your machine. No key needed.',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.2',
    hint: 'Runs on your machine. No key needed.',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    model: 'gemini-2.0-flash',
    hint: 'Needs a Google AI Studio key.',
  },
];

function envDefault(key: string, fallback: string): string {
  const value = (import.meta.env as Record<string, string | undefined>)[key];
  return value && value.trim() ? value.trim() : fallback;
}

export function defaultConfig(): Config {
  return {
    mcpUrl: envDefault('VITE_DEFAULT_MCP_URL', 'http://localhost:9001/mcp/stream'),
    baseUrl: envDefault('VITE_DEFAULT_LLM_BASE_URL', 'https://api.particle.ai/v1'),
    apiKey: '',
    model: envDefault('VITE_DEFAULT_LLM_MODEL', 'deepseek-v4.1-flash'),
  };
}

export function loadConfig(): Config {
  const base = defaultConfig();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<Config>;
    return {
      mcpUrl: parsed.mcpUrl?.trim() || base.mcpUrl,
      baseUrl: parsed.baseUrl?.trim() || base.baseUrl,
      apiKey: parsed.apiKey ?? base.apiKey,
      model: parsed.model?.trim() || base.model,
    };
  } catch {
    return base;
  }
}

export function saveConfig(config: Config): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* private mode, ignore */
  }
}

/** Warn (do not block) when the MCP URL looks like it is missing its token. */
export function mcpUrlWarning(mcpUrl: string): string | null {
  if (!mcpUrl.trim()) return 'No MCP endpoint set.';
  if (!/^https?:\/\//i.test(mcpUrl.trim())) return 'The MCP endpoint should start with http:// or https://';
  if (!/userToken=/i.test(mcpUrl)) {
    return 'No userToken in the URL. Self-hosted Penpot always runs in multi-user mode, so every file call will fail with "No userToken found in session context".';
  }
  return null;
}