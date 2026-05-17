// Run all E2E test modules sequentially, aggregate pass/fail/skip
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const modules = [
  'license.mjs',
  'ipc-surface.mjs',
  'assets.mjs',
  'chat.mjs',
  'tabs.mjs',
  'rate-limit.mjs',
  'web-search.mjs',
  'tools-agent.mjs',
  'errors.mjs',
  'integration.mjs',
];

function runOne(file) {
  return new Promise((resolveP) => {
    const t0 = Date.now();
    const child = spawn('node', [resolve(__dirname, file)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('close', (code) => {
      const elapsed = Date.now() - t0;
      // parse "pass X · fail Y · skip Z" from out
      const m = out.match(/=== ([^·]+) · pass (\d+) · fail (\d+) · skip (\d+) ===/);
      const summary = m
        ? { module: m[1].trim(), pass: +m[2], fail: +m[3], skip: +m[4] }
        : { module: file, pass: 0, fail: 0, skip: 0, parseFail: true };
      resolveP({ file, code, elapsed, out, err, summary });
    });
  });
}

console.log(`\n===== Running ${modules.length} E2E modules =====\n`);
const results = [];
for (const file of modules) {
  console.log(`\n>>> ${file}`);
  console.log('-'.repeat(60));
  const r = await runOne(file);
  console.log(r.out);
  if (r.err) console.error('[stderr]', r.err);
  results.push(r);
  console.log(`<<< ${file} exit=${r.code} ${r.elapsed}ms`);
}

console.log('\n===== AGGREGATE =====\n');
let totalP = 0;
let totalF = 0;
let totalS = 0;
const lines = [];
for (const r of results) {
  totalP += r.summary.pass;
  totalF += r.summary.fail;
  totalS += r.summary.skip;
  lines.push(
    `${r.code === 0 ? '✓' : '✗'} ${r.summary.module || r.file.padEnd(20)}  pass=${r.summary.pass}  fail=${r.summary.fail}  skip=${r.summary.skip}  (${r.elapsed}ms, exit=${r.code})`,
  );
}
console.log(lines.join('\n'));
console.log(`\nTOTAL · pass=${totalP} · fail=${totalF} · skip=${totalS}`);

// Persist JSON for TEST_REPORT auto-gen
const out = {
  ts: Date.now(),
  total: { pass: totalP, fail: totalF, skip: totalS },
  modules: results.map((r) => ({
    file: r.file,
    exit: r.code,
    elapsed: r.elapsed,
    summary: r.summary,
    out: r.out,
  })),
};
const { writeFileSync } = await import('node:fs');
writeFileSync(resolve(__dirname, 'last-run.json'), JSON.stringify(out, null, 2));
console.log(`\n[run-all] results saved to tests/e2e/last-run.json`);

process.exit(totalF > 0 ? 1 : 0);
