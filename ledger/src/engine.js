/*
 * Ledger engine — a pure, in-memory model of the ledger described in LEDGER_STUDY.md:
 *
 *  - a unified API (creditBalance / deductFromBalance) over two stores:
 *    the `user_altcoin_portfolios` document and the legacy fields on the `User` document
 *  - every balance type has a primary and a bonus amount
 *  - a balance changes with one findOneAndUpdate aggregation pipeline, which snapshots the
 *    original amounts, guards against overdraft and splits a deduction primary-first
 *  - transaction rows are written after the balance changes (180-day TTL)
 *  - bets, bonuses, payments and responsible gaming sit on top of the ledger
 *
 * Every public operation takes the current state and returns a NEW state.
 * Each operation also records a `trace` (sequence-diagram steps) for the UI.
 *
 * The pipelines here are reconstructed from the study's description, not copied from
 * the backend: the stage layout is ours, the behaviour is the study's.
 */
import Decimal from 'decimal.js';

export const BALANCE_TYPES = [
  { code: 'usdt', label: 'USDT', store: 'portfolio', decimals: 6 },
  { code: 'eth', label: 'ETH', store: 'portfolio', decimals: 18 },
  // Legacy balances are plain fields on the User document.
  { code: 'btc', label: 'BTC', store: 'user', field: 'balance', bonusField: 'btcBonusBalance', decimals: 8 },
  { code: 'cash', label: 'Cash', store: 'user', field: 'cashBalance', bonusField: 'cashBonusBalance', decimals: 2 },
];
export const BT = Object.fromEntries(BALANCE_TYPES.map((b) => [b.code, b]));

export const PARTICIPANTS = ['Payments', 'Provider', 'Admin', 'Bonus', 'Bet', 'RG', 'Ledger', 'Balance DAL', 'Tx DAL', 'MongoDB', 'Reconciler'];
// What each column of the sequence diagram stands for (shown on hover).
export const PARTICIPANT_INFO = {
  Payments: 'The payments domain: the deposit queue credits the ledger and the withdraw worker deducts from it.',
  Provider: 'An external game provider. It sends bet, win and refund callbacks, and may send the same one more than once.',
  Admin: 'A back-office user setting a balance by hand.',
  Bonus: 'The bonuses module (src/modules/bonuses). It grants bonus funds, tracks wagering, and completes or expires a bonus.',
  Bet: 'The bet module (src/modules/bet). It turns provider callbacks into ledger debits and credits.',
  RG: 'Responsible gaming (src/modules/responsibleGaming). It holds wager and loss limits and updates its counters from ledger changes.',
  Ledger: 'The unified ledger API (src/modules/ledger/lib/index.ts): creditBalance and deductFromBalance. Every money movement goes through it.',
  'Balance DAL': 'The storage managers and their data access layer: portfolio.ts for tokens, userObject.ts for legacy balances. They build and run the update pipeline.',
  'Tx DAL': 'The transaction data access layer (documents/transaction/dal.ts). It writes the history rows.',
  MongoDB: 'The database: the user_altcoin_portfolios and users documents that hold balances, and the transactions collection.',
  Reconciler: 'Hardened design only: a background worker that writes the rows of any pending entry left by a failed insert.',
};

const DAY = 86400000;
export const TX_TTL_DAYS = 180;
export const BONUS_DAYS = 7;

/* ─── design knobs ─── */
export const KNOBS = {
  update: { label: 'Balance increment', options: { atomic: 'One findOneAndUpdate pipeline (§4.1)', readThenWrite: 'Read, check in app, then $inc (§7.2 pseudocode)' } },
  idempotency: { label: 'Duplicate callbacks', options: { none: 'No check', providerCheck: 'Caller looks for an existing row first (§4.2)', ledgerKey: 'Key guarded inside the balance update' } },
  rowFailure: { label: 'Failed transaction insert', options: { swallow: 'Caught, logged, balance stays (§6)', outbox: 'Pending entry on the balance document, retried' } },
  refund: { label: 'Bet refund goes to', options: { primary: 'Primary, whole amount', originalBuckets: 'The buckets the bet came from (§7.3 #8)' } },
  math: { label: 'Balance arithmetic', options: { float: 'IEEE 754 doubles (§3.2)', decimal: 'decimal.js' } },
};

export const PRESETS = {
  pseudocode: {
    label: 'Pseudocode (§7.2)',
    blurb: 'The study’s pseudocode taken literally: read, check, then write, with no duplicate protection.',
    config: { update: 'readThenWrite', idempotency: 'none', rowFailure: 'swallow', refund: 'primary', math: 'float' },
  },
  deployed: {
    label: 'As studied',
    blurb: 'The ledger as the study describes it: atomic pipeline, caller-side duplicate check, swallowed row failures, doubles.',
    config: { update: 'atomic', idempotency: 'providerCheck', rowFailure: 'swallow', refund: 'originalBuckets', math: 'float' },
  },
  hardened: {
    label: 'Hardened',
    blurb: 'The same ledger with the study’s gaps closed. These fixes are proposals, not part of the study.',
    config: { update: 'atomic', idempotency: 'ledgerKey', rowFailure: 'outbox', refund: 'originalBuckets', math: 'decimal' },
  },
};

/* ─── helpers ─── */
const perType = (f) => Object.fromEntries(BALANCE_TYPES.map((b) => [b.code, f(b)]));
const dAdd = (a, b) => new Decimal(a).plus(b).toNumber();
const dSub = (a, b) => new Decimal(a).minus(b).toNumber();
const dMul = (a, b) => new Decimal(a).times(b).toNumber();
// The pipeline's own arithmetic follows the `math` knob; diffs and bookkeeping always use decimal.js.
const FLOAT = { add: (a, b) => a + b, sub: (a, b) => a - b };
const DECIMAL = { add: dAdd, sub: dSub };
const mathOf = (s) => (s.config.math === 'decimal' ? DECIMAL : FLOAT);
const near = (a, b) => Math.abs(a - b) < 1e-9;

const getPath = (doc, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc);
function setPath(doc, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  let o = doc;
  for (const k of keys) o = o[k] ??= {};
  o[last] = value;
}
function unsetPath(doc, path) {
  const keys = path.split('.');
  const last = keys.pop();
  const o = keys.reduce((acc, k) => acc?.[k], doc);
  if (o) delete o[last];
}

export function createState(config = PRESETS.deployed.config) {
  return {
    clock: 0,
    seq: 0,
    config: { ...config },
    fault: 'none', // one-shot: 'rowWrite' fails the next transaction insert
    // `users` document: holds the legacy BTC and cash amounts.
    user: { id: 'u_1001', name: 'player_one', balance: 0, btcBonusBalance: 0, cashBalance: 0, cashBonusBalance: 0 },
    // `user_altcoin_portfolios` document: holds the token amounts.
    portfolio: {
      userId: 'u_1001',
      balances: { usdt: { balance: 0, bonusBalance: 0, currency: 'usd' }, eth: { balance: 0, bonusBalance: 0, currency: 'usd' } },
    },
    transactions: [], // newest first, 180-day TTL
    expiredSums: {}, // per balanceType: total of the rows the TTL has removed
    bets: [],
    bonuses: perType(() => null),
    rg: { wagerLimit: null, lossLimit: null, wagered: 0, netLoss: 0 },
    lastCallback: null,
    lastPipeline: null,
    expected: perType(() => 0), // ground truth: what each balance type should hold if every operation applied once
    counted: {}, // ground truth: the idempotency keys already counted in `expected`
    negativeAllowed: perType(() => false),
    events: [],
    trace: [],
    lastOp: null,
  };
}

/* ─── aggregation pipeline: a small evaluator for the operators the ledger uses ─── */
function evalExpr(e, doc, m) {
  if (typeof e === 'string') return e.startsWith('$') ? getPath(doc, e.slice(1)) : e;
  if (Array.isArray(e)) return e.map((x) => evalExpr(x, doc, m));
  if (e === null || typeof e !== 'object') return e;
  const keys = Object.keys(e);
  if (keys.length !== 1 || !keys[0].startsWith('$')) return Object.fromEntries(keys.map((k) => [k, evalExpr(e[k], doc, m)]));
  const op = keys[0];
  if (op === '$literal') return e[op];
  const a = evalExpr(e[op], doc, m);
  switch (op) {
    case '$add': return a.reduce((x, y) => m.add(x, y));
    case '$subtract': return m.sub(a[0], a[1]);
    case '$min': return Math.min(...a);
    case '$max': return Math.max(...a);
    case '$lte': return a[0] <= a[1];
    case '$ne': return a[0] !== a[1];
    case '$or': return a.some(Boolean);
    case '$cond': return a[0] ? a[1] : a[2];
    case '$ifNull': return a[0] ?? a[1];
    case '$concatArrays': return a.flat();
    default: throw new Error(`unsupported operator ${op}`);
  }
}

/** Runs the pipeline against one document, in place. Every `$set` reads the document as the stage found it. */
function applyPipeline(doc, pipeline, m) {
  for (const stage of pipeline) {
    if (stage.$set) {
      const values = Object.entries(stage.$set).map(([path, expr]) => [path, evalExpr(expr, doc, m)]);
      for (const [path, v] of values) setPath(doc, path, v);
    } else if (stage.$unset) {
      unsetPath(doc, stage.$unset);
    }
  }
}

/** Where a balance type's two amounts live. Only the portfolio keeps the original* snapshot fields. */
export function pathsOf(bt) {
  const b = BT[bt];
  if (b.store === 'portfolio') {
    const base = `balances.${bt}`;
    return { store: 'portfolio', collection: 'user_altcoin_portfolios', primary: `${base}.balance`, bonus: `${base}.bonusBalance`, origPrimary: `${base}.originalBalance`, origBonus: `${base}.originalBonusBalance` };
  }
  return { store: 'user', collection: 'users', primary: b.field, bonus: b.bonusField };
}
const docOf = (s, bt) => (BT[bt].store === 'portfolio' ? s.portfolio : s.user);
export const readBalance = (s, bt, bucket = 'primary') => getPath(docOf(s, bt), pathsOf(bt)[bucket]) ?? 0;

/**
 * The stages that change the two amounts for an increment (utils/queryBuilder.ts).
 * A credit adds to one bucket. A deduction takes from primary first and overflows into bonus;
 * if the buckets in use cannot cover it, both amounts are restored unless `allowNegative` is set.
 */
export function buildIncrementBalanceQuery(p, { amount, bucket = 'primary', balancesToUse = ['primary', 'bonus'], allowNegative = false }) {
  if (amount >= 0) return [{ $set: { [p[bucket]]: { $add: [bucket === 'primary' ? '$_calc.p0' : '$_calc.b0', amount] } } }];
  const abs = -amount;
  const applied = allowNegative ? true : { $lte: ['$_calc.shortfall', 0] };
  return [
    { $set: { '_calc.fromPrimary': balancesToUse.includes('primary') ? { $min: [{ $max: ['$_calc.p0', 0] }, abs] } : 0 } },
    { $set: { '_calc.fromBonus': balancesToUse.includes('bonus') ? { $min: [{ $max: ['$_calc.b0', 0] }, { $subtract: [abs, '$_calc.fromPrimary'] }] } : 0 } },
    { $set: { '_calc.shortfall': { $subtract: [abs, { $add: ['$_calc.fromPrimary', '$_calc.fromBonus'] }] } } },
    { $set: {
      [p.primary]: { $cond: [applied, { $subtract: ['$_calc.p0', { $add: ['$_calc.fromPrimary', allowNegative ? '$_calc.shortfall' : 0] }] }, '$_calc.p0'] },
      [p.bonus]: { $cond: [applied, { $subtract: ['$_calc.b0', '$_calc.fromBonus'] }, '$_calc.b0'] },
    } },
  ];
}

/** Wraps the changing stages with the snapshot and, in the hardened design, the pending entry and the idempotency key. */
function buildBalancePipeline(p, mutate, { pending, key } = {}) {
  const changed = { $or: [{ $ne: [`$${p.primary}`, '$_calc.p0'] }, { $ne: [`$${p.bonus}`, '$_calc.b0'] }] };
  const append = (field, item) => ({ $set: { [field]: { $cond: [changed, { $concatArrays: [{ $ifNull: [`$${field}`, []] }, [item]] }, { $ifNull: [`$${field}`, []] }] } } });
  const pipeline = [{ $set: { _calc: { p0: { $ifNull: [`$${p.primary}`, 0] }, b0: { $ifNull: [`$${p.bonus}`, 0] } } } }];
  if (p.origPrimary) pipeline.push({ $set: { [p.origPrimary]: '$_calc.p0', [p.origBonus]: '$_calc.b0' } });
  pipeline.push(...mutate);
  if (pending) pipeline.push(append('pendingEntries', { ...Object.fromEntries(Object.entries(pending).map(([k, v]) => [k, { $literal: v }])), primaryBefore: '$_calc.p0', bonusBefore: '$_calc.b0', primaryAfter: `$${p.primary}`, bonusAfter: `$${p.bonus}` }));
  if (key) pipeline.push(append('appliedKeys', { $literal: key }));
  pipeline.push({ $unset: '_calc' });
  return pipeline;
}

/** utils/computeDebitAmountChanges.ts: how a deduction splits between primary and bonus. */
export function computeDebitAmountChanges({ primary, bonus, amount, balancesToUse = ['primary', 'bonus'], allowNegative = false }, m = DECIMAL) {
  const fromPrimary = balancesToUse.includes('primary') ? Math.min(Math.max(primary, 0), amount) : 0;
  const fromBonus = balancesToUse.includes('bonus') ? Math.min(Math.max(bonus, 0), m.sub(amount, fromPrimary)) : 0;
  const shortfall = m.sub(amount, m.add(fromPrimary, fromBonus));
  const sufficient = shortfall <= 0;
  if (!sufficient && !allowNegative) return { primaryChange: 0, bonusChange: 0, sufficient };
  return { primaryChange: m.sub(0, m.add(fromPrimary, allowNegative ? Math.max(shortfall, 0) : 0)), bonusChange: m.sub(0, fromBonus), sufficient };
}

/* ─── op scaffolding ─── */
// Returns the step so the caller can attach `.why`: the plain-language explanation shown on hover.
function step(s, from, to, label, kind = 'call', detail) {
  const entry = { from, to, label, kind, detail };
  s.trace.push(entry);
  return entry;
}
const note = (s, at, label, detail) => step(s, at, at, label, 'note', detail);

function log(s, level, msg) {
  s.events.unshift({ t: s.clock, level, msg });
  s.events.length = Math.min(s.events.length, 300);
}
function begin(state, name, caller) {
  const s = structuredClone(state);
  s.clock += 1000;
  s.trace = [];
  s.lastOp = { name, caller, ok: null, message: '', warning: null, result: null };
  // The reconciler is a background worker; here it runs between requests.
  if (s.config.rowFailure === 'outbox') drainPending(s);
  return s;
}
function fail(s, msg, from = 'Ledger') {
  step(s, from, s.lastOp.caller, msg, 'error').why = 'The operation is refused and the module that started it is told why. Nothing further happens.';
  s.lastOp.ok = false;
  s.lastOp.message = msg;
  log(s, 'error', `${s.lastOp.name}: ${msg}`);
  return s;
}
function succeed(s, msg, from = 'Ledger') {
  if (from !== s.lastOp.caller) step(s, from, s.lastOp.caller, msg, 'return').why = 'The final result, returned to the module that started the operation.';
  s.lastOp.ok = true;
  s.lastOp.message = msg;
  log(s, s.lastOp.warning ? 'warn' : 'ok', `${s.lastOp.name}: ${msg}${s.lastOp.warning ? ` — ${s.lastOp.warning}` : ''}`);
  return s;
}
/** Ends an operation from a ledger result. */
function finishOp(s, r, msg) {
  s.lastOp.result = r;
  if (!r.ok) return fail(s, r.error, r.from);
  if (r.duplicate) return succeed(s, 'Duplicate ignored, nothing applied');
  if (r.rowMissing) s.lastOp.warning = s.config.rowFailure === 'outbox' ? 'the row insert failed; the pending entry waits for the reconciler' : 'the balance moved but no transaction row was written';
  return succeed(s, msg);
}

const fmtAmt = (bt, n) => `${Number(n).toFixed(2)} ${BT[bt].label}`;
const nextId = (s, prefix) => `${prefix}_${(s.seq += 1)}`;
function oid(s) {
  s.seq += 1;
  return '66f8' + s.seq.toString(16).padStart(20, '0');
}
const validAmount = (amount) => Number.isFinite(amount) && amount > 0;

/* ─── balance DAL ─── */
/**
 * One atomic findOneAndUpdate on the balance document. Returns the amounts before and after,
 * or null when the idempotency key in the filter has already been applied.
 */
function atomicUpdate(s, bt, mutate, { type, meta, key }) {
  const p = pathsOf(bt);
  const doc = docOf(s, bt);
  const useKey = s.config.idempotency === 'ledgerKey' && key ? key : null;
  const pending = s.config.rowFailure === 'outbox' ? { id: oid(s), type, balanceType: bt, meta, createdAt: s.clock } : null;
  const pipeline = buildBalancePipeline(p, mutate, { pending, key: useKey });
  const filter = { [p.store === 'portfolio' ? 'userId' : '_id']: s.user.id, ...(useKey ? { appliedKeys: { $ne: useKey } } : {}) };
  s.lastPipeline = { collection: p.collection, filter, pipeline };
  step(s, 'Balance DAL', 'MongoDB', `${p.collection}.findOneAndUpdate(pipeline)`, 'call', { filter, pipeline }).why = `The single atomic write. MongoDB runs the whole pipeline on the balance document as one step, so no other request can read or change the balance in between. The payload shows the filter and every stage.${useKey ? ' The filter also requires that this idempotency key is not on the document yet.' : ''}`;
  if (useKey && (doc.appliedKeys || []).includes(useKey)) {
    step(s, 'MongoDB', 'Balance DAL', 'null: key already applied', 'return', { key: useKey }).why = 'No document matched, because the idempotency key is already on it. This callback was applied before, so nothing changes.';
    return null;
  }
  const before = { primary: readBalance(s, bt), bonus: readBalance(s, bt, 'bonus') };
  applyPipeline(doc, pipeline, mathOf(s));
  const after = { primary: readBalance(s, bt), bonus: readBalance(s, bt, 'bonus') };
  // decimal.js diff of the returned document against its snapshot (§3.2).
  const r = { before, after, primaryChange: dSub(after.primary, before.primary), bonusChange: dSub(after.bonus, before.bonus) };
  r.pendingId = pending && (r.primaryChange !== 0 || r.bonusChange !== 0) ? pending.id : null;
  return r;
}

/* ─── transaction DAL ─── */
/** One row per bucket that changed; a change that touched neither still gets its primary row. */
function rowsFor(bt, primaryChange, bonusChange, balance, bonusBalance) {
  const rows = [];
  if (primaryChange !== 0 || bonusChange === 0) rows.push([bt, primaryChange, balance]);
  if (bonusChange !== 0) rows.push([`${bt}Bonus`, bonusChange, bonusBalance]);
  return rows;
}
function insertRows(s, { type, meta, createdAt }, rows) {
  return rows.map(([balanceType, amount, currentBalance]) => {
    const doc = { _id: oid(s), userId: s.user.id, type, amount, currentBalance, balanceType, meta, createdAt };
    s.transactions.unshift(doc);
    return doc._id;
  });
}
function pullPending(s, bt, id) {
  const doc = docOf(s, bt);
  doc.pendingEntries = (doc.pendingEntries || []).filter((e) => e.id !== id);
}

/** createPrimaryAndBonusTransactions: written after the balance change, in a separate write. */
function createTransactions(s, { bt, type, meta, primaryChange, bonusChange, balance, bonusBalance, pendingId }) {
  const rows = rowsFor(bt, primaryChange, bonusChange, balance, bonusBalance);
  step(s, 'Ledger', 'Tx DAL', 'createPrimaryAndBonusTransactions()', 'call', { type, meta, rows: rows.map(([balanceType, amount, currentBalance]) => ({ balanceType, amount, currentBalance })) }).why = 'The balance has already changed. The ledger now asks for the history rows: one per bucket that changed, each holding the change and that bucket\'s new balance.';
  step(s, 'Tx DAL', 'MongoDB', `transactions.insert × ${rows.length}`).why = 'A second, separate write. Nothing ties it to the balance update, so it can fail on its own.';
  if (s.fault === 'rowWrite') {
    s.fault = 'none';
    step(s, 'MongoDB', 'Tx DAL', 'insert failed', 'error').why = 'The rows were not written. The balance update before it is not undone.';
    step(s, 'Tx DAL', 'Ledger', 'caught and logged: transactionId undefined', 'error').why = 'The error is logged and swallowed. The caller gets a result with no transactionId, and the balance stays changed (study §6).';
    if (pendingId) note(s, 'MongoDB', 'pendingEntries still holds the entry', { pendingId }).why = 'Hardened design: the pending entry written together with the balance is still on the document, so the reconciler can write the missing rows later.';
    log(s, 'error', `transaction insert failed for ${type} on ${bt}${pendingId ? ' (pending entry kept)' : ': no row exists for this balance change'}`);
    return [];
  }
  const ids = insertRows(s, { type, meta, createdAt: s.clock }, rows);
  if (pendingId) {
    step(s, 'Tx DAL', 'MongoDB', '$pull pendingEntries', 'call', { pendingId }).why = 'Hardened design: the rows now exist, so the pending entry is removed from the balance document.';
    pullPending(s, bt, pendingId);
  }
  step(s, 'Tx DAL', 'Ledger', `transactionId …${ids[0].slice(-4)}`, 'return', { ids }).why = 'The rows are written. The id of the first row is returned as the transactionId.';
  return ids;
}

/** Writes the rows of every pending entry left behind by a failed insert. */
function drainPending(s) {
  let written = 0;
  for (const doc of [s.portfolio, s.user]) {
    for (const e of doc.pendingEntries || []) {
      const rows = rowsFor(e.balanceType, dSub(e.primaryAfter, e.primaryBefore), dSub(e.bonusAfter, e.bonusBefore), e.primaryAfter, e.bonusAfter);
      step(s, 'Reconciler', 'MongoDB', `pendingEntries → transactions.insert × ${rows.length}`, 'call', e).why = 'The reconciler found a pending entry whose rows were never written. It writes them now, from the amounts stored in the entry.';
      insertRows(s, e, rows);
      written += rows.length;
    }
    if (doc.pendingEntries) doc.pendingEntries = [];
  }
  if (written) log(s, 'ok', `reconciler wrote ${written} missing transaction row${written > 1 ? 's' : ''}`);
  return written;
}
export const pendingCount = (s) => (s.portfolio.pendingEntries?.length || 0) + (s.user.pendingEntries?.length || 0);

/* ─── unified API: creditBalance / deductFromBalance ─── */
/**
 * First half of a balance change: everything up to and including the read (read-then-write)
 * or the whole update (atomic). Split in two so that two requests can be interleaved.
 */
function startChange(s, a) {
  const { bt, amount, bucket = 'primary', balancesToUse = ['primary', 'bonus'], allowNegative = false } = a;
  const p = pathsOf(bt);
  const credit = amount > 0;
  step(s, a.caller, 'Ledger', `${credit ? 'creditBalance' : 'deductFromBalance'}(${bt}, ${Math.abs(amount)}, '${a.type}')`, 'call', { balanceType: bt, amount, type: a.type, meta: a.meta, ...(credit ? { bucket } : { balancesToUse, allowNegative }) }).why = credit ? `A module asks the ledger to add money to the ${bucket} bucket. Every credit in the system enters through this one function.` : 'A module asks the ledger to take money. balancesToUse says which buckets may be used, and allowNegative says whether the balance may go below zero.';
  step(s, 'Ledger', 'Balance DAL', `${p.store === 'portfolio' ? 'incrementPortfolioBalance' : 'incrementUserBalance'}(${amount})`).why = p.store === 'portfolio' ? 'The ledger routes this balance type to the portfolio manager: token balances live in the user_altcoin_portfolios document.' : 'The ledger routes this balance type to the legacy manager: BTC and cash are fields on the User document.';

  if (s.config.update === 'readThenWrite') {
    const m = mathOf(s);
    step(s, 'Balance DAL', 'MongoDB', `${p.collection}.findOne()`).why = 'Pseudocode preset: the balance is read first, in its own request. Another request can read the same value before this one writes.';
    const read = { primary: readBalance(s, bt), bonus: readBalance(s, bt, 'bonus') };
    step(s, 'MongoDB', 'Balance DAL', `balance ${read.primary}, bonus ${read.bonus}`, 'return', read).why = 'The amounts as they were at the moment of the read. They may be out of date by the time the write happens.';
    const change = credit
      ? { primaryChange: bucket === 'primary' ? amount : 0, bonusChange: bucket === 'bonus' ? amount : 0, sufficient: true }
      : computeDebitAmountChanges({ primary: read.primary, bonus: read.bonus, amount: -amount, balancesToUse, allowNegative }, m);
    if (!credit) note(s, 'Balance DAL', change.sufficient || allowNegative ? 'checked in app: enough funds' : 'checked in app: not enough', change).why = 'The funds check runs in the application, on the amounts just read, not inside the database.';
    if (!change.sufficient && !allowNegative) return { a, failed: 'Insufficient funds' };
    return { a, rtw: { read, ...change } };
  }

  const r = atomicUpdate(s, bt, buildIncrementBalanceQuery(p, { amount, bucket, balancesToUse, allowNegative }), a);
  if (!r) return { a, duplicate: true };
  if (r.primaryChange === 0 && r.bonusChange === 0) {
    note(s, 'MongoDB', 'guard failed: both amounts restored', r.before).why = 'The buckets in use did not cover the amount, so the pipeline put both amounts back as they were. Nothing changed.';
    step(s, 'MongoDB', 'Balance DAL', 'document unchanged', 'return', r.after).why = 'The document comes back with the same amounts as before. That is how the DAL knows the deduction was refused.';
    return { a, failed: 'Insufficient funds' };
  }
  if (!credit) note(s, 'MongoDB', r.bonusChange ? 'primary first, overflow to bonus' : 'guard passed: taken from primary', { primaryChange: r.primaryChange, bonusChange: r.bonusChange }).why = r.bonusChange ? 'Primary did not cover the amount. The pipeline took what primary had and the rest from bonus, in the same write.' : 'Primary covered the whole amount, so bonus was not touched.';
  step(s, 'MongoDB', 'Balance DAL', p.origPrimary ? 'updated doc + originalBalance' : 'updated doc', 'return', r).why = p.origPrimary ? 'The updated document carries originalBalance and originalBonusBalance, so the DAL gets the before and after amounts in one round trip.' : 'The updated User document. The DAL compares it with the amounts before the update.';
  return { a, r };
}

/** Second half: the write (read-then-write only), the transaction rows and the ledger event. */
function finishChange(s, ph) {
  const { a } = ph;
  const { bt } = a;
  if (ph.failed) {
    step(s, 'Balance DAL', 'Ledger', ph.failed, 'error').why = 'The DAL reports the refusal. No transaction row is written for a refused change.';
    return { ok: false, error: ph.failed };
  }
  if (ph.duplicate) {
    step(s, 'Balance DAL', 'Ledger', 'already applied', 'return').why = 'The DAL reports that this change was applied earlier. No rows are written again.';
    return { ok: true, duplicate: true, primaryChange: 0, bonusChange: 0 };
  }
  let res;
  if (ph.rtw) {
    const m = mathOf(s);
    const p = pathsOf(bt);
    const { read, primaryChange, bonusChange } = ph.rtw;
    step(s, 'Balance DAL', 'MongoDB', `${p.collection}.updateOne($inc)`, 'call', { $inc: { [p.primary]: primaryChange, [p.bonus]: bonusChange } }).why = 'Pseudocode preset: the change is written as an increment, with no check. If another request wrote in between, the balance can go below zero.';
    const doc = docOf(s, bt);
    setPath(doc, p.primary, m.add(readBalance(s, bt), primaryChange));
    setPath(doc, p.bonus, m.add(readBalance(s, bt, 'bonus'), bonusChange));
    // The resulting balance is worked out from what was read, not from what is now stored.
    res = { primaryChange, bonusChange, balance: m.add(read.primary, primaryChange), bonusBalance: m.add(read.bonus, bonusChange) };
  } else {
    res = { primaryChange: ph.r.primaryChange, bonusChange: ph.r.bonusChange, balance: ph.r.after.primary, bonusBalance: ph.r.after.bonus };
  }
  step(s, 'Balance DAL', 'Ledger', `primary ${res.primaryChange}, bonus ${res.bonusChange}`, 'return', res).why = 'How much each bucket changed (a decimal.js difference of after and before) and the new balances.';
  // A retried callback counts once, however many times the ledger applies it.
  if (!a.key || !s.counted[a.key]) s.expected[bt] = dAdd(s.expected[bt], a.amount);
  if (a.key) s.counted[a.key] = true;
  if (a.allowNegative && readBalance(s, bt) < 0) s.negativeAllowed[bt] = true;
  const ids = createTransactions(s, { bt, type: a.type, meta: a.meta, ...res, pendingId: ph.r?.pendingId });
  onLedgerChange(s, a);
  return { ok: true, ...res, transactionId: ids[0], transactionIds: ids, rowMissing: ids.length === 0 };
}
const changeBalance = (s, a) => finishChange(s, startChange(s, a));

/** Changes that are not increments: bonus → primary, clear bonus, admin set. Always one atomic update. */
function applyUpdate(s, { bt, mutate, type, meta, caller, api }) {
  const p = pathsOf(bt);
  step(s, caller, 'Ledger', api, 'call', { balanceType: bt, type, meta }).why = 'A change that is not a plain increment: bonus to primary, clear bonus, or admin set. It also runs as one atomic update.';
  step(s, 'Ledger', 'Balance DAL', api.replace('Portfolio', p.store === 'portfolio' ? 'Portfolio' : 'User')).why = 'The ledger routes the change to the manager for this balance type\'s store.';
  const r = atomicUpdate(s, bt, mutate, { type, meta });
  step(s, 'MongoDB', 'Balance DAL', 'updated doc', 'return', r).why = 'The document after the update, with the amounts before it for comparison.';
  const res = { ok: true, primaryChange: r.primaryChange, bonusChange: r.bonusChange, balance: r.after.primary, bonusBalance: r.after.bonus };
  if (r.primaryChange === 0 && r.bonusChange === 0) return { ...res, unchanged: true };
  s.expected[bt] = dAdd(s.expected[bt], dAdd(r.primaryChange, r.bonusChange));
  const ids = createTransactions(s, { bt, type, meta, ...res, pendingId: r.pendingId });
  return { ...res, transactionId: ids[0], transactionIds: ids, rowMissing: ids.length === 0 };
}

/* ─── responsible gaming: listens to ledger changes ─── */
function onLedgerChange(s, a) {
  if (!['bet', 'payout', 'refund'].includes(a.type)) return;
  const abs = Math.abs(a.amount);
  if (a.type === 'bet') {
    s.rg.wagered = dAdd(s.rg.wagered, abs);
    s.rg.netLoss = dAdd(s.rg.netLoss, abs);
  } else {
    if (a.type === 'refund') s.rg.wagered = dSub(s.rg.wagered, abs);
    s.rg.netLoss = dSub(s.rg.netLoss, abs);
  }
  step(s, 'Ledger', 'RG', `ledger change: ${a.type}`, 'call', { wagered: s.rg.wagered, netLoss: s.rg.netLoss }).why = 'Responsible gaming listens to ledger changes. A bet raises the wagered and net-loss counters; a payout or refund lowers net loss.';
}
function limitReached(s, amount) {
  const { wagerLimit, lossLimit, wagered, netLoss } = s.rg;
  if (wagerLimit === null && lossLimit === null) return null;
  step(s, 'Bet', 'RG', 'check limits', 'call', { amount, ...s.rg }).why = 'Before a bet reaches the ledger, the bet module asks whether this amount would pass the player\'s wager or loss limit.';
  const hit = wagerLimit !== null && dAdd(wagered, amount) > wagerLimit ? 'Wager limit reached' : lossLimit !== null && dAdd(netLoss, amount) > lossLimit ? 'Loss limit reached' : null;
  step(s, 'RG', 'Bet', hit || 'within limits', hit ? 'error' : 'return').why = hit ? 'The limit would be exceeded, so the bet is refused before the ledger is called.' : 'The bet fits within the limits.';
  return hit;
}

/* ─── duplicate callbacks ─── */
/** §4.2: the calling module looks for a transaction it already wrote before it calls the ledger. */
function seenBefore(s, caller, type, idField, id) {
  if (s.config.idempotency !== 'providerCheck') return false;
  step(s, caller, 'MongoDB', `transactions.findOne({type:'${type}', meta.${idField}})`, 'call', { type, [`meta.${idField}`]: id }).why = 'Duplicate check (study §4.2): before calling the ledger, the caller looks for a row it already wrote for this identifier. The check reads the transaction rows.';
  const hit = s.transactions.some((t) => t.type === type && t.meta?.[idField] === id);
  step(s, 'MongoDB', caller, hit ? 'row exists: skip the ledger' : 'null', 'return').why = hit ? 'A row exists, so this callback was handled before. The ledger is not called.' : 'No row found, so the callback is treated as new.';
  return hit;
}
const duplicate = () => ({ ok: true, duplicate: true });

/* ─── payments ─── */
export function deposit(state, { balanceType: bt, amount, externalIdentifier, replay = false }) {
  const s = begin(state, replay ? 'Deposit (replayed)' : 'Deposit', 'Payments');
  if (!validAmount(amount)) return fail(s, 'Invalid amount', 'Payments');
  const ext = externalIdentifier || nextId(s, 'dep');
  if (!replay) s.lastCallback = { op: 'deposit', args: { balanceType: bt, amount, externalIdentifier: ext } };
  note(s, 'Payments', `depositQueue: ${ext}`).why = 'The deposit queue delivers a confirmed deposit with its external identifier.';
  if (seenBefore(s, 'Payments', 'deposit', 'externalIdentifier', ext)) return finishOp(s, duplicate());
  const r = changeBalance(s, { bt, amount, type: 'deposit', meta: { externalIdentifier: ext, source: 'depositQueue' }, caller: 'Payments', key: `deposit:${ext}` });
  return finishOp(s, r, `Deposited ${fmtAmt(bt, amount)}`);
}

/** One deposit notification delivered twice, both in flight together. */
export function concurrentDeposit(state, { balanceType: bt, amount }) {
  const s = begin(state, 'Same deposit, twice at once', 'Payments');
  if (!validAmount(amount)) return fail(s, 'Invalid amount', 'Payments');
  const ext = nextId(s, 'dep');
  s.lastCallback = { op: 'deposit', args: { balanceType: bt, amount, externalIdentifier: ext } };
  note(s, 'Payments', `depositQueue: ${ext} delivered twice`).why = 'The same deposit notification is delivered twice, and both deliveries are processed at the same moment.';
  // Both deliveries look for the row before either has written one.
  const skip = [0, 1].map(() => seenBefore(s, 'Payments', 'deposit', 'externalIdentifier', ext));
  const results = skip.map((seen, i) => (seen ? duplicate() : changeBalance(s, { bt, amount, type: 'deposit', meta: { externalIdentifier: ext, source: 'depositQueue' }, caller: 'Payments', key: `deposit:${ext}` })));
  const applied = results.filter((r) => !r.duplicate).length;
  s.lastOp.result = { applied };
  if (applied > 1) s.lastOp.warning = `one deposit of ${fmtAmt(bt, amount)} was credited ${applied} times`;
  return succeed(s, `Credited ${applied} time${applied > 1 ? 's' : ''}; primary is now ${fmtAmt(bt, readBalance(s, bt))}`);
}

export function withdraw(state, { balanceType: bt, amount }) {
  const s = begin(state, 'Withdraw', 'Payments');
  if (!validAmount(amount)) return fail(s, 'Invalid amount', 'Payments');
  const ext = nextId(s, 'wd');
  note(s, 'Payments', `withdrawWorker: ${ext}`).why = 'The withdraw worker starts a withdrawal. Withdrawals may use the primary bucket only.';
  // Only the primary amount is withdrawable.
  const r = changeBalance(s, { bt, amount: -amount, balancesToUse: ['primary'], type: 'withdrawal', meta: { externalIdentifier: ext, source: 'withdrawWorker' }, caller: 'Payments', key: `withdrawal:${ext}` });
  if (!r.ok && readBalance(s, bt, 'bonus') > 0) r.error = 'Insufficient funds (bonus is not withdrawable)';
  return finishOp(s, r, `Withdrew ${fmtAmt(bt, amount)}`);
}

/** A deduction with allowNegative: the one path that may leave a balance below zero. */
export function chargeback(state, { balanceType: bt, amount }) {
  const s = begin(state, 'Chargeback', 'Payments');
  if (!validAmount(amount)) return fail(s, 'Invalid amount', 'Payments');
  const ext = nextId(s, 'cb');
  const r = changeBalance(s, { bt, amount: -amount, balancesToUse: ['primary'], allowNegative: true, type: 'chargeback', meta: { externalIdentifier: ext }, caller: 'Payments', key: `chargeback:${ext}` });
  return finishOp(s, r, `Charged back ${fmtAmt(bt, amount)}; primary is now ${fmtAmt(bt, readBalance(s, bt))}`);
}

/* ─── bets ─── */
const PROVIDER = 'sim-provider';

function doPlaceBet(s, { bt, amount, betId }) {
  step(s, 'Provider', 'Bet', `bet ${betId}`, 'call', { betId, balanceType: bt, amount }).why = 'The game provider reports a bet with its betId.';
  const hit = limitReached(s, amount);
  if (hit) return { ok: false, error: hit, from: 'Bet' };
  if (seenBefore(s, 'Bet', 'bet', 'betId', betId)) return duplicate();
  const r = changeBalance(s, { bt, amount: -amount, type: 'bet', meta: { betId, provider: PROVIDER }, caller: 'Bet', key: `bet:${betId}` });
  if (r.ok && !r.duplicate) {
    if (!s.bets.some((b) => b.betId === betId)) s.bets.unshift({ betId, balanceType: bt, amount, status: 'open', payout: 0, createdAt: s.clock });
    bonusProgress(s, bt, amount);
  }
  return r;
}

function doSettle(s, bet, multiplier) {
  const payout = dMul(bet.amount, multiplier);
  step(s, 'Provider', 'Bet', `${payout > 0 ? 'win' : 'lose'} ${bet.betId}`, 'call', { betId: bet.betId, payout }).why = 'The game provider reports the result of the round.';
  if (payout === 0) {
    bet.status = 'lost';
    note(s, 'Bet', 'lost: no ledger call').why = 'A lost bet moves no money: the stake was already taken when the bet was placed.';
    return { ok: true, lost: true };
  }
  if (seenBefore(s, 'Bet', 'payout', 'betId', bet.betId)) return duplicate();
  const r = changeBalance(s, { bt: bet.balanceType, amount: payout, type: 'payout', meta: { betId: bet.betId, provider: PROVIDER }, caller: 'Bet', key: `payout:${bet.betId}` });
  if (r.ok && !r.duplicate) Object.assign(bet, { status: 'won', payout });
  return r;
}

function doRefund(s, bet) {
  const bt = bet.balanceType;
  step(s, 'Provider', 'Bet', `refund ${bet.betId}`, 'call', { betId: bet.betId }).why = 'The game provider cancels the round and asks for the stake back.';
  if (seenBefore(s, 'Bet', 'refund', 'betId', bet.betId)) return duplicate();
  let parts = [['primary', bet.amount]];
  if (s.config.refund === 'originalBuckets') {
    // The bet's own rows say how it was split.
    step(s, 'Bet', 'MongoDB', `transactions.find({type:'bet', meta.betId})`).why = 'To return the stake to the buckets it came from, the bet module reads the rows written when the bet was placed.';
    const rows = s.transactions.filter((t) => t.type === 'bet' && t.meta?.betId === bet.betId);
    const taken = (balanceType) => rows.filter((t) => t.balanceType === balanceType).reduce((sum, t) => dSub(sum, t.amount), 0);
    step(s, 'MongoDB', 'Bet', `${rows.length} row${rows.length === 1 ? '' : 's'}`, 'return', rows).why = rows.length ? 'The rows of the bet show how much came from primary and how much from bonus.' : 'No rows exist for this bet, so the split is unknown and the whole refund goes to primary.';
    if (rows.length) parts = [['primary', taken(bt)], ['bonus', taken(`${bt}Bonus`)]].filter(([, n]) => n > 0);
    else s.lastOp.warning = 'the bet has no rows, so the whole refund went to primary';
  }
  let r;
  for (const [bucket, amount] of parts) {
    r = changeBalance(s, { bt, amount, bucket, type: 'refund', meta: { betId: bet.betId, provider: PROVIDER }, caller: 'Bet', key: `refund:${bet.betId}${bucket === 'bonus' ? ':bonus' : ''}` });
  }
  if (r.ok && !r.duplicate) bet.status = 'refunded';
  return r;
}

/** Places a bet and leaves the round open. */
export function placeBet(state, { balanceType: bt, amount, betId, replay = false }) {
  const s = begin(state, replay ? 'Bet (replayed)' : 'Bet', 'Bet');
  if (!validAmount(amount)) return fail(s, 'Invalid amount', 'Bet');
  const id = betId || nextId(s, 'b');
  if (!replay) s.lastCallback = { op: 'placeBet', args: { balanceType: bt, amount, betId: id } };
  return finishOp(s, doPlaceBet(s, { bt, amount, betId: id }), `Bet ${fmtAmt(bt, amount)} (${id})`);
}

export function settleBet(state, { betId, multiplier = 2, replay = false }) {
  const s = begin(state, replay ? 'Settle (replayed)' : 'Settle bet', 'Bet');
  const bet = s.bets.find((b) => b.betId === betId);
  if (!bet) return fail(s, `Unknown bet ${betId}`, 'Bet');
  if (!replay && bet.status !== 'open') return fail(s, `Bet ${betId} is already ${bet.status}`, 'Bet');
  if (!replay) s.lastCallback = { op: 'settleBet', args: { betId, multiplier } };
  const r = doSettle(s, bet, multiplier);
  return finishOp(s, r, r.lost ? `Bet ${betId} lost` : `Paid out ${fmtAmt(bet.balanceType, dMul(bet.amount, multiplier))} on ${betId}`);
}

export function refundBet(state, { betId, replay = false }) {
  const s = begin(state, replay ? 'Refund (replayed)' : 'Refund bet', 'Bet');
  const bet = s.bets.find((b) => b.betId === betId);
  if (!bet) return fail(s, `Unknown bet ${betId}`, 'Bet');
  if (!replay && bet.status !== 'open') return fail(s, `Bet ${betId} is already ${bet.status}`, 'Bet');
  if (!replay) s.lastCallback = { op: 'refundBet', args: { betId } };
  return finishOp(s, doRefund(s, bet), `Refunded ${fmtAmt(bet.balanceType, bet.amount)} on ${betId}`);
}

/** A whole round in one go: the bet, then the win or loss. */
export function playRound(state, { balanceType: bt, amount, multiplier = 0 }) {
  const s = begin(state, multiplier > 0 ? `Bet and win ×${multiplier}` : 'Bet and lose', 'Bet');
  if (!validAmount(amount)) return fail(s, 'Invalid amount', 'Bet');
  const betId = nextId(s, 'b');
  s.lastCallback = { op: 'placeBet', args: { balanceType: bt, amount, betId } };
  const placed = doPlaceBet(s, { bt, amount, betId });
  if (!placed.ok || placed.duplicate) return finishOp(s, placed);
  if (multiplier > 0) s.lastCallback = { op: 'settleBet', args: { betId, multiplier } };
  const r = doSettle(s, s.bets.find((b) => b.betId === betId), multiplier);
  r.rowMissing ||= placed.rowMissing;
  return finishOp(s, r, r.lost ? `Lost ${fmtAmt(bt, amount)}` : `Bet ${fmtAmt(bt, amount)}, won ${fmtAmt(bt, dMul(amount, multiplier))}`);
}

/** Two different bets on the same balance, both in flight together. */
export function concurrentBets(state, { balanceType: bt, amount }) {
  const s = begin(state, 'Two bets at once', 'Bet');
  if (!validAmount(amount)) return fail(s, 'Invalid amount', 'Bet');
  const ids = [nextId(s, 'b'), nextId(s, 'b')];
  note(s, 'Bet', `${ids.join(' and ')} arrive together`).why = 'Two different bets on the same balance are processed at the same moment.';
  const phases = ids.map((betId) => startChange(s, { bt, amount: -amount, type: 'bet', meta: { betId, provider: PROVIDER }, caller: 'Bet', key: `bet:${betId}` }));
  const results = phases.map((ph) => finishChange(s, ph));
  results.forEach((r, i) => { if (r.ok) s.bets.unshift({ betId: ids[i], balanceType: bt, amount, status: 'open', payout: 0, createdAt: s.clock }); });
  const accepted = results.filter((r) => r.ok).length;
  s.lastOp.result = { accepted };
  if (!accepted) return fail(s, 'Both rejected: insufficient funds');
  if (readBalance(s, bt) < 0) s.lastOp.warning = 'both passed the check and the balance went negative';
  return succeed(s, `${accepted} of 2 accepted; primary is now ${fmtAmt(bt, readBalance(s, bt))}`);
}

/** Re-delivers the last provider or payment callback with the same identifier. */
export function replayLast(state) {
  const cb = state.lastCallback;
  if (!cb) return fail(begin(state, 'Replay', 'Provider'), 'Nothing to replay yet', 'Provider');
  return { deposit, placeBet, settleBet, refundBet }[cb.op](state, { ...cb.args, replay: true });
}

/* ─── bonuses ─── */
function bonusProgress(s, bt, amount) {
  const b = s.bonuses[bt];
  if (!b) return;
  b.wagered = dAdd(b.wagered, amount);
  step(s, 'Bet', 'Bonus', `wagered ${b.wagered} of ${b.wagerRequired}`, 'call', b).why = 'Each bet counts toward the bonus wagering requirement. When it is met, the bonus moves to primary.';
  if (b.wagered >= b.wagerRequired) doCompleteBonus(s, bt);
}
function doCompleteBonus(s, bt) {
  const p = pathsOf(bt);
  const bonusId = s.bonuses[bt]?.id;
  s.bonuses[bt] = null;
  return applyUpdate(s, { bt, caller: 'Bonus', api: 'transferPortfolioBonusToPrimary()', type: 'bonusCompleted', meta: { bonusId }, mutate: [{ $set: { [p.primary]: { $add: ['$_calc.p0', '$_calc.b0'] }, [p.bonus]: 0 } }] });
}
function doClearBonus(s, bt, reason) {
  const p = pathsOf(bt);
  const bonusId = s.bonuses[bt]?.id;
  s.bonuses[bt] = null;
  return applyUpdate(s, { bt, caller: 'Bonus', api: 'clearPortfolioBonus()', type: 'bonusExpired', meta: { bonusId, reason }, mutate: [{ $set: { [p.bonus]: 0 } }] });
}

export function grantBonus(state, { balanceType: bt, amount, wagerMultiplier = 5, days = BONUS_DAYS }) {
  const s = begin(state, 'Grant bonus', 'Bonus');
  if (!validAmount(amount)) return fail(s, 'Invalid amount', 'Bonus');
  if (s.bonuses[bt]) return fail(s, `${BT[bt].label} already has an active bonus`, 'Bonus');
  const id = nextId(s, 'bonus');
  const r = changeBalance(s, { bt, amount, bucket: 'bonus', type: 'bonus', meta: { bonusId: id }, caller: 'Bonus', key: `bonus:${id}` });
  s.bonuses[bt] = { id, amount, wagerRequired: dMul(amount, wagerMultiplier), wagered: 0, expiresAt: s.clock + days * DAY };
  return finishOp(s, r, `Granted ${fmtAmt(bt, amount)} bonus: wager ${dMul(amount, wagerMultiplier)} within ${days} days`);
}

export function completeBonus(state, { balanceType: bt }) {
  const s = begin(state, 'Complete bonus', 'Bonus');
  const bonus = readBalance(s, bt, 'bonus');
  if (bonus <= 0) return fail(s, 'No bonus balance to transfer', 'Bonus');
  return finishOp(s, doCompleteBonus(s, bt), `Moved ${fmtAmt(bt, bonus)} from bonus to primary`);
}

export function expireBonus(state, { balanceType: bt }) {
  const s = begin(state, 'Expire bonus', 'Bonus');
  const bonus = readBalance(s, bt, 'bonus');
  if (bonus <= 0) return fail(s, 'No bonus balance to clear', 'Bonus');
  return finishOp(s, doClearBonus(s, bt, 'forfeited'), `Cleared ${fmtAmt(bt, bonus)} of bonus`);
}

/* ─── admin ─── */
export function adminSetBalance(state, { balanceType: bt, bucket = 'primary', value, adminId = 'admin_7', reason = 'Operational correction' }) {
  const s = begin(state, 'Admin set balance', 'Admin');
  if (!Number.isFinite(value) || value < 0) return fail(s, 'Invalid amount', 'Admin');
  const p = pathsOf(bt);
  const previous = readBalance(s, bt, bucket);
  const r = applyUpdate(s, { bt, caller: 'Admin', api: `setPortfolioBalance(${bucket}, ${value})`, type: 'adminSetBalance', meta: { adminId, reason, previous }, mutate: [{ $set: { [p[bucket]]: { $literal: value } } }] });
  if (readBalance(s, bt) >= 0) s.negativeAllowed[bt] = false;
  return finishOp(s, r, r.unchanged ? `${BT[bt].label} ${bucket} is already ${value}` : `Set ${BT[bt].label} ${bucket} from ${previous} to ${value}`);
}

/* ─── responsible gaming, faults, time ─── */
export function setLimits(state, { wagerLimit, lossLimit }) {
  const s = begin(state, 'Set limits', 'RG');
  s.rg.wagerLimit = wagerLimit ?? null;
  s.rg.lossLimit = lossLimit ?? null;
  return succeed(s, `Wager limit ${wagerLimit ?? 'off'}, loss limit ${lossLimit ?? 'off'}`, 'RG');
}

export function runReconciler(state) {
  const pending = pendingCount(state);
  const s = begin(state, 'Run reconciler', 'Reconciler');
  if (s.config.rowFailure !== 'outbox') return fail(s, 'Nothing to reconcile from: a failed insert leaves no record behind', 'Reconciler');
  return succeed(s, pending ? `Wrote the rows of ${pending} pending entr${pending > 1 ? 'ies' : 'y'}` : 'No pending entries', 'Reconciler');
}

export function advanceDays(state, { days }) {
  const s = begin(state, `+${days} days`, 'Bonus');
  s.clock += days * DAY;
  const cutoff = s.clock - TX_TTL_DAYS * DAY;
  const expired = s.transactions.filter((t) => t.createdAt < cutoff);
  for (const t of expired) s.expiredSums[t.balanceType] = dAdd(s.expiredSums[t.balanceType] || 0, t.amount);
  s.transactions = s.transactions.filter((t) => t.createdAt >= cutoff);
  if (expired.length) note(s, 'MongoDB', `TTL index removed ${expired.length} transaction rows`).why = 'Transaction rows older than 180 days are removed by the TTL index. Balances are not affected.';
  let cleared = 0;
  for (const { code } of BALANCE_TYPES) {
    if (s.bonuses[code] && s.bonuses[code].expiresAt <= s.clock) {
      doClearBonus(s, code, 'expired');
      cleared += 1;
    }
  }
  return succeed(s, `${expired.length} rows expired, ${cleared} bonus${cleared === 1 ? '' : 'es'} expired`, 'Bonus');
}

export function setFault(state, fault) {
  return { ...state, fault };
}
export function setConfig(state, config) {
  return { ...state, config: { ...config } };
}

/** The documents as stored (for the Database tab). */
export function storedDocuments(s) {
  return { portfolio: s.portfolio, user: s.user, transactions: s.transactions.slice(0, 4) };
}

/* ─── invariants ─── */
export function invariants(s) {
  const out = [];
  const pending = [...(s.portfolio.pendingEntries || []), ...(s.user.pendingEntries || [])];
  const callbackId = (t) => t.meta?.betId ?? t.meta?.externalIdentifier;
  for (const { code, label } of BALANCE_TYPES) {
    const amounts = { [code]: readBalance(s, code), [`${code}Bonus`]: readBalance(s, code, 'bonus') };
    const held = dAdd(amounts[code], amounts[`${code}Bonus`]);
    const check = (f) => {
      const results = Object.entries(amounts).map(([bucket, amount]) => f(bucket, amount));
      return { ok: results.every((r) => r.ok), detail: results.map((r) => r.detail).join('; ') };
    };
    // `currentBalance` is the balance of the one amount a row touched, so the newest row per bucket must match it.
    const latest = check((bucket, amount) => {
      const t = s.transactions.find((x) => x.balanceType === bucket);
      if (!t) return { ok: near(amount, 0) || bucket in s.expiredSums || pending.length > 0, detail: `no ${bucket} row; stored ${amount}` };
      return { ok: near(t.currentBalance, amount) || pending.some((e) => e.balanceType === code), detail: `newest ${bucket} row says ${t.currentBalance}; stored ${amount}` };
    });
    // Rows, rows the TTL removed and entries still pending must add up to the stored amount.
    const covered = check((bucket, amount) => {
      const rows = s.transactions.filter((t) => t.balanceType === bucket).reduce((sum, t) => dAdd(sum, t.amount), 0);
      const waiting = pending.filter((e) => e.balanceType === code).reduce((sum, e) => dAdd(sum, bucket === code ? dSub(e.primaryAfter, e.primaryBefore) : dSub(e.bonusAfter, e.bonusBefore)), 0);
      const total = dAdd(dAdd(rows, s.expiredSums[bucket] || 0), waiting);
      return { ok: near(total, amount), detail: `${bucket}: rows add up to ${total}; stored ${amount}` };
    });
    const seen = {};
    for (const t of s.transactions) {
      if (callbackId(t) && (t.balanceType === code || t.balanceType === `${code}Bonus`)) {
        const k = `${t.type} ${callbackId(t)} on ${t.balanceType}`;
        seen[k] = (seen[k] || 0) + 1;
      }
    }
    const repeated = Object.entries(seen).filter(([, n]) => n > 1).map(([k, n]) => `${k} × ${n}`);
    const residue = Object.entries(amounts).filter(([, n]) => Number(n.toFixed(8)) !== n);
    out.push(
      { id: `conserve-${code}`, group: 'Conservation', cur: label, ok: near(held, s.expected[code]), detail: `primary + bonus ${held} vs expected ${s.expected[code]}` },
      { id: `neg-${code}`, group: 'No negative balance', cur: label, ok: (amounts[code] >= 0 || s.negativeAllowed[code]) && amounts[`${code}Bonus`] >= 0, detail: `primary ${amounts[code]}, bonus ${amounts[`${code}Bonus`]}${s.negativeAllowed[code] ? ' (allowNegative was used)' : ''}` },
      { id: `latest-${code}`, group: 'Latest row ↔ balance', cur: label, ...latest },
      { id: `rows-${code}`, group: 'Every change has a row', cur: label, ...covered },
      { id: `once-${code}`, group: 'Each callback applied once', cur: label, ok: repeated.length === 0, detail: repeated.join('; ') || 'no callback has two rows' },
      { id: `float-${code}`, group: 'No float residue', cur: label, ok: residue.length === 0, detail: residue.map(([k, n]) => `${k} = ${n}`).join('; ') || 'amounts are exact' },
    );
  }
  return out;
}
