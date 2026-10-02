import {
  createState, deposit, bet, withdraw, grantLockedBonus, transferToStash, transferFromStash,
  raceTransferToStash, adminStash, updateAutoReload, setFault, setTwoFactor, mapBalanceInformation,
  invariants, totp,
} from './engine.js';

/* Each scenario returns { pass, notes[] }. `run` receives a config so the
 * same scenario can be evaluated against every preset. */

const chain = (s, ...ops) => ops.reduce((acc, [fn, args]) => fn(acc, args), s);
const inv = (s, group, cur) => invariants(s).filter((i) => i.group === group && (!cur || i.cur === cur));
const allOk = (list) => list.every((i) => i.ok);

export const SCENARIOS = [
  {
    id: 'isolation',
    suite: 'stashExclusion.test.ts',
    title: '100 BTC in Stash, 0 in Main → wagerable is 0',
    run(config) {
      let s = chain(createState(config), [deposit, { currency: 'btc', amount: 100 }], [transferToStash, { currency: 'btc', amount: 100 }]);
      const wagerable = mapBalanceInformation(s.portfolio, s.config).btc;
      s = bet(s, { currency: 'btc', amount: 1, outcome: false });
      const betRejected = s.lastOp.ok === false;
      return { pass: wagerable === 0 && betRejected, notes: [`wagerable BTC = ${wagerable}`, betRejected ? '1 BTC bet rejected' : `1 BTC bet ACCEPTED (main now ${s.portfolio.balances.btc.total})`] };
    },
  },
  {
    id: 'overdraft',
    suite: 'transferToStash.test.ts',
    title: 'Overdraft: moving 80 with 50 in Main is rejected',
    run(config) {
      const s = chain(createState(config), [deposit, { currency: 'usdt', amount: 50 }], [transferToStash, { currency: 'usdt', amount: 80 }]);
      const { balances, stashBalances } = s.portfolio;
      return { pass: s.lastOp.ok === false && balances.usdt.total === 50 && stashBalances.usdt.total === 0, notes: [s.lastOp.message, `main ${balances.usdt.total}, stash ${stashBalances.usdt.total}`] };
    },
  },
  {
    id: 'race',
    suite: 'transferToStash.test.ts',
    title: 'Double-submit: 2× move 80 with 100 in Main never overdraws',
    run(config) {
      const s = chain(createState(config), [deposit, { currency: 'usdt', amount: 100 }], [raceTransferToStash, { currency: 'usdt', amount: 80 }]);
      const main = s.portfolio.balances.usdt.total;
      return { pass: main >= 0, notes: [s.lastOp.message, `main ${main}, stash ${s.portfolio.stashBalances.usdt.total}`] };
    },
  },
  {
    id: 'acid',
    suite: 'transferToStash.test.ts',
    title: 'Crash between debit and credit leaves no money missing',
    run(config) {
      let s = deposit(createState(config), { currency: 'usdt', amount: 100 });
      s = transferToStash(setFault(s, 'afterDebit'), { currency: 'usdt', amount: 40 });
      const conserved = allOk(inv(s, 'Conservation', 'USDT'));
      return { pass: conserved, notes: [`main ${s.portfolio.balances.usdt.total}, stash ${s.portfolio.stashBalances.usdt.total}`, conserved ? 'rolled back, total = 100' : '40 USDT vanished'] };
    },
  },
  {
    id: 'bonus-blocks',
    suite: 'transferToStash.test.ts',
    title: 'Locked bonus on ETH blocks ETH transfer-in',
    run(config) {
      const s = chain(createState(config),
        [deposit, { currency: 'eth', amount: 5 }],
        [grantLockedBonus, { currency: 'eth', amount: 1 }],
        [transferToStash, { currency: 'eth', amount: 2 }]);
      return { pass: s.lastOp.ok === false, notes: [s.lastOp.message] };
    },
  },
  {
    id: 'bonus-scope',
    suite: 'transferToStash.test.ts',
    title: 'Locked bonus on ETH does NOT block USDT (PRD: "on that balance")',
    run(config) {
      const s = chain(createState(config),
        [deposit, { currency: 'usdt', amount: 100 }],
        [grantLockedBonus, { currency: 'eth', amount: 1 }],
        [transferToStash, { currency: 'usdt', amount: 50 }]);
      return { pass: s.lastOp.ok === true, notes: [s.lastOp.message] };
    },
  },
  {
    id: '2fa-invalid',
    suite: 'transferFromStash.test.ts',
    title: '2FA on: wrong token rejected, right token accepted',
    run(config) {
      let s = chain(createState(config), [deposit, { currency: 'usdt', amount: 100 }], [transferToStash, { currency: 'usdt', amount: 100 }]);
      s = transferFromStash(s, { currency: 'usdt', amount: 10, token: '000000' });
      const rejected = s.lastOp.ok === false;
      s = transferFromStash(s, { currency: 'usdt', amount: 10, token: totp(s.clock + 1000) });
      return { pass: rejected && s.lastOp.ok === true, notes: [`bad token: ${rejected ? 'rejected' : 'ACCEPTED'}`, `good token: ${s.lastOp.message}`] };
    },
  },
  {
    id: '2fa-warn',
    suite: 'transferFromStash.test.ts',
    title: '2FA off: transfer proceeds with a subtle warning',
    run(config) {
      let s = chain(setTwoFactor(createState(config), false), [deposit, { currency: 'usdt', amount: 100 }], [transferToStash, { currency: 'usdt', amount: 100 }]);
      s = transferFromStash(s, { currency: 'usdt', amount: 10 });
      const pass = config.twoFaPolicy === 'MANDATORY' ? s.lastOp.ok === false : s.lastOp.ok === true && Boolean(s.lastOp.warning);
      return { pass, notes: [s.lastOp.message, s.lastOp.warning || '(no warning)'] };
    },
  },
  {
    id: 'admin',
    suite: 'adminStash.test.ts',
    title: 'ACP add / confiscate / reset each write an audited transaction',
    run(config) {
      const a = { adminId: 'adm_42', reason: 'VIP Reward' };
      let s = chain(createState(config),
        [adminStash, { ...a, action: 'add', currency: 'usdt', amount: 100 }],
        [adminStash, { ...a, action: 'confiscate', currency: 'usdt', amount: 30, reason: 'Fraud Investigation' }],
        [adminStash, { ...a, action: 'confiscate', currency: 'usdt', amount: 500, reason: 'Fraud Investigation' }]);
      const overConfiscateRejected = s.lastOp.ok === false;
      s = adminStash(s, { ...a, action: 'add', currency: 'usdt', amount: 5, reason: 'because' });
      const badReasonRejected = s.lastOp.ok === false;
      s = adminStash(s, { ...a, action: 'reset', currency: 'usdt' });
      const audited = s.transactions.filter((t) => t.type.startsWith('ADMIN_STASH_'));
      const pass = audited.length === 3 && audited.every((t) => t.meta.adminId && t.meta.reason) && overConfiscateRejected && badReasonRejected && s.portfolio.stashBalances.usdt.total === 0;
      return { pass, notes: [`${audited.length} audit txs: ${audited.map((t) => t.type.replace('ADMIN_STASH_', '')).reverse().join(', ')}`, `over-confiscate ${overConfiscateRejected ? 'rejected' : 'ALLOWED'}, free-text reason ${badReasonRejected ? 'rejected' : 'ALLOWED'}`] };
    },
  },
  {
    id: 'autoreload',
    suite: 'autoReload.test.ts',
    title: 'Bet drops Main below threshold → background top-up from Stash',
    run(config) {
      let s = chain(createState(config), [deposit, { currency: 'usdt', amount: 300 }], [transferToStash, { currency: 'usdt', amount: 270 }]);
      s = updateAutoReload(s, { enabled: true, threshold: 20, target: 100, currency: 'usdt', token: totp(s.clock + 1000) });
      s = bet(s, { currency: 'usdt', amount: 15, outcome: false });
      const reload = s.transactions.find((t) => t.type === 'STASH_OUT' && t.meta?.source === 'autoReload');
      return { pass: Boolean(reload) && s.portfolio.balances.usdt.total === 100, notes: [`main after bet+reload: ${s.portfolio.balances.usdt.total}`, reload ? 'STASH_OUT (source: autoReload) recorded' : 'no reload'] };
    },
  },
  {
    id: 'drain',
    suite: 'new: autoReload security',
    title: 'Stolen session (no 2FA token) cannot drain Stash via auto-reload + withdraw',
    run(config) {
      let s = chain(createState(config), [deposit, { currency: 'usdt', amount: 550 }], [transferToStash, { currency: 'usdt', amount: 500 }]);
      // attacker: has the session cookie, not the authenticator
      s = updateAutoReload(s, { enabled: true, threshold: 10, target: 100, currency: 'usdt' });
      let withdrawn = 0;
      for (let i = 0; i < 8; i++) {
        const avail = s.portfolio.balances.usdt.original;
        if (avail <= 0) break;
        s = withdraw(s, { currency: 'usdt', amount: avail });
        if (s.lastOp.ok) withdrawn += avail;
      }
      return { pass: withdrawn <= 50, notes: [`attacker withdrew ${withdrawn} USDT (Main held 50)`, `stash left: ${s.portfolio.stashBalances.usdt.total}`] };
    },
  },
  {
    id: 'recon',
    suite: 'new: reconciliation',
    title: 'Σ transactions per bucket = portfolio balance per bucket',
    run(config) {
      let s = chain(createState(config), [deposit, { currency: 'usdt', amount: 100 }], [transferToStash, { currency: 'usdt', amount: 60 }]);
      s = transferFromStash(s, { currency: 'usdt', amount: 20, token: totp(s.clock + 1000) });
      const checks = [...inv(s, 'Ledger ↔ MAIN', 'USDT'), ...inv(s, 'Ledger ↔ STASH', 'USDT')];
      return { pass: allOk(checks), notes: checks.map((c) => `${c.group}: ${c.detail}`) };
    },
  },
  {
    id: 'stats',
    suite: 'new: stats',
    title: 'Main-balance stats snapshot is not skewed by Stash movement',
    run(config) {
      let s = chain(createState(config), [deposit, { currency: 'usdt', amount: 100 }], [transferToStash, { currency: 'usdt', amount: 60 }]);
      const c = inv(s, 'Stats snapshot = MAIN', 'USDT')[0];
      return { pass: c.ok, notes: [c.detail] };
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
