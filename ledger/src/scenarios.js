import {
  createState, deposit, concurrentDeposit, withdraw, chargeback, placeBet, settleBet, refundBet, playRound, concurrentBets,
  replayLast, grantBonus, completeBonus, expireBonus, adminSetBalance, setLimits, runReconciler, advanceDays, setFault,
  readBalance, invariants,
} from './engine.js';

/* Each scenario returns { pass, notes[], state }. `run` receives a config so the same
 * scenario can be evaluated against every preset; `state` is the end state, which the UI
 * can load into the Simulator tab.
 *
 * `study` is the scenario's number in section 7.3 of LEDGER_STUDY.md.
 * `debt` marks a scenario the "As studied" preset is expected to fail, with the reason.
 * It is shown as DEBT and does not fail `npm test`. */

const chain = (s, ...ops) => ops.reduce((acc, [fn, args]) => fn(acc, args), s);
const both = (s, bt) => [readBalance(s, bt), readBalance(s, bt, 'bonus')];
const is = (s, bt, primary, bonus) => readBalance(s, bt) === primary && readBalance(s, bt, 'bonus') === bonus;
const say = (s, bt) => `primary ${both(s, bt)[0]}, bonus ${both(s, bt)[1]}`;
const holds = (s, group) => invariants(s).filter((i) => i.group === group).every((i) => i.ok);
const rows = (s, type) => s.transactions.filter((t) => t.type === type);
const lastBet = (s) => s.bets[0].betId;
const usdt = { balanceType: 'usdt' };

export const SCENARIOS = [
  {
    id: 'basic-credit', study: 1, suite: 'credit',
    title: 'Basic credit: 0, credit 100 → 100 primary',
    run(config) {
      const s = deposit(createState(config), { ...usdt, amount: 100 });
      const row = rows(s, 'deposit')[0];
      return { state: s, pass: is(s, 'usdt', 100, 0) && row?.amount === 100 && row?.currentBalance === 100 && row?.balanceType === 'usdt', notes: [say(s, 'usdt'), `row: ${row ? `${row.type} ${row.amount} on ${row.balanceType}, currentBalance ${row.currentBalance}` : 'none'}`] };
    },
  },
  {
    id: 'basic-debit', study: 2, suite: 'debit',
    title: 'Basic debit: 100, debit 40 → 60 primary',
    run(config) {
      const s = chain(createState(config), [deposit, { ...usdt, amount: 100 }], [placeBet, { ...usdt, amount: 40 }]);
      return { state: s, pass: is(s, 'usdt', 60, 0) && rows(s, 'bet')[0]?.amount === -40, notes: [say(s, 'usdt'), `bet row amount ${rows(s, 'bet')[0]?.amount}`] };
    },
  },
  {
    id: 'insufficient', study: 3, suite: 'debit',
    title: 'Insufficient funds: 10, debit 50 → error, nothing moves',
    run(config) {
      const s = chain(createState(config), [deposit, { ...usdt, amount: 10 }], [placeBet, { ...usdt, amount: 50 }]);
      return { state: s, pass: s.lastOp.ok === false && is(s, 'usdt', 10, 0) && rows(s, 'bet').length === 0, notes: [s.lastOp.message, say(s, 'usdt'), `${rows(s, 'bet').length} bet rows`] };
    },
  },
  {
    id: 'bonus-split', study: 4, suite: 'debit',
    title: 'Bonus split debit: (10 primary, 50 bonus), debit 30 → (0, 30)',
    run(config) {
      const s = chain(createState(config), [deposit, { ...usdt, amount: 10 }], [grantBonus, { ...usdt, amount: 50 }], [placeBet, { ...usdt, amount: 30 }]);
      const split = rows(s, 'bet').map((t) => `${t.balanceType} ${t.amount}`).sort();
      return { state: s, pass: is(s, 'usdt', 0, 30) && split.join() === 'usdt -10,usdtBonus -20', notes: [say(s, 'usdt'), `bet rows: ${split.join(', ') || 'none'}`] };
    },
  },
  {
    id: 'bonus-credit', study: 5, suite: 'credit',
    title: 'Bonus-only credit: 20 to the bonus bucket leaves primary alone',
    run(config) {
      const s = chain(createState(config), [deposit, { ...usdt, amount: 25 }], [grantBonus, { ...usdt, amount: 20 }]);
      const row = rows(s, 'bonus')[0];
      return { state: s, pass: is(s, 'usdt', 25, 20) && row?.balanceType === 'usdtBonus', notes: [say(s, 'usdt'), `row balanceType: ${row?.balanceType}`] };
    },
  },
  {
    id: 'concurrent-debits', study: 6, suite: 'concurrency',
    title: 'Concurrent debits: two 60 debits on 100 → one succeeds, 40 left',
    run(config) {
      const s = chain(createState(config), [deposit, { ...usdt, amount: 100 }], [concurrentBets, { ...usdt, amount: 60 }]);
      const accepted = s.lastOp.result?.accepted;
      return { state: s, pass: accepted === 1 && is(s, 'usdt', 40, 0), notes: [`${accepted} of 2 accepted`, say(s, 'usdt')] };
    },
  },
  {
    id: 'refund-primary', study: 7, suite: 'refund',
    title: 'Refund to primary: a bet taken from primary comes back to primary',
    run(config) {
      let s = chain(createState(config), [deposit, { ...usdt, amount: 100 }], [placeBet, { ...usdt, amount: 40 }]);
      s = refundBet(s, { betId: lastBet(s) });
      return { state: s, pass: is(s, 'usdt', 100, 0) && s.bets[0].status === 'refunded', notes: [say(s, 'usdt'), `bet is ${s.bets[0].status}`] };
    },
  },
  {
    id: 'refund-split', study: 8, suite: 'refund',
    title: 'Refund to split: a bet split across primary and bonus returns to both',
    run(config) {
      let s = chain(createState(config), [deposit, { ...usdt, amount: 10 }], [grantBonus, { ...usdt, amount: 50 }], [placeBet, { ...usdt, amount: 30 }]);
      s = refundBet(s, { betId: lastBet(s) });
      return { state: s, pass: is(s, 'usdt', 10, 50), notes: [say(s, 'usdt'), 'expected primary 10, bonus 50'] };
    },
  },
  {
    id: 'admin-set', study: 9, suite: 'admin',
    title: 'Admin set: balance becomes 1000 whatever it was',
    run(config) {
      const s = chain(createState(config), [deposit, { ...usdt, amount: 37.5 }], [adminSetBalance, { ...usdt, value: 1000 }]);
      const row = rows(s, 'adminSetBalance')[0];
      return { state: s, pass: is(s, 'usdt', 1000, 0) && row?.amount === 962.5 && row?.meta.previous === 37.5, notes: [say(s, 'usdt'), `row amount ${row?.amount}, previous ${row?.meta.previous}`] };
    },
  },
  {
    id: 'bonus-completion', study: 10, suite: 'bonus',
    title: 'Bonus completion: 50 bonus moves to primary → (50, 0)',
    run(config) {
      const s = chain(createState(config), [grantBonus, { ...usdt, amount: 50 }], [completeBonus, usdt]);
      const moved = rows(s, 'bonusCompleted').map((t) => `${t.balanceType} ${t.amount}`).sort();
      return { state: s, pass: is(s, 'usdt', 50, 0) && moved.join() === 'usdt 50,usdtBonus -50', notes: [say(s, 'usdt'), `rows: ${moved.join(', ')}`] };
    },
  },
  {
    id: 'payout', suite: 'bets',
    title: 'Bet flow: bet 40, win ×2 → 140, with a bet row and a payout row',
    run(config) {
      const s = chain(createState(config), [deposit, { ...usdt, amount: 100 }], [playRound, { ...usdt, amount: 40, multiplier: 2 }]);
      return { state: s, pass: is(s, 'usdt', 140, 0) && rows(s, 'bet').length === 1 && rows(s, 'payout')[0]?.amount === 80 && s.bets[0].status === 'won', notes: [say(s, 'usdt'), `payout row ${rows(s, 'payout')[0]?.amount}`] };
    },
  },
  {
    id: 'snapshot', suite: 'pipeline',
    title: 'The update returns the before and after amounts in one trip (originalBalance)',
    run(config) {
      const s = chain(createState(config), [deposit, { ...usdt, amount: 100 }], [placeBet, { ...usdt, amount: 40 }]);
      const original = s.portfolio.balances.usdt.originalBalance;
      return { state: s, pass: original === 100 && s.lastOp.result?.primaryChange === -40, notes: [`originalBalance on the document: ${original}`, `primaryChange returned: ${s.lastOp.result?.primaryChange}`] };
    },
  },
  {
    id: 'legacy-store', suite: 'two stores',
    title: 'BTC lives on the User document and behaves the same (split debit)',
    run(config) {
      const btc = { balanceType: 'btc' };
      const s = chain(createState(config), [deposit, { ...btc, amount: 10 }], [grantBonus, { ...btc, amount: 50 }], [placeBet, { ...btc, amount: 30 }]);
      const untouched = s.portfolio.balances.usdt.balance === 0 && s.portfolio.balances.eth.balance === 0;
      return { state: s, pass: s.user.balance === 0 && s.user.btcBonusBalance === 30 && untouched, notes: [`users.balance ${s.user.balance}, users.btcBonusBalance ${s.user.btcBonusBalance}`, untouched ? 'portfolio document untouched' : 'portfolio document CHANGED'] };
    },
  },
  {
    id: 'withdraw-primary', suite: 'payments',
    title: 'Withdrawals take primary only: 30 from (10, 50) is refused',
    run(config) {
      let s = chain(createState(config), [deposit, { ...usdt, amount: 10 }], [grantBonus, { ...usdt, amount: 50 }], [withdraw, { ...usdt, amount: 30 }]);
      const refused = s.lastOp.ok === false && is(s, 'usdt', 10, 50);
      s = withdraw(s, { ...usdt, amount: 10 });
      return { state: s, pass: refused && is(s, 'usdt', 0, 50), notes: [refused ? 'withdraw 30 refused' : 'withdraw 30 ACCEPTED', `after withdrawing 10: ${say(s, 'usdt')}`] };
    },
  },
  {
    id: 'allow-negative', suite: 'payments',
    title: 'allowNegative: a 50 chargeback on 20 leaves −30; a normal debit is still refused',
    run(config) {
      let s = chain(createState(config), [deposit, { ...usdt, amount: 20 }], [chargeback, { ...usdt, amount: 50 }]);
      const negative = readBalance(s, 'usdt') === -30;
      s = placeBet(s, { ...usdt, amount: 5 });
      return { state: s, pass: negative && s.lastOp.ok === false && holds(s, 'No negative balance'), notes: [say(s, 'usdt'), `bet of 5 afterwards: ${s.lastOp.ok ? 'ACCEPTED' : 'refused'}`] };
    },
  },
  {
    id: 'bonus-wagering', suite: 'bonus',
    title: 'Wagering 5× the bonus completes it: bonus moves to primary on its own',
    run(config) {
      const round = [playRound, { ...usdt, amount: 50, multiplier: 1 }];
      const s = chain(createState(config), [deposit, { ...usdt, amount: 100 }], [grantBonus, { ...usdt, amount: 20, wagerMultiplier: 5 }], round, round);
      return { state: s, pass: is(s, 'usdt', 120, 0) && s.bonuses.usdt === null && rows(s, 'bonusCompleted').length === 2, notes: [say(s, 'usdt'), `${rows(s, 'bonusCompleted').length} bonusCompleted rows`] };
    },
  },
  {
    id: 'bonus-expiry', suite: 'bonus',
    title: 'An expired bonus is cleared; primary is untouched',
    run(config) {
      const s = chain(createState(config), [deposit, { ...usdt, amount: 30 }], [grantBonus, { ...usdt, amount: 50 }], [advanceDays, { days: 8 }]);
      const row = rows(s, 'bonusExpired')[0];
      return { state: s, pass: is(s, 'usdt', 30, 0) && row?.amount === -50 && row?.balanceType === 'usdtBonus', notes: [say(s, 'usdt'), `row: ${row ? `${row.amount} on ${row.balanceType}` : 'none'}`] };
    },
  },
  {
    id: 'bonus-forfeit', suite: 'bonus',
    title: 'Clearing a bonus by hand removes the bonus amount only',
    run(config) {
      const s = chain(createState(config), [deposit, { ...usdt, amount: 30 }], [grantBonus, { ...usdt, amount: 50 }], [expireBonus, usdt]);
      return { state: s, pass: is(s, 'usdt', 30, 0) && s.bonuses.usdt === null, notes: [say(s, 'usdt')] };
    },
  },
  {
    id: 'rg-wager-limit', suite: 'responsible gaming',
    title: 'Wager limit 100: a second bet of 60 is refused before the ledger is called',
    run(config) {
      const s = chain(createState(config), [setLimits, { wagerLimit: 100 }], [deposit, { ...usdt, amount: 500 }], [placeBet, { ...usdt, amount: 60 }], [placeBet, { ...usdt, amount: 60 }]);
      return { state: s, pass: s.lastOp.ok === false && is(s, 'usdt', 440, 0) && s.rg.wagered === 60, notes: [s.lastOp.message, say(s, 'usdt'), `wagered ${s.rg.wagered}`] };
    },
  },
  {
    id: 'rg-loss-limit', suite: 'responsible gaming',
    title: 'Loss limit 50: wins lower the net loss, and a bet past the limit is refused',
    run(config) {
      let s = chain(createState(config), [setLimits, { lossLimit: 50 }], [deposit, { ...usdt, amount: 500 }], [playRound, { ...usdt, amount: 40, multiplier: 2 }], [playRound, { ...usdt, amount: 80, multiplier: 0 }]);
      const after = s.rg.netLoss;
      s = placeBet(s, { ...usdt, amount: 20 });
      return { state: s, pass: after === 40 && s.lastOp.ok === false && is(s, 'usdt', 460, 0), notes: [`net loss after a win of 40 and a loss of 80: ${after}`, `bet of 20: ${s.lastOp.ok ? 'ACCEPTED' : s.lastOp.message}`] };
    },
  },
  {
    id: 'duplicate-callback', suite: 'idempotency',
    title: 'The same deposit notification delivered again is applied once',
    run(config) {
      const s = chain(createState(config), [deposit, { ...usdt, amount: 100, externalIdentifier: 'tx_abc' }], [replayLast]);
      return { state: s, pass: is(s, 'usdt', 100, 0), notes: [say(s, 'usdt'), s.lastOp.message] };
    },
  },
  {
    id: 'duplicate-payout', suite: 'idempotency',
    title: 'A replayed win callback pays out once',
    run(config) {
      const s = chain(createState(config), [deposit, { ...usdt, amount: 100 }], [playRound, { ...usdt, amount: 40, multiplier: 2 }], [replayLast]);
      return { state: s, pass: is(s, 'usdt', 140, 0), notes: [say(s, 'usdt'), s.lastOp.message] };
    },
  },
  {
    id: 'duplicate-concurrent', suite: 'idempotency',
    debt: 'Derived from §4.2, not observed in the backend: the caller checks for a row and then calls the ledger, and no unique index backs that up, so two deliveries in flight together both find nothing.',
    title: 'The same deposit delivered twice at once is applied once',
    run(config) {
      const s = chain(createState(config), [concurrentDeposit, { ...usdt, amount: 100 }]);
      return { state: s, pass: is(s, 'usdt', 100, 0), notes: [say(s, 'usdt'), `credited ${s.lastOp.result.applied} time(s)`] };
    },
  },
  {
    id: 'row-failure', suite: 'transaction log',
    debt: '§6 tech debt: the balance update succeeds, the insert fails, the error is logged and transactionId is undefined. The balance has moved and no ledger entry exists.',
    title: 'A failed transaction insert leaves no balance change without a row',
    run(config) {
      let s = chain(createState(config), [deposit, { ...usdt, amount: 100 }]);
      s = placeBet(setFault(s, 'rowWrite'), { ...usdt, amount: 40 });
      const noId = s.lastOp.result?.transactionId === undefined;
      s = runReconciler(s);
      return { state: s, pass: is(s, 'usdt', 60, 0) && holds(s, 'Every change has a row') && holds(s, 'Latest row ↔ balance'), notes: [say(s, 'usdt'), noId ? 'the bet returned transactionId undefined' : 'the bet returned a transactionId', `${rows(s, 'bet').length} bet rows after the reconciler`] };
    },
  },
  {
    id: 'replay-after-row-failure', suite: 'transaction log',
    debt: 'Follows from §4.2 and §6 together: the duplicate check reads the transaction rows, so a change whose row was never written looks new when the callback is retried.',
    title: 'A callback retried after its row failed to write is still applied once',
    run(config) {
      let s = deposit(setFault(createState(config), 'rowWrite'), { ...usdt, amount: 100, externalIdentifier: 'tx_def' });
      s = replayLast(s);
      return { state: s, pass: is(s, 'usdt', 100, 0), notes: [say(s, 'usdt'), s.lastOp.message] };
    },
  },
  {
    id: 'refund-lost-rows', suite: 'transaction log',
    debt: 'Follows from §6: a refund that returns funds to their original buckets needs the bet’s rows to know the split. Without them the bonus part comes back as withdrawable primary.',
    title: 'A split bet whose rows failed to write still refunds to both buckets',
    run(config) {
      let s = chain(createState(config), [deposit, { ...usdt, amount: 10 }], [grantBonus, { ...usdt, amount: 50 }]);
      s = placeBet(setFault(s, 'rowWrite'), { ...usdt, amount: 30 });
      s = refundBet(s, { betId: lastBet(s) });
      return { state: s, pass: is(s, 'usdt', 10, 50), notes: [say(s, 'usdt'), 'expected primary 10, bonus 50'] };
    },
  },
  {
    id: 'float', suite: 'numbers',
    debt: 'Derived from §3.2, not observed in the backend: balances are doubles, and 0.7 + 0.1 is 0.7999999999999999 as a double, so the guard sees a shortfall.',
    title: 'Credit 0.7 and 0.1, then debit 0.8 → accepted, balance exactly 0',
    run(config) {
      const s = chain(createState(config), [deposit, { ...usdt, amount: 0.7 }], [deposit, { ...usdt, amount: 0.1 }], [placeBet, { ...usdt, amount: 0.8 }]);
      return { state: s, pass: s.lastOp.ok === true && is(s, 'usdt', 0, 0), notes: [s.lastOp.message, say(s, 'usdt')] };
    },
  },
  {
    id: 'ttl', suite: 'transaction log',
    title: 'After 181 days the rows are gone and the balances are unchanged',
    run(config) {
      const s = chain(createState(config), [deposit, { ...usdt, amount: 100 }], [placeBet, { ...usdt, amount: 40 }], [advanceDays, { days: 181 }]);
      return { state: s, pass: s.transactions.length === 0 && is(s, 'usdt', 60, 0) && invariants(s).every((i) => i.ok), notes: [`${s.transactions.length} rows left`, say(s, 'usdt')] };
    },
  },
  {
    id: 'settle-open', suite: 'bets',
    title: 'An open bet can be settled later, and only once',
    run(config) {
      let s = chain(createState(config), [deposit, { ...usdt, amount: 100 }], [placeBet, { ...usdt, amount: 25 }]);
      const betId = lastBet(s);
      s = settleBet(s, { betId, multiplier: 2 });
      s = settleBet(s, { betId, multiplier: 2 });
      return { state: s, pass: s.lastOp.ok === false && is(s, 'usdt', 125, 0), notes: [say(s, 'usdt'), `second settle: ${s.lastOp.message}`] };
    },
  },
];

export function runScenario(sc, config) {
  try {
    return sc.run(config);
  } catch (e) {
    return { pass: false, notes: [`threw: ${e.message}`] };
  }
}
