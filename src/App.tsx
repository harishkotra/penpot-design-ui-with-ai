import { useEffect, useState } from 'react';
import type { Config, RunOutcome, Step } from './types';
import { loadConfig, mcpUrlWarning, saveConfig } from './lib/config';
import { executeCode, exportScreen, generateCode } from './lib/api';
import { SettingsPanel } from './components/SettingsPanel';
import { StepsPanel } from './components/StepsPanel';
import { CanvasPanel } from './components/CanvasPanel';

/** Must match SCREEN_NAME in server/prompt.ts. */
const SCREEN_NAME = 'Screen';

const INITIAL_STEPS: Step[] = [
  { id: 'generate', label: 'Model writes Plugin API code', status: 'idle' },
  { id: 'execute', label: 'Code runs on the Penpot canvas', status: 'idle' },
  { id: 'export', label: 'Board exported back as PNG', status: 'idle' },
];

const EXAMPLES = [
  'A pricing page hero for a developer tool called Atelier, dark, three tiers',
  'A signup screen for a privacy-first AI agent, calm and minimal',
  'A dashboard header with a title, four stat cards and a search field',
];

export default function App() {
  const [config, setConfig] = useState<Config>(() => loadConfig());
  const [request, setRequest] = useState('');
  const [steps, setSteps] = useState<Step[]>(() => INITIAL_STEPS.map((s) => ({ ...s })));
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  useEffect(() => {
    saveConfig(config);
  }, [config]);

  function addLog(line: string) {
    const stamp = new Date().toLocaleTimeString();
    setLog((prev) => [...prev.slice(-60), `${stamp}  ${line}`]);
  }

  function patchStep(id: string, patch: Partial<Step>) {
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  function failRunningStep(detail: string) {
    setSteps((prev) =>
      prev.map((s) => (s.status === 'running' ? { ...s, status: 'error', detail } : s)),
    );
  }

  async function run() {
    const prompt = request.trim();
    if (!prompt || busy) return;

    setBusy(true);
    setError(null);
    setOutcome(null);
    setSteps(INITIAL_STEPS.map((s) => ({ ...s })));

    const urlWarning = mcpUrlWarning(config.mcpUrl);
    if (urlWarning) addLog(`Warning: ${urlWarning}`);

    let code = '';
    let model: string | undefined;
    let usage: unknown;
    let summary: unknown = null;
    let execLog = '';

    try {
      patchStep('generate', { status: 'running' });
      addLog('Asking the model for Plugin API code...');
      const t0 = performance.now();
      const gen = await generateCode(config, prompt);
      code = gen.code;
      model = gen.model;
      usage = gen.usage;
      const lines = code.split('\n').length;
      patchStep('generate', {
        status: 'ok',
        ms: Math.round(performance.now() - t0),
        detail: `${lines} lines from ${gen.model ?? config.model}`,
      });
      addLog(`Model returned ${lines} lines.`);
      if (!code.trim()) throw new Error('The model returned no code.');

      patchStep('execute', { status: 'running' });
      addLog('Running the code on the Penpot canvas...');
      const t1 = performance.now();
      const exec = await executeCode(config, code);
      if (exec.isError) throw new Error(exec.text || 'execute_code reported an error.');
      summary = exec.result;
      const childCount = Array.isArray((summary as { children?: unknown[] })?.children)
        ? (summary as { children: unknown[] }).children.length
        : undefined;
      patchStep('execute', {
        status: 'ok',
        ms: Math.round(performance.now() - t1),
        detail: childCount !== undefined ? `${childCount} top-level children` : undefined,
      });
      addLog('Canvas updated.');

      patchStep('export', { status: 'running' });
      addLog(`Exporting "${SCREEN_NAME}" as PNG...`);
      const t2 = performance.now();
      const exp = await exportScreen(config, SCREEN_NAME);
      if (!exp.ok || !exp.image) {
        throw new Error(exp.text || 'Export produced no image.');
      }
      patchStep('export', {
        status: 'ok',
        ms: Math.round(performance.now() - t2),
      });
      addLog('Export complete.');

      setOutcome({ code, summary, image: exp.image, execLog, model, usage });
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      failRunningStep(message.slice(0, 120));
      addLog(`Failed: ${message}`);
      // Keep whatever we have so the code is still inspectable.
      if (code) {
        setOutcome({ code, summary, image: null, execLog, model, usage });
      }
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void run();
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          <h1>Atelier</h1>
          <span className="tagline">
            chat in, real editable design out, on a live Penpot canvas
          </span>
        </div>
        <div className="status">
          <span className={busy ? 'pill busy' : 'pill'}>{busy ? 'working' : 'idle'}</span>
          <span className="pill">{config.model || 'no model'}</span>
        </div>
      </header>

      <div className="body">
        <SettingsPanel config={config} onChange={setConfig} onLog={addLog} />

        <div className="middle">
          <CanvasPanel outcome={outcome} busy={busy} screenName={SCREEN_NAME} />

          <section className="composer">
            <textarea
              value={request}
              onChange={(e) => setRequest(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Describe the screen you want. e.g. A pricing page hero for a developer tool, dark theme, three tiers"
              rows={3}
            />
            <div className="composer-actions">
              <div className="examples">
                {EXAMPLES.map((ex) => (
                  <button key={ex} className="chip" onClick={() => setRequest(ex)} disabled={busy}>
                    {ex.length > 46 ? `${ex.slice(0, 46)}...` : ex}
                  </button>
                ))}
              </div>
              <button className="primary" onClick={() => void run()} disabled={busy || !request.trim()}>
                {busy ? 'Working...' : 'Generate'}
              </button>
            </div>
            {error && <p className="err">{error}</p>}
          </section>
        </div>

        <div className="right">
          <StepsPanel steps={steps} log={log} />
        </div>
      </div>
    </div>
  );
}