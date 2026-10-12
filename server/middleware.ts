/**
 * Local API layer.
 *
 * Mounted by the Vite plugin in vite.config.ts, so it runs in BOTH `vite dev`
 * and `vite preview`. Two reasons this exists rather than calling from the browser:
 *
 *  1. CORS. The Penpot MCP endpoint and most model endpoints do not send CORS
 *     headers, so a browser fetch is blocked. Server-side there is no such rule.
 *  2. The Penpot MCP session header has to be threaded through several calls.
 *
 * Everything stays on your machine. The API key travels browser -> localhost -> upstream.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  callTool,
  imageDataUrl,
  listTools,
  openSession,
  unwrapExecuteResult,
  type McpToolResult,
} from './mcpClient';
import { generateCode, listModels, type LlmConfig } from './llm';
import { buildUserPrompt, SCREEN_NAME, SYSTEM_PROMPT } from './prompt';

const MAX_BODY_BYTES = 2_000_000;

type Handler = (body: Record<string, unknown>) => Promise<unknown>;

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (err) {
        reject(new Error(`Invalid JSON body: ${(err as Error).message}`));
      }
    });
    req.on('error', reject);
  });
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing required field: "${key}".`);
  }
  return value;
}

function llmConfigFrom(body: Record<string, unknown>): LlmConfig {
  return {
    baseUrl: String(body.baseUrl ?? '').trim(),
    apiKey: String(body.apiKey ?? '').trim(),
    model: String(body.model ?? '').trim(),
  };
}

/** Turn a raw MCP result into something the UI can render. */
function shapeToolResult(result: McpToolResult): Record<string, unknown> {
  const image = imageDataUrl(result);
  return {
    isError: result.isError,
    text: result.text,
    result: unwrapExecuteResult(result.text),
    image: image ?? null,
    raw: result.raw,
  };
}

const routes: Record<string, Handler> = {
  'GET /api/health': async () => ({
    ok: true,
    screenName: SCREEN_NAME,
    node: process.version,
  }),

  'POST /api/llm/models': async (body) => {
    const cfg = llmConfigFrom(body);
    const models = await listModels(cfg);
    return { ok: true, models };
  },

  'POST /api/llm/generate': async (body) => {
    const cfg = llmConfigFrom(body);
    const request = requireString(body, 'request');
    const canvasSummary =
      typeof body.canvasSummary === 'string' ? body.canvasSummary : undefined;
    const out = await generateCode(cfg, SYSTEM_PROMPT, buildUserPrompt(request, canvasSummary));
    return { ok: true, code: out.code, raw: out.raw, model: out.model, usage: out.usage };
  },

  'POST /api/mcp/connect': async (body) => {
    const mcpUrl = requireString(body, 'mcpUrl');
    const session = await openSession(mcpUrl);
    const tools = await listTools(mcpUrl, session.sessionId);
    return {
      ok: true,
      serverInfo: session.serverInfo ?? null,
      instructions: session.instructions ?? null,
      tools,
    };
  },

  'POST /api/mcp/execute': async (body) => {
    const mcpUrl = requireString(body, 'mcpUrl');
    const code = requireString(body, 'code');
    const session = await openSession(mcpUrl);
    const result = await callTool(mcpUrl, 'execute_code', { code }, session.sessionId);
    return { ok: !result.isError, ...shapeToolResult(result) };
  },

  'POST /api/mcp/export': async (body) => {
    const mcpUrl = requireString(body, 'mcpUrl');
    const shapeName = typeof body.shapeName === 'string' && body.shapeName ? body.shapeName : SCREEN_NAME;
    const session = await openSession(mcpUrl);

    // Resolve the board id by name first: exporting the page root fails because the
    // page root frame is zero-sized.
    const lookup = await callTool(
      mcpUrl,
      'execute_code',
      {
        code:
          `const s = penpotUtils.findShape(x => x.name === ${JSON.stringify(shapeName)});` +
          `return s ? { id: s.id, name: s.name, type: s.type, width: s.width, height: s.height } : null;`,
      },
      session.sessionId,
    );
    if (lookup.isError) return { ok: false, ...shapeToolResult(lookup) };

    const found = unwrapExecuteResult(lookup.text) as { id?: string } | null;
    if (!found?.id) {
      return {
        ok: false,
        isError: true,
        text: `No shape named "${shapeName}" on the current page. Run a generation first.`,
        result: null,
        image: null,
        raw: lookup.raw,
      };
    }

    const exported = await callTool(
      mcpUrl,
      'export_shape',
      { shapeId: found.id, format: 'png', mode: 'shape' },
      session.sessionId,
      60_000,
    );

    const shaped = shapeToolResult(exported);
    if (!shaped.image) {
      return {
        ok: false,
        isError: true,
        text:
          'export_shape returned no image. Open the raw response panel to see the ' +
          'actual payload shape, then adjust imageDataUrl() in server/mcpClient.ts.',
        result: shaped.result,
        image: null,
        raw: shaped.raw,
      };
    }
    return { ok: true, ...shaped, shape: found };
  },
};

export async function apiMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): Promise<void> {
  const url = req.url ?? '';
  if (!url.startsWith('/api/')) {
    next();
    return;
  }

  const path = url.split('?')[0];
  const key = `${req.method ?? 'GET'} ${path}`;
  const handler = routes[key];

  if (!handler) {
    sendJson(res, 404, { ok: false, error: `No such endpoint: ${key}` });
    return;
  }

  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    const payload = await handler(body);
    sendJson(res, 200, payload);
  } catch (err) {
    sendJson(res, 200, { ok: false, error: (err as Error).message });
  }
}

export { routes };