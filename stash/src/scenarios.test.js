import { SCENARIOS, runScenario } from './scenarios.js';
import { PRESETS } from './engine.js';

// Prints the pass/fail matrix; exits non-zero if the Recommended preset fails anything.
const names = Object.keys(PRESETS);
let failed = 0;
console.log(['scenario'.padEnd(34), ...names.map((n) => n.padEnd(12))].join(''));
for (const sc of SCENARIOS) {
  const row = names.map((n) => {
    const r = runScenario(sc, PRESETS[n].config);
    if (n === 'recommended' && !r.pass) { failed++; console.error(`  ✗ ${sc.id}: ${r.notes.join(' | ')}`); }
    return (r.pass ? 'PASS' : 'fail').padEnd(12);
  });
  console.log([sc.id.padEnd(34), ...row].join(''));
}
process.exit(failed ? 1 : 0);
