/*
 * Stash ledger engine — a pure, in-memory model of the Stash spec.
 *
 * Every public operation takes the current state and returns a NEW state.
 * Mongo is modelled as the `portfolio` + `transactions` documents; a
 * "session" snapshot/restore models ACID transactions. Each operation
 * also records a `trace` (sequence-diagram steps) so the UI can show
 * exactly which services were called and which queries ran.
 */

export const CURRENCIES = [
  { code: 'usdt', label: 'USDT', kind: 'crypto', dp: 2 },
  { code: 'eth', label: 'ETH', kind: 'crypto', dp: 4 },
  { code: 'btc', label: 'BTC', kind: 'crypto', dp: 6 },
  { code: 'usd', label: 'USD', kind: 'fiat', dp: 2 },
];
export const CUR = Object.fromEntries(CURRENCIES.map((c) => [c.code, c]));

export const ADMIN_REASONS = [
  'VIP Reward',
  'Goodwill / Compensation',
  'Fraud Investigation',
  'Chargeback Recovery',
  'Responsible Gambling Request',
  'Operational Correction',
];

export const PARTICIPANTS = ['User', 'Admin', 'Game', 'Ledger', 'Bonus', 'Auth', 'Reload', 'Mongo', 'Stats', 'WS'];

/* ─── design knobs ─── */
export const KNOBS = {
  guardClause: { label: 'Balance guard clause', options: { true: 'Destructure `balances` only', false: 'Aggregate every bucket' } },
  acid: { label: 'Mongo session (ACID)', options: { true: 'startTransaction / commit', false: 'Sequential writes' } },
  overdraft: { label: 'Overdraft check', options: { atomic: 'In query filter ($gte)', readThenWrite: 'Read, check in app, then $inc' } },
  recording: { label: 'Transfer recording', options: { single: 'Single doc (spec)', paired: 'Paired debit/credit legs' } },
  bonusScope: { label: 'Locked-bonus block scope', options: { user: 'Any bonus on user (spec)', currency: 'That balance only (PRD)' } },
  twoFaPolicy: { label: '2FA on transfer-out', options: { IF_ENABLED: 'If enabled, else warn', MANDATORY: 'Mandatory' } },
  fiatStash: { label: 'Fiat Stash', options: { true: 'Allowed', false: 'Deferred (crypto only)' } },
  statsExcludeStash: { label: 'Stats exclude STASH', options: { true: 'Filter STASH txs', false: 'Count everything' } },
  autoReloadOnWithdraw: { label: 'Auto-reload trigger', options: { true: 'Bets + withdrawals (spec)', false: 'Bets only' } },
  autoReloadEnable2fa: { label: 'Enabling auto-reload', options: { false: 'No step-up', true: 'Needs 2FA token' } },
};

export const PRESETS = {
  naive: {
    label: 'Naive',
    blurb: 'No safeguards. Shows the failures the spec is guarding against.',
    config: { guardClause: false, acid: false, overdraft: 'readThenWrite', recording: 'single', bonusScope: 'user', twoFaPolicy: 'IF_ENABLED', fiatStash: true, statsExcludeStash: false, autoReloadOnWithdraw: true, autoReloadEnable2fa: false },
  },
  spec: {
    label: 'Spec as written',
    blurb: 'The design in the Sept 2026 write-up, taken literally.',
    config: { guardClause: true, acid: true, overdraft: 'atomic', recording: 'single', bonusScope: 'user', twoFaPolicy: 'IF_ENABLED', fiatStash: true, statsExcludeStash: true, autoReloadOnWithdraw: true, autoReloadEnable2fa: false },
  },
  recommended: {
    label: 'Recommended',
    blurb: 'The spec plus the fixes this simulator shows are needed.',
    config: { guardClause: true, acid: true, overdraft: 'atomic', recording: 'paired', bonusScope: 'currency', twoFaPolicy: 'IF_ENABLED', fiatStash: false, statsExcludeStash: true, autoReloadOnWithdraw: false, autoReloadEnable2fa: true },
  },
};

/* ─── helpers ─── */
export const r8 = (n) => Math.round(n * 1e8) / 1e8;
const emptyBal = () => ({ total: 0, bonus: 0, original: 0 });
const perCurrency = (f) => Object.fromEntries(CURRENCIES.map((c) => [c.code, f(c)]));

export function totp(clock) {
  // Deterministic 6-digit code that rotates every 30 simulated seconds.
  let h = 2166136261 ^ Math.floor(clock / 30000);
  for (let i = 0; i < 4; i++) h = Math.imul(h ^ (h >>> 13), 16777619);
  return String(Math.abs(h) % 1e6).padStart(6, '0');
}

export function createState(config = PRESETS.recommended.config) {
  return {
    clock: 0,
    seq: 0,
    config: { ...config },
    fault: 'none', // one-shot: 'afterDebit' | 'afterCredit'
    user: { userId: 'u_1001', username: 'player_one', twoFactorEnabled: true },
    settings: { stashAutoReloadEnabled: false, stashAutoReloadThreshold: 20, stashAutoReloadTargetAmount: 100, stashAutoReloadCurrency: 'usdt' },
    bonuses: perCurrency(() => null),
    portfolio: { userId: 'u_1001', balances: perCurrency(emptyBal), stashBalances: perCurrency(emptyBal) },
    transactions: [],
    ws: [],
    events: [],
    trace: [],
    lastOp: null,
    external: perCurrency(() => 0), // ground truth: net money that entered/left the platform
    stats: perCurrency(() => ({ wagered: 0, won: 0, mainSnapshot: 0 })),
  };
}

/* ─── op scaffolding ─── */
class Crash extends Error {}

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

const fmtAmt = (cur, n) => `${Number(n).toFixed(CUR[cur].dp)} ${CUR[cur].label}`;

function oid(s) {
  s.seq += 1;
  return '66f8' + s.seq.toString(16).padStart(20, '0');
}

/* ─── query builder / DAL ─── */
export function buildIncrementBalanceQuery(currency, amount, balanceType, portion = 'original') {
  const path = balanceType === 'STASH' ? 'stashBalances' : 'balances';
  return { $inc: { [`${path}.${currency}.total`]: amount, [`${path}.${currency}.${portion}`]: amount } };
}

function readPath(doc, path) {
  return path.split('.').reduce((o, k) => o?.[k], doc);
}

/** Mimics findOneAndUpdate: the filter is evaluated atomically with the update. */
function findOneAndUpdate(s, filter, update, from = 'Ledger') {
  step(s, from, 'Mongo', 'findOneAndUpdate', 'call', { filter, update });
  const p = s.portfolio;
  for (const [path, cond] of Object.entries(filter)) {
    if (path === 'userId') continue;
    const v = readPath(p, path);
    if (cond.$gte !== undefined && !(v >= cond.$gte)) {
      step(s, 'Mongo', from, 'null (filter did not match)', 'return');
      return null;
    }
  }
  for (const [path, v] of Object.entries(update.$inc || {})) {
    const [b, c, f] = path.split('.');
    p[b][c][f] = r8(p[b][c][f] + v);
  }
  for (const [path, v] of Object.entries(update.$set || {})) {
    const [b, c, f] = path.split('.');
    p[b][c][f] = v;
  }
  step(s, 'Mongo', from, 'updated document', 'return');
  return p;
}

/** Debit a bucket, honouring the configured overdraft strategy. */
function debit(s, currency, amount, balanceType, from = 'Ledger') {
  const path = `${balanceType === 'STASH' ? 'stashBalances' : 'balances'}.${currency}.original`;
  const update = buildIncrementBalanceQuery(currency, -amount, balanceType);
  if (s.config.overdraft === 'atomic') {
    return findOneAndUpdate(s, { userId: s.user.userId, [path]: { $gte: amount } }, update, from) !== null;
  }
  step(s, from, 'Mongo', `findOne → read ${path}`, 'call');
  const seen = readPath(s.portfolio, path);
  step(s, 'Mongo', from, `${seen}`, 'return');
  if (seen < amount) return false;
  findOneAndUpdate(s, { userId: s.user.userId }, update, from);
  return true;
}

/* ─── transactions / stats / websocket ─── */
function insertTx(s, doc, from = 'Ledger') {
  const tx = { _id: oid(s), userId: s.user.userId, ...doc, createdAt: s.clock };
  step(s, from, 'Mongo', `insert ${tx.type} (${tx.balanceType} ${tx.amount >= 0 ? '+' : ''}${tx.amount})`, 'call', tx);
  s.transactions.unshift(tx);
  writeStatsForTransaction(s, tx);
  s.ws.unshift({ t: s.clock, event: 'balance:update', type: tx.type, currency: tx.currency, balanceType: tx.balanceType, amount: tx.amount });
  s.ws.length = Math.min(s.ws.length, 100);
  return tx;
}

function writeStatsForTransaction(s, tx) {
  if (s.config.statsExcludeStash && tx.balanceType === 'STASH') {
    note(s, 'Stats', `skip ${tx.type} (STASH)`);
    return;
  }
  const st = s.stats[tx.currency];
  st.mainSnapshot = r8(st.mainSnapshot + tx.amount);
  if (tx.type === 'BET') st.wagered = r8(st.wagered - tx.amount);
  if (tx.type === 'WIN') st.won = r8(st.won + tx.amount);
  step(s, 'Ledger', 'Stats', `writeStatsForTransaction(${tx.type})`, 'call');
}

function recordTransfer(s, kind, currency, amount, meta = {}) {
  if (s.config.recording === 'single') {
    // Spec: one document; STASH_IN targets STASH, STASH_OUT targets MAIN.
    insertTx(s, { type: kind, currency, balanceType: kind === 'STASH_IN' ? 'STASH' : 'MAIN', amount, meta });
    return;
  }
  const transferId = oid(s);
  const [debitBucket, creditBucket] = kind === 'STASH_IN' ? ['MAIN', 'STASH'] : ['STASH', 'MAIN'];
  insertTx(s, { type: kind, currency, balanceType: debitBucket, amount: -amount, transferId, leg: 'DEBIT', meta });
  insertTx(s, { type: kind, currency, balanceType: creditBucket, amount, transferId, leg: 'CREDIT', meta });
}

/* ─── sessions ─── */
function withSession(s, label, fn) {
  const snap = structuredClone({ portfolio: s.portfolio, transactions: s.transactions, stats: s.stats, ws: s.ws });
  if (s.config.acid) step(s, 'Ledger', 'Mongo', `startTransaction() — ${label}`, 'call');
  else note(s, 'Ledger', `no session — ${label}`);
  try {
    const result = fn();
    if (result === false) {
      if (s.config.acid) {
        Object.assign(s, structuredClone(snap));
        step(s, 'Ledger', 'Mongo', 'abortTransaction()', 'call');
      }
      return false;
    }
    if (s.config.acid) step(s, 'Ledger', 'Mongo', 'commitTransaction()', 'call');
    return true;
  } catch (e) {
    if (!(e instanceof Crash)) throw e;
    step(s, 'Mongo', 'Ledger', `💥 ${e.message}`, 'error');
    if (s.config.acid) {
      Object.assign(s, structuredClone(snap));
      note(s, 'Mongo', 'session aborted — all writes rolled back');
      log(s, 'warn', `Injected crash (${e.message}); transaction rolled back`);
    } else {
      note(s, 'Mongo', 'no session — partial writes persisted!');
      log(s, 'error', `Injected crash (${e.message}); PARTIAL WRITE persisted`);
    }
    return 'crash';
  }
}

function maybeCrash(s, at) {
  if (s.fault === at) {
    s.fault = 'none';
    throw new Crash(`process crashed ${at === 'afterDebit' ? 'after debit' : 'after credit'}`);
  }
}

/* ─── queries ─── */
export function mapBalanceInformation(portfolio, config) {
  if (config.guardClause) {
    const { balances } = portfolio; // GUARD: stashBalances is deliberately ignored
    return Object.fromEntries(Object.entries(balances).map(([c, b]) => [c, b.total]));
  }
  const out = {};
  for (const bucket of Object.values(portfolio)) {
    if (!bucket || typeof bucket !== 'object') continue;
    for (const [c, b] of Object.entries(bucket)) out[c] = r8((out[c] || 0) + b.total);
  }
  return out;
}

export function isBonusLocked(s, currency) {
  if (s.config.bonusScope === 'user') return Object.values(s.bonuses).some(Boolean);
  return Boolean(s.bonuses[currency]);
}

function validAmount(s, amount) {
  if (!(amount > 0) || !Number.isFinite(amount)) {
    fail(s, 'Amount must be a positive number');
    return false;
  }
  return true;
}

function stashAvailable(s, currency) {
  if (CUR[currency].kind === 'fiat' && !s.config.fiatStash) {
    fail(s, `Stash is not available for fiat (${CUR[currency].label}) — deferred`);
    return false;
  }
  return true;
}

/* ─── player operations ─── */
export function deposit(state, { currency, amount }) {
  const s = begin(state, `deposit ${fmtAmt(currency, amount)}`);
  if (!validAmount(s, amount)) return s;
  step(s, 'User', 'Ledger', `deposit(${amount}, ${currency})`);
  findOneAndUpdate(s, { userId: s.user.userId }, buildIncrementBalanceQuery(currency, amount, 'MAIN'));
  insertTx(s, { type: 'DEPOSIT', currency, balanceType: 'MAIN', amount });
  s.external[currency] = r8(s.external[currency] + amount);
  return succeed(s, 'Deposited to MAIN');
}

export function grantLockedBonus(state, { currency, amount, wagerMultiplier = 5 }) {
  const s = begin(state, `grant locked bonus ${fmtAmt(currency, amount)}`);
  if (!validAmount(s, amount)) return s;
  step(s, 'Admin', 'Bonus', `grantBonus(${amount} ${currency}, ${wagerMultiplier}x wagering)`);
  if (s.bonuses[currency]) return fail(s, 'A locked bonus is already active on this balance', 'Bonus', 'Admin');
  step(s, 'Bonus', 'Ledger', 'credit bonus funds');
  findOneAndUpdate(s, { userId: s.user.userId }, buildIncrementBalanceQuery(currency, amount, 'MAIN', 'bonus'));
  insertTx(s, { type: 'BONUS_CREDIT', currency, balanceType: 'MAIN', amount, meta: { wagerRequirement: amount * wagerMultiplier } });
  s.bonuses[currency] = { amount, wagerRequirement: r8(amount * wagerMultiplier), wagered: 0 };
  s.external[currency] = r8(s.external[currency] + amount);
  return succeed(s, 'Locked bonus active', 'Admin');
}

export function bet(state, { currency, amount, outcome }) {
  const s = begin(state, `bet ${fmtAmt(currency, amount)}`);
  if (!validAmount(s, amount)) return s;
  step(s, 'Game', 'Ledger', `getWagerableBalance(${currency})`);
  const wagerable = mapBalanceInformation(s.portfolio, s.config)[currency] || 0;
  note(s, 'Ledger', s.config.guardClause ? 'GUARD: only `balances` read' : 'aggregating ALL buckets (incl. stash)');
  step(s, 'Ledger', 'Game', `wagerable = ${wagerable}`, 'return');
  if (amount > wagerable) return fail(s, `Insufficient wagerable balance (${wagerable})`, 'Game', 'User');

  const main = s.portfolio.balances[currency];
  const fromOriginal = Math.min(Math.max(main.original, 0), amount);
  const fromBonus = Math.min(main.bonus, amount - fromOriginal);
  const shortfall = r8(amount - fromOriginal - fromBonus); // non-zero only when stash leaked into wagerable
  findOneAndUpdate(s, { userId: s.user.userId }, {
    $inc: {
      [`balances.${currency}.total`]: -amount,
      [`balances.${currency}.original`]: -(fromOriginal + shortfall),
      [`balances.${currency}.bonus`]: -fromBonus,
    },
  }, 'Game');
  if (shortfall > 0) note(s, 'Mongo', `⚠ MAIN driven negative by ${shortfall}: stash counted as wagerable`);
  insertTx(s, { type: 'BET', currency, balanceType: 'MAIN', amount: -amount }, 'Game');
  s.external[currency] = r8(s.external[currency] - amount);

  const bonus = s.bonuses[currency];
  if (bonus) {
    bonus.wagered = r8(bonus.wagered + amount);
    step(s, 'Ledger', 'Bonus', `wagering progress ${bonus.wagered}/${bonus.wagerRequirement}`);
  }

  const won = outcome ?? Math.random() < 0.48;
  if (won) {
    const payout = amount * 2;
    const bonusShare = bonus ? fromBonus * 2 : 0;
    findOneAndUpdate(s, { userId: s.user.userId }, {
      $inc: {
        [`balances.${currency}.total`]: payout,
        [`balances.${currency}.original`]: payout - bonusShare,
        [`balances.${currency}.bonus`]: bonusShare,
      },
    }, 'Game');
    insertTx(s, { type: 'WIN', currency, balanceType: 'MAIN', amount: payout }, 'Game');
    s.external[currency] = r8(s.external[currency] + payout);
  }

  settleBonus(s, currency);
  s.lastOp.message = won ? 'Won' : 'Lost';
  succeed(s, won ? `Won ${amount * 2}` : 'Lost', 'User', 'Game');
  checkAndTriggerAutoReload(s, currency, 'bet');
  return s;
}

function settleBonus(s, currency) {
  const bonus = s.bonuses[currency];
  if (!bonus) return;
  const main = s.portfolio.balances[currency];
  if (bonus.wagered >= bonus.wagerRequirement) {
    const release = main.bonus;
    findOneAndUpdate(s, { userId: s.user.userId }, { $inc: { [`balances.${currency}.bonus`]: -release, [`balances.${currency}.original`]: release } }, 'Bonus');
    insertTx(s, { type: 'BONUS_RELEASE', currency, balanceType: 'MAIN', amount: 0, meta: { converted: release } }, 'Bonus');
    s.bonuses[currency] = null;
    log(s, 'ok', `Locked bonus on ${CUR[currency].label} completed — ${release} converted to real funds`);
  } else if (main.bonus <= 0) {
    s.bonuses[currency] = null;
    note(s, 'Bonus', 'bonus funds exhausted — lock released');
    log(s, 'info', `Locked bonus on ${CUR[currency].label} busted`);
  }
}

export function withdraw(state, { currency, amount }) {
  const s = begin(state, `withdraw ${fmtAmt(currency, amount)}`);
  if (!validAmount(s, amount)) return s;
  step(s, 'User', 'Ledger', `withdraw(${amount}, ${currency})`);
  if (!debit(s, currency, amount, 'MAIN')) return fail(s, 'Insufficient withdrawable MAIN balance');
  insertTx(s, { type: 'WITHDRAWAL', currency, balanceType: 'MAIN', amount: -amount });
  s.external[currency] = r8(s.external[currency] - amount);
  succeed(s, 'Withdrawal sent');
  if (s.config.autoReloadOnWithdraw) checkAndTriggerAutoReload(s, currency, 'withdraw');
  else note(s, 'Ledger', 'auto-reload not evaluated on withdrawals');
  return s;
}

/* ─── stash transfers ─── */
function moveToStash(s, currency, amount, label) {
  return withSession(s, label, () => {
    if (!debit(s, currency, amount, 'MAIN')) return false;
    maybeCrash(s, 'afterDebit');
    findOneAndUpdate(s, { userId: s.user.userId }, buildIncrementBalanceQuery(currency, amount, 'STASH'));
    maybeCrash(s, 'afterCredit');
    recordTransfer(s, 'STASH_IN', currency, amount);
    return true;
  });
}

function bonusCheck(s, currency) {
  step(s, 'Ledger', 'Bonus', s.config.bonusScope === 'user' ? 'checkIfBonusActive(userId)' : `checkIfBonusActive(userId, ${currency})`);
  const locked = isBonusLocked(s, currency);
  step(s, 'Bonus', 'Ledger', `isActive: ${locked}`, 'return');
  return locked;
}

export function transferToStash(state, { currency, amount }) {
  const s = begin(state, `transferToStash ${fmtAmt(currency, amount)}`);
  if (!validAmount(s, amount) || !stashAvailable(s, currency)) return s;
  step(s, 'User', 'Ledger', `transferToStash(${amount}, ${currency})`);
  if (bonusCheck(s, currency)) return fail(s, 'Blocked: Locked Bonus active');
  const res = moveToStash(s, currency, amount, 'MAIN → STASH');
  if (res === false) return fail(s, 'Insufficient MAIN balance (overdraft protection)');
  if (res === 'crash') return fail(s, 'Transfer failed — process crashed');
  return succeed(s, 'Moved to Stash');
}

/** Two identical requests hitting two pods at once (double-click / retry). */
export function raceTransferToStash(state, { currency, amount }) {
  const s = begin(state, `double-submit transferToStash 2× ${fmtAmt(currency, amount)}`);
  if (!validAmount(s, amount) || !stashAvailable(s, currency)) return s;
  step(s, 'User', 'Ledger', `2× transferToStash(${amount}) in parallel`);
  if (bonusCheck(s, currency)) return fail(s, 'Blocked: Locked Bonus active');

  if (s.config.overdraft === 'atomic') {
    const results = ['A', 'B'].map((r) => moveToStash(s, currency, amount, `request ${r}`));
    const okCount = results.filter((x) => x === true).length;
    if (okCount < 2) note(s, 'Mongo', `request B rejected by $gte filter`);
    return succeed(s, `${okCount}/2 requests applied`);
  }
  // read-then-write: both requests read before either writes
  const path = `balances.${currency}.original`;
  const seen = readPath(s.portfolio, path);
  step(s, 'Ledger', 'Mongo', `A: read ${path}`, 'call');
  step(s, 'Ledger', 'Mongo', `B: read ${path}`, 'call');
  step(s, 'Mongo', 'Ledger', `both see ${seen}`, 'return');
  if (seen < amount) return fail(s, 'Both rejected: insufficient balance');
  note(s, 'Ledger', `A & B: ${seen} ≥ ${amount} ✓ (stale check)`);
  for (const r of ['A', 'B']) {
    withSession(s, `request ${r}`, () => {
      findOneAndUpdate(s, { userId: s.user.userId }, buildIncrementBalanceQuery(currency, -amount, 'MAIN'));
      findOneAndUpdate(s, { userId: s.user.userId }, buildIncrementBalanceQuery(currency, amount, 'STASH'));
      recordTransfer(s, 'STASH_IN', currency, amount);
      return true;
    });
  }
  if (s.portfolio.balances[currency].original < 0) note(s, 'Mongo', '⚠ MAIN is now negative');
  return succeed(s, '2/2 requests applied');
}

function moveFromStash(s, currency, amount, label, meta) {
  return withSession(s, label, () => {
    if (!debit(s, currency, amount, 'STASH')) return false;
    maybeCrash(s, 'afterDebit');
    findOneAndUpdate(s, { userId: s.user.userId }, buildIncrementBalanceQuery(currency, amount, 'MAIN'));
    maybeCrash(s, 'afterCredit');
    recordTransfer(s, 'STASH_OUT', currency, amount, meta);
    return true;
  });
}

function check2fa(s, token, purpose) {
  step(s, 'Ledger', 'Auth', `check2faIfEnabled(user, ${token ? `"${token}"` : 'no token'})`);
  if (!s.user.twoFactorEnabled) {
    if (s.config.twoFaPolicy === 'MANDATORY') {
      step(s, 'Auth', 'Ledger', '2FA not enabled', 'return');
      return { ok: false, error: `2FA must be enabled to ${purpose}` };
    }
    step(s, 'Auth', 'Ledger', '2FA disabled → allow + warn', 'return');
    return { ok: true, warning: 'Enable 2FA to protect future Stash transfers.' };
  }
  if (token !== totp(s.clock)) {
    step(s, 'Auth', 'Ledger', 'invalid token', 'return');
    return { ok: false, error: 'Invalid 2FA token' };
  }
  step(s, 'Auth', 'Ledger', 'valid', 'return');
  return { ok: true };
}

export function transferFromStash(state, { currency, amount, token }) {
  const s = begin(state, `transferFromStash ${fmtAmt(currency, amount)}`);
  if (!validAmount(s, amount) || !stashAvailable(s, currency)) return s;
  step(s, 'User', 'Ledger', `transferFromStash(${amount}, ${currency}, token)`);
  const auth = check2fa(s, token, 'move funds out of Stash');
  if (!auth.ok) return fail(s, auth.error);
  if (auth.warning) s.lastOp.warning = auth.warning;
  const res = moveFromStash(s, currency, amount, 'STASH → MAIN', { source: 'user' });
  if (res === false) return fail(s, 'Insufficient Stash balance');
  if (res === 'crash') return fail(s, 'Transfer failed — process crashed');
  return succeed(s, auth.warning ? 'Moved to Main (warning: 2FA off)' : 'Moved to Main');
}

/* ─── auto-reload ─── */
export function updateAutoReload(state, { enabled, threshold, target, currency, token }) {
  const s = begin(state, `update auto-reload settings`);
  step(s, 'User', 'Ledger', `updateSettings(enabled=${enabled}, ${threshold}→${target} ${currency})`);
  if (!(target > threshold) || !(threshold >= 0)) return fail(s, 'Target must be greater than threshold');
  if (!stashAvailable(s, currency)) return s;
  const turningOn = enabled && !s.settings.stashAutoReloadEnabled;
  const widening = enabled && (target > s.settings.stashAutoReloadTargetAmount || threshold > s.settings.stashAutoReloadThreshold);
  if (s.config.autoReloadEnable2fa && (turningOn || widening)) {
    const auth = check2fa(s, token, 'enable auto-reload');
    if (!auth.ok) return fail(s, `${auth.error} — auto-reload moves Stash funds without a token later`);
  }
  s.settings = { stashAutoReloadEnabled: enabled, stashAutoReloadThreshold: threshold, stashAutoReloadTargetAmount: target, stashAutoReloadCurrency: currency };
  step(s, 'Ledger', 'Mongo', 'update user settings', 'call', s.settings);
  return succeed(s, enabled ? 'Auto-reload enabled' : 'Auto-reload disabled');
}

function checkAndTriggerAutoReload(s, currency, trigger) {
  const st = s.settings;
  const main = s.portfolio.balances[currency].total;
  step(s, 'Ledger', 'Reload', `checkAndTriggerAutoReload(${main})`);
  step(s, 'Reload', 'Mongo', 'getSettings(userId)');
  if (!st.stashAutoReloadEnabled || st.stashAutoReloadCurrency !== currency) {
    note(s, 'Reload', 'disabled → no action');
    return;
  }
  if (main >= st.stashAutoReloadThreshold) {
    note(s, 'Reload', `${main} ≥ threshold ${st.stashAutoReloadThreshold} → no action`);
    return;
  }
  const topUp = r8(st.stashAutoReloadTargetAmount - main);
  const available = s.portfolio.stashBalances[currency].original;
  if (available < topUp) {
    note(s, 'Reload', `stash ${available} < top-up ${topUp} → skipped`);
    log(s, 'warn', `autoReload skipped: not enough in Stash (${available} < ${topUp})`);
    return;
  }
  note(s, 'Reload', 'pre-authorized: 2FA bypassed');
  step(s, 'Reload', 'Ledger', `executeStashToMainTransfer(${topUp})`);
  const res = moveFromStash(s, currency, topUp, 'auto-reload', { source: 'autoReload', trigger });
  if (res === true) log(s, 'reload', `autoReload: +${fmtAmt(currency, topUp)} to MAIN (triggered by ${trigger})`);
}

/* ─── admin (ACP) ─── */
export function adminStash(state, { action, currency, amount, adminId, reason }) {
  const s = begin(state, `ACP stash ${action} ${action === 'reset' ? CUR[currency].label : fmtAmt(currency, amount)}`);
  step(s, 'Admin', 'Ledger', `POST /admin/stash/${action}`, 'call', { userId: s.user.userId, currency, amount, adminId, reason });
  if (!adminId?.trim()) return fail(s, 'adminId is required', 'Ledger', 'Admin');
  if (!ADMIN_REASONS.includes(reason)) return fail(s, 'reason must be one of the predefined list', 'Ledger', 'Admin');
  if (!stashAvailable(s, currency)) return s;
  const meta = { adminId, reason };

  if (action === 'add') {
    if (!validAmount(s, amount)) return s;
    findOneAndUpdate(s, { userId: s.user.userId }, buildIncrementBalanceQuery(currency, amount, 'STASH'));
    insertTx(s, { type: 'ADMIN_STASH_ADD', currency, balanceType: 'STASH', amount, meta });
    s.external[currency] = r8(s.external[currency] + amount);
  } else if (action === 'confiscate') {
    if (!validAmount(s, amount)) return s;
    if (!debit(s, currency, amount, 'STASH')) return fail(s, 'Cannot confiscate more than the Stash balance', 'Ledger', 'Admin');
    insertTx(s, { type: 'ADMIN_STASH_CONFISCATE', currency, balanceType: 'STASH', amount: -amount, meta });
    s.external[currency] = r8(s.external[currency] - amount);
  } else if (action === 'reset') {
    const prev = s.portfolio.stashBalances[currency].total;
    findOneAndUpdate(s, { userId: s.user.userId }, { $set: { [`stashBalances.${currency}.total`]: 0, [`stashBalances.${currency}.original`]: 0, [`stashBalances.${currency}.bonus`]: 0 } });
    insertTx(s, { type: 'ADMIN_STASH_RESET', currency, balanceType: 'STASH', amount: -prev, meta: { ...meta, previousTotal: prev } });
    s.external[currency] = r8(s.external[currency] - prev);
  } else {
    return fail(s, `unknown action ${action}`, 'Ledger', 'Admin');
  }
  return succeed(s, 'Adjustment recorded in audit log', 'Admin');
}

/* ─── misc state setters ─── */
export const setConfig = (state, config) => ({ ...state, config: { ...config } });
export const setFault = (state, fault) => ({ ...state, fault });
export const setTwoFactor = (state, on) => ({ ...state, user: { ...state.user, twoFactorEnabled: on } });
export const tick = (state, ms = 1000) => ({ ...state, clock: state.clock + ms });

/* ─── invariants ─── */
export function invariants(s) {
  const out = [];
  const wagerable = mapBalanceInformation(s.portfolio, s.config);
  for (const { code, label } of CURRENCIES) {
    const main = s.portfolio.balances[code];
    const stash = s.portfolio.stashBalances[code];
    const sum = (bucket) => r8(s.transactions.filter((t) => t.currency === code && t.balanceType === bucket).reduce((a, t) => a + t.amount, 0));
    const ledgerMain = sum('MAIN');
    const ledgerStash = sum('STASH');
    out.push(
      { id: `conserve-${code}`, group: 'Conservation', cur: label, ok: Math.abs(r8(main.total + stash.total) - s.external[code]) < 1e-8, detail: `main+stash ${r8(main.total + stash.total)} vs net external ${s.external[code]}` },
      { id: `neg-${code}`, group: 'No negative balances', cur: label, ok: main.total >= 0 && stash.total >= 0 && main.original >= 0, detail: `main ${main.total}, stash ${stash.total}` },
      { id: `recon-main-${code}`, group: 'Ledger ↔ MAIN', cur: label, ok: Math.abs(ledgerMain - main.total) < 1e-8, detail: `Σ MAIN txs ${ledgerMain} vs doc ${main.total}` },
      { id: `recon-stash-${code}`, group: 'Ledger ↔ STASH', cur: label, ok: Math.abs(ledgerStash - stash.total) < 1e-8, detail: `Σ STASH txs ${ledgerStash} vs doc ${stash.total}` },
      { id: `wager-${code}`, group: 'Wagerable excludes Stash', cur: label, ok: Math.abs((wagerable[code] || 0) - main.total) < 1e-8, detail: `wagerable ${wagerable[code] || 0} vs main ${main.total}` },
      { id: `stats-${code}`, group: 'Stats snapshot = MAIN', cur: label, ok: Math.abs(s.stats[code].mainSnapshot - main.total) < 1e-8, detail: `stats ${s.stats[code].mainSnapshot} vs main ${main.total}` },
      { id: `stashbonus-${code}`, group: 'Stash holds no bonus funds', cur: label, ok: stash.bonus === 0, detail: `stash.bonus ${stash.bonus}` },
    );
  }
  return out;
}
