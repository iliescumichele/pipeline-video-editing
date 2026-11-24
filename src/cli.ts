// bun run shorts <video> [--vertical file] [--lucio-log file] [--out dir] [--count 8]
//                        [--force fase,fase] [--until fase]
//
// Ogni fase scrive in work/<id>/<fase>/ e si salta se è già fatta con gli stessi ingressi.
// --force rifà le fasi indicate, --until si ferma dopo la fase indicata.
import { existsSync, mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PATHS } from './lib/env';
import { projectId } from './gameplay/edit';
import { shortsDir } from './lib/project';
import { llm } from './lib/llm';
import { fmtDuration, type Ctx } from './lib/stage';
import { ingest, type Ingest } from './stages/ingest';
import { audio } from './stages/audio';
import { candidates } from './stages/candidates';
import { copy } from './stages/copy';
import { output } from './stages/output';
import { rank } from './stages/rank';
import { render } from './stages/render';
import { signals } from './stages/signals';
import { checkSpace, shortsSpace } from './lib/space';
import { probe } from './lib/ff';
import { vision } from './stages/vision';
import { transcribe } from './stages/transcribe';

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    vertical: { type: 'string' },
    'lucio-log': { type: 'string' },
    out: { type: 'string' },
    count: { type: 'string', default: '8' },
    force: { type: 'string' },
    until: { type: 'string' },
  },
});

const video = positionals[0] && resolve(positionals[0]);
if (!video) {
  console.error('uso: bun run shorts <video> [--vertical file] [--lucio-log file] [--out dir] [--count 8] [--force fase,fase] [--until fase]');
  process.exit(2);
}
for (const f of [video, values.vertical, values['lucio-log']]) {
  if (f && !existsSync(f)) {
    console.error(`file non trovato: ${f}`);
    process.exit(2);
  }
}

const id = projectId(video);
const ctx: Ctx = {
  id,
  video,
  vertical: values.vertical && resolve(values.vertical),
  lucioLog: values['lucio-log'] && resolve(values['lucio-log']),
  count: Number(values.count),
  workDir: join(PATHS.work, id),
  outDir: values.out ? join(resolve(values.out), id) : shortsDir(id),
  force: new Set((values.force ?? '').split(',').filter(Boolean)),
};
mkdirSync(ctx.workDir, { recursive: true });
console.log(`Video: ${basename(video)}\nID: ${id}\nLavoro: ${ctx.workDir}\n`);
{
  const info = await probe(video);
  checkSpace(
    shortsSpace({ duration: info.duration, ingestDone: existsSync(join(ctx.workDir, '01-ingest', 'done.json')), separate: info.audio.length >= 3 || existsSync(video.replace(/\.mp4$/i, '.tracce.m4a')) }),
    'gli short',
  );
}

const t0 = performance.now();
const done = (prefix: string) => !!values.until?.startsWith(prefix);
run: {
  const ing: Ingest = await ingest(ctx);
  if (done('01')) break run;
  const tr = await transcribe(ctx, ing);
  if (done('02')) break run;
  const sig = await signals(ctx, ing, tr);
  if (done('03')) break run;
  const cands = await candidates(ctx, ing, tr, sig);
  if (done('04')) break run;
  const vis = await vision(ctx, ing, cands);
  if (done('05')) break run;
  const picks = await rank(ctx, ing, tr, sig, cands, vis);
  if (done('06')) break run;
  const shorts = await copy(ctx, ing, tr, sig, picks, vis);
  if (done('07')) break run;
  const rendered = await render(ctx, ing, tr, sig, shorts, vis);
  if (done('08')) break run;
  const mixed = await audio(ctx, ing, shorts, rendered);
  if (done('09')) break run;
  await output(ctx, ing, sig, cands, vis, shorts, rendered, mixed, t0);
  // Qwen non serve più: si libera la memoria (il server resta acceso se ci sono altri modelli).
  await llm(['down']);
  console.log(`\nShort e review: ${join(ctx.outDir, 'review.html')}`);
}
console.log(`\nTotale: ${fmtDuration((performance.now() - t0) / 1000)}`);
