/*
 * Stash ledger engine — a pure, in-memory model of draft 2 of the Stash plan,
 * shaped like the real backend (see TECHNICAL_PLAN.md):
 *
 *  - two balance stores: the Mongo portfolio and the RethinkDB user row
 *  - every amount is USD
 *  - a balance type holds three amounts: primary, bonus, stash
 *  - balances change with single-document guarded updates; there are no sessions
 *  - transaction rows are written after the balance changes
 *
 * Every public operation takes the current state and returns a NEW state.
 * Each operation also records a `trace` (sequence-diagram steps) so the UI can
 * show which services were called and which writes ran.
 */

export const BALANCE_TYPES = [
  { code: 'usdt', label: 'USDT', store: 'portfolio' },
  { code: 'sol', label: 'SOL', store: 'portfolio' },
  // `crypto` is BTC, and its primary field is `balance`: the backend's own legacy names.
  { code: 'crypto', label: 'BTC', store: 'user', field: 'balance', bonusField: 'btcBonusBalance', stashField: 'btcStashBalance' },
  { code: 'cash', label: 'Cash', store: 'user', field: 'cashBalance', bonusField: 'cashBonusBalance', stashField: 'cashStashBalance', fiat: true },
];
export const BT = Object.fromEntries(BALANCE_TYPES.map((b) => [b.code, b]));

// Server-side list (a GraphQL enum in the plan). A value off the list is rejected.
export const ADMIN_REASONS = [
  'Responsible Gambling Request',
  'Customer Request',
  'Fraud Investigation',
  'Operational Correction',
];

export const RELOAD_MODES = { off: 'Off', manual: 'Manual (player confirms)', auto: 'Auto (pre-authorized)' };
const RELOAD_DEFAULT = [20, 100]; // USD, the same for every balance type

export const PARTICIPANTS = ['User', 'Admin', 'Game', 'Ledger', 'Bonus', 'Auth', 'Reload', 'Redis', 'Mongo', 'Rethink', 'CRM'];

const DAY = 86400000;
export const TX_TTL_DAYS = 180;
const TOTP_STEP = 30000;
const TOTP_CONSUMED_TTL = 120000;
export const WRONG_CODE_LIMIT = 15;
const WRONG_CODE_WINDOW = 300000;
const REQUEST_ID_LOOKBACK = 600000;

/* ─── design knobs ─── */
export const KNOBS = {
  wagerable: { label: 'Wagerable balance', options: { named: 'balance + bonusBalance, by name', allAmounts: 'Every amount of the balance type' } },
  storage: { label: 'Where Stash is stored', options: { sibling: 'Beside each balance, in its own store', mongoAll: 'stashBalances in the Mongo portfolio (spec)' } },
  overdraft: { label: 'Overdraft check', options: { atomic: 'Guard inside the update', readThenWrite: 'Read, check in app, then write' } },
  rowModel: { label: 'Transfer rows', options: { spec: 'One row, balanceType MAIN / STASH (spec)', paired: 'Two rows: <type> and <type>Stash' } },
  validator: { label: 'balanceType read hook', options: { current: 'As deployed today', acceptsStash: 'Accepts <type>Stash' } },
  rowFailure: { label: 'Failed row write', options: { swallow: 'Logged and swallowed (today)', alert: 'Swallowed, plus an alert' } },
  totals: { label: 'Stash in UserBalances', options: { excluded: 'Not a key (spec guard clause)', included: '<type>Stash keys' } },
  connectFilter: { label: 'Connect API', options: { false: 'Publishes every numeric key', true: 'Filters Stash keys' } },
  fastTrack: { label: 'FastTrack real_money', options: { everyRow: 'Published for every row (today)', skipStash: 'Skipped for Stash rows' } },
  bonusScope: { label: 'Bonus block scope', options: { user: 'Any bonus on the user (spec)', balanceType: 'That balance type (real function)' } },
  twoFaPolicy: { label: '2FA on transfer-out', options: { IF_ENABLED: 'If enabled, else warn', MANDATORY: 'Mandatory' } },
  wrongCodeLimit: { label: 'Wrong 2FA codes', options: { none: 'Unlimited (today)', limiter: `${WRONG_CODE_LIMIT} per 5 min, per user` } },
  duplicates: { label: 'Duplicate requests', options: { none: 'No protection (spec)', mutex: 'Per-user Redis mutex', mutexRequestId: 'Mutex + requestId lookup' } },
  audit: { label: 'ACP audit record', options: { rowOnly: 'Transaction row only (180-day TTL)', audits: 'audits collection + row' } },
  cleanupChecksStash: { label: 'Account cleanup', options: { false: 'Checks primary only (today)', true: 'Also checks Stash' } },
  cashStash: { label: 'Stash on cash (fiat)', options: { true: 'Allowed', false: 'Deferred' } },
  autoReloadOnWithdraw: { label: 'Auto-reload trigger', options: { true: 'Bets + withdrawals (spec)', false: 'Bets only' } },
  autoReloadEnable2fa: { label: 'Enabling auto-reload', options: { false: 'No step-up', true: 'Needs 2FA code' } },
  reloadScope: { label: 'Reload settings scope', options: { single: 'One setting per user (spec)', balanceType: 'Per balance type' } },
};

export const PRESETS = {
  naive: {
    label: 'Naive',
    blurb: 'No safeguards. Shows the failures the spec is guarding against.',
    config: { wagerable: 'allAmounts', storage: 'mongoAll', overdraft: 'readThenWrite', rowModel: 'spec', validator: 'current', rowFailure: 'swallow', totals: 'excluded', connectFilter: false, fastTrack: 'everyRow', bonusScope: 'user', twoFaPolicy: 'IF_ENABLED', wrongCodeLimit: 'none', duplicates: 'none', audit: 'rowOnly', cleanupChecksStash: false, cashStash: true, autoReloadOnWithdraw: true, autoReloadEnable2fa: false, reloadScope: 'single' },
  },
  spec: {
    label: 'Spec as written',
    blurb: 'The Sept 2026 write-up, taken literally and run against how the backend really works.',
    config: { wagerable: 'named', storage: 'mongoAll', overdraft: 'atomic', rowModel: 'spec', validator: 'current', rowFailure: 'swallow', totals: 'excluded', connectFilter: false, fastTrack: 'everyRow', bonusScope: 'user', twoFaPolicy: 'IF_ENABLED', wrongCodeLimit: 'none', duplicates: 'none', audit: 'rowOnly', cleanupChecksStash: false, cashStash: true, autoReloadOnWithdraw: true, autoReloadEnable2fa: false, reloadScope: 'single' },
  },
  recommended: {
    label: 'Recommended',
    blurb: 'Draft 2 of the technical plan.',
    config: { wagerable: 'named', storage: 'sibling', overdraft: 'atomic', rowModel: 'paired', validator: 'acceptsStash', rowFailure: 'alert', totals: 'included', connectFilter: true, fastTrack: 'skipStash', bonusScope: 'balanceType', twoFaPolicy: 'IF_ENABLED', wrongCodeLimit: 'limiter', duplicates: 'mutex', audit: 'audits', cleanupChecksStash: true, cashStash: false, autoReloadOnWithdraw: false, autoReloadEnable2fa: true, reloadScope: 'balanceType' },
  },
};

/* ─── helpers ─── */
export const r8 = (n) => Math.round(n * 1e8) / 1e8;
const perType = (f) => Object.fromEntries(BALANCE_TYPES.map((b) => [b.code, f(b)]));
const baseType = (v) => (/(Bonus|Stash)$/.test(v) ? v.slice(0, -5) : v);
/** A transaction-row bucket that holds Stash funds: `<type>Stash`, or the spec's literal `STASH`. */
export const isStashBucket = (v) => v === 'STASH' || (v.endsWith('Stash') && Boolean(BT[v.slice(0, -5)]));

export function totp(clock) {
  // Deterministic 6-digit code that rotates every 30 simulated seconds.
  let h = 2166136261 ^ Math.floor(clock / TOTP_STEP);
  for (let i = 0; i < 4; i++) h = Math.imul(h ^ (h >>> 13), 16777619);
  return String(Math.abs(h) % 1e6).padStart(6, '0');
}

export function createState(config = PRESETS.recommended.config) {
  return {
    clock: 0,
    seq: 0,
    config: { ...config },
    fault: 'none', // one-shot, next transfer: 'betweenWrites' | 'rowWrite'
    // RethinkDB `users` row: holds the BTC and cash amounts.
    user: {
      id: 'u_1001', name: 'player_one', twofactorEnabled: true, deleted: false,
      hiddenTotalDeposited: 0, hiddenTotalBet: 0,
      balance: 0, cashBalance: 0,
      btcBonusBalance: 0, cashBonusBalance: 0,
      btcStashBalance: 0, cashStashBalance: 0,
    },
    // Mongo `user_altcoin_portfolios`: holds the USDT and SOL amounts.
    // `stashBalances` is only used by the spec's storage model (knob `storage: mongoAll`).
    portfolio: {
      userId: 'u_1001',
      balances: { usdt: { balance: 0, bonusBalance: 0, stashBalance: 0, currency: 'usd' }, sol: { balance: 0, bonusBalance: 0, stashBalance: 0, currency: 'usd' } },
      stashBalances: perType(() => 0),
    },
    settings: { stashReload: perType(() => ({ mode: 'off', threshold: RELOAD_DEFAULT[0], target: RELOAD_DEFAULT[1] })) },
    bonuses: perType(() => null),
    transactions: [], // Mongo `transactions` (180-day TTL)
    audits: [], // Mongo `audits` (no TTL)
    redis: { totpUsed: {}, twoFaFails: { count: 0, resetAt: 0 } },
    rowsExpired: false,
    crm: [],
    ws: [],
    alerts: [],
    events: [],
    trace: [],
    lastOp: null,
    external: perType(() => 0), // ground truth: net money that entered/left this user's balances
    flows: { deposited: 0, withdrawn: 0 },
  };
}

/* ─── op scaffolding ─── */
class Crash extends Error {}
class RowWriteError extends Error {}

function begin(state, name) {
  const s = structuredClone(state);
  s.clock += 1000;
  s.trace = [];
  s.lastOp = { name, ok: null, message: '', warning: null };
  return s;
}
const step = (s, from, to, label, kind = 'call', detail) => s.trace.push({ from, to, label, kind, detail });
const note = (s, at, label, detail) => step(s, at, at, label, 'note', detail);

function log(s, level, msg) {
  s.events.unshift({ t: s.clock, level, msg });
  s.events.length = Math.min(s.events.length, 300);
}
function fail(s, msg, from = 'Ledger', to = 'User') {
  step(s, from, to, msg, 'error');
  s.lastOp.ok = false;
  s.lastOp.message = msg;
  log(s, 'error', `${s.lastOp.name}: ${msg}`);
  return s;
}
function succeed(s, msg, to = 'User', from = 'Ledger') {
  step(s, from, to, msg, 'return');
  if (s.lastOp.ok !== false) {
    s.lastOp.ok = true;
    s.lastOp.message = msg;
  }
  log(s, s.lastOp.warning ? 'warn' : 'ok', `${s.lastOp.name}: ${msg}${s.lastOp.warning ? ` — ${s.lastOp.warning}` : ''}`);
  return s;
}

const fmtAmt = (bt, n) => `${Number(n).toFixed(2)} ${BT[bt].label}`;

function oid(s) {
  s.seq += 1;
  return '66f8' + s.seq.toString(16).padStart(20, '0');
}

/* ─── stores ─── */
/** Where one amount of a balance type lives: which database, which path, and accessors. */
function loc(s, bt, bucket) {
  const b = BT[bt];
  if (bucket === 'stash' && s.config.storage === 'mongoAll') {
    return { db: 'Mongo', path: `stashBalances.${bt}`, get: () => s.portfolio.stashBalances[bt], set: (v) => { s.portfolio.stashBalances[bt] = v; } };
  }
  if (b.store === 'portfolio') {
    const f = { primary: 'balance', bonus: 'bonusBalance', stash: 'stashBalance' }[bucket];
    return { db: 'Mongo', path: `balances.${bt}.${f}`, get: () => s.portfolio.balances[bt][f], set: (v) => { s.portfolio.balances[bt][f] = v; } };
  }
  const f = { primary: b.field, bonus: b.bonusField, stash: b.stashField }[bucket];
  return { db: 'Rethink', path: `users.${f}`, get: () => s.user[f], set: (v) => { s.user[f] = v; } };
}
export const readBalance = (s, bt, bucket = 'primary') => loc(s, bt, bucket).get();
export const stashPath = (s, bt) => loc(s, bt, 'stash').path;
const updateName = (db) => (db === 'Mongo' ? 'findOneAndUpdate (pipeline)' : 'users.get(id).update()');

/** One unconditional update of one document. `changes` is a list of [balanceType, bucket, delta]. */
function applyUpdate(s, changes, from = 'Ledger') {
  const locs = changes.map(([bt, bucket, delta]) => [loc(s, bt, bucket), delta]);
  const { db } = locs[0][0];
  step(s, from, db, updateName(db), 'call', Object.fromEntries(locs.map(([l, d]) => [l.path, d])));
  for (const [l, d] of locs) l.set(r8(l.get() + d));
}

/** Debit one amount, honouring the configured overdraft strategy. */
function debit(s, l, amount, from = 'Ledger') {
  if (s.config.overdraft === 'atomic') {
    step(s, from, l.db, updateName(l.db), 'call', { guard: `${l.path} >= ${amount}`, [l.path]: -amount });
    if (l.get() < amount) {
      step(s, l.db, from, 'no-op: the guard did not hold', 'return');
      return false;
    }
    l.set(r8(l.get() - amount));
    step(s, l.db, from, 'debited', 'return');
    return true;
  }
  step(s, from, l.db, `read ${l.path}`, 'call');
  const seen = l.get();
  step(s, l.db, from, `${seen}`, 'return');
  if (seen < amount) return false;
  step(s, from, l.db, updateName(l.db), 'call', { [l.path]: -amount });
  l.set(r8(l.get() - amount));
  return true;
}

function maybeCrash(s) {
  if (s.fault === 'betweenWrites') {
    s.fault = 'none';
    throw new Crash('process crashed between debit and credit');
  }
}

/**
 * Move `amount` between primary and Stash of one balance type.
 * When both amounts are in one document and the guard is in the update, this is
 * one atomic write. Otherwise it is a debit followed by a credit, with nothing
 * to roll the debit back if the process stops in between.
 */
function moveFunds(s, bt, amount, dir, from = 'Ledger') {
  const src = loc(s, bt, dir === 'in' ? 'primary' : 'stash');
  const dst = loc(s, bt, dir === 'in' ? 'stash' : 'primary');
  const oneDoc = src.db === dst.db;

  if (oneDoc && s.config.overdraft === 'atomic') {
    step(s, from, src.db, updateName(src.db), 'call', { guard: `${src.path} >= ${amount}`, [src.path]: -amount, [dst.path]: amount });
    if (src.get() < amount) {
      step(s, src.db, from, 'no-op: the guard did not hold', 'return');
      return false;
    }
    src.set(r8(src.get() - amount));
    dst.set(r8(dst.get() + amount));
    step(s, src.db, from, 'both amounts changed in one document', 'return');
    return true;
  }

  if (!oneDoc) note(s, from, `${src.db} + ${dst.db}: no transaction can span them`);
  if (!debit(s, src, amount, from)) return false;
  maybeCrash(s);
  step(s, from, dst.db, updateName(dst.db), 'call', { [dst.path]: amount });
  dst.set(r8(dst.get() + amount));
  return true;
}

/* ─── transactions and their side effects ─── */
/** The validator behind the schema's post('init') hook. An unknown value makes a hydrating read throw. */
export function isKnownBalanceType(s, v) {
  if (BT[v]) return true;
  if (v.endsWith('Bonus') && BT[v.slice(0, -5)]) return true;
  return s.config.validator === 'acceptsStash' && v.endsWith('Stash') && Boolean(BT[v.slice(0, -5)]);
}

function createTransaction(s, doc, from = 'Ledger') {
  const tx = { _id: oid(s), userId: s.user.id, ...doc, createdAt: s.clock };
  step(s, from, 'Mongo', `insert ${tx.type} (${tx.balanceType} ${tx.amount >= 0 ? '+' : ''}${tx.amount})`, 'call', tx);
  s.transactions.unshift(tx);
  // Every row, whatever its type, emits a socket event and a FastTrack CRM message.
  s.ws.unshift({ t: s.clock, event: 'transactionCreated', delta: tx.amount, balanceType: tx.balanceType, currentBalance: tx.currentBalance });
  s.ws.length = Math.min(s.ws.length, 100);
  if (s.config.fastTrack === 'skipStash' && isStashBucket(tx.balanceType)) return tx;
  step(s, from, 'CRM', `real_money = ${tx.currentBalance}`, 'call', { type: 'USER_BALANCES_UPDATE', key: 'real_money', amount: tx.currentBalance, fromRow: tx.balanceType });
  s.crm.unshift({ t: s.clock, key: 'real_money', amount: tx.currentBalance, balanceType: tx.balanceType, bt: tx.currency ?? baseType(tx.balanceType) });
  s.crm.length = Math.min(s.crm.length, 100);
  return tx;
}

/** Rows for one transfer. They are written after the balance moved; a failure is swallowed, as in the ledger. */
function recordTransfer(s, kind, bt, amount, meta) {
  const dirIn = kind === 'stashIn';
  try {
    if (s.fault === 'rowWrite') {
      s.fault = 'none';
      step(s, 'Ledger', 'Mongo', `insert ${kind}`, 'call');
      throw new RowWriteError('Unable to create transaction');
    }
    if (s.config.rowModel === 'spec') {
      // Spec: one row; STASH_IN is tagged STASH, STASH_OUT is tagged MAIN.
      createTransaction(s, { type: dirIn ? 'STASH_IN' : 'STASH_OUT', currency: bt, balanceType: dirIn ? 'STASH' : 'MAIN', amount, currentBalance: readBalance(s, bt, dirIn ? 'stash' : 'primary'), meta });
      return;
    }
    // Stash row first, so the last socket event and CRM message carry the primary balance.
    const m = { transferId: oid(s), ...meta };
    createTransaction(s, { type: kind, balanceType: `${bt}Stash`, amount: dirIn ? amount : -amount, currentBalance: readBalance(s, bt, 'stash'), meta: m });
    createTransaction(s, { type: kind, balanceType: bt, amount: dirIn ? -amount : amount, currentBalance: readBalance(s, bt), meta: m });
  } catch (e) {
    if (!(e instanceof RowWriteError)) throw e;
    step(s, 'Mongo', 'Ledger', '💥 insert failed', 'error');
    note(s, 'Ledger', 'Transaction log failed — the balance change stands');
    s.lastOp.rowFailed = true;
    log(s, 'error', `${s.lastOp.name}: transaction rows were not written (transactionId: undefined)`);
    if (s.config.rowFailure === 'alert') {
      s.alerts.unshift({ t: s.clock, msg: `Stash ${kind} of ${fmtAmt(bt, amount)} has no transaction rows` });
      note(s, 'Ledger', 'alert raised');
    }
  }
}

/* ─── queries ─── */
/** What a bet or a game provider may spend: one balance type, read by name. */
export function wagerableBalance(s, bt) {
  const named = r8(readBalance(s, bt) + (s.bonuses[bt] ? readBalance(s, bt, 'bonus') : 0));
  return s.config.wagerable === 'named' ? named : r8(named + readBalance(s, bt, 'stash'));
}

/** The flat `UserBalances` object that the client, the ACP and every total are built from. */
export function mapBalanceInformation(s) {
  const out = { selectedBalanceType: 'usdt' };
  for (const { code } of BALANCE_TYPES) {
    out[code] = readBalance(s, code);
    const bonus = readBalance(s, code, 'bonus');
    const stash = readBalance(s, code, 'stash');
    if (bonus > 0) out[`${code}Bonus`] = bonus;
    if (s.config.totals === 'included' && stash > 0) out[`${code}Stash`] = stash;
  }
  return out;
}

/** Sums every numeric key of `UserBalances`, as the backend does. */
export function totalBalance(balances) {
  const { selectedBalanceType, ...rest } = balances; // eslint-disable-line no-unused-vars
  return r8(Object.values(rest).reduce((a, v) => a + v, 0));
}

/** Cashback / lossback P&L: deposits − withdrawals − total balance. A positive value is a loss. */
export function calculatePnl(s) {
  return r8(s.flows.deposited - s.flows.withdrawn - totalBalance(mapBalanceInformation(s)));
}

/** The public Connect API publishes every numeric key of `UserBalances` under its raw name. */
export function connectApiBalances(s) {
  const entries = Object.entries(mapBalanceInformation(s)).filter(([, v]) => typeof v === 'number');
  return Object.fromEntries(s.config.connectFilter ? entries.filter(([k]) => !k.endsWith('Stash')) : entries);
}

export function isBonusLocked(s, bt) {
  if (s.config.bonusScope === 'user') return Object.values(s.bonuses).some(Boolean);
  return Boolean(s.bonuses[bt]);
}

function validAmount(s, amount) {
  if (!(amount > 0) || !Number.isFinite(amount)) {
    fail(s, 'Amount must be a positive number');
    return false;
  }
  return true;
}

function stashAvailable(s, bt) {
  if (BT[bt].fiat && !s.config.cashStash) {
    fail(s, 'Stash is not on the allow-list for the cash balance type — deferred');
    return false;
  }
  return true;
}

/* ─── player operations ─── */
export function deposit(state, { balanceType: bt, amount }) {
  const s = begin(state, `deposit ${fmtAmt(bt, amount)}`);
  if (!validAmount(s, amount)) return s;
  step(s, 'User', 'Ledger', `creditBalance(${amount}, ${bt})`);
  applyUpdate(s, [[bt, 'primary', amount]]);
  createTransaction(s, { type: 'deposit', balanceType: bt, amount, currentBalance: readBalance(s, bt) });
  s.external[bt] = r8(s.external[bt] + amount);
  s.user.hiddenTotalDeposited = r8(s.user.hiddenTotalDeposited + amount);
  s.flows.deposited = r8(s.flows.deposited + amount);
  return succeed(s, 'Deposited to the primary balance');
}

/** Funds from another player: a credit that is not a deposit. */
export function receiveTip(state, { balanceType: bt, amount }) {
  const s = begin(state, `receive tip ${fmtAmt(bt, amount)}`);
  if (!validAmount(s, amount)) return s;
  step(s, 'User', 'Ledger', `creditBalance(${amount}, ${bt}, 'tip')`);
  applyUpdate(s, [[bt, 'primary', amount]]);
  createTransaction(s, { type: 'tip', balanceType: bt, amount, currentBalance: readBalance(s, bt), meta: { fromName: 'another_player' } });
  s.external[bt] = r8(s.external[bt] + amount);
  return succeed(s, 'Tip received');
}

export function grantLockedBonus(state, { balanceType: bt, amount, wagerMultiplier = 5 }) {
  const s = begin(state, `grant bonus ${fmtAmt(bt, amount)}`);
  if (!validAmount(s, amount)) return s;
  step(s, 'Admin', 'Bonus', `cashableBonusCreate(${amount} on ${bt}, ${wagerMultiplier}x wagering)`);
  if (s.bonuses[bt]) return fail(s, 'User already has a bonus in this balance', 'Bonus', 'Admin');
  applyUpdate(s, [[bt, 'bonus', amount]], 'Bonus');
  createTransaction(s, { type: 'cashableBonus', balanceType: `${bt}Bonus`, amount, currentBalance: readBalance(s, bt, 'bonus'), meta: { status: 'active' } }, 'Bonus');
  s.bonuses[bt] = { amount, wagerRequirement: r8(amount * wagerMultiplier), wagered: 0 };
  s.external[bt] = r8(s.external[bt] + amount);
  return succeed(s, 'Bonus active on this balance type', 'Admin', 'Bonus');
}

export function bet(state, { balanceType: bt, amount, outcome }) {
  const s = begin(state, `bet ${fmtAmt(bt, amount)}`);
  if (!validAmount(s, amount)) return s;
  step(s, 'Game', 'Ledger', `getBalanceFromUserAndType(${bt})`);
  const wagerable = wagerableBalance(s, bt);
  note(s, 'Ledger', s.config.wagerable === 'named' ? 'reads balance + bonusBalance by name' : 'sums every amount (incl. Stash)');
  step(s, 'Ledger', 'Game', `available = ${wagerable}`, 'return');
  if (amount > wagerable) return fail(s, `bet__not_enough_balance (${wagerable})`, 'Game', 'User');

  // Primary first, overflow to bonus while a bonus is active.
  const active = Boolean(s.bonuses[bt]);
  const fromPrimary = Math.min(Math.max(readBalance(s, bt), 0), amount);
  const fromBonus = active ? Math.min(readBalance(s, bt, 'bonus'), r8(amount - fromPrimary)) : 0;
  const shortfall = r8(amount - fromPrimary - fromBonus); // non-zero only when Stash leaked into wagerable
  const primaryChange = r8(fromPrimary + shortfall);
  applyUpdate(s, [[bt, 'primary', -primaryChange], [bt, 'bonus', -fromBonus]].filter((c) => c[2] !== 0), 'Game');
  if (shortfall > 0) note(s, loc(s, bt, 'primary').db, `⚠ primary driven negative by ${shortfall}: Stash counted as wagerable`);
  if (fromBonus) createTransaction(s, { type: 'bet', balanceType: `${bt}Bonus`, amount: -fromBonus, currentBalance: readBalance(s, bt, 'bonus') }, 'Game');
  if (primaryChange) createTransaction(s, { type: 'bet', balanceType: bt, amount: -primaryChange, currentBalance: readBalance(s, bt) }, 'Game');
  s.external[bt] = r8(s.external[bt] - amount);
  s.user.hiddenTotalBet = r8(s.user.hiddenTotalBet + amount);

  const bonus = s.bonuses[bt];
  if (bonus) {
    bonus.wagered = r8(bonus.wagered + amount);
    step(s, 'Ledger', 'Bonus', `wager progress ${bonus.wagered}/${bonus.wagerRequirement}`);
  }

  const won = outcome ?? Math.random() < 0.48;
  if (won) {
    const payout = amount * 2;
    const bonusShare = active ? r8(fromBonus * 2) : 0;
    const primaryShare = r8(payout - bonusShare);
    applyUpdate(s, [[bt, 'primary', primaryShare], [bt, 'bonus', bonusShare]].filter((c) => c[2] !== 0), 'Game');
    if (bonusShare) createTransaction(s, { type: 'payout', balanceType: `${bt}Bonus`, amount: bonusShare, currentBalance: readBalance(s, bt, 'bonus') }, 'Game');
    if (primaryShare) createTransaction(s, { type: 'payout', balanceType: bt, amount: primaryShare, currentBalance: readBalance(s, bt) }, 'Game');
    s.external[bt] = r8(s.external[bt] + payout);
  }

  settleBonus(s, bt);
  succeed(s, won ? `Won ${amount * 2}` : 'Lost', 'User', 'Game');
  checkAndTriggerAutoReload(s, bt, 'bet');
  return s;
}

function settleBonus(s, bt) {
  const bonus = s.bonuses[bt];
  if (!bonus) return;
  const live = readBalance(s, bt, 'bonus');
  if (bonus.wagered >= bonus.wagerRequirement) {
    if (live > 0) {
      applyUpdate(s, [[bt, 'bonus', -live], [bt, 'primary', live]], 'Bonus');
      createTransaction(s, { type: 'cashableBonus', balanceType: `${bt}Bonus`, amount: -live, currentBalance: 0, meta: { status: 'completed' } }, 'Bonus');
      createTransaction(s, { type: 'cashableBonus', balanceType: bt, amount: live, currentBalance: readBalance(s, bt), meta: { status: 'completed' } }, 'Bonus');
    }
    s.bonuses[bt] = null;
    log(s, 'ok', `Bonus on ${BT[bt].label} completed — ${live} moved to the primary balance`);
  } else if (live < 0.01) {
    s.bonuses[bt] = null;
    note(s, 'Bonus', 'bonus balance below 0.01 — forfeited');
    log(s, 'info', `Bonus on ${BT[bt].label} forfeited (zero balance)`);
  }
}

export function withdraw(state, { balanceType: bt, amount }) {
  const s = begin(state, `withdraw ${fmtAmt(bt, amount)}`);
  if (!validAmount(s, amount)) return s;
  step(s, 'User', 'Ledger', `deductFromBalance(${amount}, ${bt}, 'withdrawal')`);
  if (!debit(s, loc(s, bt, 'primary'), amount)) return fail(s, 'withdrawal__low_bal: only the primary balance can be withdrawn');
  createTransaction(s, { type: 'withdrawal', balanceType: bt, amount: -amount, currentBalance: readBalance(s, bt) });
  s.external[bt] = r8(s.external[bt] - amount);
  s.flows.withdrawn = r8(s.flows.withdrawn + amount);
  succeed(s, 'Withdrawal sent');
  if (s.config.autoReloadOnWithdraw) checkAndTriggerAutoReload(s, bt, 'withdraw');
  else note(s, 'Ledger', 'auto-reload is not evaluated on withdrawals');
  return s;
}

/* ─── stash transfers ─── */
const DUPLICATE_MSG = 'Duplicate request ignored — the original transfer stands';

/** Non-blocking per-user Redis mutex, held for the length of one request. Sequential requests never contend. */
function acquireLock(s) {
  if (s.config.duplicates === 'none') return;
  step(s, 'Ledger', 'Redis', "MutexLock.acquireLock(user, 'stash', 'transfer')", 'call');
  step(s, 'Redis', 'Ledger', 'acquired (released in finally)', 'return');
}

/** Optional retry check: look for the client's requestId in recent rows, inside the lock. */
function isDuplicateRequest(s, requestId) {
  if (s.config.duplicates !== 'mutexRequestId' || !requestId) return false;
  step(s, 'Ledger', 'Mongo', 'find recent rows by meta.requestId', 'call', { userId: s.user.id, type: { $in: ['stashIn', 'stashOut'] }, createdAt: { $gte: 'now − 10 min' }, 'meta.requestId': requestId });
  const hit = s.transactions.some((t) => t.meta?.requestId === requestId && t.createdAt >= s.clock - REQUEST_ID_LOOKBACK);
  step(s, 'Mongo', 'Ledger', hit ? 'found — already processed' : 'none', 'return');
  if (hit) s.lastOp.duplicate = true;
  return hit;
}

const transferMeta = (s, source, requestId, extra = {}) => ({ source, ...(s.config.duplicates === 'mutexRequestId' && requestId ? { requestId } : {}), ...extra });

/** Move the funds, then write the rows. Returns true, false (insufficient funds) or 'crash'. */
function runMove(s, bt, amount, dir, meta, from = 'Ledger') {
  try {
    if (!moveFunds(s, bt, amount, dir, from)) return false;
  } catch (e) {
    if (!(e instanceof Crash)) throw e;
    note(s, from, `💥 ${e.message}`);
    note(s, from, 'no rollback: the debit stands');
    log(s, 'error', `Injected crash (${e.message}); the debit was already written`);
    return 'crash';
  }
  if (s.fault === 'betweenWrites') {
    s.fault = 'none';
    note(s, from, 'one update: there is no point between debit and credit to crash at');
  }
  recordTransfer(s, dir === 'in' ? 'stashIn' : 'stashOut', bt, amount, meta);
  return true;
}

function bonusCheck(s, bt, admin = false) {
  const call = s.config.bonusScope === 'user' ? 'checkIfBonusActive(userId)' : admin ? `getActiveCashableBonus(userId, ${bt}, bypassFlagCheck)` : `checkIfBonusActive(user, ${bt})`;
  step(s, 'Ledger', 'Bonus', call);
  const locked = isBonusLocked(s, bt);
  step(s, 'Bonus', 'Ledger', `active: ${locked}`, 'return');
  return locked;
}

export function transferToStash(state, { balanceType: bt, amount, requestId }) {
  const s = begin(state, `stashTransferIn ${fmtAmt(bt, amount)}`);
  if (!validAmount(s, amount) || !stashAvailable(s, bt)) return s;
  step(s, 'User', 'Ledger', `stashTransferIn(${amount}, ${bt})`);
  acquireLock(s);
  if (isDuplicateRequest(s, requestId)) return succeed(s, DUPLICATE_MSG);
  if (bonusCheck(s, bt)) return fail(s, 'Blocked: a bonus is active');
  const res = runMove(s, bt, amount, 'in', transferMeta(s, 'user', requestId));
  if (res === false) return fail(s, 'Not enough primary balance');
  if (res === 'crash') return fail(s, 'Transfer failed — process crashed');
  return succeed(s, 'Moved to Stash');
}

/** The same request sent twice at the same moment (a double-click). */
export function raceTransferToStash(state, { balanceType: bt, amount, requestId }) {
  const s = begin(state, `double-click stashTransferIn 2× ${fmtAmt(bt, amount)}`);
  if (!validAmount(s, amount) || !stashAvailable(s, bt)) return s;
  step(s, 'User', 'Ledger', `2× stashTransferIn(${amount}, ${bt}) at the same time`);
  if (bonusCheck(s, bt)) return fail(s, 'Blocked: a bonus is active');
  const meta = transferMeta(s, 'user', requestId);

  if (s.config.duplicates !== 'none') {
    step(s, 'Ledger', 'Redis', 'A: MutexLock.acquireLock', 'call');
    step(s, 'Redis', 'Ledger', 'A: acquired', 'return');
    step(s, 'Ledger', 'Redis', 'B: MutexLock.acquireLock', 'call');
    step(s, 'Redis', 'Ledger', 'B: null → slow_down', 'error');
    const res = runMove(s, bt, amount, 'in', meta);
    if (res === false) return fail(s, 'Not enough primary balance');
    if (res === 'crash') return fail(s, 'Transfer failed — process crashed');
    return succeed(s, '1/2 requests applied (B was refused by the mutex)');
  }

  if (s.config.overdraft === 'atomic') {
    const okCount = ['A', 'B'].map(() => runMove(s, bt, amount, 'in', meta)).filter((x) => x === true).length;
    if (okCount < 2) note(s, 'Ledger', 'request B: the guard did not hold');
    return succeed(s, `${okCount}/2 requests applied`);
  }
  // read-then-write with no mutex: both requests read before either writes
  const src = loc(s, bt, 'primary');
  const seen = src.get();
  step(s, 'Ledger', src.db, `A: read ${src.path}`, 'call');
  step(s, 'Ledger', src.db, `B: read ${src.path}`, 'call');
  step(s, src.db, 'Ledger', `both see ${seen}`, 'return');
  if (seen < amount) return fail(s, 'Both rejected: not enough primary balance');
  note(s, 'Ledger', `A & B: ${seen} ≥ ${amount} ✓ (stale check)`);
  for (let i = 0; i < 2; i++) {
    applyUpdate(s, [[bt, 'primary', -amount]]);
    applyUpdate(s, [[bt, 'stash', amount]]);
    recordTransfer(s, 'stashIn', bt, amount, meta);
  }
  if (src.get() < 0) note(s, src.db, '⚠ the primary balance is now negative');
  return succeed(s, '2/2 requests applied');
}

function check2fa(s, token, purpose) {
  step(s, 'Ledger', 'Auth', `check2faIfEnabled(user, ${token ? `"${token}"` : 'no code'})`);
  if (!s.user.twofactorEnabled) {
    if (s.config.twoFaPolicy === 'MANDATORY') {
      step(s, 'Auth', 'Ledger', '2FA not enabled', 'return');
      return { ok: false, error: `2FA must be enabled to ${purpose}` };
    }
    step(s, 'Auth', 'Ledger', '2FA not enabled → no challenge', 'return');
    return { ok: true, warning: 'Enable 2FA to protect future Stash transfers.' };
  }
  const fails = s.redis.twoFaFails;
  if (s.config.wrongCodeLimit === 'limiter' && fails.count >= WRONG_CODE_LIMIT && s.clock < fails.resetAt) {
    step(s, 'Auth', 'Ledger', 'attempt limit reached', 'return');
    return { ok: false, error: `Too many wrong codes — locked for ${Math.ceil((fails.resetAt - s.clock) / 1000)} s` };
  }
  // speakeasy `window: 1`: the previous, current and next 30-second codes are accepted.
  const matches = [-1, 0, 1].some((k) => token === totp(s.clock + k * TOTP_STEP));
  let claimed = false;
  if (matches) {
    // Codes are single-use per user across all actions for 120 s (already true in the backend).
    step(s, 'Auth', 'Redis', 'claimTotpCode: SET totp-used NX EX 120', 'call');
    claimed = !((s.redis.totpUsed[token] ?? 0) > s.clock);
    if (claimed) s.redis.totpUsed[token] = s.clock + TOTP_CONSUMED_TTL;
    step(s, 'Redis', 'Auth', claimed ? 'OK' : 'already claimed', 'return');
  }
  if (!claimed) {
    if (s.clock >= fails.resetAt) {
      fails.count = 0;
      fails.resetAt = s.clock + WRONG_CODE_WINDOW;
    }
    fails.count += 1;
    step(s, 'Auth', 'Ledger', 'user__2fa_required', 'return');
    return { ok: false, error: matches ? '2FA code already used — wait for the next code' : 'Wrong 2FA code (user__2fa_required)' };
  }
  step(s, 'Auth', 'Ledger', 'verified', 'return');
  return { ok: true };
}

export function transferFromStash(state, { balanceType: bt, amount, token, requestId }) {
  const s = begin(state, `stashTransferOut ${fmtAmt(bt, amount)}`);
  if (!validAmount(s, amount) || !stashAvailable(s, bt)) return s;
  step(s, 'User', 'Ledger', `stashTransferOut(${amount}, ${bt}, code)`);
  acquireLock(s);
  if (isDuplicateRequest(s, requestId)) return succeed(s, DUPLICATE_MSG);
  // 2FA runs after the cheap checks: a verified code is consumed even if the transfer then fails.
  const auth = check2fa(s, token, 'move funds out of Stash');
  if (!auth.ok) return fail(s, auth.error);
  if (auth.warning) s.lastOp.warning = auth.warning;
  const res = runMove(s, bt, amount, 'out', transferMeta(s, 'user', requestId));
  if (res === false) return fail(s, 'Not enough Stash balance');
  if (res === 'crash') return fail(s, 'Transfer failed — process crashed');
  return succeed(s, auth.warning ? 'Moved to primary (warning: 2FA off)' : 'Moved to primary');
}

/* ─── reload (Stash → primary top-up) ─── */
/** Reload settings per balance type, in USD. `manual` prompts the player; `auto` is pre-authorized and skips 2FA later. */
export function updateAutoReload(state, { balanceType: bt, mode, threshold, target, token }) {
  const s = begin(state, `reload settings ${BT[bt].label}: ${mode}`);
  step(s, 'User', 'Ledger', `updateStashReload(${bt}, mode=${mode}, ${threshold}→${target})`);
  if (!(mode in RELOAD_MODES)) return fail(s, 'mode must be off, manual or auto');
  if (!(target > threshold) || !(threshold >= 0)) return fail(s, 'Target must be greater than threshold');
  if (!stashAvailable(s, bt)) return s;
  const prev = s.settings.stashReload[bt];
  const turningOn = mode === 'auto' && prev.mode !== 'auto';
  const widening = mode === 'auto' && (target > prev.target || threshold > prev.threshold);
  if (s.config.autoReloadEnable2fa && (turningOn || widening)) {
    const auth = check2fa(s, token, 'enable auto-reload');
    if (!auth.ok) return fail(s, `${auth.error} — auto-reload moves Stash funds without a code later`);
  }
  if (s.config.reloadScope === 'single' && mode !== 'off') {
    for (const c of Object.keys(s.settings.stashReload)) if (c !== bt) s.settings.stashReload[c].mode = 'off';
    note(s, 'Ledger', 'one setting per user — other balance types switched off');
  }
  s.settings.stashReload[bt] = { mode, threshold, target };
  step(s, 'Ledger', 'Mongo', `update user_system_settings stashReload.${bt}`, 'call', s.settings.stashReload[bt]);
  return succeed(s, mode === 'off' ? 'Reload disabled' : `${mode === 'auto' ? 'Auto' : 'Manual'} reload set: below ${threshold} → top up to ${target}`);
}

/** Top-up the client prompts a manual-mode player for (0 when there is nothing to prompt). Computed client-side. */
export function reloadSuggestion(s, bt) {
  const st = s.settings.stashReload[bt];
  const primary = readBalance(s, bt);
  return st.mode === 'manual' && primary < st.threshold ? r8(st.target - primary) : 0;
}

/** Auto-reload lives in the bet path, which is why the plan defers it. */
function checkAndTriggerAutoReload(s, bt, trigger) {
  const st = s.settings.stashReload[bt];
  if (st.mode !== 'auto') return;
  const primary = readBalance(s, bt);
  step(s, 'Ledger', 'Reload', `checkAndTriggerAutoReload(${primary})`);
  if (primary >= st.threshold) {
    note(s, 'Reload', `${primary} ≥ threshold ${st.threshold} → no action`);
    return;
  }
  const topUp = r8(st.target - primary);
  const available = readBalance(s, bt, 'stash');
  if (available < topUp) {
    note(s, 'Reload', `Stash ${available} < top-up ${topUp} → skipped`);
    log(s, 'warn', `auto-reload skipped: not enough in Stash (${available} < ${topUp})`);
    return;
  }
  note(s, 'Reload', 'pre-authorized: no 2FA');
  const res = runMove(s, bt, topUp, 'out', { source: 'reload', mode: 'auto', trigger }, 'Reload');
  if (res === true) log(s, 'reload', `auto-reload: +${fmtAmt(bt, topUp)} to primary (triggered by ${trigger})`);
}

/** Player-confirmed reload: tops the primary balance up to the target. It is a transfer-out, so 2FA applies. */
export function reloadFromStash(state, { balanceType: bt, token, requestId }) {
  const s = begin(state, `manual reload ${BT[bt].label}`);
  step(s, 'User', 'Ledger', `stashTransferOut(${bt}, code) — reload`);
  if (!stashAvailable(s, bt)) return s;
  const st = s.settings.stashReload[bt];
  if (st.mode === 'off') return fail(s, 'Reload is not set up for this balance type');
  const primary = readBalance(s, bt);
  const topUp = r8(st.target - primary);
  if (!(topUp > 0)) return fail(s, `The primary balance is already at the reload target (${st.target})`);
  note(s, 'User', `top-up = target ${st.target} − primary ${primary} = ${topUp}`);
  acquireLock(s);
  if (isDuplicateRequest(s, requestId)) return succeed(s, DUPLICATE_MSG);
  const auth = check2fa(s, token, 'reload from Stash');
  if (!auth.ok) return fail(s, auth.error);
  if (auth.warning) s.lastOp.warning = auth.warning;
  const res = runMove(s, bt, topUp, 'out', transferMeta(s, 'reload', requestId, { mode: 'manual' }));
  if (res === false) return fail(s, `Not enough Stash balance for a ${fmtAmt(bt, topUp)} top-up`);
  if (res === 'crash') return fail(s, 'Reload failed — process crashed');
  return succeed(s, `Reloaded ${fmtAmt(bt, topUp)} to primary`);
}

/* ─── admin (ACP) ─── */
/** Admin transfer between a player's primary and Stash amounts. Phase 1 has no direct add / confiscate / reset on Stash. */
export function adminStash(state, { action, balanceType: bt, amount, adminId, reason }) {
  const dir = { 'transfer-in': 'in', 'transfer-out': 'out' }[action];
  const s = begin(state, `ACP ${action} ${fmtAmt(bt, amount)}`);
  step(s, 'Admin', 'Ledger', `mutation ${dir === 'out' ? 'stashTransferOut' : 'stashTransferIn'}`, 'call', { userId: s.user.id, balanceType: bt, amount, reason });
  if (!dir) return fail(s, `unknown action ${action}`, 'Ledger', 'Admin');
  if (!adminId?.trim()) return fail(s, 'Unauthenticated: adminId comes from the session', 'Ledger', 'Admin');
  if (!ADMIN_REASONS.includes(reason)) return fail(s, 'reason is not on the server-side list', 'Ledger', 'Admin');

  const run = () => {
    if (!validAmount(s, amount) || !stashAvailable(s, bt)) return;
    if (dir === 'in' && bonusCheck(s, bt, true)) { fail(s, 'Blocked: a bonus is active', 'Ledger', 'Admin'); return; }
    if (dir === 'out') note(s, 'Auth', "player 2FA not asked — gated by balances:stash_transfer");
    const res = runMove(s, bt, amount, dir, { source: 'admin', adminId, reason });
    if (res === false) fail(s, `Not enough ${dir === 'in' ? 'primary' : 'Stash'} balance`, 'Ledger', 'Admin');
    else if (res === 'crash') fail(s, 'Transfer failed — process crashed', 'Ledger', 'Admin');
    else succeed(s, 'Transfer done', 'Admin');
  };
  run();
  if (s.config.audit === 'audits') {
    // createAuditRecord: written in `finally`, so a failed operation is recorded too.
    const record = { _id: oid(s), editorId: adminId, subjectId: s.user.id, actionType: 'stashTransfer', databaseAction: 'edit', success: s.lastOp.ok === true, reason, meta: { direction: dir, balanceType: bt, amount }, createdAt: s.clock };
    step(s, 'Ledger', 'Mongo', `insert audits (success: ${record.success})`, 'call', record);
    s.audits.unshift(record);
  }
  return s;
}

/** A hydrating read of the user's rows (the admin CSV export). The schema hook validates every balanceType. */
export function adminExport(state) {
  const s = begin(state, 'ACP export transactions');
  step(s, 'Admin', 'Ledger', 'GET /admin/users/transactions/export');
  step(s, 'Ledger', 'Mongo', 'TransactionModel.find({ userId })  (hydrated, not lean)', 'call');
  const bad = s.transactions.find((t) => !isKnownBalanceType(s, t.balanceType));
  if (bad) {
    step(s, 'Mongo', 'Ledger', `post('init') hook throws on "${bad.balanceType}"`, 'error');
    return fail(s, `Invalid balance identifier, ${bad.balanceType}`, 'Ledger', 'Admin');
  }
  step(s, 'Mongo', 'Ledger', `${s.transactions.length} rows`, 'return');
  return succeed(s, `${s.transactions.length} rows exported`, 'Admin');
}

/** The old-account cleanup job: deletes accounts with no BTC balance that never deposited or bet. */
export function cleanupOldUsers(state) {
  const s = begin(state, 'cleanupOldUsers job');
  const checksStash = s.config.cleanupChecksStash;
  step(s, 'Ledger', 'Rethink', 'filter users to delete', 'call', { balance: '< 0.01', ...(checksStash ? { btcStashBalance: '< 0.01' } : {}), hiddenTotalDeposited: 0, hiddenTotalBet: 0 });
  const u = s.user;
  const matches = u.balance < 0.01 && u.hiddenTotalDeposited === 0 && u.hiddenTotalBet === 0 && (!checksStash || readBalance(s, 'crypto', 'stash') < 0.01);
  if (!matches) {
    step(s, 'Rethink', 'Ledger', 'no match', 'return');
    return succeed(s, 'Account kept', 'Admin');
  }
  const held = r8(BALANCE_TYPES.reduce((a, b) => a + readBalance(s, b.code) + readBalance(s, b.code, 'bonus') + readBalance(s, b.code, 'stash'), 0));
  u.deleted = true;
  step(s, 'Rethink', 'Ledger', 'matched → archiveAndDeleteManyAccounts', 'return');
  if (held > 0) log(s, 'error', `Account deleted while holding ${held.toFixed(2)} USD`);
  return succeed(s, held > 0 ? `Account archived and deleted while holding ${held.toFixed(2)} USD` : 'Empty account archived and deleted', 'Admin');
}

/** Advance the clock by whole days. The TTL index removes transaction rows older than 180 days; audits stay. */
export function advanceDays(state, { days }) {
  const s = begin(state, `advance ${days} days`);
  s.clock += days * DAY;
  const before = s.transactions.length;
  s.transactions = s.transactions.filter((t) => t.createdAt >= s.clock - TX_TTL_DAYS * DAY);
  const removed = before - s.transactions.length;
  if (removed) s.rowsExpired = true;
  note(s, 'Mongo', `TTL index (${TX_TTL_DAYS} d) removed ${removed} of ${before} transaction rows`);
  return succeed(s, `${removed} transaction rows expired; ${s.audits.length} audit records remain`, 'Admin', 'Mongo');
}

/* ─── misc state setters ─── */
/** Changing the storage knob moves existing Stash amounts to where the new model keeps them. */
export function setConfig(state, config) {
  const s = structuredClone(state);
  const held = perType((b) => readBalance(s, b.code, 'stash'));
  for (const { code } of BALANCE_TYPES) loc(s, code, 'stash').set(0);
  s.config = { ...config };
  for (const { code } of BALANCE_TYPES) loc(s, code, 'stash').set(held[code]);
  return s;
}
export const setFault = (state, fault) => ({ ...state, fault });
export const setTwoFactor = (state, on) => ({ ...state, user: { ...state.user, twofactorEnabled: on } });
export const tick = (state, ms = 1000) => ({ ...state, clock: state.clock + ms });

/* ─── invariants ─── */
export function invariants(s) {
  const out = [];
  const balances = mapBalanceInformation(s);
  const near = (a, b) => Math.abs(a - b) < 1e-8;
  for (const { code, label } of BALANCE_TYPES) {
    const primary = readBalance(s, code);
    const bonus = readBalance(s, code, 'bonus');
    const stash = readBalance(s, code, 'stash');
    const held = r8(primary + bonus + stash);
    // `currentBalance` is the balance of the one amount a row touched, so the newest row per bucket must match it.
    const row = (bucket, amount) => {
      const t = s.transactions.find((x) => x.balanceType === bucket);
      if (!t) return { ok: near(amount, 0) || s.rowsExpired, detail: `no ${bucket} row; stored ${amount}` };
      return { ok: near(t.currentBalance, amount), detail: `newest ${bucket} row says ${t.currentBalance}; stored ${amount}` };
    };
    const wagerable = wagerableBalance(s, code);
    const spendable = r8(primary + (s.bonuses[code] ? bonus : 0));
    const counted = r8((balances[code] ?? 0) + (balances[`${code}Bonus`] ?? 0) + (balances[`${code}Stash`] ?? 0));
    const leak = s.crm.find((m) => m.bt === code && isStashBucket(m.balanceType));
    out.push(
      { id: `conserve-${code}`, group: 'Conservation', cur: label, ok: near(held, s.external[code]), detail: `primary+bonus+stash ${held} vs net external ${s.external[code]}` },
      { id: `neg-${code}`, group: 'No negative balances', cur: label, ok: primary >= 0 && bonus >= 0 && stash >= 0, detail: `primary ${primary}, bonus ${bonus}, stash ${stash}` },
      { id: `row-primary-${code}`, group: 'Latest row ↔ primary', cur: label, ...row(code, primary) },
      { id: `row-stash-${code}`, group: 'Latest row ↔ Stash', cur: label, ...row(`${code}Stash`, stash) },
      { id: `wager-${code}`, group: 'Wagerable excludes Stash', cur: label, ok: near(wagerable, spendable), detail: `wagerable ${wagerable} vs primary+active bonus ${spendable}` },
      { id: `totals-${code}`, group: 'Totals count Stash', cur: label, ok: near(counted, held), detail: `UserBalances counts ${counted} of ${held} held` },
      { id: `crm-${code}`, group: 'CRM never sees Stash', cur: label, ok: !leak, detail: leak ? `real_money = ${leak.amount} came from a ${leak.balanceType} row` : 'no Stash row was published as real_money' },
    );
  }
  return out;
}
