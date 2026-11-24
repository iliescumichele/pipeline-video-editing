// bun run bench [--from work/<id>] [--candidates qwen27b,gemma4,...] [--tasks meaning,vision,rank,copy] [--into <id banco>]
//
// Banco di prova dei modelli sui compiti veri della pipeline. Prende i compiti già eseguiti in
// work/<id>/llm/ (stesso system, input, schema e immagini), li fa risolvere a ogni candidato di
// config/routing.json e misura tempo e costo. Poi il giudice (routing.tasks.judge, Opus) valuta
// alla cieca le risposte di ogni campione. Con --into si rifanno quei compiti dentro un banco già
// esistente (es. dopo un errore) e se ne rigiudicano i campioni. Tutto finisce in data/bench/<run>/:
// results.json è quello che legge la dashboard, dove si vota anche a coppie senza sapere quale modello è quale.
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PATHS, ROOT } from '../lib/env';
import { llm, runTask, type LlmTask } from '../lib/llm';
import { readRouting, toLlmTask, type Candidate } from '../lib/routing';

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: { from: { type: 'string' }, candidates: { type: 'string' }, tasks: { type: 'string' }, into: { type: 'string' } },
});

/** Campioni per compito: le sottocartelle di work/<id>/llm/<compito> da usare. */
const SAMPLES: Record<string, string[]> = {
  meaning: ['001', '004', '008'],
  vision: ['c02', 'c07', 'c13', 'c16'],
  rank: ['.'],
  copy: ['s01', 's03', 's05'],
};

export interface BenchRun {
  task: string;
  sample: string;
  candidate: string;
  ok: boolean;
  seconds: number;
  cost_usd?: number;
  error?: string;
  output?: unknown;
}

export interface BenchJudgement {
  task: string;
  sample: string;
  /** voto 1–10 del giudice per candidato */
  scores: Record<string, number>;
  reasons: Record<string, string>;
}

export interface BenchResults {
  id: string;
  from: string;
  created_at: string;
  candidates: Candidate[];
  runs: BenchRun[];
  judgements: BenchJudgement[];
}

const routing = await readRouting();
const wanted = values.candidates?.split(',');
const candidates = routing.candidates.filter((c) => !wanted || wanted.includes(c.id));
const tasks = (values.tasks?.split(',') ?? Object.keys(SAMPLES)).filter((t) => SAMPLES[t]);
const id = values.into ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const dir = join(ROOT, 'data', 'bench', id);
mkdirSync(dir, { recursive: true });
const previous = values.into ? ((await Bun.file(join(dir, 'results.json')).json()) as BenchResults) : undefined;
const from = resolve(values.from ?? previous?.from ?? latestWork());
console.log(`Banco di prova ${id}${previous ? ' (aggiornamento)' : ''}\nCompiti da ${from}\nCandidati: ${candidates.map((c) => c.id).join(', ')}\n`);

const results: BenchResults = previous
  ? {
      ...previous,
      runs: previous.runs.filter((r) => !(tasks.includes(r.task) && candidates.some((c) => c.id === r.candidate))),
      judgements: previous.judgements.filter((j) => !tasks.includes(j.task)),
    }
  : { id, from, created_at: new Date().toISOString(), candidates, runs: [], judgements: [] };
const save = () => Bun.write(join(dir, 'results.json'), JSON.stringify(results, null, 2));

// I candidati locali uno alla volta (si carica un modello, si fanno tutti i compiti, si scarica).
for (const cand of candidates) {
  for (const task of tasks) {
    for (const sample of SAMPLES[task]!) {
      const src = join(from, 'llm', task, sample);
      if (!existsSync(join(src, 'input.md'))) {
        console.log(`  ${task}/${sample}: manca in ${from}, salto`);
        continue;
      }
      const orig = (await Bun.file(join(src, 'task.json')).json()) as LlmTask;
      const tdir = join(dir, task, sample === '.' ? 'main' : sample, cand.id);
      mkdirSync(tdir, { recursive: true });
      for (const f of ['system.md', 'input.md', 'schema.json']) cpSync(join(src, f), join(tdir, f));
      const images = (orig.images ?? []).map((p) => (p.startsWith('/') ? p : join(src, p)));
      const t = toLlmTask(cand, { images, think: false, temperature: orig.temperature, max_tokens: orig.max_tokens, timeout_s: 900 });
      const t0 = performance.now();
      const run: BenchRun = { task, sample, candidate: cand.id, ok: false, seconds: 0 };
      try {
        run.output = await runTask(tdir, t, await Bun.file(join(tdir, 'system.md')).text(), await Bun.file(join(tdir, 'input.md')).text(), await Bun.file(join(tdir, 'schema.json')).json());
        run.ok = true;
        const meta = (await Bun.file(join(tdir, 'meta.json')).json()) as { cost_usd?: number; duration_s: number };
        run.seconds = meta.duration_s;
        run.cost_usd = meta.cost_usd;
      } catch (e) {
        run.seconds = Math.round((performance.now() - t0) / 100) / 10;
        run.error = (e as Error).message.split('\n').slice(-2).join(' ');
      }
      results.runs.push(run);
      console.log(`  ${cand.id.padEnd(12)} ${task}/${sample}: ${run.ok ? 'ok' : `ERRORE ${run.error}`} ${run.seconds} s${run.cost_usd ? `, $${run.cost_usd.toFixed(4)}` : ''}`);
      await save();
    }
  }
  if (cand.provider === 'local') await llm(['down', 'qwen']);
}

// Giudizio alla cieca: le risposte di ogni campione con lettere al posto dei nomi.
const judge = routing.tasks.judge;
const judgeSchema = {
  type: 'object',
  properties: {
    notes: { type: 'string', maxLength: 1500 },
    scores: {
      type: 'array',
      items: {
        type: 'object',
        properties: { label: { type: 'string' }, score: { type: 'integer', minimum: 1, maximum: 10 }, reason: { type: 'string', maxLength: 300 } },
        required: ['label', 'score', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['notes', 'scores'],
  additionalProperties: false,
};
const judgeSystem = `You are judging answers from different models to the same task of a GTA shorts pipeline. You get the original task (instructions, input, and the frames when the task has images) and the answers, labelled A, B, C… in random order. Score each answer 1–10 for how well it does the task: correctness against the input, usefulness for the channel, following the instructions and the format. Be strict and consistent; ignore length unless it hurts the task.`;
for (const task of tasks) {
  for (const sample of SAMPLES[task]!) {
    const runs = results.runs.filter((r) => r.task === task && r.sample === sample && r.ok);
    if (runs.length < 2) continue;
    const shuffled = [...runs].sort(() => Math.random() - 0.5);
    const labels = shuffled.map((_, i) => String.fromCharCode(65 + i));
    const src = join(from, 'llm', task, sample);
    const orig = (await Bun.file(join(src, 'task.json')).json()) as LlmTask;
    const input = [
      `## Task instructions\n${await Bun.file(join(src, 'system.md')).text()}`,
      `## Task input\n${await Bun.file(join(src, 'input.md')).text()}`,
      ...shuffled.map((r, i) => `## Answer ${labels[i]}\n${JSON.stringify(r.output, null, 1)}`),
    ].join('\n\n');
    const jdir = join(dir, task, sample === '.' ? 'main' : sample, '_judge');
    try {
      const out = await runTask<{ scores: { label: string; score: number; reason: string }[] }>(
        jdir,
        toLlmTask(judge, { images: (orig.images ?? []).map((p) => (p.startsWith('/') ? p : join(src, p))), timeout_s: 600 }),
        judgeSystem,
        input,
        judgeSchema,
      );
      const j: BenchJudgement = { task, sample, scores: {}, reasons: {} };
      for (const s of out.scores) {
        const r = shuffled[labels.indexOf(s.label)];
        if (!r) continue;
        j.scores[r.candidate] = s.score;
        j.reasons[r.candidate] = s.reason;
      }
      results.judgements.push(j);
      console.log(`  giudice ${task}/${sample}: ${Object.entries(j.scores).map(([c, s]) => `${c} ${s}`).join(', ')}`);
    } catch (e) {
      console.log(`  giudice ${task}/${sample}: ERRORE ${(e as Error).message.split('\n').at(-1)}`);
    }
    await save();
  }
}
console.log(`\nFatto: ${join(dir, 'results.json')}`);

function latestWork(): string {
  const dirs = readdirSync(PATHS.work)
    .filter((d) => existsSync(join(PATHS.work, d, '07-copy', 'done.json')))
    .map((d) => ({ d, t: Bun.file(join(PATHS.work, d, '07-copy', 'done.json')).lastModified }))
    .sort((a, b) => b.t - a.t);
  if (!dirs[0]) throw new Error('nessuna corsa completa in work/: passa --from');
  return join(PATHS.work, dirs[0].d);
}
