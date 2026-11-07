// 隔离探针：供 P2 测试用子进程验证 env/路径/导入顺序。
import fs from 'node:fs';
import path from 'node:path';
import { assertTestEnv, assertIsolatedPaths, PROD_DATA_DIR, PROD_DIARY_ROOT } from './_isolation.mjs';

const mode = process.env.PROBE_MODE || 'check';
const out = process.env.PROBE_OUT || '';
const write = (obj) => { if (out) fs.writeFileSync(out, JSON.stringify(obj)); console.log(JSON.stringify(obj)); };
try {
  if (mode === 'noenv') {
    delete process.env.QQ_AGENT_TEST_ISOLATION;
    try { assertTestEnv(); write({ ok: false, error: 'should refuse' }); process.exit(0); }
    catch (e) { write({ ok: true, refused: true, error: String(e.message) }); process.exit(0); }
  }
  if (mode === 'prod-data') {
    try { assertIsolatedPaths({ dataDir: PROD_DATA_DIR, diaryRoot: process.env.QQ_AGENT_DIARY_ROOT }); write({ ok: false }); process.exit(0); }
    catch (e) { write({ ok: true, refused: true, error: String(e.message) }); process.exit(0); }
  }
  if (mode === 'prod-diary') {
    try { assertIsolatedPaths({ dataDir: process.env.QQ_AGENT_DATA_DIR, diaryRoot: PROD_DIARY_ROOT }); write({ ok: false }); process.exit(0); }
    catch (e) { write({ ok: true, refused: true, error: String(e.message) }); process.exit(0); }
  }
  const iso = assertTestEnv();
  const { DATA_DIR } = await import('../src/config.js');
  if (path.resolve(DATA_DIR) !== path.resolve(iso.dataDir)) { write({ ok: false, error: `module DATA_DIR 不一致：${DATA_DIR}` }); process.exit(2); }
  const marker = path.join(iso.dataDir, `marker-${process.pid}.txt`);
  fs.writeFileSync(marker, 'ok');
  write({ ok: true, dataDir: iso.dataDir, diaryRoot: iso.diaryRoot, marker, dataDirFromModule: DATA_DIR });
} catch (e) {
  write({ ok: false, error: String(e?.stack || e) });
  process.exit(2);
}
