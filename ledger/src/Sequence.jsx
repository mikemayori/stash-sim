import { useEffect, useMemo, useState } from 'react';
import { PARTICIPANTS, PARTICIPANT_INFO, EVIDENCE } from './engine.js';
import { Chip, Toast } from './ui.jsx';

const KIND_TAG = { call: 'main', return: 'muted', error: 'err', note: 'bonus' };
const payloadOf = (s) => (s.detail === undefined ? null : JSON.stringify(s.detail, null, 2));

/** What one step is: who talks to whom, why, the evidence behind it, and the data it carries. */
function StepInfo({ s, index, full }) {
  const payload = payloadOf(s);
  const lines = payload ? payload.split('\n') : [];
  const cut = !full && lines.length > 12;
  const ev = s.ev && EVIDENCE[s.ev];
  return (
    <>
      <div className="tip-head">
        <span className="faint mono">{index + 1}</span>
        <strong>{s.from === s.to ? s.from : `${s.from} → ${s.to}`}</strong>
        <span className={`tag ${KIND_TAG[s.kind]}`}>{s.kind}</span>
      </div>
      <div className="mono tip-label">{s.label}</div>
      {s.why && <p className="tip-why">{s.why}</p>}
      {ev && (
        <div className="tip-ev">
          <div className="tip-cap">evidence</div>
          <p><Chip label={ev.label} /> <span className="ref mono">{s.ev}</span> {ev.text}</p>
        </div>
      )}
      {payload && (
        <>
          <div className="tip-cap">payload</div>
          <pre className="mono tip-pre">{cut ? `${lines.slice(0, 12).join('\n')}\n…` : payload}</pre>
          {cut && <div className="tip-cap">click the step to pin it and see all {lines.length} lines</div>}
        </>
      )}
    </>
  );
}

function Arrow({ s, a, b }) {
  const left = Math.min(a, b);
  const width = Math.abs(b - a);
  return (
    <>
      <div className={`seq-label ${s.kind}`} style={{ left: `${left}%`, width: `${width}%` }}>{s.label}</div>
      <div className={`seq-arrow ${s.kind} ${b > a ? 'r' : 'l'}`} style={{ left: `${left}%`, width: `${width}%` }} />
    </>
  );
}

export default function Sequence({ state }) {
  const steps = state.trace;
  // `hover` is { step } or { col } plus the pointer position; `pinned` is a step index kept open below the diagram.
  const [hover, setHover] = useState(null);
  const [pinned, setPinned] = useState(null);
  useEffect(() => { setPinned(null); setHover(null); }, [steps]);
  // Only the participants of this trace, in the engine's order.
  const cols = useMemo(() => {
    const used = new Set(steps.flatMap((s) => [s.from, s.to]));
    return PARTICIPANTS.filter((p) => used.has(p));
  }, [steps]);
  const x = (p) => ((cols.indexOf(p) + 0.5) / cols.length) * 100;
  const at = (e, what) => setHover({ ...what, x: e.clientX, y: e.clientY });
  // Keep the card inside the window: flip it above the pointer in the lower part of the screen.
  const tipStyle = hover && {
    left: Math.max(8, Math.min(hover.x + 16, window.innerWidth - 416)),
    ...(hover.y > window.innerHeight * 0.55 ? { bottom: window.innerHeight - hover.y + 14 } : { top: hover.y + 18 }),
  };

  return (
    <div className="panel">
      <h2>Sequence: last operation <span className="right sub">{state.lastOp?.name || 'run an action'} · {steps.length} steps · {cols.length} of {PARTICIPANTS.length} participants</span></h2>
      <Toast op={state.lastOp} />
      {steps.length === 0 ? (
        <p className="sub" style={{ marginTop: 8 }}>Every action renders here as a sequence diagram: the caller, lib/index.ts, the service for the store, the balance update, and the separate row write. Hover a step for why it happens and the evidence behind it. Click it to pin its payload.</p>
      ) : (
        <>
          <div className="seq" onMouseLeave={() => setHover(null)}>
            <div className="seq-inner" style={{ minWidth: cols.length * 92 }}>
              <div className="seq-head" style={{ gridTemplateColumns: `repeat(${cols.length}, 1fr)` }}>
                {cols.map((c) => <div key={c}><span onMouseMove={(e) => at(e, { col: c })} onMouseLeave={() => setHover(null)}>{c}</span></div>)}
              </div>
              {steps.map((s, i) => (
                <div className={`seq-row ${pinned === i ? 'pinned' : ''}`} key={i} onMouseMove={(e) => at(e, { step: i })} onClick={() => setPinned(pinned === i ? null : i)}>
                  {cols.map((c) => <div key={c} className="seq-life" style={{ left: `${x(c)}%` }} />)}
                  {s.from === s.to ? (
                    <div className={`seq-note ${s.kind === 'error' ? 'error' : ''}`} style={{ left: `${x(s.from)}%` }}>{s.label}</div>
                  ) : (
                    <Arrow s={s} a={x(s.from)} b={x(s.to)} />
                  )}
                  {s.ev && EVIDENCE[s.ev] && <i className={`seq-ev chip ${EVIDENCE[s.ev].label.toLowerCase()}`} />}
                </div>
              ))}
            </div>
          </div>
          <div className="seq-legend sub">
            <span><i className="lg call" /> call</span>
            <span><i className="lg return" /> return</span>
            <span><i className="lg error" /> error</span>
            <span><i className="lg note" /> note</span>
            <span><i className="seq-ev chip code" style={{ position: 'static' }} /> evidence label of the step</span>
            <span className="faint">hover a step or a column name · click a step to pin it</span>
          </div>
          {pinned !== null && steps[pinned] && (
            <div className="seq-detail">
              <button className="btn small" style={{ float: 'right' }} onClick={() => setPinned(null)}>Close</button>
              <StepInfo s={steps[pinned]} index={pinned} full />
            </div>
          )}
          {hover && (
            <div className="seq-tip" style={tipStyle}>
              {hover.col ? (
                <>
                  <div className="tip-head"><strong>{hover.col}</strong><span className="tag muted">participant</span></div>
                  <p className="tip-why">{PARTICIPANT_INFO[hover.col]}</p>
                </>
              ) : steps[hover.step] && <StepInfo s={steps[hover.step]} index={hover.step} />}
            </div>
          )}
        </>
      )}
    </div>
  );
}
