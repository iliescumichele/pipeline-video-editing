import { join } from 'node:path';
import { peaks, type SignalName, type Win } from '../lib/signal';
import { stage, stamp, type Ctx } from '../lib/stage';
import { loadTranscript, type Transcript } from '../lib/transcript';
import type { Ingest } from './ingest';
import type { SceneInfo, Signals } from './signals';
import type { TranscribeResult } from './transcribe';

export interface Candidate {
  id: string;
  s: number;
  e: number;
  peak: number;
  /** punteggio complessivo 0–1 (somma pesata dei segnali disponibili) */
  score: number;
  /** punteggio di ogni segnale 0–1: il più alto tra le sue finestre con il picco dentro [s, e] */
  signals: Record<SignalName, number>;
  labels: string[];
  why?: string;
  quote?: string;
  transcript: string;
}

export const WEIGHTS: Record<SignalName, number> = { markers: 1, lucio: 0.8, meaning: 0.7, voice: 0.6, game: 0.5, scenes: 0.2 };

const VERSION = 3;
const TARGET = 35;
const MIN_LEN = 20;
const MAX_LEN = 45;
/** quota della durata prima della svolta: la svolta cade verso i due terzi */
const LEAD = 0.62;

export function candidates(ctx: Ctx, ing: Ingest, tr: TranscribeResult, sig: Signals): Promise<Candidate[]> {
  const after = Object.keys(sig).map((n) => stamp(ctx, `03-signals/${n}`));
  return stage(ctx, '04-candidates', { VERSION, after, count: ctx.count }, async (dir) => {
    const dur = ing.main.duration;
    const t = await loadTranscript(tr.path);
    const scenes = (await Bun.file(String(sig.scenes.info?.path)).json()) as SceneInfo;
    const available = (Object.keys(sig) as SignalName[]).filter((n) => sig[n].available);
    const weightSum = available.reduce((a, n) => a + WEIGHTS[n], 0);

    // Curva di calore a 1 Hz: ogni finestra aggiunge peso × punteggio come una gaussiana sul suo picco.
    const heat = new Array(Math.ceil(dur) + 1).fill(0);
    for (const n of available) {
      for (const w of sig[n].windows) {
        for (let i = Math.max(0, Math.floor(w.peak - 15)); i <= Math.min(heat.length - 1, w.peak + 15); i++) {
          heat[i] += WEIGHTS[n] * w.score * Math.exp(-((i - w.peak) ** 2) / (2 * 6 ** 2));
        }
      }
    }
    await Bun.write(join(dir, 'heat.json'), JSON.stringify({ hop: 1, heat: heat.map((h) => Math.round(h * 100) / 100) }));

    // 30 candidati per ora (20–40 richiesti), almeno il doppio di --count perché la classifica possa scegliere.
    const want = Math.max(Math.round((30 * dur) / 3600), ctx.count * 2);
    const tops = peaks(heat, 1, 0.05, 25).sort((a, b) => b.v - a.v);

    const out: Candidate[] = [];
    for (const p of tops) {
      if (out.length >= want) break;
      const span = spanFor(p.t, sig.meaning.windows, dur);
      const { s, e } = snap(t, span.s, span.e, dur);
      if (e - s < MIN_LEN - 2) continue;
      const frozen = scenes.freezes.reduce((a, f) => a + Math.max(0, Math.min(e, f.e) - Math.max(s, f.s)), 0);
      if (frozen / (e - s) > 0.3) continue;
      // webcam a tutto schermo (volto grande) per più di 2 s: non è gameplay
      if ((scenes.webcam ?? []).reduce((a, w) => a + overlap(w, { s, e }), 0) > 2) continue;
      if (out.some((c) => overlap(c, { s, e }) > 0.5 * Math.min(c.e - c.s, e - s))) continue;

      const scores = {} as Record<SignalName, number>;
      const labels = new Set<string>();
      let why: string | undefined;
      let quote: string | undefined;
      for (const n of Object.keys(sig) as SignalName[]) {
        const inside = sig[n].windows.filter((w) => w.peak >= s && w.peak <= e);
        scores[n] = Math.round(Math.max(0, ...inside.map((w) => w.score)) * 100) / 100;
        for (const w of inside) if (n !== 'scenes') labels.add(labelOf(w));
        const best = inside.filter((w) => n === 'meaning').sort((a, b) => b.score - a.score)[0];
        if (best) ({ why, quote } = best);
      }
      const score = available.reduce((a, n) => a + WEIGHTS[n] * scores[n], 0) / (weightSum || 1);
      const text = t.words.filter((w) => w.s >= s && w.s < e).map((w) => w.w).join(' ');
      out.push({ id: '', s, e, peak: p.t, score: Math.round(score * 100) / 100, signals: scores, labels: [...labels], why, quote, transcript: text });
    }

    out.sort((a, b) => a.s - b.s).forEach((c, i) => (c.id = `c${String(i + 1).padStart(2, '0')}`));
    console.log(`  ${out.length} candidati (obiettivo ${want}) su ${(dur / 60).toFixed(1)} min`);
    for (const c of out) console.log(`    ${c.id} ${fmt(c.s)}–${fmt(c.e)} punteggio ${c.score.toFixed(2)} ${c.labels.slice(0, 4).join(', ')}`);
    await Bun.write(join(dir, 'candidates.json'), JSON.stringify(out, null, 2));
    return out;
  });
}

/** Intervallo attorno al picco: il momento di Qwen che lo contiene, altrimenti 35 s con la svolta ai 2/3. */
function spanFor(peak: number, meaning: Win[], dur: number): { s: number; e: number } {
  const best = (ws: Win[]) => ws.sort((a, b) => b.score - a.score)[0];
  const m = best(meaning.filter((w) => peak >= w.s && peak <= w.e)) ?? best(meaning.filter((w) => peak >= w.s - 3 && peak <= w.e + 3));
  let s = m ? Math.min(m.s, peak - 5) : peak - TARGET * LEAD;
  let e = m ? Math.max(m.e, peak + 3) : peak + TARGET * (1 - LEAD);
  if (e - s > MAX_LEN) {
    // troppo lungo: si tiene la parte attorno alla svolta
    s = Math.max(s, peak - MAX_LEN * LEAD);
    e = s + MAX_LEN;
  }
  if (e - s < MIN_LEN) {
    const pad = (MIN_LEN - (e - s)) / 2;
    s -= pad;
    e += pad;
  }
  if (s < 0) [s, e] = [0, Math.min(dur, e - s)];
  if (e > dur) [s, e] = [Math.max(0, s - (e - dur)), dur];
  return { s, e };
}

/** Porta inizio e fine ai confini delle frasi vicine, senza tagliare parole. */
function snap(t: Transcript, s: number, e: number, dur: number): { s: number; e: number } {
  const startSent = t.sentences.find((x) => x.s <= s + 0.5 && x.e > s) ?? t.sentences.find((x) => x.s >= s);
  let ns = startSent && s - startSent.s <= 6 ? startSent.s : s;
  const endSent = t.sentences.find((x) => x.s < e && x.e >= e - 0.5);
  let ne = endSent && endSent.e - e <= 6 ? endSent.e : e;
  // una parola a cavallo del taglio: si sposta il taglio fuori dalla parola
  const cutIn = t.words.find((w) => w.s < ns && w.e > ns);
  if (cutIn) ns = cutIn.s;
  const cutOut = t.words.find((w) => w.s < ne && w.e > ne);
  if (cutOut) ne = cutOut.e;
  ns = Math.max(0, ns - 0.15);
  ne = Math.min(dur, ne + 0.35);
  if (ne - ns > MAX_LEN) ne = ns + MAX_LEN;
  return { s: Math.round(ns * 100) / 100, e: Math.round(ne * 100) / 100 };
}

function labelOf(w: Win): string {
  return w.label === 'exclamation' && w.quote ? `exclamation: ${w.quote}` : w.label;
}

function overlap(a: { s: number; e: number }, b: { s: number; e: number }): number {
  return Math.max(0, Math.min(a.e, b.e) - Math.max(a.s, b.s));
}

function fmt(t: number): string {
  return `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
}
