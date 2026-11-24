import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { BenchResults } from '../bench/bench';
import { DATA, db, now } from './db';

const BENCH = join(DATA, 'bench');

export function benchRuns(): BenchResults[] {
  if (!existsSync(BENCH)) return [];
  return readdirSync(BENCH)
    .filter((d) => existsSync(join(BENCH, d, 'results.json')))
    .sort()
    .reverse()
    .map((d) => JSON.parse(readFileSync(join(BENCH, d, 'results.json'), 'utf8')) as BenchResults)
    .filter((r) => r.runs.length > 0);
}

/** Tabella per compito e candidato: tempo, costo, voto del giudice e i tuoi voti alla cieca. */
export function benchSummary(id?: string) {
  const all = benchRuns();
  const b = (id && all.find((x) => x.id === id)) || all.find((x) => x.candidates.length > 2) || all[0];
  if (!b) return null;
  const votes = db.query('SELECT * FROM bench_votes WHERE bench_id = ?').all(b.id) as { task: string; a: string; b: string; winner: string }[];
  const tasks = [...new Set(b.runs.map((r) => r.task))];
  const rows = tasks.flatMap((task) =>
    b.candidates.map((c) => {
      const runs = b.runs.filter((r) => r.task === task && r.candidate === c.id);
      const ok = runs.filter((r) => r.ok);
      const judged = b.judgements.filter((j) => j.task === task && j.scores[c.id] !== undefined).map((j) => j.scores[c.id]!);
      const mine = votes.filter((v) => v.task === task && (v.a === c.id || v.b === c.id));
      const wins = mine.filter((v) => (v.winner === 'a' && v.a === c.id) || (v.winner === 'b' && v.b === c.id)).length;
      const ties = mine.filter((v) => v.winner === 'pari').length;
      return {
        task,
        candidate: c.id,
        label: c.label,
        provider: c.provider,
        runs: runs.length,
        failed: runs.length - ok.length,
        seconds: avg(ok.map((r) => r.seconds)),
        cost_usd: c.provider === 'claude' ? avg(ok.map((r) => r.cost_usd ?? 0)) : 0,
        judge: avg(judged),
        votes: mine.length,
        win_rate: mine.length ? (wins + ties / 2) / mine.length : null,
      };
    }),
  );
  return { id: b.id, from: b.from, created_at: b.created_at, candidates: b.candidates, rows, votes: votes.length, reasons: b.judgements };
}

const pending = new Map<string, { bench: string; task: string; sample: string; a: string; b: string }>();

/** Dati della corsa da cui vengono i campioni del banco: servono a mostrare il contesto del voto. */
function runData(from: string) {
  const read = (p: string) => (existsSync(join(from, p)) ? JSON.parse(readFileSync(join(from, p), 'utf8')) : null);
  const ingest = read('01-ingest/done.json')?.result;
  return {
    run: basename(from),
    width: ingest?.main?.video?.width ?? 1920,
    height: ingest?.main?.video?.height ?? 1080,
    candidates: (read('04-candidates/candidates.json') ?? []) as { id: string; s: number; e: number; peak: number; labels: string[]; why?: string; quote?: string; transcript: string }[],
    vision: (read('05-vision/vision.json') ?? []) as { id: string; what: string; frames: Record<string, string>; timeline: { t0: number; step: number } }[],
    shorts: (read('07-copy/shorts.json') ?? []) as { id: string; s: number; e: number; turn: number; peak: number; frames: Record<string, string> }[],
  };
}

const fileUrl = (p?: string) => (p ? `/media/file?path=${encodeURIComponent(p)}` : null);

/** Quello che serve per giudicare a occhio: trascrizione, frame, candidati o short, link al video sorgente. */
function pairContext(b: BenchResults, task: string, sample: string, input: string) {
  const d = runData(b.from);
  const base = { run: d.run, source_url: `/media/source/${encodeURIComponent(d.run)}`, aspect: d.width / d.height };
  if (task === 'meaning') {
    const block = input.match(/Block from (\d+) s to (\d+) s/);
    const lines = [...input.matchAll(/^\[(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\] (.*)$/gm)].map((m) => ({ s: Number(m[1]), e: Number(m[2]), text: m[3]! }));
    return { ...base, block: block ? { s: Number(block[1]), e: Number(block[2]) } : null, lines };
  }
  if (task === 'vision') {
    const c = d.candidates.find((x) => x.id === sample);
    const v = d.vision.find((x) => x.id === sample);
    return {
      ...base,
      candidate: c ? { id: c.id, s: c.s, e: c.e, peak: c.peak, labels: c.labels, transcript: c.transcript } : null,
      frames: v ? Object.fromEntries(Object.entries(v.frames).map(([k, p]) => [k, fileUrl(p)])) : null,
      timeline: v?.timeline ?? null,
    };
  }
  if (task === 'rank') {
    return {
      ...base,
      candidates: d.candidates.map((c) => ({
        id: c.id,
        s: c.s,
        e: c.e,
        peak: c.peak,
        labels: c.labels,
        why: c.why,
        what: d.vision.find((v) => v.id === c.id)?.what,
        thumb: fileUrl(d.vision.find((v) => v.id === c.id)?.frames.peak),
      })),
    };
  }
  if (task === 'copy') {
    const sh = d.shorts.find((x) => x.id === sample);
    const lines = [...input.matchAll(/^\[(\d+(?:\.\d+)?)\] (.*)$/gm)].map((m) => ({ s: Number(m[1]), text: m[2]! }));
    return {
      ...base,
      short: sh ? { id: sh.id, s: sh.s, e: sh.e, turn: sh.turn, peak: sh.peak } : null,
      frames: sh ? Object.fromEntries(Object.entries(sh.frames).map(([k, p]) => [k, fileUrl(p)])) : null,
      lines,
    };
  }
  return base;
}

/** Una coppia di risposte allo stesso campione, senza dire quale modello è quale. Prima le coppie meno votate. */
export function benchPair(id?: string, task?: string) {
  const s = benchSummary(id);
  if (!s) return null;
  const b = benchRuns().find((x) => x.id === s.id)!;
  const votes = db.query('SELECT task, sample, a, b FROM bench_votes WHERE bench_id = ?').all(b.id) as { task: string; sample: string; a: string; b: string }[];
  const count = (t: string, sample: string, x: string, y: string) =>
    votes.filter((v) => v.task === t && v.sample === sample && ((v.a === x && v.b === y) || (v.a === y && v.b === x))).length;
  const options: { task: string; sample: string; x: string; y: string; n: number }[] = [];
  for (const t of new Set(b.runs.map((r) => r.task))) {
    if (task && t !== task) continue;
    for (const sample of new Set(b.runs.filter((r) => r.task === t).map((r) => r.sample))) {
      const ok = b.runs.filter((r) => r.task === t && r.sample === sample && r.ok).map((r) => r.candidate);
      for (let i = 0; i < ok.length; i++) for (let j = i + 1; j < ok.length; j++) options.push({ task: t, sample, x: ok[i]!, y: ok[j]!, n: count(t, sample, ok[i]!, ok[j]!) });
    }
  }
  if (!options.length) return null;
  const min = Math.min(...options.map((o) => o.n));
  const pool = options.filter((o) => o.n === min);
  const o = pool[Math.floor(Math.random() * pool.length)]!;
  const [a, bb] = Math.random() < 0.5 ? [o.x, o.y] : [o.y, o.x];
  const token = crypto.randomUUID();
  pending.set(token, { bench: b.id, task: o.task, sample: o.sample, a, b: bb });
  const dir = join(BENCH, b.id, o.task, o.sample === '.' ? 'main' : o.sample, a);
  const input = existsSync(join(dir, 'input.md')) ? readFileSync(join(dir, 'input.md'), 'utf8') : '';
  const perTask = votes.reduce<Record<string, number>>((acc, v) => ((acc[v.task] = (acc[v.task] ?? 0) + 1), acc), {});
  return {
    token,
    task: o.task,
    sample: o.sample,
    remaining: options.filter((x) => x.n === 0).length,
    votes: perTask,
    tasks: [...new Set(b.runs.map((r) => r.task))],
    input,
    context: pairContext(b, o.task, o.sample, input),
    a: b.runs.find((r) => r.task === o.task && r.sample === o.sample && r.candidate === a)?.output,
    b: b.runs.find((r) => r.task === o.task && r.sample === o.sample && r.candidate === bb)?.output,
  };
}

/** Registra il voto e svela i due modelli, con voto e motivo del giudice, tempo e costo. */
export function benchVote(token: string, winner: 'a' | 'b' | 'pari') {
  const p = pending.get(token);
  if (!p) return null;
  pending.delete(token);
  db.run('INSERT INTO bench_votes (bench_id, task, sample, a, b, winner, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [p.bench, p.task, p.sample, p.a, p.b, winner, now()]);
  const b = benchRuns().find((x) => x.id === p.bench)!;
  const j = b.judgements.find((x) => x.task === p.task && x.sample === p.sample);
  const who = (c: string) => {
    const r = b.runs.find((x) => x.task === p.task && x.sample === p.sample && x.candidate === c);
    const cand = b.candidates.find((x) => x.id === c);
    return { id: c, label: cand?.label ?? c, provider: cand?.provider, judge: j?.scores[c] ?? null, reason: j?.reasons[c] ?? null, seconds: r?.seconds ?? null, cost_usd: r?.cost_usd ?? null };
  };
  return { a: who(p.a), b: who(p.b), winner };
}

function avg(xs: number[]): number | null {
  return xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 1000) / 1000 : null;
}
