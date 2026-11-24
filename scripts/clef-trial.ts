// bun scripts/clef-trial.ts <work/<id>>
//
// Confronta Clef-Flash (backend decide di llm.ts) con quello che la pipeline ha già fatto con Qwen
// sullo stesso video, senza toccare work/<id>/ fuori da clef-trial/:
//   1. controllo visivo dei candidati: stesse 5 immagini, stesse domande, più la webcam per riquadro
//   2. classifica: voto di Clef per candidato contro i voti di Claude sugli short e l'ordine di Qwen
//   3. rilevatore veloce: Clef sulla trascrizione a finestre di 20 s, contro i momenti di Qwen
// Scrive clef-trial/RESULTS.md e i JSON dei confronti.
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { llm, runTask } from '../src/lib/llm';
import type { Signal } from '../src/lib/signal';
import { timedText, type Transcript } from '../src/lib/transcript';
import type { Candidate } from '../src/stages/candidates';
import type { Short } from '../src/stages/copy';
import type { SceneInfo } from '../src/stages/signals';
import type { Vision } from '../src/stages/vision';

const work = resolve(process.argv[2] ?? '');
if (!existsSync(join(work, '05-vision', 'vision.json'))) {
  console.error('uso: bun scripts/clef-trial.ts <work/<id>> (serve una corsa completa della pipeline)');
  process.exit(2);
}
const out = join(work, 'clef-trial');
mkdirSync(out, { recursive: true });

const cands = (await Bun.file(join(work, '04-candidates', 'candidates.json')).json()) as Candidate[];
const vis = (await Bun.file(join(work, '05-vision', 'vision.json')).json()) as Vision[];
const shorts = (await Bun.file(join(work, '07-copy', 'shorts.json')).json()) as Short[];
const transcript = (await Bun.file(join(work, '02-transcribe', 'transcript.json')).json()) as Transcript;
const scenes = (await Bun.file(join(work, '03-signals', 'scenes', 'scenes.json')).json()) as SceneInfo;
const meaning = ((await Bun.file(join(work, '03-signals', 'meaning', 'done.json')).json()) as { result: Signal }).result;

await llm(['up', 'clef']);
type Answers = Record<string, { noul?: number; score?: number; probabilities?: Record<string, number> }>;
const decide = (dir: string, state: string, questions: object, images: string[] = []) =>
  runTask<Answers>(join(out, dir), { backend: 'decide', images }, '', state, questions);
const ms = async <T>(f: () => Promise<T>): Promise<[T, number]> => {
  const t0 = performance.now();
  const r = await f();
  return [r, performance.now() - t0];
};
const lines: string[] = ['# Prova Clef-Flash contro Qwen', ''];

// ─── 1. controllo visivo ───
const VISION_Q = {
  graphic_violence_first7s: { type: 'noul', instructions: 'Do images 1 and 4 (the first 7 seconds) show graphic violence: blood, gore, a visibly injured or dead person, or a close-up of someone being shot or killed? Police chases, car crashes, distant explosions and holding a gun do not count.' },
  cutscene: { type: 'noul', instructions: 'Do the frames show a scripted cutscene (letterbox bars, no HUD, cinematic camera) instead of gameplay?' },
  ingame_screen: { type: 'noul', instructions: 'Do the frames mainly show an in-game TV, phone, computer, map, menu or loading screen?' },
  standalone: { type: 'noul', instructions: 'Can a viewer with no context follow what happens in the clip?' },
  wide_shot: { type: 'noul', instructions: 'Is the important action spread across the frame so that a vertical crop of about one third of the width would cut it?' },
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => [
      `webcam_${i + 1}`,
      { type: 'noul', instructions: `In image 5 (a 4×3 grid of frames numbered 1–12, left to right, top to bottom), does tile ${i + 1} mainly show a real person filling the frame (a webcam) instead of the game? A small facecam in a corner does not count.` },
    ]),
  ),
};
const visRows: { id: string; ms: number; flags: Record<string, [boolean, number]>; webcamQwen: number[]; webcamClef: number[]; webcamFaces: number[] }[] = [];
for (const c of cands) {
  const v = vis.find((x) => x.id === c.id)!;
  const state = `Five images from one candidate clip of a GTA gameplay recording: 1 first frame, 2 peak frame, 3 last frame, 4 a 2×2 grid of seconds 1, 3, 5, 7, 5 a 4×3 grid over the whole clip.\nWhat the streamer says (Italian):\n${c.transcript.slice(0, 1500)}`;
  const [a, t] = await ms(() => decide(join('vision', c.id), state, VISION_Q, [v.frames.start, v.frames.peak, v.frames.end, v.frames.first7s, v.frames.timeline]));
  const flags: Record<string, [boolean, number]> = {};
  for (const k of ['graphic_violence_first7s', 'cutscene', 'ingame_screen', 'standalone', 'wide_shot'] as const) flags[k] = [v[k], a[k]!.noul!];
  const tileTime = (k: number) => v.timeline.t0 + (k - 1) * v.timeline.step;
  const webcamFaces = Array.from({ length: 12 }, (_, i) => i + 1).filter((k) => scenes.webcam.some((w) => tileTime(k) >= w.s - 0.5 && tileTime(k) <= w.e + 0.5));
  const webcamClef = Array.from({ length: 12 }, (_, i) => i + 1).filter((k) => a[`webcam_${k}`]!.noul! >= 0.5);
  visRows.push({ id: c.id, ms: t, flags, webcamQwen: v.webcam_tiles, webcamClef, webcamFaces });
  console.log(`vision ${c.id}: ${(t / 1000).toFixed(1)} s, webcam Qwen ${JSON.stringify(v.webcam_tiles)} Clef ${JSON.stringify(webcamClef)} volti ${JSON.stringify(webcamFaces)}`);
}
await Bun.write(join(out, 'vision.json'), JSON.stringify(visRows, null, 2));
const qwenVisionS = vis.length ? cands.reduce((a, c) => a + metaSeconds(join(work, 'llm', 'vision', c.id)), 0) : 0;
lines.push('## 1. Controllo visivo (16 candidati, stesse immagini)', '');
lines.push(`Tempo: Clef ${(visRows.reduce((a, r) => a + r.ms, 0) / 1000).toFixed(0)} s in tutto, Qwen ${qwenVisionS.toFixed(0)} s.`, '');
lines.push('| Domanda | Accordo Clef/Qwen | Dove non sono d\'accordo (Qwen → Clef p) |', '| --- | ---: | --- |');
for (const k of ['graphic_violence_first7s', 'cutscene', 'ingame_screen', 'standalone', 'wide_shot']) {
  const diff = visRows.filter((r) => r.flags[k]![0] !== r.flags[k]![1] >= 0.5);
  lines.push(`| ${k} | ${visRows.length - diff.length}/${visRows.length} | ${diff.map((r) => `${r.id}: ${r.flags[k]![0] ? 'sì' : 'no'} → ${r.flags[k]![1].toFixed(2)}`).join(', ') || '—'} |`);
}
const tiles = (sel: (r: (typeof visRows)[number]) => number[]) => visRows.flatMap((r) => sel(r).map((k) => `${r.id}:${k}`));
const facesSet = new Set(tiles((r) => r.webcamFaces));
const score = (set: string[]) => `${set.filter((x) => facesSet.has(x)).length} su ${set.length} confermati dai volti`;
lines.push('', `Webcam per riquadro (riferimento: rilevamento dei volti, ${facesSet.size} riquadri). Qwen: ${score(tiles((r) => r.webcamQwen))}. Clef: ${score(tiles((r) => r.webcamClef))}.`);
lines.push(`Riquadri dei volti trovati da Qwen: ${[...facesSet].filter((x) => tiles((r) => r.webcamQwen).includes(x)).length}/${facesSet.size}; da Clef: ${[...facesSet].filter((x) => tiles((r) => r.webcamClef).includes(x)).length}/${facesSet.size}.`, '');

// ─── 2. classifica ───
const RANK_Q = {
  entertaining: { type: 'score', instructions: 'How entertaining is this clip as a vertical short for a GTA gameplay channel?', criteria: ['boring', 'mildly interesting', 'fun', 'very funny or exciting', 'must-watch'] },
  hook: { type: 'score', instructions: 'Does something grab attention in the first seconds?', criteria: ['nothing happens at the start', 'something starts to happen', 'strong hook right away'] },
  payoff: { type: 'noul', instructions: 'Is there a clear payoff, punchline or strong reaction?' },
  standalone: { type: 'noul', instructions: 'Does it make sense to a viewer who has never seen the stream?' },
};
const rankRows: { id: string; clef: number; claude?: number; qwenRank?: number }[] = [];
for (const c of cands) {
  const v = vis.find((x) => x.id === c.id);
  const state = [
    `Candidate clip ${c.id}, ${(c.e - c.s).toFixed(0)} s, from a GTA gameplay recording. The streamer speaks Italian.`,
    `Signals (0–1): ${Object.entries(c.signals).map(([k, x]) => `${k} ${x}`).join(', ')}. Labels: ${c.labels.join(', ')}.`,
    c.why ? `Transcript reading: ${c.why}` : '',
    v ? `On screen: ${v.what}` : '',
    `Transcript:\n${timedText(transcript, c.s, c.e)}`,
  ].filter(Boolean).join('\n');
  const a = await decide(join('rank', c.id), state, RANK_Q);
  const clef = a.entertaining!.score! / 4 + a.hook!.score! / 2 + a.payoff!.noul! + a.standalone!.noul!;
  const sh = shorts.find((x) => x.candidate === c.id);
  rankRows.push({ id: c.id, clef: Math.round(clef * 100) / 100, claude: sh?.copy.score, qwenRank: sh && !sh.adjusted.some((x) => x.includes('--count')) ? sh.rank : undefined });
}
await Bun.write(join(out, 'rank.json'), JSON.stringify(rankRows, null, 2));
const judged = rankRows.filter((r) => r.claude !== undefined);
const byQwen = judged.filter((r) => r.qwenRank !== undefined);
lines.push('## 2. Classifica', '', 'Voto Clef = intrattenimento + gancio + payoff + comprensibile (0–4). Riferimento: il voto di Claude sugli short che ne sono usciti.', '');
lines.push('| Candidato | Voto Clef | Posizione Clef | Voto Claude | Posizione Qwen |', '| --- | ---: | ---: | ---: | ---: |');
const clefOrder = [...rankRows].sort((a, b) => b.clef - a.clef).map((r) => r.id);
for (const r of [...rankRows].sort((a, b) => b.clef - a.clef)) lines.push(`| ${r.id} | ${r.clef} | ${clefOrder.indexOf(r.id) + 1} | ${r.claude ?? ''} | ${r.qwenRank ?? ''} |`);
lines.push('', `Correlazione di Spearman con il voto di Claude: Clef ${spearman(judged.map((r) => r.clef), judged.map((r) => r.claude!)).toFixed(2)} (${judged.length} short), Qwen ${spearman(byQwen.map((r) => -r.qwenRank!), byQwen.map((r) => r.claude!)).toFixed(2)} (${byQwen.length} short scelti da Qwen).`, '');

// ─── 3. rilevatore veloce sulla trascrizione ───
const DETECT_Q = {
  moment: { type: 'score', instructions: 'How likely is it that this stretch contains a funny moment, a punchline or a strong reaction to something in the game?', criteria: ['very unlikely', 'unlikely', 'possible', 'likely', 'very likely'] },
};
const dur = transcript.duration;
const det: { t: number; p: number }[] = [];
const t0 = performance.now();
for (let s = 0; s + 10 < dur; s += 5) {
  const text = timedText(transcript, s, s + 20);
  if (!text.trim()) continue;
  const a = await decide(join('detect', String(Math.round(s)).padStart(5, '0')), `Stretch of a GTA stream transcript (Italian), seconds ${s}–${s + 20}:\n${text}`, DETECT_Q);
  det.push({ t: s + 10, p: a.moment!.score! / 4 });
}
const detS = (performance.now() - t0) / 1000;
await Bun.write(join(out, 'detect.json'), JSON.stringify(det));
const top = [...det].sort((a, b) => b.p - a.p).filter((x, i, arr) => arr.slice(0, i).every((y) => Math.abs(y.t - x.t) >= 30)).slice(0, 15);
const hit = top.filter((x) => meaning.windows.some((w) => x.t >= w.s - 5 && x.t <= w.e + 5)).length;
const qwenMeaningS = metaSecondsDir(join(work, 'llm', 'meaning'));
lines.push('## 3. Rilevatore veloce sulla trascrizione', '');
lines.push(`${det.length} finestre da 20 s ogni 5 s in ${detS.toFixed(0)} s (Qwen sui blocchi da 3 minuti: ${qwenMeaningS.toFixed(0)} s).`);
lines.push(`Dei 15 picchi più alti di Clef (distanti almeno 30 s), ${hit} cadono dentro un momento trovato da Qwen (${meaning.windows.length} momenti).`, '');
lines.push('| Picco Clef | p | Dentro un momento di Qwen |', '| ---: | ---: | --- |');
for (const x of top) lines.push(`| ${fmt(x.t)} | ${x.p.toFixed(2)} | ${meaning.windows.find((w) => x.t >= w.s - 5 && x.t <= w.e + 5)?.label ?? '—'} |`);
await Bun.write(join(out, 'RESULTS.md'), `${lines.join('\n')}\n`);
await llm(['down', 'clef']);
console.log(`\n${join(out, 'RESULTS.md')}`);

function metaSeconds(dir: string): number {
  const p = join(dir, 'meta.json');
  return existsSync(p) ? ((JSON.parse(readFileSync(p, 'utf8')) as { duration_s: number }).duration_s) : 0;
}
function metaSecondsDir(dir: string): number {
  return existsSync(dir) ? readdirSync(dir).reduce((a, x) => a + metaSeconds(join(dir, x)), 0) : 0;
}
function spearman(a: number[], b: number[]): number {
  const rank = (xs: number[]) => {
    const order = xs.map((x, i) => [x, i] as const).sort((p, q) => p[0] - q[0]);
    const r = new Array(xs.length);
    for (let i = 0; i < order.length; ) {
      let j = i;
      while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
      for (let k = i; k <= j; k++) r[order[k]![1]] = (i + j) / 2;
      i = j + 1;
    }
    return r as number[];
  };
  const ra = rank(a);
  const rb = rank(b);
  const m = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const ma = m(ra);
  const mb = m(rb);
  const cov = ra.reduce((s, x, i) => s + (x - ma) * (rb[i]! - mb), 0);
  const sd = (xs: number[], mx: number) => Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0));
  return cov / (sd(ra, ma) * sd(rb, mb) || 1);
}
function fmt(t: number): string {
  return `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`;
}
