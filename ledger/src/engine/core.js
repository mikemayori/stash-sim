/*
 * Core of the ledger engine: constants, evidence register, knobs, presets, state and trace helpers.
 *
 * The engine models the ledger as described in current-ledger-analysis.md (backend commit
 * d4cfca3613b431abe952a20775f2ddec69641329). Every behaviour carries an evidence label:
 * Code / Meeting / Study / Inferred / Open / Assumed / Proposed.
 */
import Decimal from 'decimal.js';

/* ─── balance types and stores (L-01, L-03, L-04) ─── */
const legacy = (code, label, field, bonusField, stashField) => ({ code, label, store: 'rethink', field, bonusField, stashField });
export const ALL_BALANCE_TYPES = [
  ...['usdt', 'usdc', 'xrp', 'doge', 'trx', 'sol', 'bnb', 'sui'].map((code) => ({ code, label: code.toUpperCase(), store: 'portfolio' })),
  // The stash field names are placeholders from the Stash plan (stash-ledger-path.md 5.13 #9).
  legacy('crypto', 'BTC', 'balance', 'btcBonusBalance', 'btcStashBalance'),
  legacy('eth', 'ETH', 'ethBalance', 'ethBonusBalance', 'ethStashBalance'),
  legacy('ltc', 'LTC', 'ltcBalance', 'ltcBonusBalance', 'ltcStashBalance'),
  legacy('cash', 'Cash', 'cashBalance', 'cashBonusBalance', 'cashStashBalance'),
];
export const BT = Object.fromEntries(ALL_BALANCE_TYPES.map((b) => [b.code, b]));
// The subset the UI shows.
export const BALANCE_TYPES = ['usdt', 'sol', 'crypto', 'eth', 'cash'].map((c) => BT[c]);

export const USER_ID = 'u_1001';
export const DAY = 86400000;
export const TX_TTL_DAYS = 180;
export const BONUS_DAYS = 7; // Assumed
export const BONUS_WAGER_MULTIPLIER = 5; // Assumed
export const PRECISION = 8; // Assumed: decimals kept by the "round before storing" fix
export const EPS = 1e-9;
export const RECENT_WINDOW_MS = 60000; // Assumed: the "createdAt >= recent" window of the ThrillTech check
export const STASH_KEYS_KEPT = 20; // Proposed parameter (stash-ledger-path.md 5.13 #8)
export const TWO_FA_WINDOW_MS = 120000;

/* ─── evidence register ─── */
export const LABELS = ['Code', 'Meeting', 'Study', 'Inferred', 'Open', 'Assumed', 'Proposed'];
const E = (label, text) => ({ label, text });
export const EVIDENCE = {
  'L-01': E('Code', 'Two stores: crypto (BTC), eth, ltc and cash on the RethinkDB users row; the other eight types in Mongo user_altcoin_portfolios.'),
  'L-03': E('Code', 'Legacy fields: balance, ethBalance, ltcBalance, cashBalance and btcBonusBalance, ethBonusBalance, ltcBonusBalance, cashBonusBalance.'),
  'L-04': E('Code', 'Portfolio shape: balances.<type>.balance, .bonusBalance, .originalBalance, .originalBonusBalance.'),
  'L-05': E('Meeting', 'One portfolio document per user, created on first use. Users with only legacy balances have none.'),
  'L-06': E('Code', 'Every balance is a USD amount stored as a float Number. The ledger does no rounding.'),
  'L-10': E('Meeting', 'ledger/lib/index.ts is the entry point for balance changes.'),
  'L-11': E('Meeting', 'lib/index.ts routes by balanceType to the portfolio service or the userObject service.'),
  'L-12': E('Meeting', 'lib/index.ts has admin replace user balance (ACP replace, reset, confiscate) and deductBalance (ACP adjust).'),
  'L-13': E('Meeting', 'Portfolio data layer: incrementPortfolioBalance and setPortfolioBalance.'),
  'L-14': E('Meeting', 'The userObject service is the legacy counterpart, in ReQL, with its own "update balance and create a transaction" function.'),
  'L-15': E('Meeting', 'queryBuilder.ts holds buildIncrementBalanceQuery, the update pipeline with the guard and the split.'),
  'L-16': E('Meeting', 'computeDebitAmountChanges runs after the update and subtracts original* from the returned document.'),
  'L-18': E('Meeting', 'Balances from both stores are merged when the user is loaded, so callers cannot tell where a balance lives.'),
  'L-19': E('Open', 'Whether the row is written in lib/index.ts or in each service layer is not known. The simulator writes it from the service layer.'),
  'L-20': E('Study', 'A deduction takes primary first, then bonus for the rest.'),
  'L-21': E('Study', 'If primary and bonus together are not enough, the deduction is refused, unless allowNegative is set.'),
  'L-22': E('Open', 'Refuse or clamp, and the pipeline’s logic for negative numbers, are not fully known.'),
  'L-23': E('Study', 'The split decision runs inside one atomic update.'),
  'L-24': E('Meeting', 'Mongo returns only the document after the update. The pipeline copies the starting values into original*.'),
  'L-25': E('Meeting', 'The scratch fields are in the schema and stay, stale, on every portfolio document.'),
  'L-27': E('Code', 'RethinkDB uses r.branch and returnChanges, which returns both images, so it needs no scratch fields.'),
  'L-28': E('Meeting', 'The RethinkDB and Mongo split logic differ slightly, not on purpose. The exact difference is open (owner: Alex).'),
  'L-29': E('Meeting', 'deductBalance applies −1 × |change|.'),
  'L-30': E('Open', 'Whether the credit path forces a positive sign is not known.'),
  'L-31': E('Study', 'Withdrawals take from primary only.'),
  'L-32': E('Study', 'Deposits and payouts credit primary. Bonus grants credit bonus.'),
  'L-33': E('Study', 'Bonus completion moves bonus to primary; expiry zeroes bonus; each in one update.'),
  'L-34': E('Meeting', 'ACP reset and confiscate overwrite through setPortfolioBalance (legacy equivalent on RethinkDB) and write a row.'),
  'L-35': E('Open', 'How a set computes the difference it records is not known.'),
  'L-36': E('Meeting', 'allowNegative is a flag on balance operations, used by the sportsbook.'),
  'L-37': E('Meeting', 'Deposits live in a deposits collection with a status. The credit happens only on completion; fraud or a block stops it first. The order of status, credit and row is open.'),
  'L-38': E('Meeting', 'Withdrawals debit at request time and can be credited back by a reversal, decline or cancel.'),
  'L-39': E('Open', 'Nothing known stops a withdrawal from being credited back twice.'),
  'L-40': E('Study', 'One row per bucket changed.'),
  'L-41': E('Study', 'Row fields: userId, type, balanceType (the bucket), amount (signed delta), currentBalance, meta.'),
  'L-42': E('Meeting', 'transactions has billions of rows. Schema and indexes are frozen; meta is the only extension point.'),
  'L-44': E('Study', 'Rows expire after 180 days.'),
  'L-45': E('Meeting', 'Soft aggregations read a secondary with up to about 500 ms of lag.'),
  'L-47': E('Code', 'Side effects on every insert: transactionCreated socket event, stats, lifetime stats, FastTrack real_money publish. A responsible-gaming listener is not confirmed.'),
  'L-48': E('Meeting', 'Every action is meant to have a transaction type, so the collection works as a best-effort action log.'),
  'L-50': E('Code', 'The balance update is atomic within one document or one row.'),
  'L-51': E('Code', 'The row insert is a separate write. No runtime code uses a Mongo session.'),
  'L-52': E('Code', 'On insert failure the error is logged and swallowed, the caller gets transactionId undefined, and the balance stays changed.'),
  'L-53': E('Meeting', 'No metric, alert or reconciliation job exists.'),
  'L-54': E('Meeting', 'Balances cannot be rebuilt from rows.'),
  'L-55': E('Study', 'Callers detect duplicate callbacks by looking for an existing row before calling the ledger.'),
  'L-56': E('Study', 'Refunds rebuild the original split from the bet’s rows.'),
  'L-57': E('Open', 'Whether the duplicate check and the refund lookup read the primary or a secondary is not known.'),
  'L-80': E('Code', 'A missing balanceType falls back to the selected balance; an empty identifier resolves to BTC (crypto).'),
  'L-81': E('Code', 'Two admin APIs, REST and GraphQL, with different side effects. overviewAdjustBalance also writes a user note and a Slack line.'),
  'L-82': E('Code', 'checkIfBonusActive expires an overdue bonus on read: zeroes bonus, writes a row, sends a socket event.'),
  'L-83': E('Code', 'cleanupOldUsers deletes accounts whose BTC, ETH and LTC balances are below 0.01 and that never deposited or bet.'),
  'L-84': E('Code', 'The Mongo guard is inside the pipeline. A refused deduction is a no-op detected by comparing original* with the new values, reported as bet__not_enough_balance.'),
  'L-85': E('Code', 'Bets read balance + bonusBalance through getBalanceFromUserAndType and carry bonusBetAmount.'),
  'L-86': E('Code', 'Withdrawals, tips and rain read primary only. Withdrawal requests use a per-user, non-blocking Redis mutex.'),
  'L-87': E('Code', 'ACP reset and confiscate act on primary only.'),
  'L-88': E('Meeting', 'Sportsbook rollbacks can leave a player negative; they keep playing and a deposit covers it.'),
  'L-89': E('Code', 'The index freeze on transactions is enforced: the migration job throws on any index diff.'),
  'L-90': E('Code', 'transactions has a compound index on { userId, type, createdAt }.'),
  'L-91': E('Code', 'A Mongoose post(\'init\') hook throws on an unknown stored balanceType.'),
  'L-92': E('Open', 'The warehouse (BigQuery) keeps rows older than 180 days. Completeness is unchecked.'),
  'L-94': E('Code', 'No idempotency-key pattern on player endpoints. ThrillTech detects repeats with { userId, type, createdAt >= recent }.'),
  'L-95': E('Meeting', 'Deposits and withdrawals keep only their current status.'),
  'L-96': E('Code', 'No durable audit for admin balance actions: audits.balanceChange is defined and never written; reason is free text and player-visible in meta.'),
  'L-97': E('Code', 'The RethinkDB path is not in the integration test harness.'),
  SIM: E('Assumed', 'Simulator-only: it does not exist in the backend.'),
  NAME: E('Assumed', 'The real name is not confirmed. See TX_TYPES.'),
  'A-layout': E('Inferred', 'The stage layout of the pipeline is reconstructed from its described behaviour, not copied from queryBuilder.ts.'),
  'A-bonus': E('Assumed', 'The wagering rules (5x within 7 days) are placeholders.'),
  'A-legacy-fn': E('Assumed', 'The names of the userObject functions are not confirmed.'),
  'P-hard': E('Proposed', 'Hardened (feasible): a fix that works inside the real constraints. Not in the backend.'),
  'P-stash': E('Proposed', 'Dedicated Stash path from stash-ledger-path.md. Agreed in principle, not implemented.'),
  'P-2fa': E('Proposed', 'Stash-out checks from the Stash plan: 2FA single-use per user for 120 s (no wrong-code limiter today) and wagering read from the primary.'),
};

/* ─── transaction type names: the one place to replace an unconfirmed name ─── */
const N = (name, label) => ({ name, label });
export const TX_TYPES = {
  bet: N('bet', 'Study'),
  payout: N('payout', 'Study'),
  deposit: N('deposit', 'Study'),
  withdrawal: N('withdrawal', 'Study'),
  refund: N('refund', 'Assumed'),
  bonusGrant: N('bonus', 'Assumed'),
  bonusCompleted: N('bonusCompleted', 'Assumed'),
  bonusExpired: N('bonusExpired', 'Assumed'),
  withdrawalReversal: N('withdrawalReversal', 'Assumed'),
  withdrawalDecline: N('withdrawalDecline', 'Assumed'),
  withdrawalCancel: N('withdrawalCancel', 'Assumed'),
  acpReset: N('adminReset', 'Assumed'),
  acpConfiscate: N('adminConfiscate', 'Assumed'),
  acpReplace: N('adminReplace', 'Assumed'),
  acpAdjust: N('adminAdjust', 'Assumed'),
  sportsbookRollback: N('sportsbookRollback', 'Assumed'),
  tip: N('tip', 'Assumed'),
  stashIn: N('stashIn', 'Proposed'),
  stashOut: N('stashOut', 'Proposed'),
};
export const tx = (key) => TX_TYPES[key].name;

/* ─── sequence-diagram participants ─── */
export const PARTICIPANTS = ['Provider', 'Bet', 'Payments', 'Bonus', 'Sportsbook', 'ACP REST', 'ACP GraphQL', 'Player', 'Job', 'Ledger', 'Portfolio svc', 'userObject', 'Mongo primary', 'Mongo secondary', 'RethinkDB', 'Tx DAL', 'Side effects', 'Reconciler'];
export const PARTICIPANT_INFO = {
  Provider: 'An external game provider. It sends bet, win and refund callbacks, and may send the same one more than once.',
  Bet: 'The bet module. It turns provider callbacks into ledger calls, reads balance + bonusBalance and carries bonusBetAmount.',
  Payments: 'Deposits (a collection with a status, credited on completion) and withdrawals (debited at request, possibly credited back).',
  Bonus: 'The bonus module: grant, completion, expiry and checkIfBonusActive, which expires an overdue bonus on read.',
  Sportsbook: 'The sportsbook. The one caller known to pass allowNegative.',
  'ACP REST': 'The admin panel through the REST API. overviewAdjustBalance also writes a user note and a Slack line.',
  'ACP GraphQL': 'The admin panel through the GraphQL API. Same balance change, different side effects.',
  Player: 'A player endpoint: tips, and Stash transfers in the Stash preset.',
  Job: 'A background job: TTL, cleanupOldUsers, the measurement job, CSV export.',
  Ledger: 'ledger/lib/index.ts: the entry point. It routes by balanceType to the portfolio service or the userObject service.',
  'Portfolio svc': 'The portfolio service and data layer: incrementPortfolioBalance, setPortfolioBalance, buildIncrementBalanceQuery, computeDebitAmountChanges.',
  userObject: 'The legacy service for crypto, eth, ltc and cash, written in ReQL. Not in the integration test harness.',
  'Mongo primary': 'Mongo primary: user_altcoin_portfolios, transactions, deposits, withdrawals, audits.',
  'Mongo secondary': 'A Mongo secondary. Reads here can be up to about 500 ms behind the primary.',
  RethinkDB: 'RethinkDB: the users row that holds the four legacy balances.',
  'Tx DAL': 'The transaction data layer. It inserts rows in a separate write, after the balance has changed.',
  'Side effects': 'Listeners on every row insert: transactionCreated socket event, stats, lifetime stats, FastTrack CRM.',
  Reconciler: 'Hardened and Stash only: writes the rows of any pending entry left by a failed insert.',
};

/* ─── design knobs ─── */
// `label` is the evidence label of the Current-ledger default; `ref` points into EVIDENCE or the open questions (Qn in analysis §8).
const K = (group, label, evLabel, ref, options, only) => ({ group, label, evLabel, ref, options, only });
export const KNOBS = {
  update: K('Balance update', 'Balance increment', 'Code', 'L-23', { atomic: 'One atomic update per store', readThenWrite: 'Read, check in app, then write (study pseudocode)' }),
  shortfall: K('Balance update', 'Deduction larger than the balance', 'Code', 'L-84', { refuse: 'No-op, bet__not_enough_balance', clamp: 'Clamp at zero, take what is there' }),
  legacySplit: K('Balance update', 'ReQL split vs Mongo', 'Assumed', 'L-28', { sameAsMongo: 'Same as Mongo', noNegativeFloor: 'Hypothesis: no zero floor on a negative primary' }),
  creditSign: K('Balance update', 'Credit with a negative amount', 'Assumed', 'L-30', { asGiven: 'Passed through as given', forcePositive: 'Forced positive' }),
  negativeSpill: K('Balance update', 'allowNegative shortfall', 'Assumed', 'L-22', { bonusFirst: 'Primary, then bonus, then primary goes negative', primaryOnly: 'Primary goes negative, bonus untouched' }),
  math: K('Balance update', 'Arithmetic', 'Code', 'L-06', { float: 'Float, no rounding', round: `Round to ${PRECISION} decimals before storing` }),
  guardCompare: K('Balance update', 'Guard comparison', 'Assumed', 'L-06', { raw: 'Raw floats', epsilon: 'With a tolerance' }),
  dupCheck: K('Duplicates', 'Duplicate callbacks', 'Study', 'L-55', { none: 'No check', rows: 'Caller looks for an existing row', rowsRecent: 'Row check limited to a recent window (ThrillTech)', ledgerKey: 'Key inside the balance document' }),
  dupRead: K('Duplicates', 'Duplicate check reads', 'Assumed', 'L-57', { primary: 'Primary', secondary: 'Secondary (lagging)' }),
  lagMs: K('Duplicates', 'Secondary lag (ms)', 'Meeting', 'L-45', { 0: '0', 500: '500', 2000: '2000' }),
  refundSplit: K('Refunds', 'Refund split comes from', 'Study', 'L-56', { primary: 'Nowhere: whole amount to primary (pseudocode)', rows: 'The bet’s rows', bonusBetAmount: 'bonusBetAmount on the bet record', meta: 'Split stored in meta on the bet’s rows' }),
  refundRead: K('Refunds', 'Refund lookup reads', 'Assumed', 'L-57', { primary: 'Primary', secondary: 'Secondary (lagging)' }),
  bonusBetAmountPersisted: K('Refunds', 'bonusBetAmount persisted on the bet', 'Assumed', 'L-85', { no: 'No', yes: 'Yes' }),
  rowFailure: K('Rows', 'Failed row insert', 'Code', 'L-52', { swallow: 'Logged and swallowed', alert: 'Alert with full detail', pending: 'Pending entry in the balance document + alert' }),
  sideEffectsOnFail: K('Rows', 'Side effects when the insert fails', 'Inferred', 'L-47', { skipped: 'Skipped (they hang off the insert)', run: 'Still run' }),
  rgListener: K('Rows', 'Responsible-gaming listener', 'Open', 'L-47', { off: 'Off', on: 'On' }),
  warehouse: K('Rows', 'Warehouse copy (BigQuery)', 'Assumed', 'L-92', { complete: 'Complete', gaps: 'Has gaps' }),
  setDiff: K('Admin', 'Admin set records the difference from', 'Assumed', 'L-35', { priorRead: 'A read before the set', returned: 'The same update that sets it' }),
  positiveAdjust: K('Admin', 'Positive ACP adjust', 'Assumed', 'L-12', { creditPath: 'Through the credit path', forcedNegative: 'Through deductBalance, sign forced negative' }),
  adminAudit: K('Admin', 'Admin audit record', 'Code', 'L-96', { none: 'None (audits.balanceChange never written)', write: 'Write audits.balanceChange' }),
  missingBalanceType: K('Admin', 'Missing balanceType', 'Code', 'L-80', { fallback: 'Fall back to selected balance / BTC', reject: 'Reject at lib/index.ts' }),
  depositOrder: K('Payments', 'Deposit completion order', 'Assumed', 'L-37', { creditFirst: 'Credit, row, then status', statusFirst: 'Status, then credit and row' }),
  depositTransition: K('Payments', 'Deposit status update', 'Assumed', 'L-37', { unconditional: 'Plain update', conditional: 'Conditional pending → completed' }),
  reversalGuard: K('Payments', 'Withdrawal credit-back guard', 'Assumed', 'L-39', { none: 'None', transition: 'Status transition in the same update' }),
  // Stash (all Proposed; policies Open)
  stash: K('Stash', 'Stash path', 'Proposed', 'P-stash', { off: 'Off', on: 'On' }, 'stash'),
  stashValidator: K('Stash', 'post(\'init\') validator knows <type>Stash', 'Proposed', 'L-91', { deployed: 'Deployed first', notDeployed: 'Not deployed' }, 'stash'),
  stashRowFailure: K('Stash', 'Stash row-write failure', 'Proposed', 'P-stash', { alert: 'Alert (minimum)', pending: 'Pending entry (better)' }, 'stash'),
  stashReads: K('Stash', 'totalBalance and the flag', 'Proposed', 'P-stash', { flagIndependent: 'Reads ignore the flag', flagGated: 'Reads hide stash when the flag is off' }, 'stash'),
  resetIncludesStash: K('Stash', 'ACP reset clears stash', 'Open', 'P-stash', { no: 'No', yes: 'Yes' }, 'stash'),
  confiscateIncludesStash: K('Stash', 'ACP confiscate includes stash', 'Open', 'P-stash', { no: 'No', yes: 'Yes' }, 'stash'),
  stashOutNegative: K('Stash', 'Stash-out with a negative primary', 'Open', 'P-stash', { addToBalance: 'Any amount, added to primary', mustCoverDebt: 'Refused unless it covers the debt' }, 'stash'),
  stashCoversDebt: K('Stash', 'Stash covers sportsbook debt', 'Open', 'P-stash', { no: 'No', autoSweep: 'Swept automatically after a rollback' }, 'stash'),
  stashListeners: K('Stash', 'Listeners on stash rows', 'Open', 'P-stash', { skipFastTrack: 'Socket only; stats and FastTrack skipped', all: 'All listeners run' }, 'stash'),
};

const CURRENT = {
  update: 'atomic', shortfall: 'refuse', legacySplit: 'sameAsMongo', creditSign: 'asGiven', negativeSpill: 'bonusFirst', math: 'float', guardCompare: 'raw',
  dupCheck: 'rows', dupRead: 'primary', lagMs: 500, refundSplit: 'rows', refundRead: 'primary', bonusBetAmountPersisted: 'no',
  rowFailure: 'swallow', sideEffectsOnFail: 'skipped', rgListener: 'off', warehouse: 'complete',
  setDiff: 'priorRead', positiveAdjust: 'creditPath', adminAudit: 'none', missingBalanceType: 'fallback',
  depositOrder: 'creditFirst', depositTransition: 'unconditional', reversalGuard: 'none',
  stash: 'off', stashValidator: 'deployed', stashRowFailure: 'alert', stashReads: 'flagIndependent', resetIncludesStash: 'no', confiscateIncludesStash: 'no', stashOutNegative: 'addToBalance', stashCoversDebt: 'no', stashListeners: 'skipFastTrack',
};
export const PRESETS = {
  current: {
    label: 'Current ledger',
    blurb: 'Today’s ledger as current-ledger-analysis.md describes it. Every Open question sits at its most likely value, labelled Assumed.',
    config: CURRENT,
  },
  pseudocode: {
    label: 'Pseudocode',
    blurb: 'The study’s read-then-write pseudocode, unchanged: no duplicate check, refunds go to primary. It shows why the atomic update matters.',
    config: { ...CURRENT, update: 'readThenWrite', dupCheck: 'none', refundSplit: 'primary' },
  },
  hardened: {
    label: 'Hardened (feasible)',
    blurb: 'Only fixes that work inside the real constraints: key and pending entry in the balance document, rounding, split in meta, primary reads, reversal guard, alert, audit record, required balanceType. No unique index, no sessions, no new fields on transactions.',
    config: { ...CURRENT, dupCheck: 'ledgerKey', rowFailure: 'pending', math: 'round', refundSplit: 'meta', setDiff: 'returned', reversalGuard: 'transition', adminAudit: 'write', missingBalanceType: 'reject' },
  },
  stash: {
    label: 'Current + Stash (proposed)',
    blurb: 'The current ledger plus the dedicated Stash path from stash-ledger-path.md. Everything about Stash is a proposal.',
    config: { ...CURRENT, stash: 'on' },
  },
};
export const PRESET_ALIASES = { deployed: 'current' };

/* ─── helpers ─── */
export const dAdd = (a, b) => new Decimal(a).plus(b).toNumber();
export const dSub = (a, b) => new Decimal(a).minus(b).toNumber();
export const dMul = (a, b) => new Decimal(a).times(b).toNumber();
export const round = (x) => Number(x.toFixed(PRECISION));
export const near = (a, b) => Math.abs(a - b) < EPS;

export const getPath = (doc, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc);
export function setPath(doc, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  let o = doc;
  for (const k of keys) o = o[k] ??= {};
  o[last] = value;
}

/** Where a balance type's amounts live. Only the portfolio has the original* scratch fields. */
export function pathsOf(bt) {
  const b = BT[bt];
  if (b.store === 'portfolio') {
    const base = `balances.${bt}`;
    return { store: 'portfolio', collection: 'user_altcoin_portfolios', primary: `${base}.balance`, bonus: `${base}.bonusBalance`, stash: `${base}.stashBalance`, origPrimary: `${base}.originalBalance`, origBonus: `${base}.originalBonusBalance` };
  }
  return { store: 'rethink', collection: 'users', primary: b.field, bonus: b.bonusField, stash: b.stashField };
}
export const docOf = (s, bt) => (BT[bt].store === 'portfolio' ? s.mongo.portfolio : s.rethink.user);
export function readBalance(s, bt, bucket = 'primary') {
  const doc = docOf(s, bt);
  return (doc && getPath(doc, pathsOf(bt)[bucket])) ?? 0;
}
export const bucketName = (bt, bucket) => (bucket === 'primary' ? bt : `${bt}${bucket === 'bonus' ? 'Bonus' : 'Stash'}`);
export const svcOf = (bt) => (BT[bt].store === 'portfolio' ? 'Portfolio svc' : 'userObject');
export const dbOf = (bt) => (BT[bt].store === 'portfolio' ? 'Mongo primary' : 'RethinkDB');
export const fmtAmt = (bt, n) => `${Number(Number(n).toFixed(4))} ${BT[bt].label}`;

/** The merged balance view built when the user is loaded (L-18): one numeric key per bucket. */
export function userBalances(s) {
  const out = {};
  const stashVisible = s.config.stash === 'on' && (s.config.stashReads === 'flagIndependent' || s.stashFlag);
  for (const { code } of ALL_BALANCE_TYPES) {
    out[code] = readBalance(s, code);
    out[`${code}Bonus`] = readBalance(s, code, 'bonus');
    if (stashVisible && readBalance(s, code, 'stash') !== 0) out[`${code}Stash`] = readBalance(s, code, 'stash');
  }
  return out;
}
/** totalBalance sums every numeric key of the merged view. */
export const totalBalance = (s) => Object.values(userBalances(s)).reduce((sum, n) => dAdd(sum, n), 0);

export function createState(config = PRESETS.current.config) {
  return {
    clock: 0,
    seq: 0,
    config: { ...CURRENT, ...config },
    gapMs: null, // one-shot: how long after the previous action the next one arrives (default 1000 ms)
    faults: { failInserts: 0, failStatusUpdate: 0 },
    rethink: {
      user: { id: USER_ID, name: 'player_one', balance: 0, btcBonusBalance: 0, ethBalance: 0, ethBonusBalance: 0, ltcBalance: 0, ltcBonusBalance: 0, cashBalance: 0, cashBonusBalance: 0, selectedBalanceType: 'usdt', hasDeposited: false, hasBet: false },
    },
    mongo: { portfolio: null, transactions: [], deposits: [], withdrawals: [], bets: [], audits: [] },
    warehouse: [],
    expiredSums: {}, // per bucket: total of the rows the TTL has removed (simulator bookkeeping)
    sideEffects: { socket: 0, stats: 0, lifetimeStats: 0, fastTrack: 0, lastFastTrack: null, rg: 0, userNotes: [], slack: [], alerts: [] },
    bonuses: {},
    twoFA: { used: {} },
    mutex: {},
    stashFlag: true,
    // Ground truth for the invariants: what each bucket should hold if every operation applied exactly once.
    truth: { expected: {}, applied: {}, negativeAllowed: {}, betSplit: {}, refundMismatch: [], creditBacks: {}, adminMismatch: [], stashPairs: [] },
    lastCallback: null,
    lastUpdate: null,
    events: [],
    trace: [],
    lastOp: null,
  };
}

/* ─── trace ─── */
/** Adds a sequence-diagram step. `o`: { kind, detail, why, ev } where `ev` is an EVIDENCE id. */
export function step(s, from, to, label, o = {}) {
  const entry = { from, to, label, kind: o.kind || 'call', detail: o.detail, why: o.why, ev: o.ev };
  s.trace.push(entry);
  return entry;
}
export const note = (s, at, label, o = {}) => step(s, at, at, label, { ...o, kind: 'note' });
export function log(s, level, msg) {
  s.events.unshift({ t: s.clock, level, msg });
  s.events.length = Math.min(s.events.length, 300);
}
export const nextId = (s, prefix) => `${prefix}_${(s.seq += 1)}`;
export function oid(s) {
  s.seq += 1;
  return '66f8' + s.seq.toString(16).padStart(20, '0');
}
