import { EVIDENCE } from './engine.js';

// Every amount is USD, whatever the balance type.
export const fmt = (n) => {
  const x = Number(n);
  if (!Number.isFinite(x)) return String(n);
  return Number(x.toFixed(2)) === x ? x.toFixed(2) : String(x);
};
const pad = (n) => String(n).padStart(2, '0');
export const clockStr = (ms) => {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return `${d ? `${d}d ` : ''}${d || h ? `${pad(h)}:` : ''}${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
};
export const num = (v) => (String(v).trim() === '' ? NaN : Number(v));

/** The one badge used for evidence labels everywhere: Code / Meeting / Study / Inferred / Open / Assumed / Proposed. */
export function Chip({ label, text, title }) {
  if (!label) return null;
  return <span className={`chip ${label.toLowerCase()}`} title={title}>{text || label}</span>;
}

/** Badge + id for an entry of the evidence register. Hover for its text. */
export function Ev({ id, withId = true }) {
  const e = EVIDENCE[id];
  if (!e) return id ? <span className="ref mono">{id}</span> : null;
  return (
    <span className="ev" title={e.text}>
      <Chip label={e.label} />
      {withId && <span className="ref mono">{id}</span>}
    </span>
  );
}

export function Toast({ op }) {
  if (!op) return null;
  return (
    <div className={`toast ${op.ok === false ? 'err' : op.warning ? 'warn' : 'ok'}`}>
      <strong>{op.name}</strong>: {op.message}{op.warning ? ` — ${op.warning}` : ''}
    </div>
  );
}

export const STATUS_CLASS = { PASS: 'pass', DEBT: 'gap', RISK: 'gap', OPEN: 'open', 'N/F': 'nf', fail: 'fail', MISMATCH: 'mismatch' };
export const Pill = ({ status }) => <span className={`pill ${STATUS_CLASS[status] || 'fail'}`}>{status}</span>;
