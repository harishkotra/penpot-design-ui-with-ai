import type { Step } from '../types';

interface Props {
  steps: Step[];
  log: string[];
}

const ICON: Record<Step['status'], string> = {
  idle: 'o',
  running: '*',
  ok: '+',
  error: 'x',
};

export function StepsPanel({ steps, log }: Props) {
  return (
    <aside className="panel pipeline">
      <h2>Pipeline</h2>
      <ol className="steps">
        {steps.map((s) => (
          <li key={s.id} className={`step ${s.status}`}>
            <span className="icon">{ICON[s.status]}</span>
            <span className="label">{s.label}</span>
            {typeof s.ms === 'number' && <span className="ms">{s.ms} ms</span>}
            {s.detail && <span className="detail">{s.detail}</span>}
          </li>
        ))}
      </ol>

      <h3>Activity</h3>
      <div className="log">
        {log.length === 0 ? (
          <p className="muted">Nothing yet.</p>
        ) : (
          log.map((line, i) => <p key={i}>{line}</p>)
        )}
      </div>
    </aside>
  );
}