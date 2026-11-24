import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readModels, ROOT } from '../lib/env';
import { proxyFor } from '../gameplay/edit';
import { FFMPEG, momentaryLoudness } from '../lib/ff';
import { loadPrompt, promptHash, runTask } from '../lib/llm';
import { route, toLlmTask } from '../lib/routing';
import { py } from '../lib/py';
import { around, clamp01, peaks, perSecond, robustZ, rollingMedian, type Signal, type SignalName, type Win } from '../lib/signal';
import { stage, stamp, type Ctx } from '../lib/stage';
import { loadTranscript, norm, timedText, type Transcript } from '../lib/transcript';
import type { Ingest } from './ingest';
import type { TranscribeResult } from './transcribe';

export type Signals = Record<SignalName, Signal>;

const VERSION = 2;
/** solo per la fase delle scene (cambi, immagini ferme, webcam) */
const SCENES_VERSION = 2;

/** Contesto attorno a un picco: la svolta arriva dopo un po' di preparazione. */
const BEFORE = 20;
const AFTER = 8;

const VOICE_TAGS = {
  laughter: ['Laughter', 'Giggle', 'Snicker', 'Belly laugh', 'Chuckle, chortle', 'Baby laughter'],
  shout: ['Shout', 'Yell', 'Screaming', 'Whoop'],
};
const GAME_TAGS = {
  explosion: ['Explosion', 'Boom', 'Burst, pop', 'Fireworks', 'Firecracker'],
  gunfire: ['Gunshot, gunfire', 'Machine gun', 'Artillery fire', 'Cap gun'],
  siren: ['Siren', 'Police car (siren)', 'Ambulance (siren)', 'Fire engine, fire truck (siren)', 'Civil defense siren', 'Emergency vehicle', 'Car alarm'],
  crash: ['Smash, crash', 'Breaking', 'Shatter', 'Glass', 'Crushing', 'Skidding', 'Tire squeal'],
  // Non è un momento: serve solo all'avviso di policy (radio del gioco = musica protetta, Content ID).
  music: ['Music', 'Song', 'Singing', 'Pop music', 'Hip hop music', 'Rock music', 'Electronic music', 'Rhythm and blues', 'Soul music', 'Reggae', 'Country', 'Funk', 'Disco', 'Techno', 'Dance music', 'Rapping'],
};
/** Gruppi AudioSet che finiscono nella serie ma non generano finestre candidate. */
const SERIES_ONLY = new Set(['music']);
/** Probabilità AST minima perché un'etichetta conti (le classi rare hanno probabilità basse). */
const TAG_MIN: Record<string, number> = { laughter: 0.15, shout: 0.15, explosion: 0.25, gunfire: 0.25, siren: 0.2, crash: 0.2 };

export async function signals(ctx: Ctx, ing: Ingest, tr: TranscribeResult): Promise<Signals> {
  const vocab = await Bun.file(join(ROOT, 'vocab.json')).text();
  const ingested = stamp(ctx, '01-ingest');
  const transcribed = stamp(ctx, '02-transcribe');

  const meaningRoute = await route('meaning');
  // In parallelo: usano risorse diverse (suoni sulla GPU, scene sul processore, senso su Claude), quindi la
  // fase dura quanto la più lunga invece che la somma.
  const [markers, lucio, voice, game, scenes, meaning] = await Promise.all([
    stage(ctx, '03-signals/markers', { VERSION, ingested }, async () => markersSignal(ing)),
    stage(ctx, '03-signals/lucio', { VERSION, ingested, log: ctx.lucioLog }, (dir) => lucioSignal(ctx, ing, dir)),
    stage(ctx, '03-signals/voice', { VERSION, ingested, transcribed, vocab: Bun.hash(vocab).toString() }, (dir) => voiceSignal(ing, tr, JSON.parse(vocab), dir)),
    stage(ctx, '03-signals/game', { VERSION, ingested }, (dir) => gameSignal(ing, dir)),
    stage(ctx, '03-signals/scenes', { VERSION, SCENES_VERSION, ingested }, (dir) => scenesSignal(ctx, ing, dir)),
    stage(ctx, '03-signals/meaning', { VERSION, transcribed, prompt: promptHash('meaning'), route: meaningRoute }, () => meaningSignal(ctx, ing, tr)),
  ]);

  const all = { markers, lucio, voice, game, scenes, meaning };
  for (const s of Object.values(all)) {
    console.log(`  ${s.name.padEnd(8)} ${s.available ? `${s.windows.length} finestre` : `mancante: ${s.missing}`}`);
  }
  return all;
}

// ───────────────────────────── marker ─────────────────────────────

function markersSignal(ing: Ingest): Signal {
  // Il chapter che parte da 0 è l'inizio del file, non un marker premuto.
  const marks = ing.main.chapters.filter((c) => c.start >= 1);
  if (!marks.length) return { name: 'markers', available: false, missing: 'nessun chapter marker nel file', windows: [] };
  // Il marker si preme subito dopo il momento: la finestra guarda soprattutto indietro.
  const windows = marks.map((c) => ({ ...around(c.start, 30, 5, ing.main.duration), peak: c.start, score: 1, label: 'marker', why: c.title }));
  return { name: 'markers', available: true, windows };
}

// ───────────────────────────── Lucio ─────────────────────────────

interface LucioFrame {
  t?: number | string;
  rel?: number;
  bs?: Record<string, number>;
  yaw?: number;
  pitch?: number;
  roll?: number;
}

/**
 * Log JSONL di lucio-vite, una riga per frame: { t: epoch ms o ISO, bs: { jawOpen, eyeWideLeft, … },
 * yaw, pitch, roll } (oppure `rel` in secondi dall'inizio della registrazione al posto di `t`).
 * Le reazioni sono i picchi della combinazione di bocca, occhi, sopracciglia, sorriso e velocità
 * della testa, misurati rispetto alla mediana della sessione.
 */
async function lucioSignal(ctx: Ctx, ing: Ingest, dir: string): Promise<Signal> {
  if (!ctx.lucioLog) return { name: 'lucio', available: false, missing: 'nessun --lucio-log', windows: [] };
  const frames = readFileSync(ctx.lucioLog, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as LucioFrame);
  if (!frames.length) return { name: 'lucio', available: false, missing: 'log vuoto', windows: [] };

  const epoch = (f: LucioFrame) => (typeof f.t === 'number' ? (f.t > 1e12 ? f.t : f.t * 1000) : Date.parse(String(f.t)));
  const obsName = basename(ctx.video).match(/(\d{4})-(\d{2})-(\d{2})[ _](\d{2})-(\d{2})-(\d{2})/);
  let start: number;
  let alignment: string;
  if (frames[0]!.rel !== undefined) {
    start = 0;
    alignment = 'tempi relativi nel log (rel)';
  } else if (ing.main.creationTime) {
    start = Date.parse(ing.main.creationTime);
    alignment = `creation_time del file (${ing.main.creationTime})`;
  } else if (obsName) {
    const [, y, mo, d, h, mi, s] = obsName.map(Number);
    start = new Date(y!, mo! - 1, d, h, mi, s).getTime();
    alignment = 'orario nel nome del file OBS';
  } else {
    start = epoch(frames[0]!);
    alignment = 'primo frame del log (nessun orario di inizio nel video)';
  }
  const rel = (f: LucioFrame) => (f.rel !== undefined ? f.rel : (epoch(f) - start) / 1000);

  const hop = 0.1;
  const n = Math.ceil(ing.main.duration / hop);
  const feats: Record<string, number[]> = { mouth: [], eyes: [], brows: [], smile: [], head: [] };
  for (const k of Object.keys(feats)) feats[k] = new Array(n).fill(Number.NaN);
  let prev: LucioFrame | undefined;
  let used = 0;
  for (const f of frames) {
    const t = rel(f);
    const i = Math.floor(t / hop);
    if (i < 0 || i >= n) continue;
    used++;
    const bs = f.bs ?? {};
    const put = (k: string, v: number | undefined) => {
      if (v !== undefined && Number.isFinite(v)) feats[k]![i] = Math.max(Number.isFinite(feats[k]![i]!) ? feats[k]![i]! : -Infinity, v);
    };
    put('mouth', bs.jawOpen);
    put('eyes', Math.max(bs.eyeWideLeft ?? 0, bs.eyeWideRight ?? 0));
    put('brows', bs.browInnerUp ?? ((bs.browOuterUpLeft ?? 0) + (bs.browOuterUpRight ?? 0)) / 2);
    put('smile', ((bs.mouthSmileLeft ?? 0) + (bs.mouthSmileRight ?? 0)) / 2);
    if (prev && f.yaw !== undefined && prev.yaw !== undefined) {
      const dt = Math.max(1e-3, t - rel(prev));
      const d = Math.hypot(f.yaw - prev.yaw, (f.pitch ?? 0) - (prev.pitch ?? 0), (f.roll ?? 0) - (prev.roll ?? 0));
      put('head', d / dt);
    }
    prev = f;
  }
  if (!used) return { name: 'lucio', available: false, missing: `il log non copre il video (allineamento: ${alignment})`, windows: [] };

  const z = Object.fromEntries(Object.entries(feats).map(([k, v]) => [k, robustZ(v)]));
  const combined = Array.from({ length: n }, (_, i) => {
    const vals = Object.values(z).map((v) => v[i]!).filter(Number.isFinite);
    return vals.length ? Math.max(...vals) : Number.NaN;
  });
  const smooth = combined.map((_, i) => {
    const w = combined.slice(Math.max(0, i - 2), i + 3).filter(Number.isFinite);
    return w.length ? w.reduce((a, b) => a + b, 0) / w.length : Number.NaN;
  });

  const windows: Win[] = peaks(smooth, hop, 2.5, 8).map((p) => {
    const i = Math.round(p.t / hop);
    const label = Object.entries(z).sort((a, b) => (b[1][i] ?? -99) - (a[1][i] ?? -99))[0]![0];
    return { ...around(p.t, BEFORE, AFTER, ing.main.duration), peak: p.t, score: clamp01((p.v - 2) / 4), label: `lucio-${label}` };
  });
  const seriesPath = join(dir, 'series.json');
  await Bun.write(seriesPath, JSON.stringify({ hop: 1, reaction_z: perSecond(smooth, hop) }));
  return { name: 'lucio', available: true, windows, seriesPath, info: { frames: frames.length, used, alignment } };
}

// ───────────────────────────── voce ─────────────────────────────

async function voiceSignal(ing: Ingest, tr: TranscribeResult, vocab: { exclamations: Record<string, string[]> }, dir: string): Promise<Signal> {
  const dur = ing.main.duration;
  const windows: Win[] = [];

  // Picchi di volume rispetto alla mediana del parlato (il silenzio non conta).
  const M = await momentaryLoudness(ing.audio.voice48k);
  const z = robustZ(M.map((m) => (m > -55 ? m : Number.NaN)));
  for (const p of peaks(z, 0.1, 2.5, 8)) {
    windows.push({ ...around(p.t, BEFORE, AFTER, dur), peak: p.t, score: clamp01((p.v - 2) / 3), label: 'voice-loud' });
  }

  // Risate e urla dal classificatore AudioSet.
  const tags = await audioTags(ing.audio.voice48k, VOICE_TAGS, join(dir, 'tags.json'));
  windows.push(...tagWindows(tags, dur));

  // Esclamazioni nella trascrizione, raggruppate se distano meno di 6 s.
  const t = await loadTranscript(tr.path);
  const langs = t.language === 'other' ? Object.keys(vocab.exclamations) : [t.language];
  const phrases = langs.flatMap((l) => vocab.exclamations[l] ?? []).map((p) => p.split(/\s+/).map(norm));
  const toks = t.words.map((w) => norm(w.w));
  const hits: { t: number; phrase: string }[] = [];
  for (let i = 0; i < toks.length; i++) {
    for (const p of phrases) {
      if (p.every((x, j) => toks[i + j] === x)) hits.push({ t: t.words[i]!.s, phrase: p.join(' ') });
    }
  }
  for (const group of clusters(hits, 6)) {
    const quote = [...new Set(group.map((h) => h.phrase))].join(', ');
    windows.push({ ...around(group[0]!.t, BEFORE, AFTER, dur), peak: group[0]!.t, score: clamp01(0.35 + 0.15 * (group.length - 1)), label: 'exclamation', quote });
  }

  const seriesPath = join(dir, 'series.json');
  await Bun.write(seriesPath, JSON.stringify({ hop: 1, loudness_z: perSecond(z, 0.1), ...tagSeries(tags) }));
  return { name: 'voice', available: true, windows: windows.sort((a, b) => a.peak - b.peak), seriesPath, info: { exclamations: hits.length, source: ing.voiceSource } };
}

// ───────────────────────────── gioco ─────────────────────────────

async function gameSignal(ing: Ingest, dir: string): Promise<Signal> {
  const dur = ing.main.duration;
  const windows: Win[] = [];

  // Picchi rispetto ai 20 s attorno: uno schianto conta anche se tutto il gioco è basso nel mix.
  const M = await momentaryLoudness(ing.audio.game48k);
  const base = rollingMedian(M, 200);
  const rel = M.map((m, i) => (m > -50 ? m - base[i]! : Number.NaN));
  for (const p of peaks(rel, 0.1, 8, 6)) {
    windows.push({ ...around(p.t, 15, 10, dur), peak: p.t, score: clamp01((p.v - 6) / 12), label: 'game-loud' });
  }

  const tags = await audioTags(ing.audio.game48k, GAME_TAGS, join(dir, 'tags.json'));
  windows.push(...tagWindows(tags, dur));

  const seriesPath = join(dir, 'series.json');
  await Bun.write(seriesPath, JSON.stringify({ hop: 1, loudness_rel: perSecond(rel, 0.1), ...tagSeries(tags) }));
  return { name: 'game', available: true, windows: windows.sort((a, b) => a.peak - b.peak), seriesPath, info: { source: ing.gameSource } };
}

// ───────────────────────────── scene ─────────────────────────────

export interface SceneInfo {
  cuts: { t: number; score: number }[];
  freezes: { s: number; e: number }[];
  /** tratti con un volto reale grande: webcam a tutto schermo (o primi piani) */
  webcam: { s: number; e: number }[];
}

/**
 * Un solo passaggio di decodifica a 10 fps su 320×180: cambi di scena (scdet), immagini ferme
 * (freezedetect, es. menu e caricamenti) e, a 1 fps, volti grandi (faces.py: webcam a tutto schermo).
 * Se il video finale di un gameplay ha la sua copia a 720p si legge quella (stesso video, decine di volte
 * più leggera); altrimenti decodifica sul processore: sull'HEVC 4K i 16 core vanno ~6× il tempo reale,
 * il decoder hardware ~2,2× (misurato il 20/11/2026 su una registrazione OBS).
 */
async function scenesSignal(ctx: Ctx, ing: Ingest, dir: string): Promise<Signal> {
  const source = proxyFor(ctx.video, ing.main.duration) ?? ctx.video;
  if (source !== ctx.video) console.log(`  scene dalla copia a 720p: ${basename(source)}`);
  const meta = join(dir, 'scdet.txt');
  const facesPath = join(dir, 'faces.json');
  const fc = `[0:v]fps=10,scale=320:180,split=2[a][b];[a]freezedetect=n=-50dB:d=2,scdet=threshold=10,metadata=mode=print:file=${meta}[o1];[b]fps=1,format=gray[o2]`;
  const proc = Bun.spawn(
    [FFMPEG, '-hide_banner', '-nostdin', '-loglevel', 'error', '-i', source, '-an', '-filter_complex', fc,
      '-map', '[o1]', '-f', 'null', '/dev/null', '-map', '[o2]', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  await py('faces.py', [facesPath, '--w', '320', '--h', '180'], { stdin: proc.stdout });
  const err = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) throw new Error(`ffmpeg (scene): ${err.trim().split('\n').slice(-4).join('\n')}`);

  const faces = (await Bun.file(facesPath).json()) as { segments: { s: number; e: number }[] };
  const info: SceneInfo = { cuts: [], freezes: [], webcam: faces.segments };
  let score = 0;
  let freezeStart: number | undefined;
  for (const line of readFileSync(meta, 'utf8').split('\n')) {
    const [k, v] = line.split('=');
    if (k === 'lavfi.scd.score') score = Number(v);
    else if (k === 'lavfi.scd.time') info.cuts.push({ t: Number(v), score });
    else if (k === 'lavfi.freezedetect.freeze_start') freezeStart = Number(v);
    else if (k === 'lavfi.freezedetect.freeze_end' && freezeStart !== undefined) {
      info.freezes.push({ s: freezeStart, e: Number(v) });
      freezeStart = undefined;
    }
  }
  if (freezeStart !== undefined) info.freezes.push({ s: freezeStart, e: ing.main.duration });
  await Bun.write(join(dir, 'scenes.json'), JSON.stringify(info));

  const windows = info.cuts.map((c) => ({ ...around(c.t, 15, 15, ing.main.duration), peak: c.t, score: clamp01(c.score / 50), label: 'cut' }));
  const webcamS = info.webcam.reduce((a, w) => a + w.e - w.s, 0);
  return { name: 'scenes', available: true, windows, info: { cuts: info.cuts.length, freezes: info.freezes.length, webcam_s: webcamS, path: join(dir, 'scenes.json') } };
}

// ───────────────────────────── senso (Qwen) ─────────────────────────────

interface Moment {
  kind: string;
  start: number;
  turn: number;
  end: number;
  quote: string;
  why: string;
  strength: number;
}

/** Qwen legge la trascrizione a blocchi di 3 minuti sovrapposti di 30 s e segna i momenti. */
async function meaningSignal(ctx: Ctx, ing: Ingest, tr: TranscribeResult): Promise<Signal> {
  const t = await loadTranscript(tr.path);
  if (!t.words.length) return { name: 'meaning', available: false, missing: 'trascrizione vuota', windows: [] };
  const task = toLlmTask(await route('meaning'), { think: false, temperature: 0.3 });
  const { system, schema } = await loadPrompt('meaning');
  const dur = ing.main.duration;
  const BLOCK = 180;
  const STEP = 150;
  const moments: Moment[] = [];
  let blocks = 0;
  for (let s = 0, i = 0; s < dur; s += STEP, i++) {
    const e = Math.min(dur, s + BLOCK);
    const text = timedText(t, s, e);
    if (text.trim()) {
      const dir = join(ctx.workDir, 'llm', 'meaning', String(i).padStart(3, '0'));
      const input = `Block from ${s.toFixed(0)} s to ${e.toFixed(0)} s. Transcript language: ${langName(t)}.\n\n${text}\n`;
      const out = await runTask<{ moments: Moment[] }>(dir, task, system, input, schema);
      moments.push(...out.moments.map((m) => fixMoment(m, s, e)).filter((m): m is Moment => !!m));
      blocks++;
    }
    if (e >= dur) break;
  }

  // I blocchi si sovrappongono: dei momenti quasi uguali si tiene il più forte.
  const kept: Moment[] = [];
  for (const m of moments.sort((a, b) => b.strength - a.strength)) {
    if (kept.every((k) => iou(k, m) < 0.5)) kept.push(m);
  }
  const windows = kept
    .sort((a, b) => a.start - b.start)
    .map((m) => ({ s: m.start, e: m.end, peak: m.turn, score: clamp01(m.strength / 10), label: m.kind, why: m.why, quote: m.quote }));
  return { name: 'meaning', available: true, windows, info: { blocks, moments: moments.length } };
}

function fixMoment(m: Moment, s: number, e: number): Moment | undefined {
  const start = Math.max(s, Math.min(m.start, m.end));
  const end = Math.min(e, Math.max(m.start, m.end));
  if (end - start < 8 || m.strength < 3) return undefined;
  const turn = m.turn > start && m.turn < end ? m.turn : (start + end) / 2;
  return { ...m, start, end, turn };
}

function iou(a: { start: number; end: number }, b: { start: number; end: number }): number {
  const inter = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  return inter / (Math.max(a.end, b.end) - Math.min(a.start, b.start));
}

function langName(t: Transcript): string {
  return t.language === 'it' ? 'Italian' : t.language === 'en' ? 'English' : 'mixed or unknown';
}

// ───────────────────────────── AudioSet ─────────────────────────────

interface Tags {
  win: number;
  hop: number;
  groups: Record<string, number[]>;
}

async function audioTags(wav: string, groups: Record<string, string[]>, out: string): Promise<Tags> {
  const models = await readModels();
  await py('audiotags.py', [wav, join(ROOT, models.ast!.dir), out, '--groups', JSON.stringify(groups)]);
  return Bun.file(out).json();
}

/** Finestre dai picchi di ogni gruppo AudioSet; il valore i copre [i*hop, i*hop+win), il centro è il picco. */
function tagWindows(tags: Tags, dur: number): Win[] {
  const out: Win[] = [];
  for (const [label, probs] of Object.entries(tags.groups)) {
    if (SERIES_ONLY.has(label)) continue;
    for (const p of peaks(probs, tags.hop, TAG_MIN[label] ?? 0.2, 8)) {
      const t = p.t + tags.win / 2;
      out.push({ ...around(t, BEFORE, AFTER, dur), peak: t, score: clamp01(p.v / 0.6), label });
    }
  }
  return out;
}

function tagSeries(tags: Tags): Record<string, number[]> {
  const shift = Math.round(tags.win / 2 / tags.hop);
  return Object.fromEntries(Object.entries(tags.groups).map(([k, v]) => [k, [...new Array(shift).fill(0), ...v]]));
}

function clusters<T extends { t: number }>(xs: T[], gap: number): T[][] {
  const out: T[][] = [];
  for (const x of [...xs].sort((a, b) => a.t - b.t)) {
    const last = out.at(-1);
    if (last && x.t - last.at(-1)!.t < gap) last.push(x);
    else out.push([x]);
  }
  return out;
}
