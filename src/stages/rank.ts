import { join } from 'node:path';
import { loadPrompt, promptHash, runTask } from '../lib/llm';
import { route, toLlmTask } from '../lib/routing';
import type { SignalName } from '../lib/signal';
import { stage, stamp, type Ctx } from '../lib/stage';
import { loadTranscript, timedText, type Transcript } from '../lib/transcript';
import type { Candidate } from './candidates';
import type { Ingest } from './ingest';
import type { SceneInfo, Signals } from './signals';
import type { TranscribeResult } from './transcribe';
import type { Vision } from './vision';
import { overlapStory, type Segment, storyDuration } from '../lib/story';

export interface Pick {
  rank: number;
  /** id dello short: s01, s02… nell'ordine della classifica */
  id: string;
  candidate: string;
  /** i pezzi della storia, in ordine (secondi della sorgente) */
  segments: Segment[];
  /** inizio del primo pezzo e fine dell'ultimo */
  s: number;
  e: number;
  turn: number;
  reason: string;
  /** cosa ha corretto il codice rispetto alla proposta del modello */
  adjusted: string[];
}

const VERSION = 4;
const MIN_LEN = 30;
const MAX_LEN = 60;
const MIN_PART = 3;
/** Pezzi della stessa storia entro 15 minuti di registrazione. */
const SPAN = 15 * 60;
/** Con un modello locale: ragionamento vero (lento, una sola chiamata) o campo notes (veloce). */
const THINK = process.env.LUCIO_RANK_THINK === '1';

interface Proposal {
  id: string;
  turn: number;
  parts: { start: number; end: number; what: string }[];
  reason: string;
}

export async function rank(ctx: Ctx, ing: Ingest, tr: TranscribeResult, sig: Signals, cands: Candidate[], vis: Vision[]): Promise<Pick[]> {
  const r = await route('rank');
  const key = { VERSION, after: [stamp(ctx, '05-vision')], count: ctx.count, prompt: promptHash('rank'), think: THINK, route: r };
  return stage(ctx, '06-rank', key, async (dir) => {
    const t = await loadTranscript(tr.path);
    const dur = ing.main.duration;
    // circa 2 storie ogni mezz'ora, almeno quante ne chiede --count
    const n = Math.max(1, Math.min(cands.length, Math.max(ctx.count, Math.round(dur / 900))));
    const { system, schema } = await loadPrompt('rank');
    (schema as { properties: { stories: { maxItems?: number } } }).properties.stories.maxItems = n;
    // Webcam a tutto schermo: dai volti grandi (scene) e dai riquadri della vision.
    const scenes = (await Bun.file(String(sig.scenes.info?.path)).json()) as SceneInfo;
    const webcam = [...(scenes.webcam ?? []), ...vis.flatMap((v) => v.webcam ?? [])];
    const webcamIn = (segs: Segment[]) => webcam.reduce((a, w) => a + overlapStory(segs, w.s, w.e), 0);
    // Fuori dagli spunti: webcam per più di 2 s; cutscene e schermi del gioco se restano abbastanza alternative.
    let eligible = cands.filter((c) => webcamIn([c]) <= 2);
    const gameplay = eligible.filter((c) => {
      const v = vis.find((x) => x.id === c.id);
      return !v?.cutscene && !v?.ingame_screen;
    });
    if (gameplay.length >= n + 2) eligible = gameplay;
    const excluded = cands.filter((c) => !eligible.includes(c)).map((c) => c.id);
    if (excluded.length) console.log(`  esclusi dagli spunti: ${excluded.join(', ')} (webcam, cutscene o schermi del gioco)`);

    const missing = (Object.keys(sig) as SignalName[]).filter((k) => !sig[k].available);
    const blocks = eligible.map((c) => describe(c, vis.find((v) => v.id === c.id), t, missing));
    const input = [
      `Build at most ${n} stories from this ${Math.round(dur / 60)}-minute recording. Transcript language: ${t.language}.`,
      `# Candidate moments (${eligible.length})\n\n${blocks.join('\n\n')}`,
      `# Whole transcript\n\n${timedText(t) || '(no speech)'}`,
    ].join('\n\n');

    const out = await runTask<{ notes: string; stories: Proposal[] }>(
      join(ctx.workDir, 'llm', 'rank'),
      toLlmTask(r, { think: THINK, temperature: 0.2, max_tokens: THINK ? 16000 : 8192, timeout_s: 900 }),
      system,
      `${input}\n`,
      schema,
    );

    const picks: Pick[] = [];
    const add = (p: Proposal, note?: string) => {
      const c = cands.find((x) => x.id === p.id) ?? cands.find((x) => p.parts.some((q) => q.start < x.e && q.end > x.s));
      if (!c || picks.length >= n) return;
      const fixed = finalizeStory(p, c, t, dur);
      if (!fixed) return console.log(`  ${p.id} scartata: pezzi non validi`);
      if (picks.some((x) => x.segments.some((a) => overlapStory(fixed.segments, a.s, a.e) > 0))) return console.log(`  ${p.id} scartata: usa secondi di un'altra storia`);
      if (webcamIn(fixed.segments) > 0.5) return console.log(`  ${p.id} scartata: conterrebbe la webcam a tutto schermo`);
      if (note) fixed.adjusted.push(note);
      picks.push({ rank: picks.length + 1, id: `s${String(picks.length + 1).padStart(2, '0')}`, candidate: c.id, reason: p.reason, ...fixed });
    };
    for (const p of out.stories) add(p);
    // Se il modello non ha dato niente di valido, almeno il candidato migliore come pezzo unico.
    if (!picks.length && eligible.length) {
      const c = [...eligible].sort((a, b) => b.score - a.score)[0]!;
      add({ id: c.id, turn: c.peak, parts: [{ start: c.peak - 3, end: c.peak - 3 + 40, what: 'candidato migliore' }], reason: c.why ?? 'Candidato con il punteggio più alto.' }, 'nessuna storia valida dal modello: aggiunto il candidato migliore');
    }
    await Bun.write(join(dir, 'rank.json'), JSON.stringify({ notes: out.notes, picks }, null, 2));
    console.log(`  ${picks.length} storie da ${cands.length} candidati`);
    for (const p of picks) {
      const parts = p.segments.map((x) => `${x.s.toFixed(1)}–${x.e.toFixed(1)}`).join(' + ');
      console.log(`    ${p.id} ← ${p.candidate} ${parts} (${storyDuration(p.segments).toFixed(1)} s in ${p.segments.length} pezzi)${p.adjusted.length ? ` corretto: ${p.adjusted.join('; ')}` : ''}`);
    }
    return picks;
  });
}

function describe(c: Candidate, v: Vision | undefined, t: Transcript, missing: SignalName[]): string {
  const sig = (Object.entries(c.signals) as [SignalName, number][])
    .filter(([k]) => !missing.includes(k))
    .map(([k, x]) => `${k} ${x.toFixed(2)}`)
    .join(', ');
  const yes = (b?: boolean) => (b ? 'yes' : 'no');
  return [
    `## ${c.id}: ${c.s.toFixed(1)}–${c.e.toFixed(1)} s (${(c.e - c.s).toFixed(0)} s), strongest signal at ${c.peak.toFixed(1)}`,
    `signals: ${sig}${missing.length ? ` (not available: ${missing.join(', ')})` : ''}`,
    `labels: ${c.labels.join(', ') || 'none'}`,
    c.why ? `transcript reading: ${c.why}${c.quote ? ` Key line: "${c.quote}"` : ''}` : '',
    v
      ? `on screen: ${v.what} Standalone: ${yes(v.standalone)}. Cutscene: ${yes(v.cutscene)}. In-game screen: ${yes(v.ingame_screen)}. Graphic violence in the first 7 s: ${yes(v.graphic_violence_first7s)}.`
      : '',
    `transcript:\n${timedText(t, c.s - 8, c.e + 8) || '(no speech)'}`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Applica le regole a una storia: pezzi in ordine, dentro il video e lunghi almeno 3 s; ogni pezzo inizia su
 * una pausa (o all'inizio di una parola) e finisce dopo l'ultima parola; pezzi quasi attaccati si uniscono;
 * tutto entro 15 minuti; durata totale tra 30 e 60 s (si accorcia o si allunga l'ultimo pezzo).
 */
export function finalizeStory(p: Proposal, c: Candidate, t: Transcript, dur: number): { segments: Segment[]; s: number; e: number; turn: number; adjusted: string[] } | null {
  const adjusted: string[] = [];
  const words = t.words;
  // inizio: la pausa più vicina nei 1,5 s prima, altrimenti l'inizio della parola in cui cade
  const snapStart = (x: number) => {
    let best = x;
    let gapBest = 0;
    for (let i = 1; i < words.length; i++) {
      const gap = words[i]!.s - words[i - 1]!.e;
      const at = words[i]!.s - Math.min(0.12, gap / 2);
      if (gap >= 0.2 && at <= x + 0.3 && at >= x - 1.5 && gap > gapBest) {
        best = at;
        gapBest = gap;
      }
    }
    const inside = words.find((w) => w.s < best && w.e > best);
    return Math.max(0, inside ? inside.s - 0.05 : best);
  };
  // fine: mai a metà parola
  const snapEnd = (x: number) => {
    const inside = words.find((w) => w.s < x && w.e > x);
    return Math.min(dur, inside ? inside.e + 0.15 : x);
  };

  let segs = p.parts
    .filter((q) => Number.isFinite(q.start) && Number.isFinite(q.end) && q.end > q.start)
    .map((q) => ({ s: snapStart(Math.max(0, q.start)), e: snapEnd(Math.min(dur, q.end)) }))
    .sort((a, b) => a.s - b.s);
  if (segs.length !== p.parts.length) adjusted.push('tolti pezzi non validi');
  // pezzi sovrapposti o quasi attaccati: uno solo
  const merged: Segment[] = [];
  for (const x of segs) {
    const last = merged.at(-1);
    if (last && x.s - last.e < 1) last.e = Math.max(last.e, x.e);
    else merged.push({ ...x });
  }
  if (merged.length < segs.length) adjusted.push('uniti pezzi attaccati');
  segs = merged.filter((x, _i, all) => all.length === 1 || x.e - x.s >= MIN_PART);
  if (segs.length < merged.length) adjusted.push(`tolti pezzi sotto ${MIN_PART} s`);
  if (!segs.length) return null;
  // tutto entro 15 minuti dal primo pezzo
  const first = segs[0]!.s;
  const inSpan = segs.filter((x) => x.e - first <= SPAN);
  if (inSpan.length < segs.length) adjusted.push('tolti pezzi oltre 15 minuti');
  segs = inSpan.length ? inSpan : [segs[0]!];

  // troppo lunga: si accorcia dalla fine (l'ultimo pezzo, poi si tolgono pezzi interi)
  while (storyDuration(segs) > MAX_LEN) {
    const last = segs.at(-1)!;
    const excess = storyDuration(segs) - MAX_LEN;
    if (last.e - last.s - excess >= MIN_PART || segs.length === 1) {
      last.e = snapEnd(last.e - excess);
      if (storyDuration(segs) > MAX_LEN) last.e -= storyDuration(segs) - MAX_LEN;
      adjusted.push(`accorciata a ${MAX_LEN} s`);
      break;
    }
    segs.pop();
    adjusted.push('tolto l’ultimo pezzo per stare sotto i 60 s');
  }
  // troppo corta: si allunga l'ultimo pezzo fino alla fine di una frase
  if (storyDuration(segs) < MIN_LEN) {
    const last = segs.at(-1)!;
    const need = MIN_LEN - storyDuration(segs);
    const ends = t.sentences.map((x) => x.e).filter((x) => x - last.e >= need && x - last.e <= need + 10);
    last.e = Math.min(dur, ends.length ? ends[0]! + 0.35 : last.e + need);
    adjusted.push(`allungata a ${storyDuration(segs).toFixed(1)} s`);
  }

  const inside = (x: number) => segs.some((q) => x >= q.s && x < q.e);
  let turn = Number.isFinite(p.turn) && inside(p.turn) ? p.turn : NaN;
  if (Number.isNaN(turn)) {
    turn = inside(c.peak) ? c.peak : segs[Math.min(1, segs.length - 1)]!.s + 1;
    adjusted.push('svolta fuori dai pezzi, spostata');
  }
  const out = segs.map((x) => ({ s: round(x.s), e: round(x.e) }));
  return { segments: out, s: out[0]!.s, e: out.at(-1)!.e, turn: round(turn), adjusted };
}

const round = (x: number) => Math.round(x * 100) / 100;
