import type { Config, McpToolInfo } from '../types';

interface ApiEnvelope {
  ok?: boolean;
  error?: string;
  [key: string]: unknown;
}

async function post(path: string, body: Record<string, unknown>): Promise<ApiEnvelope> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(
      `Could not reach the local Atelier server (${path}): ${(err as Error).message}. ` +
        'Is the dev server still running?',
    );
  }

  const text = await res.text();
  let payload: ApiEnvelope;
  try {
    payload = JSON.parse(text) as ApiEnvelope;
  } catch {
    throw new Error(`Local server returned non-JSON from ${path}: ${text.slice(0, 300)}`);
  }

  if (payload.error) throw new Error(payload.error);
  if (!res.ok) throw new Error(`Local server error ${res.status} on ${path}`);
  return payload;
}

export interface ConnectResult {
  serverInfo: { name?: string; version?: string } | null;
  tools: McpToolInfo[];
  instructions: string | null;
}

export async function connect(config: Config): Promise<ConnectResult> {
  const out = await post('/api/mcp/connect', { mcpUrl: config.mcpUrl });
  return {
    serverInfo: (out.serverInfo as ConnectResult['serverInfo']) ?? null,
    tools: (out.tools as McpToolInfo[]) ?? [],
    instructions: (out.instructions as string) ?? null,
  };
}

export async function generateCode(
  config: Config,
  request: string,
  canvasSummary?: string,
): Promise<{ code: string; raw: string; model?: string; usage?: unknown }> {
  const out = await post('/api/llm/generate', {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    request,
    canvasSummary,
  });
  return {
    code: String(out.code ?? ''),
    raw: String(out.raw ?? ''),
    model: out.model as string | undefined,
    usage: out.usage,
  };
}

export async function executeCode(
  config: Config,
  code: string,
): Promise<{ ok: boolean; isError: boolean; text: string; result: unknown; raw: unknown }> {
  const out = await post('/api/mcp/execute', { mcpUrl: config.mcpUrl, code });
  return {
    ok: Boolean(out.ok),
    isError: Boolean(out.isError),
    text: String(out.text ?? ''),
    result: out.result,
    raw: out.raw,
  };
}

export async function exportScreen(
  config: Config,
  shapeName: string,
): Promise<{ ok: boolean; image: string | null; text: string; raw: unknown }> {
  const out = await post('/api/mcp/export', { mcpUrl: config.mcpUrl, shapeName });
  return {
    ok: Boolean(out.ok),
    image: (out.image as string | null) ?? null,
    text: String(out.text ?? ''),
    raw: out.raw,
  };
}

export async function fetchModels(config: Config): Promise<string[]> {
  const out = await post('/api/llm/models', {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
  });
  return (out.models as string[]) ?? [];
}