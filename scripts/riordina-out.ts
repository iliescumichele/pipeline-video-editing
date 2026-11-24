// bun scripts/riordina-out.ts [--prova] — porta i file delle versioni di prima alla cartella unica per video
// (src/lib/project.ts). Si può rilanciare: quello che è già a posto resta com'è. Con --prova dice solo cosa farebbe.
//
//   out/<id del video finale>/s01.mp4…           → out/<id della registrazione>/short/
//   work/<id del video finale>/                  → work/<id della registrazione>/ (percorsi nei .json riscritti)
//   data/gameplay/<id>/video-finale-720p.mp4     → out/<id>/copia-720p.mp4
//   da-pubblicare/<nome del video>/              → out/<id>/da-pubblicare/
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { db } from '../src/dashboard/db';
import { archivePath, gameplayIdOf, gameplayIds, keepDir } from '../src/gameplay/edit';
import { PATHS, ROOT } from '../src/lib/env';
import { publishDir, shortsDir } from '../src/lib/project';

const dry = process.argv.includes('--prova');
const move = (from: string, to: string) => {
  console.log(`  ${from.replace(`${ROOT}/`, '')} → ${to.replace(`${ROOT}/`, '')}`);
  if (dry) return;
  if (existsSync(to)) throw new Error(`c'è già: ${to}`);
  mkdirSync(join(to, '..'), { recursive: true });
  renameSync(from, to);
};
/** Toglie una cartella rimasta vuota (a parte .DS_Store). */
const dropEmpty = (dir: string) => {
  if (dry || !existsSync(dir)) return;
  rmSync(join(dir, '.DS_Store'), { force: true });
  if (!readdirSync(dir).length) rmdirSync(dir);
};
/** Riscrive i percorsi dentro i file di testo di una cartella di lavoro spostata. */
const rewrite = (dir: string, from: string, to: string) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) rewrite(p, from, to);
    else if (/\.(json|jsonl)$/.test(e.name)) {
      const s = readFileSync(p, 'utf8');
      if (s.includes(from)) writeFileSync(p, s.replaceAll(from, to));
    }
  }
};
const SHORT_FILE = /^(s\d+\.(mp4|jpg|json)|review\.html|REPORT\.md)$/;

// 1. Corse di short: la cartella di lavoro va sotto l'id del video (quello della registrazione per un gameplay),
// e gli short in out/<id>/short/.
for (const old of existsSync(PATHS.work) ? readdirSync(PATHS.work) : []) {
  const done = join(PATHS.work, old, '01-ingest', 'done.json');
  if (old.startsWith('_') || !existsSync(done)) continue;
  const source = (JSON.parse(readFileSync(done, 'utf8')) as { result?: { main?: { path?: string } } }).result?.main?.path;
  const id = (source && gameplayIdOf(source)) ?? old;
  if (id !== old) {
    console.log(`Short di ${basename(source!)}: ${old} → ${id}`);
    const from = join(PATHS.work, old);
    const to = join(PATHS.work, id);
    if (!dry) mkdirSync(to, { recursive: true });
    for (const e of readdirSync(from)) {
      if (e === '.DS_Store') continue;
      move(join(from, e), join(to, e));
      if (!dry && statSync(join(to, e)).isDirectory()) rewrite(join(to, e), `/work/${old}/`, `/work/${id}/`);
      else if (!dry && /\.(json|jsonl)$/.test(e)) {
        const p = join(to, e);
        writeFileSync(p, readFileSync(p, 'utf8').replaceAll(`/work/${old}/`, `/work/${id}/`));
      }
    }
    dropEmpty(from);
    const n = dry ? 0 : db.run('UPDATE short_reviews SET run_id = ? WHERE run_id = ?', [id, old]).changes;
    console.log(`  revisioni spostate: ${n}`);
  }
  const outOld = join(PATHS.out, old);
  if (existsSync(outOld)) {
    const files = readdirSync(outOld).filter((f) => SHORT_FILE.test(f));
    if (files.length) console.log(`Short in ${shortsDir(id).replace(`${ROOT}/`, '')}: ${files.length} file`);
    for (const f of files) move(join(outOld, f), join(shortsDir(id), f));
    if (id !== old) dropEmpty(outOld);
  }
}

// 2. Copia a 720p dei gameplay: accanto al video finale.
for (const id of gameplayIds()) {
  const old = join(keepDir(id), 'video-finale-720p.mp4');
  if (existsSync(old) && !existsSync(archivePath(id))) {
    console.log(`Copia a 720p di ${id}`);
    move(old, archivePath(id));
  }
}

// 3. Short approvati: da da-pubblicare/<nome del video>/ alla cartella del video.
const oldPublish = join(ROOT, 'da-pubblicare');
if (existsSync(oldPublish)) {
  const owner = new Map<string, string>();
  for (const id of readdirSync(PATHS.out)) {
    const s01 = join(shortsDir(id), 's01.json');
    const video = existsSync(s01) ? (JSON.parse(readFileSync(s01, 'utf8')) as { video?: string }).video : undefined;
    if (video) owner.set(basename(video, extname(video)), id);
  }
  for (const name of readdirSync(oldPublish)) {
    const dir = join(oldPublish, name);
    if (name === '.DS_Store' || !statSync(dir).isDirectory()) continue;
    const id = owner.get(name);
    if (!id) {
      console.log(`da-pubblicare/${name}: non so di quale video è, resta dov'è`);
      continue;
    }
    console.log(`Approvati di ${name}`);
    for (const f of readdirSync(dir)) if (f !== '.DS_Store') move(join(dir, f), join(publishDir(id), f));
    dropEmpty(dir);
  }
  dropEmpty(oldPublish);
}
console.log(dry ? '\nProva: niente è stato spostato.' : '\nFatto.');
