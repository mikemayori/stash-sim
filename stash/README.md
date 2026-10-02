# Stash Balance Simulator

An interactive model of the Stash feature (Main vs. Stash buckets on `UserPortfolio`). You can run
the spec as written, see where it breaks, and compare it with the recommended design.

```bash
npm install
npm run dev     # http://localhost:3001
npm test        # headless scenario matrix (Naive / Spec / Recommended)
```

## Tabs
- **Simulator**: a player wallet (balance selector), Stash vault, 2FA authenticator, player actions,
  auto-reload, ACP (per-balance view, add/confiscate/reset with reason + adminId, audit log), a live
  sequence diagram of every operation (hover a step for the Mongo filter/update), `db.transactions`,
  and invariant checks (conservation, reconciliation, isolation, stats).
- **Test scenarios**: the test suites from the spec, plus the new failure modes, run against every preset.
- **Technical plan**: the storage decision, data model, ACP, integration points, open-question
  recommendations, and follow-up stories with estimates.

## Things to try
1. **Spec as written → Enable as attacker → Withdraw repeatedly.** Auto-reload drains the Stash with no 2FA.
2. **Naive → Double-submit** 150 USDT with 200 in Main. Main goes negative.
3. **Naive → Crash next transfer after debit → Main → Stash.** Money disappears (the Conservation check fails).
4. **Spec as written → Main → Stash.** The Ledger ↔ MAIN and Stats checks fail because transfers are recorded as a single row.
5. **Grant locked bonus on ETH → Main → Stash on USDT.** The spec blocks it; the PRD (per-balance scope) allows it.

## Files
- `src/engine.js`: a pure ledger engine (query builder, DAL, sessions, services, invariants)
- `src/scenarios.js`: scenario definitions shared by the UI and `npm test`
- `src/App.jsx`, `src/Plan.jsx`: the UI
