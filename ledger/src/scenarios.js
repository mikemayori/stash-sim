import {
  PRESETS, createState, readBalance, totalBalance, invariants, parityReport, tx,
  deposit, depositCreate, depositBlock, depositComplete, concurrentDepositCallbacks,
  withdrawRequest, withdrawOutcome, concurrentWithdrawRequests,
  placeBet, refundBet, concurrentBets, replayLast,
  grantBonus, completeBonus, readBonusState, sportsbookRollback,
  acpAction, acpResetDuringBet, deductWithoutBalanceType, adminRecords, acpExportCsv,
  runReconciler, advanceDays, cleanupOldUsers, measurementJob, setFault, setGap,
  stashIn, stashOut, concurrentStashIn, setStashFlag,
  M_PRESETS, createMigration, mSeed, mWrite, mBeginWrite, mFinishWrite, mDeliver, mBackfillRead, mBackfillWrite, mRepair, mFlip, mSetFault, mCompare,
} from './engine.js';

/*
 * Every scenario stores the result the documents imply BEFORE it runs (`expect`, per preset):
 *   'correct'  the behaviour a correct ledger would show
 *   'error'    the documented error reproduces (shown as DEBT under Current, N/F under Hardened)
 * `run(config, bt)` returns { state, got: 'correct' | 'error' | 'other', notes }. `npm test` fails
 * only when `got` differs from `expect`.
 *
 *   study   the scenario's number in LEDGER_STUDY.md §7.3
 *   errors  the error-register numbers it reproduces
 *   pin     knobs fixed for this scenario (not applied to Hardened, which sets its own)
 *   pinAll  knobs fixed under every preset
 *   open    { knob }: the result depends on an Open knob; the scenario runs once per option and
 *           checks the documented result of each. Shown as OPEN.
 *   types   balance types to run on (default cash and usdt); ['both'] runs once across stores
 */

const chain = (s, ...ops) => ops.reduce((acc, [fn, args]) => fn(acc, args), s);
const P = (s, bt) => readBalance(s, bt);
const B = (s, bt) => readBalance(s, bt, 'bonus');
const S = (s, bt) => readBalance(s, bt, 'stash');
const is = (s, bt, primary, bonus) => P(s, bt) === primary && B(s, bt) === bonus;
const say = (s, bt) => `${bt}: primary ${P(s, bt)}, bonus ${B(s, bt)}`;
const holds = (s, group) => invariants(s).filter((i) => i.group === group).every((i) => i.ok);
const rows = (s, type) => s.mongo.transactions.filter((t) => t.type === type);
const rowList = (s, type) => rows(s, type).map((t) => `${t.balanceType} ${t.amount}`).sort().join(', ');
const lastBet = (s) => s.mongo.bets[0].betId;
const out = (state, correct, error, notes) => ({ state, got: correct ? 'correct' : error ? 'error' : 'other', notes });
/** Starts with `primary` and `bonus` on one balance type. The bonus does not expire during the scenario. */
function fund(config, bt, primary, bonus = 0) {
  let s = createState(config);
  if (primary) s = deposit(s, { balanceType: bt, amount: primary });
  if (bonus) s = grantBonus(s, { balanceType: bt, amount: bonus, days: 400 });
  return s;
}
const ALL = (v) => ({ current: v, pseudocode: v, hardened: v });
const DEBT = { current: 'error', pseudocode: 'error', hardened: 'correct' };

export const SCENARIOS = [
  {
    id: 'S01', study: 2, title: 'Bet using primary only: 100/0, bet 40 → 60/0, one row', shows: 'Baseline', expect: ALL('correct'),
    run(c, bt) {
      const s = placeBet(fund(c, bt, 100), { balanceType: bt, amount: 40 });
      const r = rows(s, tx('bet'));
      return out(s, is(s, bt, 60, 0) && r.length === 1 && r[0].amount === -40 && r[0].currentBalance === 60 && r[0].balanceType === bt, false, [say(s, bt), `bet rows: ${rowList(s, tx('bet'))}`]);
    },
  },
  {
    id: 'S02', study: 4, title: 'Split bet: 30 against 10 primary and 50 bonus → 0/30, two rows', shows: 'Split, one row per bucket (L-20, L-40)', expect: ALL('correct'),
    run(c, bt) {
      const s = placeBet(fund(c, bt, 10, 50), { balanceType: bt, amount: 30 });
      return out(s, is(s, bt, 0, 30) && rowList(s, tx('bet')) === `${bt} -10, ${bt}Bonus -20`, false, [say(s, bt), `bet rows: ${rowList(s, tx('bet'))}`]);
    },
  },
  {
    id: 'S03', title: 'Bet using bonus only: 0/50, bet 20 → 0/30, one bonus row', shows: 'Split', expect: ALL('correct'),
    run(c, bt) {
      const s = placeBet(fund(c, bt, 0, 50), { balanceType: bt, amount: 20 });
      return out(s, is(s, bt, 0, 30) && rowList(s, tx('bet')) === `${bt}Bonus -20`, false, [say(s, bt), `bet rows: ${rowList(s, tx('bet'))}`]);
    },
  },
  {
    id: 'S04', title: 'Bet for exactly primary + bonus: 10/20, bet 30 → 0/0', shows: 'Edge at zero', expect: ALL('correct'),
    run(c, bt) {
      const s = placeBet(fund(c, bt, 10, 20), { balanceType: bt, amount: 30 });
      return out(s, s.lastOp.ok && is(s, bt, 0, 0), false, [say(s, bt)]);
    },
  },
  {
    id: 'S05', study: 3, title: 'Bet larger than primary + bonus: 10/20, bet 40 → no-op, bet__not_enough_balance', shows: 'Refuse, not clamp (L-84); original* left stale on Mongo (L-25)', expect: ALL('correct'),
    run(c, bt) {
      const s = placeBet(fund(c, bt, 10, 20), { balanceType: bt, amount: 40 });
      const scratch = s.mongo.portfolio?.balances[bt];
      const stale = bt !== 'usdt' || c.update !== 'atomic' || (scratch.originalBalance === 10 && scratch.originalBonusBalance === 20);
      return out(s, s.lastOp.ok === false && s.lastOp.message === 'bet__not_enough_balance' && is(s, bt, 10, 20) && rows(s, tx('bet')).length === 0 && stale, false, [s.lastOp.message, say(s, bt), scratch ? `stored originalBalance ${scratch.originalBalance}, originalBonusBalance ${scratch.originalBonusBalance}` : 'no scratch fields on RethinkDB']);
    },
  },
  {
    id: 'S06', title: 'Bet with a negative amount passed in: −10 is deducted as 10', shows: 'deductBalance forces the sign (L-29)', expect: ALL('correct'),
    run(c, bt) {
      const s = placeBet(fund(c, bt, 100), { balanceType: bt, amount: -10 });
      return out(s, is(s, bt, 90, 0) && rows(s, tx('bet'))[0]?.amount === -10, false, [say(s, bt)]);
    },
  },
  {
    id: 'S07', title: 'Credit with a negative amount passed in', shows: 'Open (L-30): passed through it takes 10 off; forced positive it adds 10', open: { knob: 'creditSign' }, expect: ALL('correct'),
    run(c, bt) {
      const s = deposit(fund(c, bt, 100), { balanceType: bt, amount: -10 });
      return out(s, P(s, bt) === (c.creditSign === 'asGiven' ? 90 : 110), false, [`creditSign=${c.creditSign}: ${say(s, bt)}`]);
    },
  },
  {
    id: 'S08', title: 'Withdraw 30 with 10 primary and 50 bonus: refused; 10 is accepted', shows: 'Withdrawals take primary only (L-31)', expect: ALL('correct'),
    run(c, bt) {
      let s = withdrawRequest(fund(c, bt, 10, 50), { balanceType: bt, amount: 30 });
      const refused = s.lastOp.ok === false && is(s, bt, 10, 50);
      s = withdrawRequest(s, { balanceType: bt, amount: 10 });
      return out(s, refused && is(s, bt, 0, 50), false, [refused ? 'withdraw 30 refused' : 'withdraw 30 ACCEPTED', say(s, bt)]);
    },
  },
  {
    id: 'S09', study: '5, 10', title: 'Bonus grant, completion, and lazy expiry through checkIfBonusActive', shows: 'L-33, and a write hidden in a read (L-82)', expect: ALL('correct'),
    run(c, bt) {
      let s = grantBonus(fund(c, bt, 30), { balanceType: bt, amount: 50 });
      const granted = is(s, bt, 30, 50) && rows(s, tx('bonusGrant'))[0]?.balanceType === `${bt}Bonus`;
      s = completeBonus(s, { balanceType: bt });
      const completed = is(s, bt, 80, 0) && rowList(s, tx('bonusCompleted')) === `${bt} 50, ${bt}Bonus -50`;
      s = chain(s, [grantBonus, { balanceType: bt, amount: 20 }], [advanceDays, { days: 8 }]);
      const overdue = is(s, bt, 80, 20);
      const socket = s.sideEffects.socket;
      s = readBonusState(s, { balanceType: bt });
      const expired = is(s, bt, 80, 0) && rowList(s, tx('bonusExpired')) === `${bt}Bonus -20` && s.sideEffects.socket > socket;
      return out(s, granted && completed && overdue && expired, false, [`grant ${granted ? 'ok' : 'WRONG'}, completion ${completed ? 'ok' : 'WRONG'}`, `8 days later the overdue bonus is ${overdue ? 'still on the balance' : 'gone'}`, `after the read: ${say(s, bt)}; bonusExpired rows: ${rowList(s, tx('bonusExpired'))}`]);
    },
  },
  {
    id: 'S10', study: 9, title: 'ACP reset, confiscate and replace with primary and bonus present', shows: 'Primary only, one row each (L-34, L-87)', expect: ALL('correct'),
    run(c, bt) {
      let s = acpAction(fund(c, bt, 40, 50), { api: 'rest', action: 'reset', balanceType: bt });
      const reset = is(s, bt, 0, 50) && rows(s, tx('acpReset')).length === 1 && rows(s, tx('acpReset'))[0].amount === -40;
      s = chain(s, [deposit, { balanceType: bt, amount: 40 }], [acpAction, { api: 'graphql', action: 'confiscate', balanceType: bt }]);
      const confiscated = is(s, bt, 0, 50) && rows(s, tx('acpConfiscate')).length === 1;
      s = acpAction(s, { api: 'rest', action: 'replace', balanceType: bt, value: 1000 });
      return out(s, reset && confiscated && is(s, bt, 1000, 50) && rows(s, tx('acpReplace'))[0]?.amount === 1000, false, [`reset ${reset ? 'ok' : 'WRONG'}, confiscate ${confiscated ? 'ok' : 'WRONG'}`, say(s, bt)]);
    },
  },
  {
    id: 'S11', errors: [6], title: 'ACP reset while a bet is applied: the row must record the real change', shows: 'Error 6: read 100, bet −40 lands, set to 0 → row says −100, real change −60', expect: DEBT,
    run(c, bt) {
      const s = acpResetDuringBet(fund(c, bt, 100), { balanceType: bt, betAmount: 40 });
      const amount = rows(s, tx('acpReset'))[0]?.amount;
      return out(s, P(s, bt) === 0 && amount === -60, P(s, bt) === 0 && amount === -100 && !holds(s, 'Admin row matches real change'), [`row records ${amount}; the balance really changed by -60`]);
    },
  },
  {
    id: 'S12', title: 'ACP adjust: −20 through deductBalance; +20 depends on the knob', shows: 'Open (L-12). REST also writes a user note and a Slack line (L-81)', open: { knob: 'positiveAdjust' }, expect: ALL('correct'),
    run(c, bt) {
      let s = acpAction(fund(c, bt, 100), { api: 'rest', action: 'adjust', balanceType: bt, amount: -20 });
      const negative = P(s, bt) === 80 && s.sideEffects.userNotes.length === 1 && s.sideEffects.slack.length === 1;
      s = acpAction(s, { api: 'graphql', action: 'adjust', balanceType: bt, amount: 20 });
      const quiet = s.sideEffects.userNotes.length === 1;
      return out(s, negative && quiet && P(s, bt) === (c.positiveAdjust === 'creditPath' ? 100 : 60), false, [`positiveAdjust=${c.positiveAdjust}: ${say(s, bt)}`, `user notes ${s.sideEffects.userNotes.length}, Slack lines ${s.sideEffects.slack.length} (REST only)`]);
    },
  },
  {
    id: 'S13', title: 'Sportsbook rollback with allowNegative: 20, rollback 50 → −30; a deposit covers it', shows: 'L-36, L-88', expect: ALL('correct'),
    run(c, bt) {
      let s = sportsbookRollback(fund(c, bt, 20), { balanceType: bt, amount: 50 });
      const negative = P(s, bt) === -30 && holds(s, 'No negative balance');
      s = placeBet(s, { balanceType: bt, amount: 5 });
      const refused = s.lastOp.ok === false;
      s = deposit(s, { balanceType: bt, amount: 100 });
      return out(s, negative && refused && P(s, bt) === 70, false, [`after the rollback: ${negative ? '-30' : 'WRONG'}`, `bet of 5 while negative: ${refused ? 'refused' : 'ACCEPTED'}`, say(s, bt)]);
    },
  },
  {
    id: 'S14', errors: [1], title: 'Row insert fails after a bet', shows: 'Error 1: the balance changes, transactionId is undefined, no row exists', expect: DEBT,
    run(c, bt) {
      let s = placeBet(setFault(fund(c, bt, 100), { failInserts: 1 }), { balanceType: bt, amount: 40 });
      const noId = s.lastOp.result?.transactionId === undefined;
      s = runReconciler(s);
      const n = rows(s, tx('bet')).length;
      return out(s, P(s, bt) === 60 && n === 1 && holds(s, 'Latest row matches balance'), P(s, bt) === 60 && noId && n === 0 && !holds(s, 'Latest row matches balance'), [say(s, bt), `transactionId ${noId ? 'undefined' : 'returned'}; ${n} bet rows; alerts ${s.sideEffects.alerts.length}`]);
    },
  },
  {
    id: 'S14b', errors: [1], title: 'A batch of failed inserts: the next 3 fail', shows: 'Errors come in incidents, not one-offs', expect: DEBT,
    run(c, bt) {
      let s = setFault(fund(c, bt, 100), { failInserts: 3 });
      for (let i = 0; i < 3; i += 1) s = placeBet(s, { balanceType: bt, amount: 10 });
      s = runReconciler(s);
      const n = rows(s, tx('bet')).length;
      return out(s, P(s, bt) === 70 && n === 3 && s.sideEffects.alerts.length === 3, P(s, bt) === 70 && n === 0 && s.sideEffects.alerts.length === 0, [say(s, bt), `${n} of 3 bet rows; alerts ${s.sideEffects.alerts.length}`]);
    },
  },
  {
    id: 'S15', errors: [2], title: 'Row insert fails, then the provider retries the same callback', shows: 'Error 2: the duplicate check reads rows, finds none, and the bet is applied twice', expect: DEBT,
    run(c, bt) {
      let s = placeBet(setFault(fund(c, bt, 100), { failInserts: 1 }), { balanceType: bt, amount: 40 });
      s = replayLast(s);
      return out(s, P(s, bt) === 60, P(s, bt) === 20, [say(s, bt), s.lastOp.message]);
    },
  },
  {
    id: 'S16', errors: [3], title: 'Same deposit callback twice at the same moment', shows: 'Error 3: both deliveries see "pending" and both credit', expect: DEBT,
    run(c, bt) {
      const s = concurrentDepositCallbacks(createState(c), { balanceType: bt, amount: 100 });
      return out(s, P(s, bt) === 100, P(s, bt) === 200, [say(s, bt), `credited ${s.lastOp.result.applied} time(s)`]);
    },
  },
  {
    id: 'S17', errors: [4], title: 'Row insert fails on a split bet, then the bet is refunded', shows: 'Error 4: no rows, so the bonus part comes back as primary', expect: DEBT,
    run(c, bt) {
      let s = placeBet(setFault(fund(c, bt, 10, 50), { failInserts: 1 }), { balanceType: bt, amount: 30 });
      s = refundBet(s, { betId: lastBet(s) });
      return out(s, is(s, bt, 10, 50), is(s, bt, 30, 30) && !holds(s, 'Refund returns to source buckets'), [say(s, bt), 'correct is primary 10, bonus 50']);
    },
  },
  {
    id: 'S18', errors: [5], title: 'Deposit 0.7, deposit 0.1, bet 0.8', shows: 'Error 5: the stored balance is 0.7999999999999999 and the guard refuses the bet', expect: DEBT,
    run(c, bt) {
      const s = chain(createState(c), [deposit, { balanceType: bt, amount: 0.7 }], [deposit, { balanceType: bt, amount: 0.1 }], [placeBet, { balanceType: bt, amount: 0.8 }]);
      return out(s, s.lastOp.ok === true && is(s, bt, 0, 0), s.lastOp.ok === false && P(s, bt) !== 0.8 && Math.abs(P(s, bt) - 0.8) < 1e-9, [s.lastOp.message, say(s, bt)]);
    },
  },
  {
    id: 'S19', errors: [3], pin: { dupRead: 'secondary' }, title: 'Duplicate check on a secondary with 500 ms lag; the retry arrives after 100 ms', shows: 'Errors 2 and 3 with lag (L-57): the row is not visible yet', expect: DEBT,
    run(c, bt) {
      let s = placeBet(fund(c, bt, 100), { balanceType: bt, amount: 40 });
      s = replayLast(setGap(s, 100));
      return out(s, P(s, bt) === 60, P(s, bt) === 20, [`dupRead=${c.dupRead}: ${say(s, bt)}`, s.lastOp.message]);
    },
  },
  {
    id: 'S20', errors: [4], pin: { refundRead: 'secondary' }, title: 'Refund read from a secondary 100 ms after a split bet', shows: 'Error 4 without a failed insert', expect: DEBT,
    run(c, bt) {
      let s = placeBet(fund(c, bt, 10, 50), { balanceType: bt, amount: 30 });
      s = refundBet(setGap(s, 100), { betId: lastBet(s) });
      return out(s, is(s, bt, 10, 50), is(s, bt, 30, 30), [`refundRead=${c.refundRead}: ${say(s, bt)}`]);
    },
  },
  {
    id: 'S21', errors: [7], title: 'Withdrawal declined, then cancelled, for the same withdrawal', shows: 'Error 7: credited back twice', expect: DEBT,
    run(c, bt) {
      let s = withdrawRequest(fund(c, bt, 100), { balanceType: bt, amount: 60 });
      const id = s.mongo.withdrawals[0].id;
      s = chain(s, [withdrawOutcome, { withdrawalId: id, outcome: 'decline' }], [withdrawOutcome, { withdrawalId: id, outcome: 'cancel' }]);
      return out(s, P(s, bt) === 100, P(s, bt) === 160 && !holds(s, 'Withdrawal credited back at most once'), [say(s, bt), 'correct is 100']);
    },
  },
  {
    id: 'S22', errors: [7], title: 'Withdrawal reversal retried', shows: 'Error 7: credited back twice', expect: DEBT,
    run(c, bt) {
      let s = withdrawRequest(fund(c, bt, 100), { balanceType: bt, amount: 60 });
      const id = s.mongo.withdrawals[0].id;
      s = chain(s, [withdrawOutcome, { withdrawalId: id, outcome: 'reversal' }], [withdrawOutcome, { withdrawalId: id, outcome: 'reversal' }]);
      return out(s, P(s, bt) === 100, P(s, bt) === 160, [say(s, bt), 'correct is 100']);
    },
  },
  {
    id: 'S23', errors: [2], title: 'Deposit: credit succeeds, status update fails, callback retried', shows: 'Error 2 for deposits: the deposit still says pending (L-37)', expect: DEBT,
    run(c, bt) {
      let s = deposit(setFault(createState(c), { failStatusUpdate: 1 }), { balanceType: bt, amount: 100 });
      s = replayLast(s);
      return out(s, P(s, bt) === 100, P(s, bt) === 200, [`depositOrder=${c.depositOrder}: ${say(s, bt)}`]);
    },
  },
  {
    id: 'S24a', errors: [2], title: 'Rows older than the TTL, then the same bet callback again', shows: 'Retention (L-44): the duplicate check finds nothing after 180 days', expect: DEBT,
    run(c, bt) {
      let s = placeBet(fund(c, bt, 100), { balanceType: bt, amount: 40 });
      s = replayLast(advanceDays(s, { days: 181 }));
      return out(s, P(s, bt) === 60, P(s, bt) === 20, [say(s, bt), `${s.mongo.transactions.length} rows left, ${s.warehouse.length} in the warehouse`]);
    },
  },
  {
    id: 'S24b', errors: [4], title: 'Rows older than the TTL, then a refund of a split bet', shows: 'Not fixable by meta: the split lived on rows that expired. Needs a durable split (the bet record is frozen)', expect: ALL('error'),
    run(c, bt) {
      let s = placeBet(fund(c, bt, 10, 50), { balanceType: bt, amount: 30 });
      s = refundBet(advanceDays(s, { days: 181 }), { betId: lastBet(s) });
      return out(s, is(s, bt, 10, 50), is(s, bt, 30, 30), [say(s, bt), 'correct is primary 10, bonus 50']);
    },
  },
  {
    id: 'S25', study: 6, title: 'Two concurrent bets of 60 on 100: one accepted, 40 left', shows: 'Atomic guard (L-23, L-50)', expect: { current: 'correct', pseudocode: 'error', hardened: 'correct' },
    run(c, bt) {
      const s = concurrentBets(fund(c, bt, 100), { balanceType: bt, amount: 60 });
      const n = s.lastOp.result?.accepted;
      return out(s, n === 1 && is(s, bt, 40, 0), n === 2 && P(s, bt) === -20, [`${n} of 2 accepted`, say(s, bt)]);
    },
  },
  {
    id: 'S26', types: ['both'], title: 'Same sequence on cash and usdt, plus the golden cases', shows: 'Store parity holds only because the ReQL split is Assumed to match Mongo (L-28)', expect: ALL('correct'),
    run: (c) => parity(c),
  },
  {
    id: 'S26b', errors: [8], types: ['both'], pinAll: { legacySplit: 'noNegativeFloor' }, title: 'Store parity under the hypothesis "no zero floor in ReQL"', shows: 'Error 8: after sportsbook debt, the same bet splits differently by store. Not fixable without the bonus decision (Alex)', expect: ALL('error'),
    run: (c) => parity(c),
  },
  {
    id: 'S27', title: 'Side effects when the row insert fails', shows: 'Open (L-47): skipped if the listeners hang off the insert', open: { knob: 'sideEffectsOnFail' }, expect: ALL('correct'),
    run(c, bt) {
      let s = fund(c, bt, 100);
      const before = s.sideEffects.fastTrack;
      s = placeBet(setFault(s, { failInserts: 1 }), { balanceType: bt, amount: 40 });
      const delta = s.sideEffects.fastTrack - before;
      return out(s, delta === (c.sideEffectsOnFail === 'skipped' ? 0 : 1), false, [`sideEffectsOnFail=${c.sideEffectsOnFail}: FastTrack publishes for the bet: ${delta}`]);
    },
  },
  {
    id: 'S28', errors: [9], types: ['cash'], title: 'Ledger call without balanceType: meant for cash', shows: 'Error 9 (L-80): undefined falls back to the selected balance (usdt); an empty identifier resolves to BTC', expect: DEBT,
    run(c) {
      let s = chain(createState(c), [deposit, { balanceType: 'cash', amount: 100 }], [deposit, { balanceType: 'usdt', amount: 100 }], [deposit, { balanceType: 'crypto', amount: 100 }]);
      s = deductWithoutBalanceType(s, { intended: 'cash', amount: 10, identifier: undefined });
      const first = s.lastOp.ok;
      s = deductWithoutBalanceType(s, { intended: 'cash', amount: 10, identifier: '' });
      const untouched = P(s, 'cash') === 100 && P(s, 'usdt') === 100 && P(s, 'crypto') === 100;
      return out(s, !first && !s.lastOp.ok && untouched, P(s, 'cash') === 100 && P(s, 'usdt') === 90 && P(s, 'crypto') === 90, [`cash ${P(s, 'cash')}, usdt ${P(s, 'usdt')}, crypto ${P(s, 'crypto')}`, s.lastOp.message]);
    },
  },
  {
    id: 'S29', errors: [10], title: 'ACP confiscate, then +181 days: is any record left?', shows: 'Error 10 (L-96): the row expired and audits.balanceChange was never written', expect: DEBT,
    run(c, bt) {
      const s = chain(fund(c, bt, 100), [acpAction, { api: 'rest', action: 'confiscate', balanceType: bt, reason: 'fraud review' }], [advanceDays, { days: 181 }]);
      const rec = adminRecords(s);
      return out(s, rec.audits === 1, rec.rows === 0 && rec.audits === 0, [`rows ${rec.rows}, audits ${rec.audits}, warehouse copy ${rec.warehouse} (completeness unchecked, L-92)`]);
    },
  },
  {
    id: 'ST1', study: 1, title: 'Basic credit: 0, deposit 100 → 100 primary', shows: 'Study scenario 1', expect: ALL('correct'),
    run(c, bt) {
      const s = fund(c, bt, 100);
      const r = rows(s, tx('deposit'))[0];
      return out(s, is(s, bt, 100, 0) && r?.amount === 100 && r?.currentBalance === 100 && r?.balanceType === bt && s.mongo.deposits[0].status === 'completed', false, [say(s, bt)]);
    },
  },
  {
    id: 'ST7', study: 7, title: 'Refund to primary: a bet taken from primary comes back to primary', shows: 'Study scenario 7', expect: ALL('correct'),
    run(c, bt) {
      let s = placeBet(fund(c, bt, 100), { balanceType: bt, amount: 40 });
      s = refundBet(s, { betId: lastBet(s) });
      return out(s, is(s, bt, 100, 0) && s.mongo.bets[0].status === 'refunded', false, [say(s, bt)]);
    },
  },
  {
    id: 'ST8', study: 8, title: 'Refund to split: a split bet returns to both buckets', shows: 'Study scenario 8 (L-56)', expect: { current: 'correct', pseudocode: 'error', hardened: 'correct' },
    run(c, bt) {
      let s = placeBet(fund(c, bt, 10, 50), { balanceType: bt, amount: 30 });
      s = refundBet(s, { betId: lastBet(s) });
      return out(s, is(s, bt, 10, 50), is(s, bt, 30, 30), [say(s, bt)]);
    },
  },
  {
    id: 'X01', title: 'A blocked deposit is never credited', shows: 'Fraud or a block stops it before the credit (L-37)', expect: ALL('correct'),
    run(c, bt) {
      let s = depositCreate(createState(c), { balanceType: bt, amount: 100 });
      const id = s.mongo.deposits[0].id;
      const pending = P(s, bt) === 0;
      s = chain(s, [depositBlock, { depositId: id }], [depositComplete, { depositId: id }]);
      return out(s, pending && s.lastOp.ok === false && P(s, bt) === 0 && rows(s, tx('deposit')).length === 0, false, [s.lastOp.message, say(s, bt)]);
    },
  },
  {
    id: 'X02', title: 'Two withdrawal requests at once: the Redis mutex refuses the second', shows: 'Per-user, non-blocking mutex on the request (L-86)', expect: ALL('correct'),
    run(c, bt) {
      const s = concurrentWithdrawRequests(fund(c, bt, 100), { balanceType: bt, amount: 60 });
      return out(s, s.lastOp.result?.accepted === 1 && P(s, bt) === 40, false, [say(s, bt), s.lastOp.message]);
    },
  },
  {
    id: 'X03', types: ['usdt'], title: 'cleanupOldUsers deletes an account that never deposited or bet', shows: 'L-83: only BTC, ETH and LTC are checked; here the account held a usdt bonus (Inferred)', expect: ALL('correct'),
    run(c) {
      let s = cleanupOldUsers(grantBonus(createState(c), { balanceType: 'usdt', amount: 50 }));
      const gone = s.rethink.user.deleted === true;
      s = placeBet(s, { balanceType: 'usdt', amount: 5 });
      return out(s, gone && s.lastOp.ok === false, false, [gone ? 'account deleted while holding usdtBonus 50' : 'account kept', s.lastOp.message]);
    },
  },
  {
    id: 'X04', errors: [1], title: 'The measurement job finds a balance whose newest row disagrees', shows: 'Analysis §7: error 1 measured without code changes', expect: DEBT,
    run(c, bt) {
      let s = placeBet(setFault(fund(c, bt, 100), { failInserts: 1 }), { balanceType: bt, amount: 40 });
      s = measurementJob(s);
      const n = s.lastOp.result.mismatches.length;
      return out(s, n === 0, n === 1 && s.lastOp.result.mismatches[0].bucket === bt, [`${n} mismatch(es) in ${s.lastOp.result.checked} buckets`]);
    },
  },
];

/** The same operations on a legacy type and a portfolio type, plus the golden cases through both split paths. */
function parity(c) {
  const seq = (bt) => chain(createState(c), [deposit, { balanceType: bt, amount: 20 }], [sportsbookRollback, { balanceType: bt, amount: 25 }], [grantBonus, { balanceType: bt, amount: 50, days: 400 }], [placeBet, { balanceType: bt, amount: 10 }]);
  const cash = seq('cash');
  const usdt = seq('usdt');
  const same = P(cash, 'cash') === P(usdt, 'usdt') && B(cash, 'cash') === B(usdt, 'usdt');
  const diffs = parityReport(c).filter((g) => !g.same);
  return out(cash, same && diffs.length === 0, !same && diffs.length > 0, [`deposit 20, rollback 25, bonus 50, bet 10 → cash ${P(cash, 'cash')}/${B(cash, 'cash')}, usdt ${P(usdt, 'usdt')}/${B(usdt, 'usdt')}`, diffs.length ? `golden cases that differ: ${diffs.map((g) => g.name).join('; ')}` : 'all golden cases agree']);
}

/* ─── Stash scenarios (Current + Stash preset only; everything here is Proposed) ─── */
const TOKEN = '123456';
export const STASH_SCENARIOS = [
  {
    id: 'T01', title: 'Stash-in with enough funds: 100, stash 40', shows: 'Primary −X, stash +X, two rows that add to 0', expect: 'correct',
    run(c, bt) {
      const s = stashIn(fund(c, bt, 100), { balanceType: bt, amount: 40 });
      const r = rows(s, tx('stashIn'));
      return out(s, P(s, bt) === 60 && S(s, bt) === 40 && rowList(s, tx('stashIn')) === `${bt} -40, ${bt}Stash 40` && r[0].meta.transferId === r[1].meta.transferId && holds(s, 'Stash pairs sum to zero'), false, [`primary ${P(s, bt)}, stash ${S(s, bt)}`, `rows: ${rowList(s, tx('stashIn'))}`]);
    },
  },
  {
    id: 'T02', title: 'Stash-in with too little: 10, stash 40', shows: 'All or nothing: no change, no rows', expect: 'correct',
    run(c, bt) {
      const s = stashIn(fund(c, bt, 10), { balanceType: bt, amount: 40 });
      return out(s, s.lastOp.ok === false && P(s, bt) === 10 && S(s, bt) === 0 && rows(s, tx('stashIn')).length === 0, false, [s.lastOp.message]);
    },
  },
  {
    id: 'T03', title: 'A withdrawal lands just before the stash-in', shows: 'The guard fails if primary < X afterwards', expect: 'correct',
    run(c, bt) {
      const s = chain(fund(c, bt, 100), [withdrawRequest, { balanceType: bt, amount: 80 }], [stashIn, { balanceType: bt, amount: 40 }]);
      return out(s, s.lastOp.ok === false && P(s, bt) === 20 && S(s, bt) === 0, false, [s.lastOp.message, `primary ${P(s, bt)}, stash ${S(s, bt)}`]);
    },
  },
  {
    id: 'T04', title: 'Same key twice, one after the other', shows: 'The second call changes nothing', expect: 'correct',
    run(c, bt) {
      const s = chain(fund(c, bt, 100), [stashIn, { balanceType: bt, amount: 40, key: 'stashIn:req_a' }], [stashIn, { balanceType: bt, amount: 40, key: 'stashIn:req_a' }]);
      return out(s, P(s, bt) === 60 && S(s, bt) === 40 && rows(s, tx('stashIn')).length === 2, false, [s.lastOp.message, `primary ${P(s, bt)}, stash ${S(s, bt)}`]);
    },
  },
  {
    id: 'T05', title: 'Same key twice, at the same moment', shows: 'Exactly one applies', expect: 'correct',
    run(c, bt) {
      const s = concurrentStashIn(fund(c, bt, 100), { balanceType: bt, amount: 40 });
      return out(s, s.lastOp.result.applied === 1 && S(s, bt) === 40, false, [s.lastOp.message]);
    },
  },
  {
    id: 'T06', title: 'Stash-out with an active wagering requirement', shows: 'Refused before the update', expect: 'correct',
    run(c, bt) {
      const s = chain(fund(c, bt, 100), [stashIn, { balanceType: bt, amount: 40 }], [grantBonus, { balanceType: bt, amount: 10 }], [stashOut, { balanceType: bt, amount: 20, token: TOKEN }]);
      return out(s, s.lastOp.ok === false && S(s, bt) === 40 && rows(s, tx('stashOut')).length === 0, false, [s.lastOp.message]);
    },
  },
  {
    id: 'T07', title: 'Row insert fails on a stash-in', shows: 'Balance changed, alert raised with full detail (minimum fix)', expect: 'correct',
    run(c, bt) {
      const s = stashIn(setFault(fund(c, bt, 100), { failInserts: 1 }), { balanceType: bt, amount: 40 });
      return out(s, P(s, bt) === 60 && S(s, bt) === 40 && rows(s, tx('stashIn')).length === 0 && s.sideEffects.alerts.length === 1, false, [`primary ${P(s, bt)}, stash ${S(s, bt)}, alerts ${s.sideEffects.alerts.length}`]);
    },
  },
  {
    id: 'T08', title: 'Bet with funds in stash', shows: 'Stash untouched; the bet uses primary, then bonus', expect: 'correct',
    run(c, bt) {
      const s = chain(fund(c, bt, 50), [stashIn, { balanceType: bt, amount: 40 }], [grantBonus, { balanceType: bt, amount: 50, days: 400 }], [placeBet, { balanceType: bt, amount: 30 }]);
      return out(s, is(s, bt, 0, 30) && S(s, bt) === 40 && holds(s, 'Stash never wagered or withdrawn'), false, [say(s, bt), `stash ${S(s, bt)}`]);
    },
  },
  {
    id: 'T09', title: 'Withdrawal with funds in stash', shows: 'Stash untouched; a withdrawal sees primary only', expect: 'correct',
    run(c, bt) {
      let s = chain(fund(c, bt, 100), [stashIn, { balanceType: bt, amount: 40 }], [withdrawRequest, { balanceType: bt, amount: 80 }]);
      const refused = s.lastOp.ok === false;
      s = withdrawRequest(s, { balanceType: bt, amount: 60 });
      return out(s, refused && P(s, bt) === 0 && S(s, bt) === 40, false, [`withdraw 80 ${refused ? 'refused' : 'ACCEPTED'}`, `primary ${P(s, bt)}, stash ${S(s, bt)}`]);
    },
  },
  {
    id: 'T11', errors: [5], title: 'Deposit 0.7, deposit 0.1, stash-in 0.8', shows: 'Follows the rounding decision of error 5: with floats the guard refuses', expect: 'error',
    run(c, bt) {
      const s = chain(createState(c), [deposit, { balanceType: bt, amount: 0.7 }], [deposit, { balanceType: bt, amount: 0.1 }], [stashIn, { balanceType: bt, amount: 0.8 }]);
      return out(s, s.lastOp.ok === true && S(s, bt) === 0.8, s.lastOp.ok === false && S(s, bt) === 0, [s.lastOp.message]);
    },
  },
  {
    id: 'T12', title: 'Flag turned off while stash holds funds', shows: 'Totals must not drop: reads ignore the flag, which only gates transfers', expect: 'correct',
    run(c, bt) {
      let s = stashIn(fund(c, bt, 100), { balanceType: bt, amount: 40 });
      const before = totalBalance(s);
      s = setStashFlag(s, { on: false });
      const after = totalBalance(s);
      s = stashIn(s, { balanceType: bt, amount: 10 });
      return out(s, before === 100 && after === 100 && s.lastOp.ok === false, false, [`totalBalance ${before} → ${after} with the flag off`, s.lastOp.message]);
    },
  },
  {
    id: 'T13', title: 'ACP confiscate with stash present', shows: 'Open policy: left out, stash shelters 40 from confiscation', open: { knob: 'confiscateIncludesStash' }, expect: 'correct',
    run(c, bt) {
      const s = chain(fund(c, bt, 100), [stashIn, { balanceType: bt, amount: 40 }], [acpAction, { api: 'rest', action: 'confiscate', balanceType: bt }]);
      const included = c.confiscateIncludesStash === 'yes';
      return out(s, P(s, bt) === 0 && S(s, bt) === (included ? 0 : 40) && rows(s, tx('acpConfiscate')).length === (included ? 2 : 1), false, [`confiscateIncludesStash=${c.confiscateIncludesStash}: primary ${P(s, bt)}, stash ${S(s, bt)}`]);
    },
  },
  {
    id: 'T14', title: 'Stash-out with 2FA; the same code again is refused', shows: '2FA single-use per user for 120 s', expect: 'correct',
    run(c, bt) {
      let s = chain(fund(c, bt, 100), [stashIn, { balanceType: bt, amount: 40 }], [stashOut, { balanceType: bt, amount: 15, token: TOKEN }]);
      const moved = P(s, bt) === 75 && S(s, bt) === 25 && rowList(s, tx('stashOut')) === `${bt} 15, ${bt}Stash -15`;
      s = stashOut(s, { balanceType: bt, amount: 5, token: TOKEN });
      return out(s, moved && s.lastOp.ok === false && S(s, bt) === 25, false, [`primary ${P(s, bt)}, stash ${S(s, bt)}`, s.lastOp.message]);
    },
  },
  {
    id: 'T15', pin: { stashValidator: 'notDeployed' }, title: 'Stash row written before the validator knows <type>Stash', shows: 'L-91: the post(\'init\') hook throws, so the CSV export fails', expect: 'error',
    run(c, bt) {
      const s = acpExportCsv(stashIn(fund(c, bt, 100), { balanceType: bt, amount: 40 }));
      return out(s, s.lastOp.ok === true, s.lastOp.ok === false && s.lastOp.message.includes('unknown balanceType'), [s.lastOp.message]);
    },
  },
];

/* ─── Migration scenarios: each case names its config and the result the documents imply ─── */
const planned = M_PRESETS.planned.config;
const mig = (config, primary = 100, bonus = 0) => mSeed(createMigration(config), { primary, bonus });
const mOut = (m, correct, note) => ({ state: m, got: correct ? 'correct' : 'error', notes: [note, ...Object.entries(mCompare(m)).map(([k, v]) => `${k}: ${v}`)] });
export const MIGRATION_SCENARIOS = [
  {
    id: 'M01', title: 'Two mirror writes arrive out of order (R2, then R1)', risk: 3,
    cases: [{ label: 'no version', config: { ...planned, delivery: 'async' }, expect: 'error' }, { label: 'version check', config: { ...planned, delivery: 'async', versionCheck: 'on' }, expect: 'correct' }],
    run(config) {
      const m = mDeliver(chain(mig(config), [mWrite, { kind: 'debit', amount: 30 }], [mWrite, { kind: 'debit', amount: 20 }]), { order: 'reversed' });
      return mOut(m, m.mongo.primary === 50, 'RethinkDB ends at 50; a stale copy leaves Mongo at 70');
    },
  },
  {
    id: 'M02', title: 'A mirror write fails, then the player goes idle until the flip', risk: '2, 4',
    cases: [{ label: 'log only', config: planned, expect: 'error' }, { label: 'repair queue', config: { ...planned, failureHandling: 'repair', versionCheck: 'on' }, expect: 'correct' }],
    run(config) {
      let m = mWrite(mig(config), { kind: 'credit', amount: 10 });
      m = mWrite(mSetFault(m, 1), { kind: 'debit', amount: 40 });
      m = mFlip(mRepair(m));
      return mOut(m, mCompare(m).sourceCorrect, 'After the flip Mongo is the source of truth; correct is 70');
    },
  },
  {
    id: 'M03', title: 'The backfill reads, a newer mirror write lands, then the backfill writes', risk: 5,
    cases: [{ label: 'plain set', config: planned, expect: 'error' }, { label: 'by data + version', config: { ...planned, backfill: 'data', versionCheck: 'on' }, expect: 'correct' }],
    run(config) {
      const m = chain(mig(config), [mBackfillRead], [mWrite, { kind: 'credit', amount: 50 }], [mBackfillWrite]);
      return mOut(m, m.mongo.primary === 150, 'RethinkDB is at 150; the backfill read 100 before the credit');
    },
  },
  {
    id: 'M04', title: 'Flip while a bet is open: placed on RethinkDB, settled on Mongo', risk: 7,
    cases: [{ label: 'as planned', config: planned, expect: 'correct' }],
    run(config) {
      const m = chain(mig(config, 10, 50), [mWrite, { kind: 'debit', amount: 30 }], [mFlip], [mWrite, { kind: 'credit', amount: 60 }]);
      const c = mCompare(m);
      return mOut(m, c.sourceCorrect && c.storesMatch && m.mongo.primary === 60 && m.mongo.bonus === 30, 'The settlement credits through Mongo; a refund would still rebuild the split from rows');
    },
  },
  {
    id: 'M05', title: 'A write lands on RethinkDB after the flip; the reverse mirror overwrites it', risk: 7,
    cases: [{ label: 'no freeze', config: planned, expect: 'error' }, { label: 'write freeze', config: { ...planned, writeFreeze: 'on' }, expect: 'correct' }],
    run(config) {
      let m = mBeginWrite(mig(config), { kind: 'debit', amount: 30 });
      m = mWrite(mig(config), { kind: 'credit', amount: 0.5 }); // make sure Mongo has a value before the flip
      m = mBeginWrite(m, { kind: 'debit', amount: 30 });
      m = chain(m, [mFlip], [mFinishWrite], [mWrite, { kind: 'credit', amount: 10 }]);
      return mOut(m, mCompare(m).sourceCorrect, 'Correct is 100 + 0.5 − 30 + 10 = 80.5 on Mongo');
    },
  },
  {
    id: 'M06', title: 'The shadow run compares the Mongo pipeline with each RethinkDB result', risk: 6,
    cases: [{ label: 'ReQL same as Mongo', config: { ...planned, shadow: 'on' }, expect: 'correct' }, { label: 'ReQL without zero floor', config: { ...planned, shadow: 'on', legacySplit: 'noNegativeFloor' }, expect: 'error' }],
    run(config) {
      const m = chain(mig(config, 20, 0), [mWrite, { kind: 'rollback', amount: 25 }], [mWrite, { kind: 'bonus', amount: 50 }], [mWrite, { kind: 'debit', amount: 10 }]);
      return mOut(m, m.shadowLog.length === 0, `shadow mismatches logged: ${m.shadowLog.length}`);
    },
  },
  {
    id: 'M07', title: 'Replaying changes instead of copying results', risk: 'L-72',
    cases: [{ label: 'replay changes', config: { ...planned, copy: 'changes' }, expect: 'error' }, { label: 'copy results', config: planned, expect: 'correct' }],
    run(config) {
      const m = chain(mig(config), [mWrite, { kind: 'debit', amount: 30 }], [mWrite, { kind: 'credit', amount: 50 }]);
      return mOut(m, m.mongo.primary === 120, 'RethinkDB ends at 120. Mongo starts at 0, so a replayed −30 hits the zero floor');
    },
  },
];

/* ─── error register (analysis §6) ─── */
export const ERROR_REGISTER = [
  { n: 1, title: 'Balance changes with no row', status: 'Confirmed', likelihood: 'Medium; clusters around failovers, restarts and timeouts', scenarios: ['S14', 'S14b', 'X04'], needs: 'Any knob setting', fix: 'Alert on failed insert; pending entry in the same update' },
  { n: 2, title: 'Retried callback applied twice after error 1', status: 'Likely', likelihood: 'Low to medium, tied to 1', scenarios: ['S15', 'S23', 'S24a'], needs: 'dupCheck = rows (Study). S23 also needs depositOrder = creditFirst (Assumed)', fix: 'Idempotency key inside the balance update' },
  { n: 3, title: 'Same callback twice at once', status: 'Likely', likelihood: 'Low; higher if the check reads a secondary', scenarios: ['S16', 'S19'], needs: 'S16: no conditional status transition (Assumed). S19: dupRead = secondary (Open)', fix: 'Same key; primary read for the check' },
  { n: 4, title: 'Refund turns bonus into primary', status: 'Derived', likelihood: 'Low, tied to 1 or a lagging read', scenarios: ['S17', 'S20', 'S24b'], needs: 'refundSplit = rows (Study). S20 also needs refundRead = secondary (Open)', fix: 'bonusBetAmount if persisted; split stored in meta' },
  { n: 5, title: 'Valid debit refused by float residue', status: 'Condition confirmed', likelihood: 'Unknown until the guard comparison is read', scenarios: ['S18'], needs: 'guardCompare = raw (Assumed)', fix: 'Round to precision before storing' },
  { n: 6, title: 'Admin set records a wrong difference', status: 'Open', likelihood: 'Unknown', scenarios: ['S11'], needs: 'setDiff = priorRead (Assumed)', fix: 'Compute the difference from the returned document' },
  { n: 7, title: 'Withdrawal credited back twice', status: 'Open', likelihood: 'Unknown', scenarios: ['S21', 'S22'], needs: 'reversalGuard = none (Assumed)', fix: 'Status transition guard in the same update as the credit' },
  { n: 8, title: 'Same operation, different result by store', status: 'Confirmed, not quantified', likelihood: 'Certain for some inputs', scenarios: ['S26b'], needs: 'legacySplit = noNegativeFloor (a hypothesis; the real difference is Open)', fix: 'Golden tests on both pipelines; decide the bonus difference' },
  { n: 9, title: 'Wrong balance changed when balanceType is omitted', status: 'Code', likelihood: 'Low, needs a caller bug', scenarios: ['S28'], needs: 'Any knob setting', fix: 'Reject a missing balance type at lib/index.ts' },
  { n: 10, title: 'Admin change cannot be audited after 180 days', status: 'Confirmed', likelihood: 'Certain for every admin action', scenarios: ['S29'], needs: 'Any knob setting', fix: 'Write the existing audits.balanceChange action' },
];

/* ─── running ─── */
const safe = (f) => {
  try {
    return f();
  } catch (e) {
    return { got: 'other', notes: [`threw: ${e.message}`] };
  }
};
export const typesOf = (sc) => sc.types || ['cash', 'usdt'];

/** One cell of the matrix: a scenario under a preset on a balance type. */
export function runCell(sc, presetKey, bt) {
  const stashOnly = STASH_SCENARIOS.includes(sc);
  const base = PRESETS[presetKey].config;
  const config = { ...base, ...(presetKey === 'hardened' ? {} : sc.pin), ...sc.pinAll };
  const expect = stashOnly ? sc.expect : sc.expect[presetKey === 'stash' ? 'current' : presetKey];
  let r;
  if (sc.open) {
    const options = Object.keys(KNOB_OPTIONS(sc.open.knob));
    const runs = options.map((opt) => safe(() => sc.run({ ...config, [sc.open.knob]: opt }, bt)));
    r = { ...runs[options.indexOf(String(config[sc.open.knob]))], got: runs.every((x) => x.got === 'correct') ? 'correct' : 'other', notes: runs.flatMap((x) => x.notes) };
  } else {
    r = safe(() => sc.run(config, bt));
  }
  const match = r.got === expect;
  const status = !match ? 'MISMATCH' : sc.open ? 'OPEN' : expect === 'correct' ? 'PASS' : presetKey === 'hardened' ? 'N/F' : presetKey === 'pseudocode' ? 'fail' : 'DEBT';
  return { ...r, expect, match, status, config };
}
import { KNOBS } from './engine.js';
const KNOB_OPTIONS = (knob) => KNOBS[knob].options;

export function runMigrationCase(sc, c) {
  const r = safe(() => sc.run(c.config));
  return { ...r, expect: c.expect, match: r.got === c.expect, status: r.got !== c.expect ? 'MISMATCH' : c.expect === 'correct' ? 'PASS' : 'RISK' };
}
