import { useMemo, useState } from 'react';
import { PRESETS } from './engine.js';
import { SCENARIOS, STASH_SCENARIOS, MIGRATION_SCENARIOS, runCell, runMigrationCase, typesOf } from './scenarios.js';
import { Chip, Pill, STATUS_CLASS } from './ui.jsx';

const PRESET_KEYS = ['current', 'pseudocode', 'hardened', 'stash'];
const LEGEND = [
  ['PASS', 'Correct, as the documents expect.'],
  ['DEBT', 'The documented error reproduces (Current, Stash).'],
  ['OPEN', 'Depends on an Open knob. Each option gives its documented result.'],
  ['N/F', 'Not fixable under Hardened without something that is blocked.'],
  ['fail', 'Pseudocode fails by design.'],
  ['MISMATCH', 'The result differs from the documented expectation. This is a simulator bug.'],
];

const runRow = (sc, keys) => Object.fromEntries(keys.map((k) => [k, typesOf(sc).map((bt) => ({ bt, ...runCell(sc, k, bt) }))]));

/** One matrix cell: one pill per balance type the scenario runs on. */
function Cell({ cells, selected, onPick }) {
  return (
    <td className="res">
      <div className="cellpills">
        {cells.map((c) => (
          <button key={c.bt} className={`cellpill ${selected === c.bt ? 'sel' : ''}`} onClick={() => onPick(c.bt)} title={`${c.bt}: expected ${c.expect}, got ${c.got}`}>
            <i>{c.bt}</i>
            <Pill status={c.status} />
          </button>
        ))}
      </div>
    </td>
  );
}

function Detail({ sc, cell, presetKey, load, span }) {
  const pins = { ...(presetKey === 'hardened' ? {} : sc.pin), ...sc.pinAll };
  return (
    <tr className="detail">
      <td colSpan={span}>
        <div className="detail-head">
          <Pill status={cell.status} />
          <strong>{sc.id} under {PRESETS[presetKey].label}, on {cell.bt}</strong>
          <span className="sub">expected {cell.expect}, got {cell.got}</span>
          {sc.open && <span className="sub">runs once per option of <code>{sc.open.knob}</code></span>}
          {Object.keys(pins).length > 0 && <span className="sub">pinned: <code>{Object.entries(pins).map(([k, v]) => `${k}=${v}`).join(', ')}</code></span>}
        </div>
        <ul className="notes">{cell.notes.map((n, i) => <li key={i} className="mono">{n}</li>)}</ul>
        {cell.state && (
          <button className="btn small" onClick={() => load(cell.state, presetKey)} title="Opens the Simulator tab on this cell’s end state and configuration: balances, rows, invariants and the last operation’s sequence">
            Load into simulator
          </button>
        )}
      </td>
    </tr>
  );
}

function Matrix({ scenarios, keys, load }) {
  const results = useMemo(() => scenarios.map((sc) => ({ sc, byPreset: runRow(sc, keys) })), [scenarios, keys]);
  const [sel, setSel] = useState(null);
  const count = (k, status) => results.reduce((n, r) => n + r.byPreset[k].filter((c) => (status ? c.status === status : true)).length, 0);
  const pick = (id, preset, bt) => setSel(sel && sel.id === id && sel.preset === preset && sel.bt === bt ? null : { id, preset, bt });
  return (
    <table className="matrix">
      <thead>
        <tr>
          <th>Scenario</th>
          <th>Study</th>
          <th>Errors</th>
          {keys.map((k) => (
            <th key={k} style={{ textAlign: 'center' }}>
              {PRESETS[k].label}
              <div className="faint" style={{ fontWeight: 400 }}>{count(k, 'PASS')}/{count(k)} pass{count(k, 'MISMATCH') ? ` · ${count(k, 'MISMATCH')} mismatch` : ''}</div>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {results.map(({ sc, byPreset }) => {
          const open = sel?.id === sc.id;
          const cell = open && byPreset[sel.preset].find((c) => c.bt === sel.bt);
          return [
            <tr key={sc.id} className={open ? 'open' : ''}>
              <td>
                <div><span className="mono faint sid">{sc.id}</span>{sc.title}</div>
                <div className="sub shows">{sc.shows}</div>
              </td>
              <td className="mono faint">{sc.study ? `#${sc.study}` : ''}</td>
              <td>{(sc.errors || []).map((n) => <span key={n} className="tag err" title={`Error ${n} of the error register`}>E{n}</span>)}</td>
              {keys.map((k) => <Cell key={k} cells={byPreset[k]} selected={open && sel.preset === k ? sel.bt : null} onPick={(bt) => pick(sc.id, k, bt)} />)}
            </tr>,
            cell && <Detail key={`${sc.id}-d`} sc={sc} cell={cell} presetKey={sel.preset} load={load} span={3 + keys.length} />,
          ];
        })}
      </tbody>
    </table>
  );
}

function MigrationMatrix({ loadMigration }) {
  const results = useMemo(() => MIGRATION_SCENARIOS.map((sc) => ({ sc, cases: sc.cases.map((c) => ({ c, r: runMigrationCase(sc, c) })) })), []);
  const [sel, setSel] = useState(null);
  return (
    <table className="matrix">
      <thead><tr><th>Case</th><th>Risk</th><th>Result per configuration</th></tr></thead>
      <tbody>
        {results.map(({ sc, cases }) => {
          const picked = sel?.id === sc.id ? cases[sel.i] : null;
          return [
            <tr key={sc.id}>
              <td><span className="mono faint sid">{sc.id}</span>{sc.title}</td>
              <td className="mono faint">{sc.risk}</td>
              <td>
                <div className="cellpills" style={{ justifyContent: 'flex-start' }}>
                  {cases.map(({ c, r }, i) => (
                    <button key={c.label} className={`cellpill wide ${picked && sel.i === i ? 'sel' : ''}`} onClick={() => setSel(picked && sel.i === i ? null : { id: sc.id, i })}>
                      <i>{c.label}</i>
                      <Pill status={r.status} />
                    </button>
                  ))}
                </div>
              </td>
            </tr>,
            picked && (
              <tr key={`${sc.id}-d`} className="detail">
                <td colSpan={3}>
                  <div className="detail-head"><Pill status={picked.r.status} /><strong>{sc.id}: {picked.c.label}</strong><span className="sub">expected {picked.c.expect}, got {picked.r.got}</span></div>
                  <ul className="notes">{picked.r.notes.map((n, i) => <li key={i} className="mono">{n}</li>)}</ul>
                  {picked.r.state && <button className="btn small" onClick={() => loadMigration(picked.r.state)}>Open in the Migration tab</button>}
                </td>
              </tr>
            ),
          ];
        })}
      </tbody>
    </table>
  );
}

const STASH_KEYS = ['stash'];

export default function Scenarios({ load, loadMigration }) {
  return (
    <div className="stack">
      <div className="panel">
        <h2>Scenario matrix <span className="right sub">each cell runs on a fresh user · one result per balance type · click a result for notes and to load it</span></h2>
        <div className="legend">
          {LEGEND.map(([s, text]) => <span key={s}><span className={`pill ${STATUS_CLASS[s]}`}>{s}</span> <span className="sub">{text}</span></span>)}
        </div>
        <Matrix scenarios={SCENARIOS} keys={PRESET_KEYS} load={load} />
        <p className="sub" style={{ marginTop: 10 }}>“Study” is the scenario’s number in LEDGER_STUDY.md §7.3. “Errors” are the entries of the error register it reproduces. The Current + Stash column is expected to match the Current column: Stash should not change existing behaviour.</p>
      </div>
      <div className="panel proposed">
        <h2>Stash scenarios <Chip label="Proposed" /><span className="right sub">Current + Stash preset only</span></h2>
        <Matrix scenarios={STASH_SCENARIOS} keys={STASH_KEYS} load={load} />
      </div>
      <div className="panel">
        <h2>Migration scenarios <Chip label="Meeting" text="In progress (Meeting)" /><Chip label="Proposed" text="safeguards: Proposed" /><span className="right sub">PASS: the stores end correct · RISK: the documented risk reproduces</span></h2>
        <MigrationMatrix loadMigration={loadMigration} />
      </div>
    </div>
  );
}
