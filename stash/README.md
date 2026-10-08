# Stash Balance Simulator

An interactive model of the Stash feature, shaped like the real backend: two balance stores
(the Mongo portfolio and the RethinkDB user row), USD amounts, and a third amount per balance
type next to primary and bonus. You can run the spec as written, see where it breaks, and
compare it with the design in `TECHNICAL_PLAN.md` (draft 2).

```bash
npm install
npm run dev     # http://localhost:3001
npm test        # headless scenario matrix (Naive / Spec / Recommended)
```

## Presets
- **Recommended**: draft 2 of the technical plan.
- **Spec as written**: the Sept 2026 write-up taken literally, run against how the backend really works.
- **Naive**: no safeguards.

"Show design knobs" exposes each decision separately, so you can change one and see what breaks.

## Tabs
- **Simulator**: the primary balances (what the game sees), the Stash amounts and where each is
  stored, a 2FA authenticator, player actions, reload settings, the ACP (balances, totals and
  P&L, admin transfers, CSV export, account cleanup, +181 days, audit log), a sequence diagram
  of every operation (hover a step for the payload), `mongo0.transactions`, and invariant checks.
- **Database**: the database design. What changes in each store, where each amount lives, and each
  store's schema (new fields highlighted) next to the live documents from the simulator. Opens
  directly with `#db`; add `?preset=recommended` to start on the Recommended design, for example
  `http://localhost:3001/?preset=recommended#db`.
- **Test scenarios**: 26 scenarios run against every preset. Click a cell, then
  **Load into simulator** to open that scenario's end state. `#scenarios` opens this tab directly.
- **Technical plan**: a summary of `TECHNICAL_PLAN.md`. `#plan` opens this tab directly.

## Things to try
1. **Spec as written, right after load.** The ACP shows a P&L of 300: the 300 USDT in Stash is not in `UserBalances`, so cashback and lossback would treat it as a loss. Switch to Recommended and it is 0.
2. **Spec as written → BTC → "Crash between debit and credit" → Primary → Stash.** BTC primary is in RethinkDB and the spec's Stash is in Mongo, so the debit is written and the credit is not. Under Recommended both amounts are in one document and there is nothing to crash between.
3. **Spec as written → Primary → Stash → Export transactions CSV.** The read hook throws on the `STASH` balance type.
4. **Spec as written → type wrong 2FA codes into Stash → Primary as often as you like.** Nothing limits them. Under Recommended the 16th attempt is refused, even with the right code.
5. **Recommended → Double-click →.** The mutex refuses the second request. Then **Retry last**: the amount moves again. This is the accepted gap; the knob "Mutex + requestId lookup" closes it.
6. **Recommended → "Fail the transaction-row write" → Primary → Stash.** The balance moves, the rows are missing, and an alert appears under Operations.
7. **Any preset → ACP transfer → +181 days.** The transaction rows expire. Under Recommended the `audits` record remains.
8. **Spec as written → Stash reload: mode Auto → Save as attacker → Withdraw repeatedly.** Auto-reload drains Stash with no 2FA.
9. **Grant bonus on BTC → Primary → Stash on USDT.** The spec's user-wide check blocks it; the real per-balance-type check allows it.
10. **Stash reload: mode Manual → Save → Bet & lose until primary is below the threshold.** Nothing moves; a prompt appears, and **Reload now** tops primary up with 2FA.

## Files
- `src/engine.js`: the pure engine (stores, guarded updates, rows and their side effects, 2FA, reload, ACP, invariants)
- `src/scenarios.js`: scenario definitions shared by the UI and `npm test`
- `src/App.jsx`, `src/Database.jsx`, `src/Plan.jsx`: the UI
- `TECHNICAL_PLAN.md`: the written plan and acceptance-criteria status
- `STASH_CODEBASE_FINDINGS.md`: the backend investigation the plan is based on
- `CODEBASE_PROMPT.md`: the prompt that produced it
