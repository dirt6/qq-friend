import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "E:/dsh/QQ-agent";
const [dir, key] = process.argv.slice(2);
const outFile = path.join(dir, "out.json");

function report(o) {
  try { fs.writeFileSync(outFile, JSON.stringify(o), "utf8"); } catch { /* ignore */ }
}

async function main() {
  process.env.QQ_AGENT_DATA_DIR = dir;
  const D = await import(pathToFileURL(path.join(ROOT, "src", "memory-hub", "diary-write.js")).href);
  const r = D.appendDiaryMemory({ dateKey: key, paragraphIndex: 0, contentType: "event" });
  report(r);
}
main().catch((e) => report({ ok: false, error: String(e?.message || e) }));
