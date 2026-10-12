import { useState } from 'react';
import type { RunOutcome } from '../types';

interface Props {
  outcome: RunOutcome | null;
  busy: boolean;
  screenName: string;
}

export function CanvasPanel({ outcome, busy, screenName }: Props) {
  const [showCode, setShowCode] = useState(true);
  const [showRaw, setShowRaw] = useState(false);

  return (
    <main className="panel canvas">
      <div className="canvas-head">
        <h2>Canvas</h2>
        {outcome?.image && (
          <a className="download" href={outcome.image} download={`${screenName}.png`}>
            Download PNG
          </a>
        )}
      </div>

      <div className="stage">
        {outcome?.image ? (
          <img src={outcome.image} alt={`Exported ${screenName} board from Penpot`} />
        ) : (
          <div className="empty">
            {busy ? (
              <p>Working. The design appears here once Penpot exports it.</p>
            ) : (
              <>
                <p>No design yet.</p>
                <p className="muted">
                  Describe a screen below and press Generate. The result is a real,
                  editable board on your Penpot canvas, not an image.
                </p>
              </>
            )}
          </div>
        )}
      </div>

      {outcome && (
        <div className="meta">
          <span>
            model <code>{outcome.model ?? 'unknown'}</code>
          </span>
          {outcome.execLog && <span className="muted">plugin log: {outcome.execLog}</span>}
        </div>
      )}

      {outcome && (
        <section className="code-block">
          <header>
            <button className="ghost" onClick={() => setShowCode((v) => !v)}>
              {showCode ? 'Hide' : 'Show'} generated code
            </button>
            <span className="muted">{outcome.code.split('\n').length} lines</span>
          </header>
          {showCode && <pre>{outcome.code}</pre>}
        </section>
      )}

      {outcome && (
        <section className="code-block">
          <header>
            <button className="ghost" onClick={() => setShowRaw((v) => !v)}>
              {showRaw ? 'Hide' : 'Show'} raw plugin return
            </button>
          </header>
          {showRaw && <pre>{JSON.stringify(outcome.summary, null, 2)}</pre>}
        </section>
      )}
    </main>
  );
}