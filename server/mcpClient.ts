/**
 * Minimal MCP (Model Context Protocol) client over Streamable HTTP.
 *
 * Deliberately dependency-free: Node 18+ has global fetch, and the MCP
 * Streamable HTTP transport is just JSON-RPC posted to one endpoint with a
 * session header. Written for Penpot's MCP server, which:
 *   - requires ?userToken=<key> on the URL (it always runs --multi-user)
 *   - replies as SSE (`event: message` then `data: {...}`)
 *   - returns a `mcp-session-id` header on initialize that must be echoed back
 */

export interface McpTool {
  name: string;
  description?: string;
}

export interface McpContent {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface McpToolResult {
  isError: boolean;
  text: string;
  image?: { data: string; mimeType: string };
  raw: unknown;
}

export interface McpSession {
  sessionId?: string;
  serverInfo?: { name?: string; version?: string };
  instructions?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const INIT_TIMEOUT_MS = 20_000;

let rpcId = 0;

async function post(
  url: string,
  body: unknown,
  sessionId: string | undefined,
  timeoutMs: number,
): Promise<{ status: number; sessionId?: string; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    return {
      status: res.status,
      sessionId: res.headers.get('mcp-session-id') ?? undefined,
      text,
    };
  } catch (err) {
    const e = err as Error;
    if (e.name === 'AbortError') {
      throw new Error(
        `MCP request timed out after ${Math.round(timeoutMs / 1000)}s. ` +
          'If this was execute_code, the Penpot plugin is probably not connected, ' +
          'or the Penpot tab is asleep.',
      );
    }
    throw new Error(`Cannot reach the MCP endpoint (${url}): ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Parse a Streamable HTTP reply: SSE frames if present, else bare JSON. */
function parsePayload(text: string): unknown[] {
  const messages: unknown[] = [];
  let sawSse = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimStart();
    if (!line.startsWith('data:')) continue;
    sawSse = true;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      messages.push(JSON.parse(payload));
    } catch {
      /* partial frame, ignore */
    }
  }
  if (!sawSse && text.trim()) {
    try {
      messages.push(JSON.parse(text));
    } catch {
      /* not JSON, ignore */
    }
  }
  return messages;
}

function firstResult(messages: unknown[]): Record<string, unknown> | undefined {
  for (const m of messages) {
    const obj = m as Record<string, unknown>;
    if (obj && typeof obj === 'object' && obj.result) {
      return obj.result as Record<string, unknown>;
    }
  }
  return undefined;
}

function firstError(messages: unknown[]): string | undefined {
  for (const m of messages) {
    const obj = m as Record<string, unknown>;
    if (obj && typeof obj === 'object' && obj.error) {
      const err = obj.error as Record<string, unknown>;
      return String(err.message ?? JSON.stringify(err));
    }
  }
  return undefined;
}

/** initialize + notifications/initialized. Returns the session id. */
export async function openSession(url: string): Promise<McpSession> {
  const init = await post(
    url,
    {
      jsonrpc: '2.0',
      id: ++rpcId,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'atelier', version: '1.0.0' },
      },
    },
    undefined,
    INIT_TIMEOUT_MS,
  );

  if (init.status >= 400) {
    throw new Error(`MCP initialize failed with HTTP ${init.status}: ${init.text.slice(0, 300)}`);
  }

  const messages = parsePayload(init.text);
  const err = firstError(messages);
  if (err) throw new Error(`MCP initialize error: ${err}`);

  const result = firstResult(messages);
  if (!result) {
    throw new Error(
      'MCP initialize returned no result. Check that the URL points at the MCP ' +
        'stream endpoint (usually /mcp/stream) and includes ?userToken=<key>.',
    );
  }

  if (init.sessionId) {
    // Notification: no id, and a 202 with an empty body is the correct answer.
    await post(
      url,
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      init.sessionId,
      INIT_TIMEOUT_MS,
    ).catch(() => undefined);
  }

  return {
    sessionId: init.sessionId,
    serverInfo: result.serverInfo as McpSession['serverInfo'],
    instructions: result.instructions as string | undefined,
  };
}

export async function listTools(url: string, sessionId?: string): Promise<McpTool[]> {
  const res = await post(
    url,
    { jsonrpc: '2.0', id: ++rpcId, method: 'tools/list', params: {} },
    sessionId,
    INIT_TIMEOUT_MS,
  );
  const messages = parsePayload(res.text);
  const err = firstError(messages);
  if (err) throw new Error(`tools/list error: ${err}`);
  const result = firstResult(messages);
  const tools = (result?.tools as McpTool[]) ?? [];
  return tools.map((t) => ({ name: t.name, description: t.description }));
}

/** Call a tool and normalise the content blocks. */
export async function callTool(
  url: string,
  name: string,
  args: Record<string, unknown>,
  sessionId?: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<McpToolResult> {
  const res = await post(
    url,
    { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } },
    sessionId,
    timeoutMs,
  );

  const messages = parsePayload(res.text);
  const err = firstError(messages);
  if (err) {
    return { isError: true, text: err, raw: messages };
  }

  const result = firstResult(messages);
  if (!result) {
    return {
      isError: true,
      text: `Tool "${name}" returned no result (HTTP ${res.status}).`,
      raw: messages,
    };
  }

  const blocks = (result.content as McpContent[]) ?? [];
  const texts: string[] = [];
  let image: McpToolResult['image'];

  for (const block of blocks) {
    if (block.type === 'image' && block.data) {
      image = { data: block.data, mimeType: block.mimeType ?? 'image/png' };
    } else if (typeof block.text === 'string') {
      texts.push(block.text);
    }
  }

  return {
    isError: Boolean(result.isError),
    text: texts.join('\n'),
    image,
    raw: result,
  };
}

/**
 * Penpot's execute_code returns {"result": <whatever the code returned>, "log": ""}
 * as a JSON *string* inside a text block. Unwrap it when possible.
 */
export function unwrapExecuteResult(text: string): unknown {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && 'result' in parsed) {
      return parsed.result;
    }
    return parsed;
  } catch {
    return text;
  }
}

/** Turn a tool result into a data URL for the browser, if it carried an image. */
export function imageDataUrl(result: McpToolResult): string | undefined {
  if (result.image) {
    return `data:${result.image.mimeType};base64,${result.image.data}`;
  }
  // Some MCP servers answer with a URL or a base64 blob in the text block instead.
  const text = result.text.trim();
  if (/^https?:\/\//i.test(text)) return text;
  const b64 = text.match(/^[A-Za-z0-9+/=\s]{512,}$/);
  if (b64) return `data:image/png;base64,${b64[0].replace(/\s+/g, '')}`;
  return undefined;
}