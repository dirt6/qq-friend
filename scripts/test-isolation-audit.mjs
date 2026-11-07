// 测试隔离静态审计（4.0 P1）。只读：扫描 test/，不执行测试。
// 用法：node scripts/test-isolation-audit.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_DIR = path.join(ROOT, 'test');
const HELPERS = new Set(['_harness.mjs', '_isolation.mjs', '_isolation-preload.mjs', '_isolation-probe.mjs', 'run-diary-test.mjs', 'run-isolation.mjs']);

function scan() {
  const files = fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.mjs')).sort();
  const rows = [];
  for (const f of files) {
    if (HELPERS.has(f)) continue;
    const text = fs.readFileSync(path.join(TEST_DIR, f), 'utf8');
    const hasTemp = /mkdtemp|bootApp|createIsolationRoot|assertTestEnv|DIARY_TEST_TMP|QQ_AGENT_DATA_DIR|QQ_AGENT_TEST_ISOLATION/.test(text);
    const hardProd = /E:[\\/]+dsh[\\/]+(日记|QQ-agent[\\/]+data)/.test(text);
    const prodWrite = /(writeFileSync|appendFileSync|rmSync|renameSync|unlinkSync|mkdirSync)\([^\n]*(E:[\\/]+dsh[\\/]+日记|E:[\\/]+dsh[\\/]+QQ-agent[\\/]+data)/.test(text);
    const envAfterImport = /import [^\n]+from ['"]\.\.\/src\//.test(text) && /process\.env\.QQ_AGENT_DATA_DIR\s*=/.test(text);
    const notes = [];
    if (!hasTemp) notes.push('no-isolation-marker');
    if (hardProd) notes.push('hardcoded-production-path');
    if (prodWrite) notes.push('direct-production-write');
    if (envAfterImport) notes.push('env-assignment-with-static-src-import');
    rows.push({ file: f, isolated: hasTemp, notes });
  }
  return rows;
}

export function main(argv = process.argv.slice(2)) {
  const json = argv.includes('--json');
  const rows = scan();
  const issues = rows.filter((r) => r.notes.length > 0);
  const summary = {
    tests: rows.length,
    isolated: rows.filter((r) => r.isolated).length,
    noMarker: rows.filter((r) => !r.isolated).length,
    hardcoded: rows.filter((r) => r.notes.includes('hardcoded-production-path')).length,
    directWrite: rows.filter((r) => r.notes.includes('direct-production-write')).length,
    envAfterImport: rows.filter((r) => r.notes.includes('env-assignment-with-static-src-import')).length
  };
  if (json) console.log(JSON.stringify({ schema: 1, summary, issues }, null, 1));
  else {
    console.log(`测试隔离静态审计：tests=${summary.tests} isolated=${summary.isolated} noMarker=${summary.noMarker}`);
    console.log(`hardcoded=${summary.hardcoded} directProductionWrite=${summary.directWrite} envAfterStaticImport=${summary.envAfterImport}`);
    for (const r of issues) console.log(`  ${r.file}: ${r.notes.join(', ')}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exit(main());
