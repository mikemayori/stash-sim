import { SCENARIOS, runScenario } from './scenarios.js';
import { PRESETS } from './engine.js';

// Prints the pass/fail matrix; exits non-zero if the Recommended preset fails anything
// other than a scenario marked as an accepted gap.
const names = Object.keys(PRESETS);
let failed = 0;
const tally = Object.fromEntries(names.map((n) => [n, 0]));
console.log(['scenario'.padEnd(34), ...names.map((n) => n.padEnd(12))].join(''));
for (const sc of SCENARIOS) {
  const row = names.map((n) => {
    const r = runScenario(sc, PRESETS[n].config);
    if (r.pass) tally[n]++;
    const gap = n === 'recommended' && !r.pass && sc.acceptedGap;
    if (n === 'recommended' && !r.pass && !gap) { failed++; console.error(`  ✗ ${sc.id}: ${r.notes.join(' | ')}`); }
    return (r.pass ? 'PASS' : gap ? 'gap' : 'fail').padEnd(12);
  });
  console.log([sc.id.padEnd(34), ...row].join(''));
}
console.log(['passed'.padEnd(34), ...names.map((n) => `${tally[n]}/${SCENARIOS.length}`.padEnd(12))].join(''));
process.exit(failed ? 1 : 0);
