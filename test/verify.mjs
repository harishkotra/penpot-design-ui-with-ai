/**
 * End-to-end verification of Atelier's local API, against a mock Penpot MCP
 * server and a mock OpenAI-compatible model endpoint.
 *
 * This exercises the REAL code path: the Vite dev server loads the TypeScript
 * middleware in server/, which uses the real MCP client in server/mcpClient.ts.
 * Only the far ends are mocked.
 *
 * Run:  node test/verify.mjs
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const MOCK_PORT = 4599;
const VITE_PORT = 5199;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
const MCP_URL = `${MOCK_BASE}/mcp/stream?userToken=mock-token`;
const MCP_URL_NO_TOKEN = `${MOCK_BASE}/mcp/stream`;
const MCP_URL_NO_PLUGIN = `${MOCK_BASE}/mcp/stream?userToken=mock-token&noPlugin=1`;
const LLM_BASE = `${MOCK_BASE}/v1`;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` -> ${detail}` : ''}`);
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

async function post(base, pathname, body) {
  const res = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: { parseError: text.slice(0, 200) } };
  }
}

async function waitFor(url, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const mock = spawn(process.execPath, [path.join(__dirname, 'mock-mcp-server.mjs'), String(MOCK_PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
mock.stderr.on('data', (d) => process.stderr.write(`[mock] ${d}`));

let vite;
let exitCode = 0;

try {
  if (!(await waitFor(`${MOCK_BASE}/v1/models`))) {
    throw new Error('mock server did not start');
  }
  console.log(`mock server up on ${MOCK_BASE}`);

  vite = await createServer({
    root: ROOT,
    logLevel: 'warn',
    server: { port: VITE_PORT, strictPort: true, host: '127.0.0.1' },
  });
  await vite.listen();
  const base = `http://127.0.0.1:${VITE_PORT}`;
  console.log(`atelier dev server up on ${base}`);

  // ---------- 1. health ----------
  section('1. health endpoint');
  const health = await fetch(`${base}/api/health`).then((r) => r.json());
  check('reports ok', health.ok === true, JSON.stringify(health));
  check('screen name contract is "Screen"', health.screenName === 'Screen', String(health.screenName));

  // ---------- 2. MCP connect ----------
  section('2. MCP connect (initialize + notifications/initialized + tools/list)');
  const conn = await post(base, '/api/mcp/connect', { mcpUrl: MCP_URL });
  check('connect ok', conn.json.ok === true, JSON.stringify(conn.json).slice(0, 200));
  check('serverInfo.name is penpot', conn.json.serverInfo?.name === 'penpot', JSON.stringify(conn.json.serverInfo));
  check('found 4 tools', Array.isArray(conn.json.tools) && conn.json.tools.length === 4, `got ${conn.json.tools?.length}`);
  const toolNames = (conn.json.tools ?? []).map((t) => t.name).join(',');
  check(
    'tool names match Penpot',
    toolNames === 'execute_code,high_level_overview,penpot_api_info,export_shape',
    toolNames,
  );

  // ---------- 3. model codegen ----------
  section('3. model codegen (markdown fence stripping)');
  const gen = await post(base, '/api/llm/generate', {
    baseUrl: LLM_BASE,
    apiKey: 'unused',
    model: 'mock-coder-1',
    request: 'A pricing page hero, dark theme',
  });
  check('generate ok', gen.json.ok === true, JSON.stringify(gen.json).slice(0, 200));
  const code = String(gen.json.code ?? '');
  check('code is non-empty', code.length > 0);
  check('markdown fences stripped', !code.includes('```'), code.slice(0, 80));
  check('leading prose stripped', !/^Sure,/.test(code), code.slice(0, 40));
  check('starts with real JS', /^(const|let|var|if|for|return|await|penpot|\/\/)/.test(code), code.slice(0, 40));
  check('contains Penpot API call', code.includes('penpot.createBoard()'));
  check('model reported', gen.json.model === 'mock-coder-1', String(gen.json.model));
  check('usage passed through', gen.json.usage?.total_tokens === 333, JSON.stringify(gen.json.usage));

  // ---------- 4. execute on canvas ----------
  section('4. execute_code on the canvas');
  const exec = await post(base, '/api/mcp/execute', { mcpUrl: MCP_URL, code });
  check('execute ok', exec.json.ok === true, JSON.stringify(exec.json).slice(0, 200));
  check('isError false', exec.json.isError === false);
  check(
    'execute_code JSON string unwrapped',
    exec.json.result?.board === 'Screen',
    JSON.stringify(exec.json.result).slice(0, 160),
  );
  check(
    'children parsed',
    Array.isArray(exec.json.result?.children) && exec.json.result.children.length === 3,
    JSON.stringify(exec.json.result?.children),
  );

  // ---------- 5. missing userToken ----------
  section('5. missing userToken is surfaced verbatim');
  const noToken = await post(base, '/api/mcp/execute', { mcpUrl: MCP_URL_NO_TOKEN, code });
  check('reports failure', noToken.json.ok === false, JSON.stringify(noToken.json).slice(0, 160));
  check(
    'error text names the userToken',
    String(noToken.json.text ?? '').includes('No userToken'),
    String(noToken.json.text ?? '').slice(0, 120),
  );

  // ---------- 6. plugin not connected ----------
  section('6. "plugin not connected" is surfaced distinctly');
  const noPlugin = await post(base, '/api/mcp/execute', { mcpUrl: MCP_URL_NO_PLUGIN, code });
  check('reports failure', noPlugin.json.ok === false);
  check(
    'error text names the plugin',
    String(noPlugin.json.text ?? '').includes('No Penpot instance connected'),
    String(noPlugin.json.text ?? '').slice(0, 140),
  );

  // ---------- 7. export ----------
  section('7. export_shape returns a usable image');
  const exp = await post(base, '/api/mcp/export', { mcpUrl: MCP_URL, shapeName: 'Screen' });
  check('export ok', exp.json.ok === true, JSON.stringify(exp.json).slice(0, 200));
  const image = String(exp.json.image ?? '');
  check('image is a data URL', image.startsWith('data:image/png;base64,'), image.slice(0, 40));
  const b64 = image.split(',')[1] ?? '';
  const bytes = Buffer.from(b64, 'base64');
  const isPng =
    bytes.length > 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47;
  check('decoded bytes are a real PNG', isPng, `first bytes: ${bytes.subarray(0, 4).toString('hex')}`);
  check('shape resolved by name', exp.json.shape?.id === 'mock-shape-id', JSON.stringify(exp.json.shape));

  // ---------- 8. model list ----------
  section('8. model list');
  const models = await post(base, '/api/llm/models', { baseUrl: LLM_BASE, apiKey: 'unused' });
  check('two models returned', Array.isArray(models.json.models) && models.json.models.length === 2, JSON.stringify(models.json.models));

  // ---------- 9. bad endpoint handling ----------
  section('9. unreachable MCP endpoint gives an actionable error');
  const bad = await post(base, '/api/mcp/connect', { mcpUrl: 'http://127.0.0.1:1/mcp/stream?userToken=x' });
  check('reports failure', bad.json.ok === false);
  check(
    'error mentions reaching the endpoint',
    /Cannot reach the MCP endpoint|timed out/i.test(String(bad.json.error ?? '')),
    String(bad.json.error ?? '').slice(0, 140),
  );

  // ---------- 10. unknown route ----------
  section('10. unknown API route');
  const unknown = await post(base, '/api/nope', {});
  check('404 with json body', unknown.status === 404 && unknown.json.ok === false, JSON.stringify(unknown.json));
} catch (err) {
  failed += 1;
  failures.push(`harness error: ${err.message}`);
  console.error(`\nHARNESS ERROR: ${err.stack}`);
} finally {
  if (vite) await vite.close();
  mock.kill('SIGTERM');
}

console.log('\n' + '-'.repeat(56));
console.log(`RESULT: ${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f}`);
}
exitCode = failed === 0 ? 0 : 1;
console.log('-'.repeat(56));
process.exit(exitCode);