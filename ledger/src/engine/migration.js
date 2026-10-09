/*
 * The RethinkDB-to-Mongo migration of one legacy balance type, as a small separate model.
 * The plan (mirror, backfill, flip, drop) is In progress (Meeting, L-70 to L-72); the safeguards
 * (version check, repair queue, backfill by data, shadow run, write freeze) are Proposed
 * (migration-risks.md, legacy-balance-migration-approach.md).
 *
 * It reuses the real split functions: the ReQL split for writes on RethinkDB and the Mongo
 * pipeline for writes on Mongo and for the shadow run.
 */
import { PRESETS } from './core.js';
import { jsSplit, mongoResult, legacyResult } from './ledger.js';

const O = (label, evLabel, options) => ({ label, evLabel, options });
export const M_KNOBS = {
  copy: O('What the mirror copies', 'Meeting', { results: 'The result of each write', changes: 'Each change, replayed' }),
  delivery: O('Mirror delivery', 'Open', { sync: 'In the request, in order', async: 'Asynchronous, can reorder' }),
  versionCheck: O('Version check on the copy', 'Proposed', { off: 'Off: plain set', on: 'On: apply only if newer' }),
  failureHandling: O('Failed mirror', 'Open', { log: 'Log line only', repair: 'Metric + repair queue' }),
  backfill: O('Backfill selects', 'Proposed', { activity: 'Inactive players', data: 'Missing or older version' }),
  shadow: O('Shadow run of the Mongo pipeline', 'Proposed', { off: 'Off', on: 'On' }),
  writeFreeze: O('Per-user write freeze at the flip', 'Proposed', { off: 'Off', on: 'On' }),
  legacySplit: O('ReQL split vs Mongo', 'Assumed', { sameAsMongo: 'Same as Mongo', noNegativeFloor: 'Hypothesis: no zero floor on a negative primary' }),
};
export const M_PRESETS = {
  planned: { label: 'Plan as described', config: { copy: 'results', delivery: 'sync', versionCheck: 'off', failureHandling: 'log', backfill: 'activity', shadow: 'off', writeFreeze: 'off', legacySplit: 'sameAsMongo' } },
  safeguarded: { label: 'With the proposed safeguards', config: { copy: 'results', delivery: 'sync', versionCheck: 'on', failureHandling: 'repair', backfill: 'data', shadow: 'on', writeFreeze: 'on', legacySplit: 'sameAsMongo' } },
};

export function createMigration(config = M_PRESETS.planned.config, type = 'cash') {
  return {
    config: { ...M_PRESETS.planned.config, ...config },
    type,
    seq: 0,
    routing: 'rethink', // the flag read in lib/index.ts: rethink | flipping | mongo
    rethink: { primary: 0, bonus: 0, stash: 0, version: 0 },
    mongo: { exists: false, primary: 0, bonus: 0, stash: 0, mirrorVersion: null },
    truth: { primary: 0, bonus: 0 }, // every accepted write applied exactly once
    queue: [], // mirror writes not delivered yet
    repairQueue: [],
    openWrites: [], // requests that read the routing flag and have not written yet
    backfillRead: null,
    active: false, // has the player written since the mirror started?
    faults: { mirrorFail: 0 },
    metrics: { mirrorFailed: 0, staleSkipped: 0, shadowMismatch: 0 },
    shadowLog: [],
    log: [],
  };
}
const say = (m, level, msg) => m.log.unshift({ n: (m.seq += 1), level, msg });
const ledgerCfg = (m) => ({ ...PRESETS.current.config, legacySplit: m.config.legacySplit });
const ARGS = {
  debit: (amount) => ({ amount: -amount }),
  credit: (amount) => ({ amount }),
  bonus: (amount) => ({ amount, bucket: 'bonus' }),
  rollback: (amount) => ({ amount: -amount, allowNegative: true }),
};
const side = (m, name) => (name === 'mongo' ? m.mongo : m.rethink);
const versionOf = (m, name) => (name === 'mongo' ? m.mongo.mirrorVersion ?? -1 : m.rethink.version);
function setVersion(m, name, v) {
  if (name === 'mongo') m.mongo.mirrorVersion = v;
  else m.rethink.version = v;
}

/** Sets the balances the player had before the migration started. */
export function mSeed(state, { primary = 0, bonus = 0, stash = 0 }) {
  const m = structuredClone(state);
  Object.assign(m.rethink, { primary, bonus, stash });
  m.truth = { primary, bonus };
  say(m, 'info', `RethinkDB starts at ${primary}/${bonus}${stash ? `, stash ${stash}` : ''}; Mongo has no value for ${m.type}`);
  return m;
}

/** Applies one copy to the other store. Best effort: it never fails the write that caused it. */
function deliver(m, item) {
  const target = side(m, item.to);
  if (m.faults.mirrorFail > 0) {
    m.faults.mirrorFail -= 1;
    if (m.config.failureHandling === 'repair') {
      m.metrics.mirrorFailed += 1;
      m.repairQueue.push({ to: item.to });
      say(m, 'warn', `mirror to ${item.to} failed: metric raised, queued for repair`);
    } else {
      say(m, 'error', `mirror to ${item.to} failed: one log line, nothing else`);
    }
    return;
  }
  if (item.to === 'mongo' && !m.mongo.exists) {
    m.mongo.exists = true;
    say(m, 'info', 'portfolio document created by the mirror');
  }
  if (item.change) {
    // Replaying the change runs the target's own logic on the target's own balance.
    const next = item.to === 'mongo' ? mongoResult(target.primary, target.bonus, item.change, ledgerCfg(m)) : legacyResult(target.primary, target.bonus, item.change, ledgerCfg(m));
    const refused = item.change.amount !== 0 && next.primary === target.primary && next.bonus === target.bonus;
    Object.assign(target, next);
    say(m, refused ? 'error' : 'ok', `replayed ${item.change.amount} on ${item.to}: ${refused ? 'refused by the zero floor' : `${next.primary}/${next.bonus}`}`);
    return;
  }
  if (m.config.versionCheck === 'on' && item.version <= versionOf(m, item.to)) {
    m.metrics.staleSkipped += 1;
    say(m, 'ok', `copy v${item.version} skipped: ${item.to} already has v${versionOf(m, item.to)}`);
    return;
  }
  Object.assign(target, item.value);
  setVersion(m, item.to, item.version);
  say(m, 'ok', `${item.to} set to ${item.value.primary}/${item.value.bonus} (v${item.version})${m.config.versionCheck === 'on' ? '' : ', plain set'}`);
}

function applyWrite(m, route, op) {
  const a = ARGS[op.kind](op.amount);
  const cfg = ledgerCfg(m);
  const from = route === 'mongo' ? 'mongo' : 'rethink';
  const to = from === 'mongo' ? 'rethink' : 'mongo';
  const src = side(m, from);
  const old = { primary: src.primary, bonus: src.bonus };
  const next = from === 'mongo' ? mongoResult(old.primary, old.bonus, a, cfg) : legacyResult(old.primary, old.bonus, a, cfg);
  const refused = next.primary === old.primary && next.bonus === old.bonus;
  if (refused) {
    say(m, 'error', `${op.kind} ${op.amount} on ${from}: refused, not enough balance`);
    return;
  }
  Object.assign(src, next);
  const version = versionOf(m, from) + 1;
  setVersion(m, from, version);
  if (from === 'rethink') m.active = true;
  Object.assign(m.truth, jsSplit(m.truth.primary, m.truth.bonus, a, cfg));
  say(m, 'ok', `${op.kind} ${op.amount} on ${from}: ${next.primary}/${next.bonus} (v${version})`);
  // Shadow run: what would the Mongo pipeline have produced from the same starting balance?
  if (from === 'rethink' && m.config.shadow === 'on') {
    const shadow = mongoResult(old.primary, old.bonus, a, cfg);
    if (shadow.primary !== next.primary || shadow.bonus !== next.bonus) {
      m.metrics.shadowMismatch += 1;
      m.shadowLog.unshift({ op: `${op.kind} ${op.amount}`, before: old, rethink: next, mongo: shadow });
      say(m, 'warn', `shadow mismatch: ReQL ${next.primary}/${next.bonus}, Mongo pipeline ${shadow.primary}/${shadow.bonus}`);
    }
  }
  // A write that lands on a store that is no longer the source of truth is not mirrored anywhere.
  if (route !== m.routing && m.routing !== 'flipping') {
    say(m, 'error', `this write used a stale routing flag (${route}); nothing mirrors it`);
    return;
  }
  // Primary, bonus and stash are always copied together, under one version.
  const item = m.config.copy === 'changes' ? { to, change: a } : { to, value: { primary: next.primary, bonus: next.bonus, stash: src.stash }, version };
  if (m.config.delivery === 'async' || op.hold) m.queue.push(item);
  else deliver(m, item);
}

/** A balance write: { kind: 'debit' | 'credit' | 'bonus' | 'rollback', amount }. Routed by the flag. */
export function mWrite(state, op) {
  const m = structuredClone(state);
  if (m.routing === 'flipping') {
    say(m, 'warn', `${op.kind} ${op.amount}: held while the type is flipping; the caller retries`);
    return m;
  }
  applyWrite(m, m.routing, op);
  return m;
}
/** A request reads the routing flag now and writes later (mFinishWrite). */
export function mBeginWrite(state, op) {
  const m = structuredClone(state);
  const id = (m.seq += 1);
  m.openWrites.push({ id, route: m.routing, op });
  say(m, 'info', `request ${id} read the flag (${m.routing}) and is in flight: ${op.kind} ${op.amount}`);
  return m;
}
export function mFinishWrite(state) {
  const m = structuredClone(state);
  const w = m.openWrites.shift();
  if (!w) return m;
  applyWrite(m, w.route, w.op);
  if (m.routing === 'flipping' && !m.openWrites.length) {
    m.routing = 'mongo';
    say(m, 'ok', 'no write in flight any more: the flip completes, Mongo is the source of truth');
  }
  return m;
}
/** Delivers the queued mirror writes, in order or reversed. */
export function mDeliver(state, { order = 'fifo' } = {}) {
  const m = structuredClone(state);
  const items = order === 'reversed' ? m.queue.reverse() : m.queue;
  m.queue = [];
  for (const item of items) deliver(m, item);
  return m;
}

/** Backfill, in two steps so a write can land between its read and its write. */
export function mBackfillRead(state) {
  const m = structuredClone(state);
  const stale = !m.mongo.exists || (m.mongo.mirrorVersion ?? -1) < m.rethink.version;
  const selected = m.config.backfill === 'data' ? stale : !m.active;
  if (!selected) {
    say(m, stale ? 'error' : 'info', m.config.backfill === 'data' ? 'backfill: Mongo is up to date, skipped' : `backfill: the player counts as active, skipped${stale ? ' although Mongo is behind' : ''}`);
    m.backfillRead = null;
    return m;
  }
  m.backfillRead = { value: { primary: m.rethink.primary, bonus: m.rethink.bonus, stash: m.rethink.stash }, version: m.rethink.version };
  say(m, 'info', `backfill read ${m.rethink.primary}/${m.rethink.bonus} (v${m.rethink.version})`);
  return m;
}
export function mBackfillWrite(state) {
  const m = structuredClone(state);
  if (!m.backfillRead) return m;
  deliver(m, { to: 'mongo', ...m.backfillRead });
  m.backfillRead = null;
  return m;
}
export const mBackfill = (state) => mBackfillWrite(mBackfillRead(state));

/** The repair job re-reads the current value and version; it never uses a value stored in the queue. */
export function mRepair(state) {
  const m = structuredClone(state);
  const jobs = m.repairQueue;
  m.repairQueue = [];
  if (!jobs.length) say(m, 'info', m.config.failureHandling === 'repair' ? 'repair queue is empty' : 'no repair queue exists: failed mirrors were only logged');
  for (const { to } of jobs) {
    const src = side(m, to === 'mongo' ? 'rethink' : 'mongo');
    deliver(m, { to, value: { primary: src.primary, bonus: src.bonus, stash: src.stash }, version: versionOf(m, to === 'mongo' ? 'rethink' : 'mongo') });
  }
  return m;
}

/** Makes Mongo the source of truth. With the freeze, it waits for requests still in flight. */
export function mFlip(state) {
  const m = structuredClone(state);
  if (m.config.writeFreeze === 'on' && m.openWrites.length) {
    m.routing = 'flipping';
    say(m, 'warn', `flipping: new writes are held until ${m.openWrites.length} request(s) in flight finish`);
    return m;
  }
  m.routing = 'mongo';
  if (!m.mongo.exists) m.mongo.exists = true;
  say(m, m.openWrites.length ? 'error' : 'ok', `flipped: Mongo is the source of truth${m.openWrites.length ? `, with ${m.openWrites.length} request(s) still in flight` : ''}`);
  return m;
}
export const mSetFault = (state, n) => ({ ...state, faults: { mirrorFail: n } });
export const mSetConfig = (state, config) => ({ ...state, config: { ...config } });

/** The comparison job: do the stores agree, and does the source of truth match what should be there? */
export function mCompare(m) {
  const source = m.routing === 'mongo' ? m.mongo : m.rethink;
  const storesMatch = m.mongo.exists && m.mongo.primary === m.rethink.primary && m.mongo.bonus === m.rethink.bonus && m.mongo.stash === m.rethink.stash;
  const sourceCorrect = source.primary === m.truth.primary && source.bonus === m.truth.bonus;
  return { storesMatch, sourceCorrect, rethink: `${m.rethink.primary}/${m.rethink.bonus}`, mongo: m.mongo.exists ? `${m.mongo.primary}/${m.mongo.bonus}` : 'no value', expected: `${m.truth.primary}/${m.truth.bonus}` };
}
