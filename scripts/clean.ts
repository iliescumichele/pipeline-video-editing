// bun run clean [--work] — cancella tutto quello che `bun run setup` reinstalla:
// node_modules, Python e librerie, modelli, cache. Restano sorgenti, lockfile e out/.
// Con --work cancella anche work/ (i file intermedi della pipeline, si rigenerano).
import { existsSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT } from '../src/lib/env';

const targets = ['node_modules', 'remotion/node_modules', 'studio/node_modules', 'python/.venv', 'models', '.tools'];
if (process.argv.includes('--work')) targets.push('work');

function sizeKb(path: string): number {
  const out = Bun.spawnSync(['du', '-sk', path]).stdout.toString();
  return Number.parseInt(out, 10) || 0;
}

let freedKb = 0;
for (const rel of targets) {
  const path = join(ROOT, rel);
  if (relative(ROOT, path).startsWith('..') || !existsSync(path)) continue;
  const kb = sizeKb(path);
  rmSync(path, { recursive: true, force: true });
  freedKb += kb;
  console.log(`  cancellato ${rel} (${(kb / 1024 / 1024).toFixed(2)} GB)`);
}

console.log(freedKb ? `Liberati ${(freedKb / 1024 / 1024).toFixed(2)} GB. Per reinstallare: bun run setup` : 'Niente da cancellare.');
