/*
 * The ledger itself: the two store paths, the transaction rows and the operation scaffolding.
 *
 *  Mongo (portfolio types): one findOneAndUpdate update pipeline. Stage 1 copies the starting
 *    values into originalBalance / originalBonusBalance, which stay on the document. The guard and
 *    the split run inside the pipeline. Only the document after the update comes back, and
 *    computeDebitAmountChanges subtracts original* to get each bucket's change.
 *  RethinkDB (legacy types): one update with r.branch(guard, change, {}) and returnChanges,
 *    which returns both images. No scratch fields. The split is written separately.
 *  Rows: a separate insert after the balance update. No sessions.
 */
import {
  USER_ID, EPS, PRECISION, RECENT_WINDOW_MS, ALL_BALANCE_TYPES, tx,
  dAdd, dSub, round, getPath, setPath, pathsOf, docOf, readBalance, bucketName, svcOf, dbOf,
  step, note, log, oid,
} from './core.js';

/* ─── aggregation pipeline: a small evaluator for the operators the ledger uses ─── */
function evalExpr(e, doc) {
  if (typeof e === 'string') return e.startsWith('$') ? getPath(doc, e.slice(1)) : e;
  if (Array.isArray(e)) return e.map((x) => evalExpr(x, doc));
  if (e === null || typeof e !== 'object') return e;
  const keys = Object.keys(e);
  if (keys.length !== 1 || !keys[0].startsWith('$')) return Object.fromEntries(keys.map((k) => [k, evalExpr(e[k], doc)]));
  const op = keys[0];
  if (op === '$literal') return e[op];
  const a = evalExpr(e[op], doc);
  switch (op) {
    case '$add': return a.reduce((x, y) => x + y); // plain doubles (L-06)
    case '$subtract': return a[0] - a[1];
    case '$min': return Math.min(...a);
    case '$max': return Math.max(...a);
    case '$lte': return a[0] <= a[1];
    case '$ne': return a[0] !== a[1];
    case '$or': return a.some(Boolean);
    case '$cond': return a[0] ? a[1] : a[2];
    case '$ifNull': return a[0] ?? a[1];
    case '$round': return Number(a[0].toFixed(a[1]));
    case '$concatArrays': return a.flat();
    default: throw new Error(`unsupported operator ${op}`);
  }
}
/** Runs an update pipeline on one document, in place. Every stage reads the document as it found it. */
function applyPipeline(doc, pipeline) {
  for (const stage of pipeline) {
    const values = Object.entries(stage.$set).map(([path, expr]) => [path, evalExpr(expr, doc)]);
    for (const [path, v] of values) setPath(doc, path, v);
  }
}

/* ─── the split, as a Mongo pipeline and as ReQL-side JavaScript ─── */
const snapshotStage = (p) => ({ $set: { [p.origPrimary]: { $ifNull: [`$${p.primary}`, 0] }, [p.origBonus]: { $ifNull: [`$${p.bonus}`, 0] } } });

/**
 * queryBuilder.ts buildIncrementBalanceQuery: the stages after the original* snapshot.
 * A credit adds to one bucket. A deduction takes primary first and bonus for the rest; on a shortfall
 * without allowNegative both amounts are restored (a no-op). The stage layout is reconstructed (A-layout).
 */
export function buildIncrementBalanceQuery(p, a, cfg) {
  const { amount, bucket = 'primary', balancesToUse = ['primary', 'bonus'], allowNegative = false } = a;
  const P0 = `$${p.origPrimary}`;
  const B0 = `$${p.origBonus}`;
  const R = (e) => (cfg.math === 'round' ? { $round: [e, PRECISION] } : e);
  if (amount >= 0) return [{ $set: { [p[bucket]]: R({ $add: [bucket === 'primary' ? P0 : B0, amount] }) } }];
  const abs = -amount;
  if (allowNegative && cfg.negativeSpill === 'primaryOnly') return [{ $set: { [p.primary]: R({ $subtract: [P0, abs] }) } }];
  const fromPrimary = balancesToUse.includes('primary') ? { $min: [{ $max: [P0, 0] }, abs] } : 0;
  const fromBonus = balancesToUse.includes('bonus') ? { $min: [{ $max: [B0, 0] }, { $subtract: [abs, fromPrimary] }] } : 0;
  const shortfall = { $subtract: [abs, { $add: [fromPrimary, fromBonus] }] };
  const applied = allowNegative || cfg.shortfall === 'clamp' ? true : { $lte: [shortfall, cfg.guardCompare === 'epsilon' ? EPS : 0] };
  const extra = allowNegative ? { $max: [shortfall, 0] } : 0;
  return [{ $set: {
    [p.primary]: { $cond: [applied, R({ $subtract: [P0, { $add: [fromPrimary, extra] }] }), P0] },
    [p.bonus]: { $cond: [applied, R({ $subtract: [B0, fromBonus] }), B0] },
  } }];
}

/** The same split in JavaScript. `floor` is the zero floor on a negative primary. Returns the new amounts; unchanged means refused. */
export function jsSplit(p0, b0, a, cfg, floor = true) {
  const { amount, bucket = 'primary', balancesToUse = ['primary', 'bonus'], allowNegative = false } = a;
  const R = (x) => (cfg.math === 'round' ? round(x) : x);
  if (amount >= 0) return bucket === 'primary' ? { primary: R(p0 + amount), bonus: b0 } : { primary: p0, bonus: R(b0 + amount) };
  const abs = -amount;
  if (allowNegative && cfg.negativeSpill === 'primaryOnly') return { primary: R(p0 - abs), bonus: b0 };
  const fromPrimary = balancesToUse.includes('primary') ? Math.min(floor ? Math.max(p0, 0) : p0, abs) : 0;
  const fromBonus = balancesToUse.includes('bonus') ? Math.min(Math.max(b0, 0), abs - fromPrimary) : 0;
  const shortfall = abs - (fromPrimary + fromBonus);
  const applied = allowNegative || cfg.shortfall === 'clamp' || shortfall <= (cfg.guardCompare === 'epsilon' ? EPS : 0);
  if (!applied) return { primary: p0, bonus: b0 };
  return { primary: R(p0 - (fromPrimary + (allowNegative ? Math.max(shortfall, 0) : 0))), bonus: R(b0 - fromBonus) };
}

/**
 * The ReQL split is written separately from the Mongo pipeline and differs from it; how is Open (L-28).
 * `sameAsMongo` is the Assumed default. `noNegativeFloor` is a hypothesis: the ReQL guard uses the raw
 * primary, so a negative primary (sportsbook debt) is folded into the split and repaid from bonus.
 */
const LEGACY_SPLITS = {
  sameAsMongo: (p0, b0, a, cfg) => jsSplit(p0, b0, a, cfg, true),
  noNegativeFloor: (p0, b0, a, cfg) => jsSplit(p0, b0, a, cfg, false),
};
export const legacySplit = (variant) => LEGACY_SPLITS[variant] || LEGACY_SPLITS.sameAsMongo;

/** What the real Mongo pipeline gives for a starting pair, without touching any state (used by parity and the shadow run). */
export function mongoResult(p0, b0, a, cfg) {
  const p = pathsOf('usdt');
  const doc = { balances: { usdt: { balance: p0, bonusBalance: b0 } } };
  applyPipeline(doc, [snapshotStage(p), ...buildIncrementBalanceQuery(p, a, cfg)]);
  return { primary: doc.balances.usdt.balance, bonus: doc.balances.usdt.bonusBalance };
}
export const legacyResult = (p0, b0, a, cfg) => legacySplit(cfg.legacySplit)(p0, b0, a, cfg);

function reqlText(p, a) {
  const { amount, bucket = 'primary', allowNegative = false } = a;
  if (amount >= 0) return `r.table('users').get(userId).update(\n  (row) => ({ ${p[bucket]}: row('${p[bucket]}').add(${amount}) }),\n  { returnChanges: true })`;
  const abs = -amount;
  return `r.table('users').get(userId).update(\n  (row) => r.branch(\n    ${allowNegative ? 'true' : `row('${p.primary}').add(row('${p.bonus}')).ge(${abs})`},\n    { ${p.primary}: /* primary first */, ${p.bonus}: /* bonus for the rest */ },\n    {}),\n  { returnChanges: true })`;
}

/* ─── operation scaffolding ─── */
export function begin(state, name, caller) {
  const s = structuredClone(state);
  s.clock += s.gapMs ?? 1000;
  s.gapMs = null;
  s.trace = [];
  s.lastOp = { name, caller, ok: null, message: '', warning: null, result: null };
  // The reconciler is a background worker; here it runs between requests.
  if (hasPendingStore(s)) drainPending(s);
  return s;
}
export function fail(s, msg, from = 'Ledger') {
  step(s, from, s.lastOp.caller, msg, { kind: 'error', why: 'The operation is refused and the caller is told why.' });
  s.lastOp.ok = false;
  s.lastOp.message = msg;
  log(s, 'error', `${s.lastOp.name}: ${msg}`);
  return s;
}
export function succeed(s, msg, from = 'Ledger') {
  if (from !== s.lastOp.caller) step(s, from, s.lastOp.caller, msg, { kind: 'return', why: 'The final result, returned to the caller.' });
  s.lastOp.ok = true;
  s.lastOp.message = msg;
  log(s, s.lastOp.warning ? 'warn' : 'ok', `${s.lastOp.name}: ${msg}${s.lastOp.warning ? ` — ${s.lastOp.warning}` : ''}`);
  return s;
}
export function warn(s, text) {
  s.lastOp.warning = s.lastOp.warning ? `${s.lastOp.warning}; ${text}` : text;
}
/** Ends an operation from a ledger result. */
export function finishOp(s, r, msg) {
  s.lastOp.result = r;
  if (!r.ok) return fail(s, r.error, r.from);
  if (r.duplicate) return succeed(s, 'Duplicate ignored, nothing applied');
  if (r.rowMissing) warn(s, s.config.rowFailure === 'pending' ? 'the row insert failed; the pending entry waits for the reconciler' : 'the balance changed but no transaction row was written');
  return succeed(s, msg);
}

/* ─── ground truth ─── */
const bump = (obj, k, n) => { obj[k] = dAdd(obj[k] || 0, n); };
/** Records what should have happened. A keyed operation counts once, however many times the ledger applies it. */
function truthApply(s, a, res) {
  const t = s.truth;
  t.negativeAllowed[a.bt] = readBalance(s, a.bt) < 0 ? Boolean(a.allowNegative || t.negativeAllowed[a.bt]) : false;
  if (a.key) {
    t.applied[a.key] = (t.applied[a.key] || 0) + 1;
    if (t.applied[a.key] > 1) return;
  }
  if (a.truthSkip) return;
  bump(t.expected, a.bt, res.primaryChange);
  bump(t.expected, `${a.bt}Bonus`, res.bonusChange);
}
export const truthAdd = (s, bucket, n) => bump(s.truth.expected, bucket, n);

/* ─── one atomic update on the store that holds the balance type ─── */
const hasPendingStore = (s) => s.config.rowFailure === 'pending' || (s.config.stash === 'on' && s.config.stashRowFailure === 'pending');
function ensurePortfolio(s) {
  if (!s.mongo.portfolio) {
    s.mongo.portfolio = { userId: USER_ID, balances: {} };
    note(s, 'Portfolio svc', 'portfolio document created on first use', { ev: 'L-05', why: 'A user with only legacy balances has no portfolio document. The first write to a portfolio type creates it.' });
  }
  return s.mongo.portfolio;
}

/**
 * Runs `spec` as one atomic update: a pipeline on the portfolio document, or r.branch on the users row.
 * Returns the amounts before and after, or null when the Hardened idempotency key was already applied.
 */
function atomicUpdate(s, bt, spec, a) {
  const p = pathsOf(bt);
  const svc = svcOf(bt);
  const db = dbOf(bt);
  const useKey = s.config.dupCheck === 'ledgerKey' && a.key ? a.key : null;
  const pending = s.config.rowFailure === 'pending' ? { id: oid(s), type: a.type, balanceType: bt, meta: a.meta, createdAt: s.clock } : null;
  let r;
  if (p.store === 'portfolio') {
    const doc = ensurePortfolio(s);
    const P0 = `$${p.origPrimary}`;
    const B0 = `$${p.origBonus}`;
    const changed = { $or: [{ $ne: [`$${p.primary}`, P0] }, { $ne: [`$${p.bonus}`, B0] }] };
    const append = (field, item) => ({ $set: { [field]: { $cond: [changed, { $concatArrays: [{ $ifNull: [`$${field}`, []] }, [item]] }, { $ifNull: [`$${field}`, []] }] } } });
    const pipeline = [snapshotStage(p), ...spec.stages(p)];
    if (pending) pipeline.push(append('pendingEntries', { ...Object.fromEntries(Object.entries(pending).map(([k, v]) => [k, { $literal: v }])), primaryBefore: P0, bonusBefore: B0, primaryAfter: { $ifNull: [`$${p.primary}`, 0] }, bonusAfter: { $ifNull: [`$${p.bonus}`, 0] } }));
    if (useKey) pipeline.push(append('appliedKeys', { $literal: useKey }));
    const filter = { userId: USER_ID, ...(useKey ? { appliedKeys: { $ne: useKey } } : {}) };
    s.lastUpdate = { store: 'Mongo', collection: p.collection, op: 'findOneAndUpdate', filter, update: pipeline, options: { new: true } };
    step(s, svc, db, 'user_altcoin_portfolios.findOneAndUpdate(pipeline)', { detail: { filter, pipeline }, ev: 'L-23', why: `One atomic update. Stage 1 copies the starting values into originalBalance and originalBonusBalance; the guard and the split run inside the pipeline, not in the filter, so the update always matches.${useKey ? ' Hardened: the filter also requires that this idempotency key is not on the document yet.' : ''}` });
    if (useKey && (doc.appliedKeys || []).includes(useKey)) {
      step(s, db, svc, 'null: key already applied', { kind: 'return', detail: { key: useKey }, ev: 'P-hard', why: 'No document matched because the idempotency key is already on it. Nothing changes.' });
      return null;
    }
    applyPipeline(doc, pipeline);
    const after = { primary: readBalance(s, bt), bonus: readBalance(s, bt, 'bonus') };
    const before = { primary: getPath(doc, p.origPrimary), bonus: getPath(doc, p.origBonus) };
    step(s, db, svc, 'document after the update', { kind: 'return', detail: doc.balances[bt], ev: 'L-24', why: 'Mongo returns one image: the document after the update. It carries originalBalance and originalBonusBalance, which stay stored and go stale.' });
    r = { before, after, primaryChange: dSub(after.primary, before.primary), bonusChange: dSub(after.bonus, before.bonus) };
    note(s, svc, `computeDebitAmountChanges: primary ${r.primaryChange}, bonus ${r.bonusChange}`, { detail: r, ev: 'L-16', why: 'Runs after the update: each bucket’s change is the returned value minus original*.' });
    r.pendingId = pending && (r.primaryChange !== 0 || r.bonusChange !== 0) ? pending.id : null;
    return r;
  }
  const row = s.rethink.user;
  const before = { primary: row[p.primary] ?? 0, bonus: row[p.bonus] ?? 0 };
  s.lastUpdate = { store: 'RethinkDB', collection: 'users', op: 'update', reql: spec.reqlText(p), options: { returnChanges: true } };
  step(s, svc, db, 'users.get(id).update(r.branch(…), { returnChanges: true })', { detail: s.lastUpdate, ev: 'L-27', why: `One atomic ReQL update. The guard and the change are one r.branch; an empty object means no change. This logic is written separately from the Mongo pipeline.${useKey ? ' Hardened: the branch also checks the idempotency key.' : ''}` });
  if (useKey && (row.appliedKeys || []).includes(useKey)) {
    step(s, db, svc, 'changes: [] (key already applied)', { kind: 'return', detail: { key: useKey }, ev: 'P-hard', why: 'The branch found the idempotency key on the row and changed nothing.' });
    return null;
  }
  const after = spec.reql(before.primary, before.bonus);
  r = { before, after, primaryChange: dSub(after.primary, before.primary), bonusChange: dSub(after.bonus, before.bonus) };
  const changed = r.primaryChange !== 0 || r.bonusChange !== 0;
  if (changed) {
    row[p.primary] = after.primary;
    row[p.bonus] = after.bonus;
    if (pending) (row.pendingEntries ||= []).push({ ...pending, primaryBefore: before.primary, bonusBefore: before.bonus, primaryAfter: after.primary, bonusAfter: after.bonus });
    if (useKey) (row.appliedKeys ||= []).push(useKey);
  }
  step(s, db, svc, changed ? 'changes: [{ old_val, new_val }]' : 'changes: []', { kind: 'return', detail: changed ? { old_val: before, new_val: after } : [], ev: 'L-27', why: 'returnChanges gives both images of the row, so no scratch fields are needed.' });
  r.pendingId = pending && changed ? pending.id : null;
  return r;
}

/* ─── transaction rows ─── */
/** One row per bucket that changed (L-40). `always` writes a primary row even for a zero change (action log, L-48). */
export function rowsFor(bt, primaryChange, bonusChange, balance, bonusBalance, always = false) {
  const rows = [];
  if (primaryChange !== 0 || (always && bonusChange === 0)) rows.push([bt, primaryChange, balance]);
  if (bonusChange !== 0) rows.push([`${bt}Bonus`, bonusChange, bonusBalance]);
  return rows;
}
/** Hardened: the bet's rows carry the split in meta, so a refund does not have to rebuild it. */
const rowMeta = (cfg, type, meta, primaryChange, bonusChange) => (cfg.refundSplit === 'meta' && type === tx('bet') ? { ...meta, split: { primary: -primaryChange, bonus: -bonusChange } } : meta);

/** Listeners on every row insert, whatever the type (L-47). */
function sideEffects(s, rows, type) {
  const fx = s.sideEffects;
  for (const [balanceType, , currentBalance] of rows) {
    const stashRow = balanceType.endsWith('Stash');
    const quiet = stashRow && s.config.stashListeners === 'skipFastTrack';
    fx.socket += 1;
    if (!quiet) {
      fx.stats += 1;
      fx.lifetimeStats += 1;
      fx.fastTrack += 1;
      fx.lastFastTrack = { bucket: balanceType, real_money: currentBalance };
    }
    if (s.config.rgListener === 'on' && !stashRow) fx.rg += 1;
  }
  step(s, 'Tx DAL', 'Side effects', `transactionCreated × ${rows.length}`, { detail: { type, socket: fx.socket, stats: fx.stats, lifetimeStats: fx.lifetimeStats, fastTrack: fx.lastFastTrack }, ev: 'L-47', why: 'Every row insert, whatever its type, triggers the transactionCreated socket event, stats, lifetime stats, and a FastTrack CRM publish of that bucket’s balance as real_money.' });
}
// `olderThan` places reconciled rows where they belong in time: before any row written after that pending entry.
function insertRows(s, { type, meta, createdAt }, rows, olderThan) {
  return rows.map(([balanceType, amount, currentBalance]) => {
    const doc = { _id: oid(s), userId: USER_ID, type, balanceType, amount, currentBalance, meta, createdAt };
    const list = s.mongo.transactions;
    const at = olderThan ? list.findIndex((x) => x.createdAt < createdAt || (x.createdAt === createdAt && x._id < olderThan)) : 0;
    list.splice(at < 0 ? list.length : at, 0, doc);
    // The warehouse keeps rows past the TTL. With gaps, every fourth row never arrives.
    if (s.config.warehouse === 'complete' || s.seq % 4 !== 0) s.warehouse.unshift(doc);
    return doc._id;
  });
}
function pullPending(s, bt, id) {
  const doc = docOf(s, bt);
  if (doc?.pendingEntries) doc.pendingEntries = doc.pendingEntries.filter((e) => e.id !== id);
}

/**
 * The separate row write (L-51). On failure the error is logged and swallowed and the caller gets no
 * transactionId (L-52). `o.stash` switches to the Stash path's own failure knob.
 */
export function createTransactions(s, { bt, type, meta, rows, pendingId, stash = false }) {
  const from = stash ? 'Ledger' : svcOf(bt);
  step(s, from, 'Tx DAL', rows.length > 1 ? `insertMany × ${rows.length}` : 'insert row', { detail: { type, meta, rows: rows.map(([balanceType, amount, currentBalance]) => ({ balanceType, amount, currentBalance })) }, ev: stash ? 'P-stash' : 'L-19', why: 'The balance has already changed. One row per bucket changed, each with the signed change and that bucket’s new balance.' });
  step(s, 'Tx DAL', 'Mongo primary', `transactions.insert × ${rows.length}`, { ev: 'L-51', why: 'A second, separate write. No session ties it to the balance update, so it can fail on its own.' });
  if (s.faults.failInserts > 0) {
    s.faults.failInserts -= 1;
    const mode = stash ? s.config.stashRowFailure : s.config.rowFailure;
    step(s, 'Mongo primary', 'Tx DAL', 'insert failed', { kind: 'error', ev: 'L-51', why: 'The rows were not written. The balance update before it is not undone.' });
    step(s, 'Tx DAL', from, 'caught and logged: transactionId undefined', { kind: 'error', ev: 'L-52', why: 'The error is logged and swallowed. The caller gets no transactionId and the balance stays changed.' });
    if (mode !== 'swallow') {
      s.sideEffects.alerts.push({ t: s.clock, userId: USER_ID, type, balanceType: bt, meta, rows });
      note(s, 'Tx DAL', 'alert raised with user, type, amounts and identifiers', { ev: stash ? 'P-stash' : 'P-hard', why: 'Enough detail to rebuild the rows by hand. Any real alert should fire on a rate, because failures come in batches.' });
    }
    if (pendingId) note(s, dbOf(bt), 'pendingEntries still holds the entry', { detail: { pendingId }, ev: stash ? 'P-stash' : 'P-hard', why: 'The pending entry written in the same update as the balance is still on the document, so the reconciler can write the missing rows.' });
    if (s.config.sideEffectsOnFail === 'run') sideEffects(s, rows, type);
    else note(s, 'Side effects', 'skipped: no insert, no listeners', { ev: 'L-47', why: 'Inferred: the listeners hang off the insert, so a failed insert also skips the socket event, stats and FastTrack.' });
    log(s, 'error', `transaction insert failed for ${type} on ${bt}${pendingId ? ' (pending entry kept)' : ': no row exists for this balance change'}`);
    return [];
  }
  const ids = insertRows(s, { type, meta, createdAt: s.clock }, rows);
  if (pendingId) {
    step(s, 'Tx DAL', dbOf(bt), 'remove the pending entry', { detail: { pendingId }, ev: stash ? 'P-stash' : 'P-hard', why: 'The rows now exist, so the pending entry is removed from the balance document.' });
    pullPending(s, bt, pendingId);
  }
  sideEffects(s, rows, type);
  step(s, 'Tx DAL', from, `transactionId …${ids[0].slice(-4)}`, { kind: 'return', detail: { ids } });
  return ids;
}

/** Hardened / Stash: writes the rows of every pending entry left behind by a failed insert. */
export function drainPending(s) {
  let written = 0;
  for (const doc of [s.mongo.portfolio, s.rethink.user]) {
    if (!doc?.pendingEntries?.length) continue;
    for (const e of doc.pendingEntries) {
      const pc = e.rows ? 0 : dSub(e.primaryAfter, e.primaryBefore);
      const bc = e.rows ? 0 : dSub(e.bonusAfter, e.bonusBefore);
      const rows = e.rows || rowsFor(e.balanceType, pc, bc, e.primaryAfter, e.bonusAfter);
      step(s, 'Reconciler', 'Mongo primary', `pending entry → transactions.insert × ${rows.length}`, { detail: e, ev: 'P-hard', why: 'The reconciler found a pending entry whose rows were never written and writes them from the amounts stored in the entry.' });
      insertRows(s, { type: e.type, meta: e.rows ? e.meta : rowMeta(s.config, e.type, e.meta, pc, bc), createdAt: e.createdAt }, rows, e.id);
      written += rows.length;
    }
    doc.pendingEntries = [];
  }
  if (written) log(s, 'ok', `reconciler wrote ${written} missing transaction row${written > 1 ? 's' : ''}`);
  return written;
}
export const pendingCount = (s) => (s.mongo.portfolio?.pendingEntries?.length || 0) + (s.rethink.user.pendingEntries?.length || 0);

/* ─── increments: creditBalance / deductBalance ─── */
/**
 * First half of a balance change: up to and including the read (read-then-write) or the whole
 * atomic update. Split in two so two requests can be interleaved deterministically.
 */
export function startChange(s, a) {
  const { bt, amount } = a;
  const p = pathsOf(bt);
  const svc = svcOf(bt);
  const db = dbOf(bt);
  const cfg = s.config;
  step(s, a.caller, 'Ledger', `${a.fn}(${bt}, ${amount}, '${a.type}')`, { detail: { balanceType: bt, amount, type: a.type, meta: a.meta, bucket: a.bucket, balancesToUse: a.balancesToUse, allowNegative: a.allowNegative }, ev: a.ev || 'L-10', why: a.why || 'Every balance change enters through ledger/lib/index.ts.' });
  step(s, 'Ledger', svc, p.store === 'portfolio' ? `incrementPortfolioBalance(${amount})` : `userObject: update balance (${amount})`, { ev: 'L-11', why: p.store === 'portfolio' ? 'Routed by balanceType: a portfolio type goes to the portfolio service and Mongo.' : 'Routed by balanceType: a legacy type goes to the userObject service and RethinkDB.' });

  if (cfg.update === 'readThenWrite') {
    step(s, svc, db, 'read the balance', { ev: 'SIM', why: 'Pseudocode preset: the balance is read first, in its own request. Another request can read the same value before this one writes.' });
    const read = { primary: readBalance(s, bt), bonus: readBalance(s, bt, 'bonus') };
    step(s, db, svc, `balance ${read.primary}, bonus ${read.bonus}`, { kind: 'return', detail: read });
    const next = p.store === 'rethink' ? legacyResult(read.primary, read.bonus, a, cfg) : jsSplit(read.primary, read.bonus, a, cfg);
    const change = { primaryChange: dSub(next.primary, read.primary), bonusChange: dSub(next.bonus, read.bonus) };
    if (amount < 0) note(s, svc, change.primaryChange || change.bonusChange ? 'checked in app: enough funds' : 'checked in app: not enough', { detail: change, ev: 'SIM', why: 'The funds check runs in the application, on the amounts just read, not inside the database.' });
    if (amount !== 0 && !change.primaryChange && !change.bonusChange) return { a, failed: 'bet__not_enough_balance' };
    return { a, rtw: { read, ...change } };
  }

  const spec = { stages: (pp) => buildIncrementBalanceQuery(pp, a, cfg), reql: (p0, b0) => legacyResult(p0, b0, a, cfg), reqlText: (pp) => reqlText(pp, a) };
  const r = atomicUpdate(s, bt, spec, a);
  if (!r) return { a, duplicate: true };
  if (amount !== 0 && r.primaryChange === 0 && r.bonusChange === 0) {
    note(s, svc, p.store === 'portfolio' ? 'no-op: original* equal the new values' : 'no-op: empty change list', { detail: r.after, ev: p.store === 'portfolio' ? 'L-84' : 'L-27', why: 'The buckets in use did not cover the amount, so nothing changed. The application detects the refusal by comparing before and after.' });
    return { a, failed: 'bet__not_enough_balance' };
  }
  return { a, r };
}

/** Second half: the write (read-then-write only), the ground truth and the rows. */
export function finishChange(s, ph) {
  const { a } = ph;
  const { bt } = a;
  const svc = svcOf(bt);
  if (ph.failed) {
    step(s, svc, 'Ledger', ph.failed, { kind: 'error', ev: 'L-84', why: 'Every shortfall is reported as bet__not_enough_balance. No row is written for a refused change.' });
    return { ok: false, error: ph.failed };
  }
  if (ph.duplicate) {
    step(s, svc, 'Ledger', 'already applied', { kind: 'return', ev: 'P-hard' });
    return { ok: true, duplicate: true, primaryChange: 0, bonusChange: 0 };
  }
  let res;
  if (ph.rtw) {
    const p = pathsOf(bt);
    const { read, primaryChange, bonusChange } = ph.rtw;
    step(s, svc, dbOf(bt), 'write the change as an increment', { detail: { [p.primary]: primaryChange, [p.bonus]: bonusChange }, ev: 'SIM', why: 'Pseudocode preset: the change is written with no check. If another request wrote in between, the balance can go below zero.' });
    const doc = p.store === 'portfolio' ? ensurePortfolio(s) : s.rethink.user;
    setPath(doc, p.primary, readBalance(s, bt) + primaryChange);
    setPath(doc, p.bonus, readBalance(s, bt, 'bonus') + bonusChange);
    // The resulting balance is worked out from what was read, not from what is now stored.
    res = { primaryChange, bonusChange, balance: read.primary + primaryChange, bonusBalance: read.bonus + bonusChange };
  } else {
    res = { primaryChange: ph.r.primaryChange, bonusChange: ph.r.bonusChange, balance: ph.r.after.primary, bonusBalance: ph.r.after.bonus };
  }
  step(s, svc, 'Ledger', `primary ${res.primaryChange}, bonus ${res.bonusChange}`, { kind: 'return', detail: res });
  truthApply(s, a, res);
  const rows = rowsFor(bt, res.primaryChange, res.bonusChange, res.balance, res.bonusBalance);
  const ids = createTransactions(s, { bt, type: a.type, meta: rowMeta(s.config, a.type, a.meta, res.primaryChange, res.bonusChange), rows, pendingId: ph.r?.pendingId });
  return { ok: true, ...res, transactionId: ids[0], transactionIds: ids, rowMissing: ids.length === 0 };
}
const changeBalance = (s, a) => finishChange(s, startChange(s, a));

/** deductBalance forces the sign: −1 × |change| (L-29). */
export const deductArgs = (a) => ({ ...a, amount: -Math.abs(a.amount), fn: 'deductBalance', ev: 'L-29', why: 'deductBalance applies −1 × |change|, so the operation sets the sign, not the caller.' });
export const deductBalance = (s, a) => changeBalance(s, deductArgs(a));
/** The credit path. Whether it forces a positive sign is Open (L-30); a negative amount passed through becomes a deduction of that bucket. */
export function creditBalance(s, a) {
  const amount = s.config.creditSign === 'forcePositive' ? Math.abs(a.amount) : a.amount;
  return changeBalance(s, { bucket: 'primary', ...a, amount, balancesToUse: [a.bucket || 'primary'], fn: 'creditBalance', ev: amount < 0 ? 'L-30' : 'L-32' });
}

/* ─── bonus completion and expiry: one update, one row per bucket (L-33) ─── */
export function transformBonus(s, { bt, kind, type, meta, caller }) {
  const svc = svcOf(bt);
  const R = (e) => (s.config.math === 'round' ? { $round: [e, PRECISION] } : e);
  const Rj = (x) => (s.config.math === 'round' ? round(x) : x);
  const fn = kind === 'complete' ? 'transferPortfolioBonusToPrimary' : 'clearPortfolioBonus';
  const spec = kind === 'complete'
    ? { stages: (p) => [{ $set: { [p.primary]: R({ $add: [`$${p.origPrimary}`, `$${p.origBonus}`] }), [p.bonus]: 0 } }], reql: (p0, b0) => ({ primary: Rj(p0 + b0), bonus: 0 }), reqlText: (p) => `r.table('users').get(userId).update(\n  (row) => ({ ${p.primary}: row('${p.primary}').add(row('${p.bonus}')), ${p.bonus}: 0 }),\n  { returnChanges: true })` }
    : { stages: (p) => [{ $set: { [p.bonus]: 0 } }], reql: (p0) => ({ primary: p0, bonus: 0 }), reqlText: (p) => `r.table('users').get(userId).update({ ${p.bonus}: 0 }, { returnChanges: true })` };
  step(s, caller, 'Ledger', `${fn}(${bt})`, { detail: { balanceType: bt, type, meta }, ev: 'L-33', why: kind === 'complete' ? 'Completion moves the bonus amount to primary in one update.' : 'Expiry zeroes the bonus amount in one update.' });
  step(s, 'Ledger', svc, fn, { ev: 'L-11' });
  const r = atomicUpdate(s, bt, spec, { type, meta });
  const res = { ok: true, primaryChange: r.primaryChange, bonusChange: r.bonusChange, balance: r.after.primary, bonusBalance: r.after.bonus };
  if (r.primaryChange === 0 && r.bonusChange === 0) return { ...res, unchanged: true };
  truthApply(s, { bt }, res);
  const ids = createTransactions(s, { bt, type, meta, rows: rowsFor(bt, r.primaryChange, r.bonusChange, r.after.primary, r.after.bonus), pendingId: r.pendingId });
  return { ...res, transactionId: ids[0], transactionIds: ids, rowMissing: ids.length === 0 };
}

/* ─── overwrite: setPortfolioBalance and its legacy equivalent (L-34) ─── */
/**
 * Overwrites one bucket and writes one row. How the recorded difference is computed is Open (L-35):
 * `priorRead` is the value the caller read before the set (it can be stale); otherwise the update itself returns it.
 */
export function setBalance(s, { bt, bucket = 'primary', value, type, meta, caller, fn, priorRead }) {
  const p = pathsOf(bt);
  const svc = svcOf(bt);
  const db = dbOf(bt);
  const name = bucketName(bt, bucket);
  step(s, caller, 'Ledger', `${fn}(${name}, ${value})`, { detail: { balanceType: bt, bucket, value, type, meta }, ev: 'L-12' });
  step(s, 'Ledger', svc, p.store === 'portfolio' ? `setPortfolioBalance(${value})` : `userObject: set balance (${value})`, { ev: 'L-34', why: 'An overwrite, not an increment. It acts on one bucket only.' });
  const doc = p.store === 'portfolio' ? ensurePortfolio(s) : s.rethink.user;
  const before = getPath(doc, p[bucket]) ?? 0;
  const fromUpdate = s.config.setDiff === 'returned' || priorRead === undefined;
  const pendingId = s.config.rowFailure === 'pending' ? oid(s) : null;
  const amount = dSub(value, fromUpdate ? before : priorRead);
  setPath(doc, p[bucket], value);
  s.lastUpdate = p.store === 'portfolio'
    ? { store: 'Mongo', collection: p.collection, op: 'findOneAndUpdate', filter: { userId: USER_ID }, update: { $set: { [p[bucket]]: value } }, options: { returnDocument: fromUpdate ? 'before' : 'after' } }
    : { store: 'RethinkDB', collection: 'users', op: 'update', reql: `r.table('users').get(userId).update({ ${p[bucket]}: ${value} }, { returnChanges: true })`, options: { returnChanges: true } };
  step(s, svc, db, p.store === 'portfolio' ? `findOneAndUpdate({ $set: ${value} })` : `update({ ${p[bucket]}: ${value} })`, { detail: s.lastUpdate, ev: 'L-34' });
  step(s, db, svc, fromUpdate ? `was ${before}, now ${value}` : `now ${value}`, { kind: 'return', ev: 'L-35', why: fromUpdate ? 'The difference is computed from the same update that sets the value, so it is always the real change.' : 'The difference is computed from a value read before the set. If anything changed the balance in between, the row is wrong.' });
  if (pendingId) (doc.pendingEntries ||= []).push({ id: pendingId, type, balanceType: bt, meta, createdAt: s.clock, rows: [[name, amount, value]] });
  const real = dSub(value, before);
  if (Math.abs(amount - real) > EPS) {
    s.truth.adminMismatch.push({ bucket: name, recorded: amount, real });
    warn(s, `the row records ${amount} but the balance really changed by ${real}`);
  }
  s.truth.expected[name] = value;
  if (bucket === 'primary' && value >= 0) s.truth.negativeAllowed[bt] = false;
  const ids = createTransactions(s, { bt, type, meta, rows: [[name, amount, value]], pendingId });
  return { ok: true, amount, real, balance: value, transactionId: ids[0], transactionIds: ids, rowMissing: ids.length === 0 };
}

/* ─── reads of the transaction collection ─── */
/** Rows as a reader sees them: the primary, or a secondary that is `lagMs` behind. */
export function readRows(s, pref = 'primary') {
  if (pref !== 'secondary') return s.mongo.transactions;
  const horizon = s.clock - Number(s.config.lagMs);
  return s.mongo.transactions.filter((t) => t.createdAt <= horizon);
}
export const mongoNode = (pref) => (pref === 'secondary' ? 'Mongo secondary' : 'Mongo primary');

/** The values the post('init') hook accepts (L-91). <type>Stash is known only if the validator was deployed first. */
export function knownRowBalanceTypes(s) {
  const known = new Set();
  for (const { code } of ALL_BALANCE_TYPES) {
    known.add(code);
    known.add(`${code}Bonus`);
    if (s.config.stash === 'on' && s.config.stashValidator === 'deployed') known.add(`${code}Stash`);
  }
  return known;
}
/** Hydrating rows through Mongoose runs the post('init') hook, which throws on an unknown balanceType. */
export function hydrate(s, rows) {
  const known = knownRowBalanceTypes(s);
  const bad = rows.find((t) => !known.has(t.balanceType));
  return bad ? { ok: false, error: `post('init') hook threw: unknown balanceType '${bad.balanceType}'` } : { ok: true, rows };
}

/**
 * The caller-side duplicate check (L-55): look for an existing row before calling the ledger.
 * `rowsRecent` is the ThrillTech form, { userId, type, createdAt >= recent } (L-94).
 */
export function seenBefore(s, caller, type, idField, id) {
  const mode = s.config.dupCheck;
  if (mode !== 'rows' && mode !== 'rowsRecent') return false;
  const node = mongoNode(s.config.dupRead);
  const recent = mode === 'rowsRecent';
  step(s, caller, node, `transactions.findOne({ userId, type: '${type}'${recent ? ', createdAt >= recent' : ''}, meta.${idField} })`, { detail: { type, [`meta.${idField}`]: id, readPreference: s.config.dupRead }, ev: recent ? 'L-94' : 'L-55', why: `Duplicate protection sits outside the ledger: the caller looks for a row it already wrote. This read goes to the ${s.config.dupRead}${s.config.dupRead === 'secondary' ? `, which can be ${s.config.lagMs} ms behind` : ''}. Which node it really reads is Open (L-57).` });
  const hit = readRows(s, s.config.dupRead).some((t) => t.type === type && t.meta?.[idField] === id && (!recent || t.createdAt >= s.clock - RECENT_WINDOW_MS));
  step(s, node, caller, hit ? 'row exists: skip the ledger' : 'null', { kind: 'return', why: hit ? 'A row exists, so this callback was handled before.' : 'No row found, so the callback is treated as new.' });
  return hit;
}
