import { useState } from 'react';
import {
  M_KNOBS, M_PRESETS, createMigration, mSeed, mWrite, mBeginWrite, mFinishWrite, mDeliver,
  mBackfillRead, mBackfillWrite, mRepair, mFlip, mSetFault, mSetConfig, mCompare,
} from './engine.js';
import { MIGRATION_SCENARIOS, runMigrationCase } from './scenarios.js';
import { Chip, Pill, num } from './ui.jsx';

const KINDS = { debit: 'Debit (bet)', credit: 'Credit (primary)', bonus: 'Credit (bonus)', rollback: 'Rollback (allowNegative)' };
const ROUTING = { rethink: 'RethinkDB is the source of truth', flipping: 'Flipping: new writes are held', mongo: 'Mongo is the source of truth' };
const queueText = (q) => (q.change ? `→ ${q.to}: replay change ${q.change.amount}${q.change.bucket === 'bonus' ? ' (bonus)' : ''}` : `→ ${q.to}: set ${q.value.primary}/${q.value.bonus}${q.value.stash ? `, stash ${q.value.stash}` : ''} (v${q.version})`);

function Store({ title, sub, source, rows }) {
  return (
    <div className={`mstore ${source ? 'source' : ''}`}>
      <div className="mstore-head"><strong>{title}</strong>{source && <span className="tag ok">source of truth</span>}</div>
      <div className="sub">{sub}</div>
      <div className="stats four">
        {rows.map(([label, value]) => <div className="stat" key={label}><b>{value}</b><span>{label}</span></div>)}
      </div>
    </div>
  );
}

export default function Migration({ m, setM }) {
  const [kind, setKind] = useState('debit');
  const [amount, setAmount] = useState('30');
  const [seed, setSeed] = useState({ primary: '100', bonus: '0', stash: '0' });
  const [loaded, setLoaded] = useState(null);
  const op = { kind, amount: num(amount) };
  const valid = Number.isFinite(op.amount) && op.amount > 0;
  const act = (fn, ...args) => { setLoaded(null); setM(fn(m, ...args)); };
  const cmp = mCompare(m);
  const presetKey = Object.keys(M_PRESETS).find((k) => Object.entries(M_PRESETS[k].config).every(([key, v]) => m.config[key] === v));
  const reseed = (config = m.config) => {
    setLoaded(null);
    setM(mSeed(createMigration(config, m.type), { primary: num(seed.primary) || 0, bonus: num(seed.bonus) || 0, stash: num(seed.stash) || 0 }));
  };
  const loadCase = (sc, c) => {
    const r = runMigrationCase(sc, c);
    if (r.state) setM(r.state);
    setLoaded({ id: sc.id, label: c.label, status: r.status, notes: r.notes, title: sc.title });
    window.scrollTo({ top: 0 });
  };

  return (
    <div className="stack">
      <div className="panel">
        <h2>Migration of one legacy balance type ({m.type}) from RethinkDB to Mongo</h2>
        <div className="mlabels">
          <span><Chip label="Meeting" text="In progress (Meeting)" /> The plan: mirror every write, backfill, flip the source of truth, drop the old field.</span>
          <span><Chip label="Proposed" /> The safeguards: version check, repair queue, backfill by data, shadow run, write freeze at the flip.</span>
        </div>
        <p className="sub">This is a separate small model with its own state. It reuses the real split functions: the ReQL split for writes on RethinkDB, the Mongo pipeline for writes on Mongo and for the shadow run. Amounts are shown as primary/bonus.</p>
        <div className="row" style={{ flexWrap: 'wrap', gap: 12, marginTop: 10 }}>
          <div className="seg" style={{ flex: 'none' }}>
            {Object.entries(M_PRESETS).map(([k, p]) => <button key={k} className={presetKey === k ? 'on' : ''} onClick={() => act(mSetConfig, M_PRESETS[k].config)}>{p.label}</button>)}
          </div>
          <span className="sub" style={{ flex: 1 }}>{presetKey ? 'Changing the preset keeps the balances and the log.' : 'Custom configuration.'}</span>
        </div>
        <div className="knobs">
          {Object.entries(M_KNOBS).map(([key, k]) => (
            <div key={key} className={`field knob ${m.config[key] !== M_PRESETS.planned.config[key] ? 'diff' : ''}`}>
              <label><span>{k.label}</span><Chip label={k.evLabel} /></label>
              <select value={m.config[key]} onChange={(e) => act(mSetConfig, { ...m.config, [key]: e.target.value })}>
                {Object.entries(k.options).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
          ))}
        </div>
      </div>

      {loaded && (
        <div className="toast warn" style={{ marginTop: 0 }}>
          <Pill status={loaded.status} /> <strong>{loaded.id}, {loaded.label}:</strong> {loaded.title}. Showing its end state.
          <ul className="notes">{loaded.notes.map((n, i) => <li key={i} className="mono">{n}</li>)}</ul>
        </div>
      )}

      <div className="mgrid">
        <div className="stack">
          <div className="panel">
            <h2>Stores <span className="right"><span className={`tag ${m.routing === 'flipping' ? 'lock' : 'main'}`}>routing flag: {m.routing}</span></span></h2>
            <p className="sub" style={{ marginBottom: 10 }}>{ROUTING[m.routing]}. The flag is read in lib/index.ts.</p>
            <div className="mstores">
              <Store title="RethinkDB users row" sub={`${m.type}Balance and its bonus and stash fields`} source={m.routing !== 'mongo'} rows={[['primary', m.rethink.primary], ['bonus', m.rethink.bonus], ['stash', m.rethink.stash], ['version', `v${m.rethink.version}`]]} />
              <Store title="Mongo user_altcoin_portfolios" sub={m.mongo.exists ? `balances.${m.type}` : `no value for ${m.type} yet`} source={m.routing === 'mongo'} rows={[['primary', m.mongo.exists ? m.mongo.primary : '—'], ['bonus', m.mongo.exists ? m.mongo.bonus : '—'], ['stash', m.mongo.exists ? m.mongo.stash : '—'], ['mirror version', m.mongo.mirrorVersion === null ? 'none' : `v${m.mongo.mirrorVersion}`]]} />
            </div>
            <div className={`compare ${cmp.storesMatch && cmp.sourceCorrect ? 'good' : 'bad'}`}>
              <strong>Comparison job</strong>
              <span>stores match: <b className={cmp.storesMatch ? 'pos' : 'neg'}>{cmp.storesMatch ? 'yes' : 'no'}</b></span>
              <span>source of truth correct: <b className={cmp.sourceCorrect ? 'pos' : 'neg'}>{cmp.sourceCorrect ? 'yes' : 'no'}</b></span>
              <span className="mono">RethinkDB {cmp.rethink}</span>
              <span className="mono">Mongo {cmp.mongo}</span>
              <span className="mono">expected {cmp.expected}</span>
            </div>
          </div>

          <div className="panel">
            <h2>Queues and metrics <span className="right sub">player has written since the mirror started: {m.active ? 'yes' : 'no'}</span></h2>
            <div className="mqueues">
              <div>
                <h3>Mirror writes not delivered ({m.queue.length})</h3>
                {m.queue.length === 0 ? <p className="sub">Empty.</p> : <ol className="mono qlist">{m.queue.map((q, i) => <li key={i}>{queueText(q)}</li>)}</ol>}
              </div>
              <div>
                <h3>Requests in flight ({m.openWrites.length})</h3>
                {m.openWrites.length === 0 ? <p className="sub">None.</p> : <ol className="mono qlist">{m.openWrites.map((w) => <li key={w.id}>request {w.id}: {w.op.kind} {w.op.amount}, read flag “{w.route}”</li>)}</ol>}
              </div>
              <div>
                <h3>Repair queue ({m.repairQueue.length})</h3>
                {m.repairQueue.length === 0 ? <p className="sub">{m.config.failureHandling === 'repair' ? 'Empty.' : 'None exists: a failed mirror is one log line.'}</p> : <ol className="mono qlist">{m.repairQueue.map((q, i) => <li key={i}>re-copy to {q.to}</li>)}</ol>}
              </div>
              <div>
                <h3>Backfill</h3>
                <p className="sub mono">{m.backfillRead ? `read ${m.backfillRead.value.primary}/${m.backfillRead.value.bonus} (v${m.backfillRead.version}), not written yet` : 'no read in progress'}</p>
              </div>
            </div>
            <div className="stats four" style={{ marginTop: 10 }}>
              <div className="stat"><b>{m.metrics.mirrorFailed}</b><span>mirror failed (metric)</span></div>
              <div className="stat"><b>{m.metrics.staleSkipped}</b><span>stale copies skipped</span></div>
              <div className="stat"><b>{m.metrics.shadowMismatch}</b><span>shadow mismatches</span></div>
              <div className="stat"><b className={m.faults.mirrorFail ? 'neg' : ''}>{m.faults.mirrorFail}</b><span>mirror writes armed to fail</span></div>
            </div>
          </div>

          <div className="panel">
            <h2>Shadow log <Chip label="Proposed" /><span className="right sub">{m.config.shadow === 'on' ? 'the Mongo pipeline runs beside every RethinkDB write' : 'shadow run is off'}</span></h2>
            {m.shadowLog.length === 0 ? <p className="sub">No mismatch recorded.</p> : (
              <table>
                <thead><tr><th>Write</th><th>Before</th><th>ReQL result</th><th>Mongo pipeline result</th></tr></thead>
                <tbody>
                  {m.shadowLog.map((x, i) => (
                    <tr key={i}><td className="mono">{x.op}</td><td className="mono">{x.before.primary}/{x.before.bonus}</td><td className="mono">{x.rethink.primary}/{x.rethink.bonus}</td><td className="mono neg">{x.mongo.primary}/{x.mongo.bonus}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="stack">
          <div className="panel">
            <h2>Controls</h2>
            <div className="group" style={{ marginTop: 0 }}>
              <label>Seed balances (starts over with the current configuration)</label>
              <div className="row">
                {['primary', 'bonus', 'stash'].map((f) => (
                  <div className="field" key={f}><label>{f}</label><input value={seed[f]} onChange={(e) => setSeed({ ...seed, [f]: e.target.value })} inputMode="decimal" /></div>
                ))}
                <button className="btn" style={{ flex: 'none', alignSelf: 'flex-end' }} onClick={() => reseed()}>Seed</button>
              </div>
            </div>
            <div className="group">
              <label>Balance write, routed by the flag</label>
              <div className="row">
                <div className="field" style={{ flex: 2 }}>
                  <label>Kind</label>
                  <select value={kind} onChange={(e) => setKind(e.target.value)}>{Object.entries(KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                </div>
                <div className="field"><label>Amount</label><input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" /></div>
              </div>
              <div className="btns" style={{ marginTop: 8 }}>
                <button className="btn main" disabled={!valid} onClick={() => act(mWrite, op)}>Write</button>
                <button className="btn" disabled={!valid} title="The request reads the routing flag now and writes later" onClick={() => act(mBeginWrite, op)}>Begin write (in flight)</button>
                <button className="btn" disabled={!m.openWrites.length} onClick={() => act(mFinishWrite)}>Finish write</button>
              </div>
            </div>
            <div className="group">
              <label>Mirror</label>
              <div className="btns">
                <button className="btn" disabled={!m.queue.length} onClick={() => act(mDeliver, { order: 'fifo' })}>Deliver queue in order</button>
                <button className="btn" disabled={!m.queue.length} onClick={() => act(mDeliver, { order: 'reversed' })}>Deliver reversed</button>
                <button className={`btn ${m.faults.mirrorFail ? 'on' : 'danger'}`} onClick={() => act(mSetFault, m.faults.mirrorFail ? 0 : 1)}>{m.faults.mirrorFail ? 'Next mirror will fail' : 'Fail next mirror'}</button>
                <button className="btn" onClick={() => act(mRepair)}>Run repair</button>
              </div>
            </div>
            <div className="group">
              <label>Backfill, in two steps so a write can land in between</label>
              <div className="btns">
                <button className="btn" onClick={() => act(mBackfillRead)}>Backfill read</button>
                <button className="btn" disabled={!m.backfillRead} onClick={() => act(mBackfillWrite)}>Backfill write</button>
              </div>
            </div>
            <div className="group">
              <label>Flip</label>
              <div className="btns">
                <button className="btn bonus" disabled={m.routing !== 'rethink'} onClick={() => act(mFlip)}>Flip to Mongo</button>
              </div>
            </div>
          </div>
          <div className="panel">
            <h2>Log <span className="right sub">newest first</span></h2>
            <div className="log tall">
              {m.log.length === 0 && <div className="info">Nothing yet.</div>}
              {m.log.map((e) => <div key={e.n}><span className="t">{e.n}</span><span className={e.level}>{e.msg}</span></div>)}
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Migration scenarios <span className="right sub">“Load” shows that case’s end state above · PASS: the stores end correct · RISK: the documented risk reproduces</span></h2>
        <table className="matrix">
          <thead><tr><th>Case</th><th>Risk</th><th>Configurations</th></tr></thead>
          <tbody>
            {MIGRATION_SCENARIOS.map((sc) => (
              <tr key={sc.id}>
                <td><span className="mono faint sid">{sc.id}</span>{sc.title}</td>
                <td className="mono faint">{sc.risk}</td>
                <td>
                  <div className="btns">
                    {sc.cases.map((c) => {
                      const r = runMigrationCase(sc, c);
                      return (
                        <span key={c.label} className={`mcase ${loaded?.id === sc.id && loaded.label === c.label ? 'sel' : ''}`}>
                          <Pill status={r.status} /> {c.label}
                          <button className="btn small" onClick={() => loadCase(sc, c)}>Load</button>
                        </span>
                      );
                    })}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
