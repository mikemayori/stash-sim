import {
  createState, deposit, receiveTip, bet, withdraw, grantLockedBonus, transferToStash, transferFromStash,
  raceTransferToStash, adminStash, adminExport, cleanupOldUsers, advanceDays, updateAutoReload, reloadFromStash,
  reloadSuggestion, setFault, setTwoFactor, tick, readBalance, wagerableBalance, calculatePnl, connectApiBalances,
  invariants, totp, WRONG_CODE_LIMIT,
} from './engine.js';

/* Each scenario returns { pass, notes[], state }. `run` receives a config so the
 * same scenario can be evaluated against every preset; `state` is the end state,
 * which the UI can load into the Simulator tab.
 *
 * `acceptedGap` marks a scenario the Recommended preset is known to fail, with
 * the reason the plan accepts it. It is shown as GAP and does not fail `npm test`. */

const chain = (s, ...ops) => ops.reduce((acc, [fn, args]) => fn(acc, args), s);
const inv = (s, group, cur) => invariants(s).filter((i) => i.group === group && (!cur || i.cur === cur));
const allOk = (list) => list.every((i) => i.ok);
const stash = (s, bt) => readBalance(s, bt, 'stash');

export const SCENARIOS = [
  {
    id: 'isolation',
    suite: 'wagering',
    title: '100 on BTC in Stash, 0 primary → nothing is wagerable',
    run(config) {
      let s = chain(createState(config), [deposit, { balanceType: 'crypto', amount: 100 }], [transferToStash, { balanceType: 'crypto', amount: 100 }]);
      const wagerable = wagerableBalance(s, 'crypto');
      s = bet(s, { balanceType: 'crypto', amount: 1, outcome: false });
      const betRejected = s.lastOp.ok === false;
      return { state: s, pass: wagerable === 0 && betRejected, notes: [`wagerable on BTC = ${wagerable}`, betRejected ? 'bet of 1 rejected' : `bet of 1 ACCEPTED (primary now ${readBalance(s, 'crypto')})`] };
    },
  },
  {
    id: 'overdraft',
    suite: 'transfer in',
    title: 'Overdraft: moving 80 with 50 in primary is rejected',
    run(config) {
      const s = chain(createState(config), [deposit, { balanceType: 'usdt', amount: 50 }], [transferToStash, { balanceType: 'usdt', amount: 80 }]);
      return { state: s, pass: s.lastOp.ok === false && readBalance(s, 'usdt') === 50 && stash(s, 'usdt') === 0, notes: [s.lastOp.message, `primary ${readBalance(s, 'usdt')}, stash ${stash(s, 'usdt')}`] };
    },
  },
  {
    id: 'race',
    suite: 'transfer in',
    title: 'Two requests at once: 2× move 80 with 100 in primary never overdraws',
    run(config) {
      const s = chain(createState(config), [deposit, { balanceType: 'usdt', amount: 100 }], [raceTransferToStash, { balanceType: 'usdt', amount: 80 }]);
      const primary = readBalance(s, 'usdt');
      return { state: s, pass: primary >= 0, notes: [s.lastOp.message, `primary ${primary}, stash ${stash(s, 'usdt')}`] };
    },
  },
  {
    id: 'crash',
    suite: 'two stores',
    title: 'BTC: a crash between debit and credit leaves no money missing',
    run(config) {
      let s = deposit(createState(config), { balanceType: 'crypto', amount: 100 });
      s = transferToStash(setFault(s, 'betweenWrites'), { balanceType: 'crypto', amount: 40 });
      const conserved = allOk(inv(s, 'Conservation', 'BTC'));
      return { state: s, pass: conserved, notes: [`primary ${readBalance(s, 'crypto')}, stash ${stash(s, 'crypto')}`, conserved ? 'one document, one update: nothing to crash between' : '40 debited from RethinkDB and never credited in Mongo'] };
    },
  },
  {
    id: 'bonus-blocks',
    suite: 'locked bonus',
    title: 'An active bonus on BTC blocks transfer-in on BTC',
    run(config) {
      const s = chain(createState(config),
        [deposit, { balanceType: 'crypto', amount: 500 }],
        [grantLockedBonus, { balanceType: 'crypto', amount: 100 }],
        [transferToStash, { balanceType: 'crypto', amount: 200 }]);
      return { state: s, pass: s.lastOp.ok === false, notes: [s.lastOp.message] };
    },
  },
  {
    id: 'bonus-scope',
    suite: 'locked bonus',
    title: 'An active bonus on BTC does NOT block USDT (PRD: "on that balance")',
    run(config) {
      const s = chain(createState(config),
        [deposit, { balanceType: 'usdt', amount: 100 }],
        [grantLockedBonus, { balanceType: 'crypto', amount: 100 }],
        [transferToStash, { balanceType: 'usdt', amount: 50 }]);
      return { state: s, pass: s.lastOp.ok === true, notes: [s.lastOp.message] };
    },
  },
  {
    id: '2fa-invalid',
    suite: '2FA',
    title: '2FA on: wrong code rejected, right code accepted',
    run(config) {
      let s = chain(createState(config), [deposit, { balanceType: 'usdt', amount: 100 }], [transferToStash, { balanceType: 'usdt', amount: 100 }]);
      s = transferFromStash(s, { balanceType: 'usdt', amount: 10, token: '000000' });
      const rejected = s.lastOp.ok === false;
      s = transferFromStash(s, { balanceType: 'usdt', amount: 10, token: totp(s.clock + 1000) });
      return { state: s, pass: rejected && s.lastOp.ok === true, notes: [`wrong code: ${rejected ? 'rejected' : 'ACCEPTED'}`, `right code: ${s.lastOp.message}`] };
    },
  },
  {
    id: '2fa-warn',
    suite: '2FA',
    title: '2FA off: the transfer goes through with a warning',
    run(config) {
      let s = chain(setTwoFactor(createState(config), false), [deposit, { balanceType: 'usdt', amount: 100 }], [transferToStash, { balanceType: 'usdt', amount: 100 }]);
      s = transferFromStash(s, { balanceType: 'usdt', amount: 10 });
      const pass = config.twoFaPolicy === 'MANDATORY' ? s.lastOp.ok === false : s.lastOp.ok === true && Boolean(s.lastOp.warning);
      return { state: s, pass, notes: [s.lastOp.message, s.lastOp.warning || '(no warning)'] };
    },
  },
  {
    id: 'totp-replay',
    suite: '2FA',
    title: 'A code that was already accepted cannot authorize a second transfer-out (already true in the backend)',
    run(config) {
      let s = chain(createState(config), [deposit, { balanceType: 'usdt', amount: 100 }], [transferToStash, { balanceType: 'usdt', amount: 100 }]);
      const code = totp(s.clock + 1000);
      s = transferFromStash(s, { balanceType: 'usdt', amount: 10, token: code });
      const firstOk = s.lastOp.ok === true;
      s = transferFromStash(s, { balanceType: 'usdt', amount: 90, token: code });
      const replayRejected = s.lastOp.ok === false;
      return { state: s, pass: firstOk && replayRejected, notes: [`first use: ${firstOk ? 'accepted' : 'rejected'}`, `replay: ${replayRejected ? 'rejected' : 'ACCEPTED'} (stash left ${stash(s, 'usdt')})`] };
    },
  },
  {
    id: '2fa-guessing',
    suite: 'new: 2FA attempts',
    title: `Stolen session guessing codes: after ${WRONG_CODE_LIMIT} wrong codes, even the right one is refused`,
    run(config) {
      let s = chain(createState(config), [deposit, { balanceType: 'usdt', amount: 100 }], [transferToStash, { balanceType: 'usdt', amount: 100 }]);
      const guesses = 20;
      for (let i = 0; i < guesses; i++) s = transferFromStash(s, { balanceType: 'usdt', amount: 100, token: String(100000 + i) });
      // stands in for the guess that eventually hits
      s = transferFromStash(s, { balanceType: 'usdt', amount: 100, token: totp(s.clock + 1000) });
      const stopped = s.lastOp.ok === false;
      return { state: s, pass: stopped, notes: [`${guesses} wrong codes sent`, stopped ? `then the right code: refused (${s.lastOp.message})` : 'then the right code: ACCEPTED — nothing limits guessing', `stash left ${stash(s, 'usdt')}`] };
    },
  },
  {
    id: 'double-click',
    suite: 'new: duplicate requests',
    title: 'Double-click: the same request twice at once (2× move 40 with 100 in primary) moves 40 once',
    run(config) {
      const req = { balanceType: 'usdt', amount: 40, requestId: 'req-7f3a' };
      const s = chain(createState(config), [deposit, { balanceType: 'usdt', amount: 100 }], [raceTransferToStash, req]);
      return { state: s, pass: stash(s, 'usdt') === 40, notes: [s.lastOp.message, `stash ${stash(s, 'usdt')} (player asked for 40)`] };
    },
  },
  {
    id: 'late-retry',
    suite: 'new: duplicate requests',
    title: 'Late retry: the client re-sends a request after the first one finished',
    acceptedGap: 'Phase 1 uses the mutex only. A late retry moves the amount again, but only between the player\'s own two amounts. The requestId lookup (knob "Mutex + requestId lookup") closes it if retries become a problem.',
    run(config) {
      const req = { balanceType: 'usdt', amount: 40, requestId: 'req-7f3a' };
      const s = chain(createState(config), [deposit, { balanceType: 'usdt', amount: 100 }], [transferToStash, req], [transferToStash, req]);
      return { state: s, pass: stash(s, 'usdt') === 40, notes: [s.lastOp.message, `stash ${stash(s, 'usdt')} (player asked for 40)`] };
    },
  },
  {
    id: 'rows',
    suite: 'transactions',
    title: 'After a transfer in and out, the newest row of each bucket carries its real balance',
    run(config) {
      let s = chain(createState(config), [deposit, { balanceType: 'usdt', amount: 100 }], [transferToStash, { balanceType: 'usdt', amount: 60 }]);
      s = transferFromStash(s, { balanceType: 'usdt', amount: 20, token: totp(s.clock + 1000) });
      const checks = [...inv(s, 'Latest row ↔ primary', 'USDT'), ...inv(s, 'Latest row ↔ Stash', 'USDT')];
      return { state: s, pass: allOk(checks), notes: checks.map((c) => c.detail) };
    },
  },
  {
    id: 'row-fail',
    suite: 'new: transactions',
    title: 'The row write fails after the balance moved: funds are intact and someone is told',
    run(config) {
      let s = deposit(createState(config), { balanceType: 'usdt', amount: 100 });
      s = transferToStash(setFault(s, 'rowWrite'), { balanceType: 'usdt', amount: 40 });
      const conserved = allOk(inv(s, 'Conservation', 'USDT'));
      const alerted = s.alerts.length === 1;
      return { state: s, pass: conserved && stash(s, 'usdt') === 40 && alerted, notes: [`primary ${readBalance(s, 'usdt')}, stash ${stash(s, 'usdt')}: the move stands`, alerted ? 'alert raised for the missing rows' : 'missing rows only show up in a log line'] };
    },
  },
  {
    id: 'admin-export',
    suite: 'new: deploy order',
    title: 'The admin CSV export still works for a user who has Stash rows',
    run(config) {
      const s = chain(createState(config), [deposit, { balanceType: 'usdt', amount: 100 }], [transferToStash, { balanceType: 'usdt', amount: 40 }], [adminExport, undefined]);
      return { state: s, pass: s.lastOp.ok === true, notes: [s.lastOp.message] };
    },
  },
  {
    id: 'lossback',
    suite: 'new: totals',
    title: 'Deposit 1000, stash 1000, never bet: cashback / lossback P&L shows no loss',
    run(config) {
      const s = chain(createState(config), [deposit, { balanceType: 'usdt', amount: 1000 }], [transferToStash, { balanceType: 'usdt', amount: 1000 }]);
      const pnl = calculatePnl(s);
      return { state: s, pass: pnl === 0, notes: [`P&L = deposits − withdrawals − totalBalance = ${pnl}`, pnl === 0 ? 'Stash is counted in totalBalance' : `${pnl} of stashed funds would be treated as a loss`] };
    },
  },
  {
    id: 'connect-api',
    suite: 'new: totals',
    title: 'The public Connect API does not publish Stash amounts',
    run(config) {
      const s = chain(createState(config), [deposit, { balanceType: 'usdt', amount: 100 }], [transferToStash, { balanceType: 'usdt', amount: 60 }]);
      const keys = Object.keys(connectApiBalances(s));
      const leaked = keys.filter((k) => k.endsWith('Stash'));
      return { state: s, pass: leaked.length === 0, notes: [`published keys: ${keys.join(', ')}`, config.totals === 'excluded' ? 'Stash is not in UserBalances at all (so totals miss it: see lossback)' : leaked.length ? `leaked: ${leaked.join(', ')}` : 'Stash keys filtered'] };
    },
  },
  {
    id: 'crm',
    suite: 'new: side effects',
    title: 'FastTrack CRM is never told that a Stash amount is the player\'s real money',
    run(config) {
      const s = chain(createState(config), [deposit, { balanceType: 'usdt', amount: 100 }], [transferToStash, { balanceType: 'usdt', amount: 60 }]);
      const c = inv(s, 'CRM never sees Stash', 'USDT')[0];
      return { state: s, pass: c.ok, notes: [c.detail, `last real_money sent: ${s.crm[0]?.amount} (primary is ${readBalance(s, 'usdt')})`] };
    },
  },
  {
    id: 'cleanup',
    suite: 'new: account cleanup',
    title: 'A tip-funded account with everything in Stash survives the old-account cleanup job (inferred risk)',
    run(config) {
      const s = chain(createState(config), [receiveTip, { balanceType: 'crypto', amount: 50 }], [transferToStash, { balanceType: 'crypto', amount: 50 }], [cleanupOldUsers, undefined]);
      return { state: s, pass: !s.user.deleted, notes: [s.lastOp.message] };
    },
  },
  {
    id: 'admin-transfer',
    suite: 'ACP',
    title: 'ACP transfer in / out moves funds with reason + adminId; off-list reasons and overdraws are rejected',
    run(config) {
      const a = { adminId: 'adm_42', reason: 'Responsible Gambling Request', balanceType: 'usdt' };
      let s = chain(createState(config), [deposit, { balanceType: 'usdt', amount: 100 }],
        [adminStash, { ...a, action: 'transfer-in', amount: 60 }],
        [adminStash, { ...a, action: 'transfer-out', amount: 20, reason: 'Operational Correction' }],
        [adminStash, { ...a, action: 'transfer-out', amount: 500 }]);
      const overdrawRejected = s.lastOp.ok === false;
      s = adminStash(s, { ...a, action: 'transfer-in', amount: 5, reason: 'because' });
      const badReasonRejected = s.lastOp.ok === false;
      const rows = s.transactions.filter((t) => t.meta?.source === 'admin');
      const pass = readBalance(s, 'usdt') === 60 && stash(s, 'usdt') === 40 && rows.length > 0 && rows.every((t) => t.meta.adminId && t.meta.reason) && overdrawRejected && badReasonRejected && allOk(inv(s, 'Conservation', 'USDT'));
      return { state: s, pass, notes: [`primary ${readBalance(s, 'usdt')}, stash ${stash(s, 'usdt')}`, `${rows.length} rows, all carry adminId + reason`, `overdraw ${overdrawRejected ? 'rejected' : 'ALLOWED'}, free-text reason ${badReasonRejected ? 'rejected' : 'ALLOWED'}`] };
    },
  },
  {
    id: 'audit-retention',
    suite: 'new: ACP audit',
    title: 'An admin transfer can still be audited 181 days later',
    run(config) {
      const s = chain(createState(config), [deposit, { balanceType: 'usdt', amount: 100 }],
        [adminStash, { action: 'transfer-in', balanceType: 'usdt', amount: 60, adminId: 'adm_42', reason: 'Responsible Gambling Request' }],
        [advanceDays, { days: 181 }]);
      const record = s.audits.find((a) => a.actionType === 'stashTransfer' && a.success);
      return { state: s, pass: Boolean(record), notes: [`transaction rows left after the 180-day TTL: ${s.transactions.length}`, record ? `audits record kept: ${record.editorId}, ${record.reason}` : 'no record of who moved the funds or why'] };
    },
  },
  {
    id: 'drain',
    suite: 'auto-reload (later phase)',
    title: 'Stolen session (no 2FA code) cannot drain Stash via auto-reload + withdraw',
    run(config) {
      let s = chain(createState(config), [deposit, { balanceType: 'usdt', amount: 550 }], [transferToStash, { balanceType: 'usdt', amount: 500 }]);
      // attacker: has the session cookie, not the authenticator
      s = updateAutoReload(s, { balanceType: 'usdt', mode: 'auto', threshold: 10, target: 100 });
      let withdrawn = 0;
      for (let i = 0; i < 8; i++) {
        const avail = readBalance(s, 'usdt');
        if (avail <= 0) break;
        s = withdraw(s, { balanceType: 'usdt', amount: avail });
        if (s.lastOp.ok) withdrawn += avail;
      }
      return { state: s, pass: withdrawn <= 50, notes: [`attacker withdrew ${withdrawn} (primary held 50)`, `stash left: ${stash(s, 'usdt')}`] };
    },
  },
  {
    id: 'autoreload',
    suite: 'auto-reload (later phase)',
    title: 'A bet takes primary below the threshold → background top-up from Stash',
    run(config) {
      let s = chain(createState(config), [deposit, { balanceType: 'usdt', amount: 300 }], [transferToStash, { balanceType: 'usdt', amount: 270 }]);
      s = updateAutoReload(s, { balanceType: 'usdt', mode: 'auto', threshold: 20, target: 100, token: totp(s.clock + 1000) });
      s = bet(s, { balanceType: 'usdt', amount: 15, outcome: false });
      const reload = s.transactions.find((t) => t.meta?.source === 'reload' && t.meta?.mode === 'auto');
      return { state: s, pass: Boolean(reload) && readBalance(s, 'usdt') === 100, notes: [`primary after bet + reload: ${readBalance(s, 'usdt')}`, reload ? 'transfer-out rows recorded (source: reload, mode: auto)' : 'no reload'] };
    },
  },
  {
    id: 'reload-per-type',
    suite: 'reload settings',
    title: 'Auto-reload on USDT and BTC at once, each with its own threshold and target',
    run(config) {
      let s = chain(createState(config),
        [deposit, { balanceType: 'usdt', amount: 300 }], [transferToStash, { balanceType: 'usdt', amount: 270 }],
        [deposit, { balanceType: 'crypto', amount: 300 }], [transferToStash, { balanceType: 'crypto', amount: 270 }]);
      s = updateAutoReload(s, { balanceType: 'usdt', mode: 'auto', threshold: 20, target: 100, token: totp(s.clock + 1000) });
      s = tick(s, 30000); // next 2FA code: a single-use code cannot authorize both changes
      s = updateAutoReload(s, { balanceType: 'crypto', mode: 'auto', threshold: 50, target: 200, token: totp(s.clock + 1000) });
      s = chain(s, [bet, { balanceType: 'usdt', amount: 15, outcome: false }], [bet, { balanceType: 'crypto', amount: 20, outcome: false }]);
      const usdt = readBalance(s, 'usdt');
      const btc = readBalance(s, 'crypto');
      return { state: s, pass: usdt === 100 && btc === 200, notes: [`USDT primary ${usdt} (target 100)`, `BTC primary ${btc} (target 200)`, `modes: usdt=${s.settings.stashReload.usdt.mode}, btc=${s.settings.stashReload.crypto.mode}`] };
    },
  },
  {
    id: 'reload-manual',
    suite: 'reload settings',
    title: 'Manual mode: a low primary balance only prompts; the player confirms the top-up with 2FA',
    run(config) {
      let s = chain(createState(config), [deposit, { balanceType: 'usdt', amount: 300 }], [transferToStash, { balanceType: 'usdt', amount: 270 }],
        [updateAutoReload, { balanceType: 'usdt', mode: 'manual', threshold: 20, target: 100 }],
        [bet, { balanceType: 'usdt', amount: 15, outcome: false }]);
      const untouched = stash(s, 'usdt') === 270;
      const suggested = reloadSuggestion(s, 'usdt');
      s = reloadFromStash(s, { balanceType: 'usdt' });
      const noCodeRejected = s.lastOp.ok === false;
      s = reloadFromStash(s, { balanceType: 'usdt', token: totp(s.clock + 1000) });
      const primary = readBalance(s, 'usdt');
      return { state: s, pass: untouched && suggested === 85 && noCodeRejected && primary === 100, notes: [untouched ? 'the bet moved nothing out of Stash' : 'Stash moved WITHOUT confirmation', `prompted top-up: ${suggested}`, `no code: ${noCodeRejected ? 'rejected' : 'ACCEPTED'}`, `primary after the confirmed reload: ${primary}`] };
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
