import { useState } from 'react';
import type { Config, McpToolInfo } from '../types';
import { PRESETS, mcpUrlWarning } from '../lib/config';
import { connect, fetchModels } from '../lib/api';

interface Props {
  config: Config;
  onChange: (next: Config) => void;
  onLog: (line: string) => void;
}

export function SettingsPanel({ config, onChange, onLog }: Props) {
  const [tools, setTools] = useState<McpToolInfo[] | null>(null);
  const [models, setModels] = useState<string[] | null>(null);
  const [checking, setChecking] = useState<'mcp' | 'llm' | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const warning = mcpUrlWarning(config.mcpUrl);

  function field(key: keyof Config, value: string) {
    onChange({ ...config, [key]: value });
  }

  async function checkMcp() {
    setChecking('mcp');
    setMessage(null);
    try {
      const result = await connect(config);
      setTools(result.tools);
      const name = result.serverInfo?.name ?? 'unknown';
      const version = result.serverInfo?.version ?? '?';
      setMessage({
        kind: 'ok',
        text: `Connected to "${name}" ${version} with ${result.tools.length} tool(s).`,
      });
      onLog(`MCP connected: ${name} ${version}, tools: ${result.tools.map((t) => t.name).join(', ')}`);
    } catch (err) {
      setTools(null);
      setMessage({ kind: 'err', text: (err as Error).message });
      onLog(`MCP connect failed: ${(err as Error).message}`);
    } finally {
      setChecking(null);
    }
  }

  async function checkLlm() {
    setChecking('llm');
    setMessage(null);
    try {
      const list = await fetchModels(config);
      setModels(list);
      setMessage({ kind: 'ok', text: `Model endpoint answered with ${list.length} model(s).` });
      onLog(`LLM reachable: ${list.length} models available`);
    } catch (err) {
      setModels(null);
      setMessage({ kind: 'err', text: (err as Error).message });
      onLog(`LLM check failed: ${(err as Error).message}`);
    } finally {
      setChecking(null);
    }
  }

  return (
    <aside className="panel settings">
      <h2>Settings</h2>

      <label className="field">
        <span>Penpot MCP endpoint</span>
        <input
          value={config.mcpUrl}
          spellCheck={false}
          onChange={(e) => field('mcpUrl', e.target.value)}
          placeholder="http://localhost:9001/mcp/stream?userToken=..."
        />
      </label>
      {warning && <p className="warn">{warning}</p>}
      <div className="row">
        <button onClick={checkMcp} disabled={checking !== null}>
          {checking === 'mcp' ? 'Checking...' : 'Test MCP'}
        </button>
      </div>
      {tools && (
        <ul className="tools">
          {tools.map((t) => (
            <li key={t.name}>
              <code>{t.name}</code>
            </li>
          ))}
        </ul>
      )}

      <hr />

      <h3>Model</h3>
      <div className="presets">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            className={config.baseUrl === p.baseUrl ? 'preset active' : 'preset'}
            title={p.hint}
            onClick={() => onChange({ ...config, baseUrl: p.baseUrl, model: p.model })}
          >
            {p.label}
          </button>
        ))}
      </div>

      <label className="field">
        <span>Base URL</span>
        <input
          value={config.baseUrl}
          spellCheck={false}
          onChange={(e) => field('baseUrl', e.target.value)}
        />
      </label>

      <label className="field">
        <span>Model</span>
        <input
          value={config.model}
          spellCheck={false}
          onChange={(e) => field('model', e.target.value)}
        />
      </label>

      <label className="field">
        <span>API key</span>
        <input
          type="password"
          value={config.apiKey}
          spellCheck={false}
          placeholder="not needed for local models"
          onChange={(e) => field('apiKey', e.target.value)}
        />
      </label>

      <div className="row">
        <button onClick={checkLlm} disabled={checking !== null}>
          {checking === 'llm' ? 'Checking...' : 'Test model'}
        </button>
      </div>
      {models && models.length > 0 && (
        <select
          className="models"
          value={config.model}
          onChange={(e) => field('model', e.target.value)}
        >
          <option value={config.model}>{config.model}</option>
          {models
            .filter((m) => m !== config.model)
            .map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
        </select>
      )}

      {message && <p className={message.kind === 'ok' ? 'ok' : 'err'}>{message.text}</p>}

      <p className="footnote">
        Settings persist in this browser only. Nothing is sent anywhere except your
        own model endpoint and your own Penpot server.
      </p>
    </aside>
  );
}