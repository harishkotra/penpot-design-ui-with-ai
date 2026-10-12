/**
 * Mock Penpot MCP server + mock OpenAI-compatible model endpoint.
 *
 * Purpose: verify Atelier's MCP client and codegen plumbing without needing a
 * live Penpot instance. It deliberately mimics Penpot's real quirks:
 *   - replies as SSE with an `mcp-session-id` header
 *   - requires ?userToken= on file operations (Penpot always runs --multi-user)
 *   - returns execute_code output as a JSON *string* inside a text block
 *   - returns export_shape as an image content block (base64)
 *   - can simulate "no plugin connected" via ?noPlugin=1
 *
 * Run:  node test/mock-mcp-server.mjs [port]
 */

import http from 'node:http';

const PORT = Number(process.argv[2] ?? 4599);

// A real 1x1 PNG, so the data URL we produce actually decodes.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

const TOOLS = [
  { name: 'execute_code', description: 'Executes JavaScript code in the Penpot plugin context.' },
  { name: 'high_level_overview', description: 'Returns basic high-level instructions.' },
  { name: 'penpot_api_info', description: 'Retrieves Penpot API documentation for types.' },
  { name: 'export_shape', description: 'Exports a shape from the Penpot design to a PNG or SVG.' },
];

function sse(res, payload, sessionId) {
  const headers = { 'Content-Type': 'text/event-stream' };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  res.writeHead(200, headers);
  res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
}

function rpcResult(res, id, result, sessionId) {
  sse(res, { jsonrpc: '2.0', id, result }, sessionId);
}

function toolText(res, id, text, isError = false) {
  rpcResult(res, id, { content: [{ type: 'text', text }], isError }, 'mock-session');
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(null);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  // ---- mock OpenAI-compatible model endpoint ----
  if (url.pathname === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        object: 'list',
        data: [{ id: 'mock-coder-1' }, { id: 'mock-coder-2' }],
      }),
    );
    return;
  }

  if (url.pathname === '/v1/chat/completions') {
    const body = await readJson(req);
    const userMsg = body?.messages?.find((m) => m.role === 'user')?.content ?? '';
    // Deliberately wrap in markdown fences to exercise extractCode().
    const content =
      'Sure, here is the code:\n\n```javascript\n' +
      "const old = penpotUtils.findShape(s => s.name === 'Screen');\n" +
      'if (old) old.remove();\n' +
      "const screen = penpot.createBoard();\n" +
      "screen.name = 'Screen';\n" +
      'screen.resize(1440, 900);\n' +
      "screen.fills = [{ fillColor: '#0B0B0F', fillOpacity: 1 }];\n" +
      'penpot.currentPage.root.appendChild(screen);\n' +
      'return { board: screen.name, echoed: ' +
      JSON.stringify(String(userMsg).slice(0, 40)) +
      ' };\n```\n\nThat should do it.';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-mock',
        model: 'mock-coder-1',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 111, completion_tokens: 222, total_tokens: 333 },
      }),
    );
    return;
  }

  // ---- mock MCP endpoint ----
  if (url.pathname !== '/mcp/stream') {
    res.writeHead(404).end('not found');
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405).end('POST only');
    return;
  }

  const msg = await readJson(req);
  if (!msg) {
    res.writeHead(400).end('bad json');
    return;
  }

  const hasToken = url.searchParams.has('userToken');
  const noPlugin = url.searchParams.get('noPlugin') === '1';

  if (msg.method === 'initialize') {
    sse(
      res,
      {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'penpot', version: 'mock-1.0.0' },
          instructions: 'Mock Penpot MCP server for verification.',
        },
      },
      'mock-session',
    );
    return;
  }

  if (msg.method === 'notifications/initialized') {
    res.writeHead(202).end();
    return;
  }

  if (msg.method === 'tools/list') {
    rpcResult(res, msg.id, { tools: TOOLS }, 'mock-session');
    return;
  }

  if (msg.method === 'tools/call') {
    const name = msg.params?.name;

    if (name === 'execute_code') {
      if (!hasToken) {
        toolText(
          res,
          msg.id,
          'Tool execution failed: Error: No userToken found in session context. Multi-user mode requires authentication.',
          true,
        );
        return;
      }
      if (noPlugin) {
        toolText(
          res,
          msg.id,
          'Tool execution failed: Error: No Penpot instance connected for user token. Please ensure that Penpot is connected and that the MCP client connection is using the correct token.',
          true,
        );
        return;
      }
      const code = msg.params?.arguments?.code ?? '';
      // Mimic Penpot: execute_code returns {result, log} as a JSON string.
      let inner;
      if (code.includes('penpotUtils.findShape(x => x.name ===')) {
        inner = { result: { id: 'mock-shape-id', name: 'Screen', type: 'board', width: 1440, height: 900 }, log: '' };
      } else {
        inner = {
          result: { board: 'Screen', children: ['Headline:text', 'Subhead:text', 'CTA / Primary:board'] },
          log: '',
        };
      }
      toolText(res, msg.id, JSON.stringify(inner));
      return;
    }

    if (name === 'export_shape') {
      if (!hasToken) {
        toolText(res, msg.id, 'Tool execution failed: Error: No userToken found in session context.', true);
        return;
      }
      rpcResult(
        res,
        msg.id,
        { content: [{ type: 'image', data: TINY_PNG_BASE64, mimeType: 'image/png' }] },
        'mock-session',
      );
      return;
    }

    toolText(res, msg.id, `Unknown tool: ${name}`, true);
    return;
  }

  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown method' } }));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock server listening on http://127.0.0.1:${PORT}`);
  console.log(`  MCP:   http://127.0.0.1:${PORT}/mcp/stream?userToken=mock-token`);
  console.log(`  LLM:   http://127.0.0.1:${PORT}/v1`);
  console.log(`  PNG:   ${TINY_PNG_BASE64.length} chars of base64`);
});

export { TINY_PNG_BASE64, PORT };