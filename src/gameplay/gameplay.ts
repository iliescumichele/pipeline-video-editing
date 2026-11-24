// Gameplay lungo: dalla registrazione di OBS al video per YouTube.
//
//   bun src/gameplay/gameplay.ts analizza  <video>              menu e impostazioni da tagliare, sincronia con Lucianus
//   bun src/gameplay/gameplay.ts lingua    <video> [--taglia ro] parti in un'altra lingua (Whisper small, in locale)
//   bun src/gameplay/gameplay.ts anteprima <video>              audio mixato per la revisione (il video è la registrazione stessa)
//   bun src/gameplay/gameplay.ts esporta   <video> [--da s --durata s]  video finale 4K con i tagli attivi (e la copia a 720p)
//   bun src/gameplay/gameplay.ts tracce    <video>              gioco e voce separati per gli short, da un video finale già esportato
//   bun src/gameplay/gameplay.ts archivio  <id>                 copia a 720p da un video finale già esportato
//
// I tagli si rivedono nella dashboard (pagina Gameplay) e stanno in data/gameplay/<id>/edit.json.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { db, now } from '../dashboard/db';
import { readExport } from '../lib/export-settings';
import { obsVoiceFile } from '../lib/obs-voice';
import { voiceGraph, voiceProfile } from '../lib/voice-eq';
import { checkSpace } from '../lib/space';
import { FFMPEG, probe } from '../lib/ff';
import { PATHS, readModels, ROOT } from '../lib/env';
import { py } from '../lib/py';
import { videoId } from '../lib/video-id';
import {
  archivePath, newEdit, type AudioMix, type Duck, editPath, exportPath, finalDuration, type GameplayEdit, gameplayDir, gameplaySpace, languagePath, LOOK, lookOf, lucianusFor, mixKey, mixOf, mixPath, oldPreviewPath, outroPieces,
  outroStart, posterPath, previewPath, readEdit, removedRanges, replaceAuto, showsFacecam, tracksPath, writeEdit,
} from './edit';

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: { taglia: { type: 'string', default: 'ro' }, da: { type: 'string' }, durata: { type: 'string' } },
});
const [command, input] = positionals;
if (!command || !input) {
  console.error('uso: bun src/gameplay/gameplay.ts <analizza|lingua|anteprima|esporta> <video> | archivio <id>');
  process.exit(2);
}
// archivio lavora sull'id: la registrazione originale può non esserci più
const byId = command === 'archivio';
const video = byId ? '' : resolve(input.replace(/^~(?=\/)/, process.env.HOME ?? '~'));
if (!byId && !existsSync(video)) {
  console.error(`file non trovato: ${video}`);
  process.exit(2);
}
const id = byId ? input : videoId(video);
const hms = (s: number) => `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function run(args: string[]): void {
  const r = Bun.spawnSync([FFMPEG, ...args], { stdout: 'inherit', stderr: 'inherit' });
  if (r.exitCode !== 0) throw new Error(`ffmpeg è uscito con codice ${r.exitCode}`);
}

/**
 * Come run, ma al posto delle statistiche di ffmpeg mostra una riga leggibile
 * (barra, posizione, velocità, fine stimata, peso) aggiornata con \r. Restituisce lo stderr di ffmpeg.
 * `total` è la durata in secondi di quello che esce, per la percentuale.
 */
async function runProgress(args: string[], total: number): Promise<string> {
  const proc = Bun.spawn([FFMPEG, '-nostats', '-stats_period', '1', '-progress', 'pipe:1', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const stderr = new Response(proc.stderr).text();
  const t0 = performance.now();
  const kv: Record<string, string> = {};
  let rest = '';
  const decoder = new TextDecoder();
  for await (const chunk of proc.stdout) {
    const lines = (rest + decoder.decode(chunk, { stream: true })).split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) {
      const i = line.indexOf('=');
      if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1).trim();
      if (!line.startsWith('progress=')) continue;
      const pos = Math.max(0, Number(kv.out_time_us) / 1e6 || 0);
      const frac = total > 0 ? Math.min(1, pos / total) : 0;
      const speed = Number.parseFloat(kv.speed ?? '') || pos / ((performance.now() - t0) / 1000) || 0;
      const eta = speed > 0 && frac > 0 ? (total - pos) / speed : NaN;
      const size = Number(kv.total_size) || 0;
      const bar = '█'.repeat(Math.round(frac * 20)).padEnd(20, '░');
      const parts = [`${bar} ${String(Math.floor(frac * 100)).padStart(3)}%`, `${hms(pos)} / ${hms(total)}`, `${speed.toFixed(1).replace('.', ',')}×`];
      if (Number.isFinite(eta)) parts.push(eta < 60 ? 'fine tra meno di 1 min' : `fine tra ~${eta >= 3600 ? `${Math.floor(eta / 3600)} h ${Math.round((eta % 3600) / 60)} min` : `${Math.round(eta / 60)} min`}`);
      if (size > 0) parts.push(`${(size / 1e9).toFixed(1).replace('.', ',')} GB`);
      process.stdout.write(`\r${parts.join('  ·  ')}   `);
    }
  }
  process.stdout.write('\n');
  const code = await proc.exited;
  const log = await stderr;
  if (code !== 0) throw new Error(`ffmpeg è uscito con codice ${code}:\n${log.trim().split('\n').slice(-5).join('\n')}`);
  return log;
}

// ───────── stato del video ─────────

async function load(): Promise<GameplayEdit> {
  const cur = readEdit(id);
  // la registrazione può essere stata spostata (per esempio sul disco esterno): si seguono i percorsi nuovi
  if (cur && cur.video !== video) return writeEdit(id, { ...cur, video, lucianus: lucianusFor(video) });
  if (cur) return cur;
  const info = await probe(video);
  if (info.audio.length < 2) console.warn('Attenzione: servono due tracce audio (1 gioco, 2 voce).');
  return writeEdit(id, newEdit(video, info.duration));
}

// ───────── sincronia: confronto della voce nei due file ─────────

function pcm(file: string, stream: string, start: number, secs: number): Float32Array {
  const r = Bun.spawnSync([FFMPEG, '-v', 'error', '-ss', String(start), '-t', String(secs), '-i', file, '-map', stream, '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { stdout: 'pipe' });
  const b = r.stdout;
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));
}

function envelope(x: Float32Array): Float64Array {
  const n = Math.floor(x.length / 48); // 1 valore al millisecondo
  const e = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < 48; j++) s += Math.abs(x[i * 48 + j] ?? 0);
    e[i] = s / 48;
  }
  const mean = e.reduce((a, v) => a + v, 0) / Math.max(1, n);
  for (let i = 0; i < n; i++) e[i] = (e[i] ?? 0) - mean;
  return e;
}

function measureOffset(e: GameplayEdit): number {
  if (!e.lucianus) return 0;
  // provo più punti: serve un tratto in cui parli
  for (const start of [600, 1800, 60, 3600]) {
    if (start + 180 > e.duration) continue;
    const a = envelope(pcm(video, '0:a:1', start, 180));
    const b = envelope(pcm(e.lucianus, '0:a:0', start, 180));
    const n = Math.min(a.length, b.length);
    const maxLag = 1000;
    let best = 0;
    let bestLag = 0;
    let sum = 0;
    let count = 0;
    for (let lag = -maxLag; lag <= maxLag; lag++) {
      let c = 0;
      for (let i = maxLag; i < n - maxLag; i++) c += (a[i] ?? 0) * (b[i - lag] ?? 0);
      sum += Math.abs(c);
      count++;
      if (c > best) [best, bestLag] = [c, lag];
    }
    const confidence = best / (sum / count);
    if (confidence >= 3) {
      console.log(`Sincronia con Lucianus: ${bestLag} ms (misurata a ${hms(start)}, affidabilità ${confidence.toFixed(1)}).`);
      return bestLag;
    }
  }
  console.log('Sincronia con Lucianus non misurabile (poca voce): uso 0 ms.');
  return 0;
}

// ───────── menu e impostazioni ─────────

const W = 160;
const H = 90;
const TEMPLATES = join(import.meta.dirname, 'templates');

async function findMenus(): Promise<{ start: number; end: number; note: string }[]> {
  const templates = readdirSync(TEMPLATES)
    .filter((f) => f.endsWith('.gray'))
    .map((f) => new Uint8Array(readFileSync(join(TEMPLATES, f))));
  console.log('Analizzo i fotogrammi chiave (uno ogni 2 s circa)…');
  const proc = Bun.spawn([FFMPEG, '-hide_banner', '-skip_frame', 'nokey', '-i', video, '-map', '0:v:0', '-vf', `scale=${W}:${H},format=gray,showinfo`, '-vsync', '0', '-f', 'rawvideo', '-'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [raw, log] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text()]);
  await proc.exited;
  const times = [...log.matchAll(/pts_time:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  const frames = new Uint8Array(raw);
  const n = Math.min(times.length, Math.floor(frames.length / (W * H)));
  // lo sfondo delle impostazioni (palme, in basso a destra) è sempre uguale: confronto quella zona
  const score = (k: number) => {
    let best = Infinity;
    for (const t of templates) {
      let d = 0;
      let c = 0;
      for (let y = 45; y < H; y++)
        for (let x = 100; x < W; x++) {
          d += Math.abs((frames[k * W * H + y * W + x] ?? 0) - (t[y * W + x] ?? 0));
          c++;
        }
      best = Math.min(best, d / c);
    }
    return best;
  };
  const hits: number[] = [];
  for (let k = 0; k < n; k++) if (score(k) < 3.5) hits.push(k);
  // tratti continui (almeno 2 fotogrammi chiave), con un margine per l'apertura e la chiusura del menu
  const found: { start: number; end: number; note: string }[] = [];
  let i = 0;
  while (i < hits.length) {
    let j = i;
    while (j + 1 < hits.length && (hits[j + 1] ?? 0) - (hits[j] ?? 0) <= 2) j++;
    if (j > i) {
      const start = Math.max(0, (times[hits[i] ?? 0] ?? 0) - 4);
      const end = (times[hits[j] ?? 0] ?? 0) + 3;
      const last = found.at(-1);
      if (last && start - last.end < 10) last.end = end;
      else found.push({ start, end, note: 'impostazioni' });
    }
    i = j + 1;
  }
  return found;
}

// ───────── lingua (Whisper small, in locale) ─────────

async function findLanguage(cutLangs: string[]): Promise<{ start: number; end: number; note: string }[]> {
  const work = join(gameplayDir(id), 'lingua');
  mkdirSync(work, { recursive: true });
  const voice = join(work, 'voce.wav');
  console.log('Estraggo la traccia della voce…');
  run(['-v', 'error', '-y', '-i', video, '-map', '0:a:1', '-ac', '1', '-ar', '16000', voice]);
  const sd = Bun.spawnSync([FFMPEG, '-hide_banner', '-i', voice, '-af', 'silencedetect=noise=-40dB:d=0.7', '-f', 'null', '-'], { stderr: 'pipe' });
  const log = sd.stderr.toString();
  const dur = (await probe(voice)).duration;
  const speech: [number, number][] = [];
  let cur = 0;
  for (const m of log.matchAll(/silence_start: ([\d.]+)[\s\S]*?silence_end: ([\d.]+)/g)) {
    const a = Number(m[1]);
    if (a - cur >= 0.8) speech.push([cur, a]);
    cur = Number(m[2]);
  }
  if (dur - cur >= 0.8) speech.push([cur, dur]);
  // Whisper sbaglia lingua sulle frasi di un paio di secondi: unisco quelle vicine (pause sotto i 3 s)
  // in tratti fino a 25 s, e spezzo quelle più lunghe
  const chunks: [number, number][] = [];
  for (const [a, b] of speech) {
    const last = chunks.at(-1);
    if (last && a - last[1] < 3 && b - last[0] <= 25) last[1] = b;
    else for (let t = a; t < b; t += 25) chunks.push([t, Math.min(b, t + 25)]);
  }
  console.log(`${chunks.length} tratti di parlato da riconoscere.`);
  const spans = join(work, 'frasi.json');
  writeFileSync(spans, JSON.stringify(chunks));
  await py('langid.py', [voice, join(ROOT, (await readModels()).whisper!.dir), spans, languagePath(id)]);
  rmSync(work, { recursive: true, force: true });
  const segs = JSON.parse(readFileSync(languagePath(id), 'utf8')) as { start: number; end: number; lang: string; p: number; top: Record<string, number> }[];
  const totals: Record<string, number> = {};
  for (const s of segs) totals[s.lang] = (totals[s.lang] ?? 0) + s.end - s.start;
  console.log('Secondi di parlato per lingua:', Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, Math.round(v)])));
  // tratti nella lingua da togliere; poi quelli incerti (la lingua principale sotto 0,5) a meno di 15 s
  // da uno già preso: nei discorsi brevi Whisper scambia il rumeno per polacco, russo, greco…
  const main = Object.entries(totals).sort((x, y) => y[1] - x[1])[0]?.[0] ?? '';
  const cut = segs.map((s) => cutLangs.includes(s.lang) && s.p >= 0.4);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [i, s] of segs.entries()) {
      if (cut[i] || (s.top[main] ?? 0) >= 0.5) continue;
      const near = (j: number) => cut[j] && Math.max(s.start, segs[j]!.start) - Math.min(s.end, segs[j]!.end) < 15;
      if (near(i - 1) || near(i + 1)) grew = cut[i] = true;
    }
  }
  // uniti se vicini, così tra due tagli non restano pochi secondi di silenzio
  const found: { start: number; end: number; note: string }[] = [];
  for (const [i, s] of segs.entries()) {
    if (!cut[i]) continue;
    const start = Math.max(0, s.start - 0.3);
    const end = s.end + 0.3;
    const last = found.at(-1);
    if (last && start - last.end < 15) last.end = end;
    else found.push({ start, end, note: `lingua: ${cutLangs.join(', ')}` });
  }
  return found;
}

// ───────── filtri comuni (gioco + Lucianus + audio) ─────────

/** Espressione per select/aselect che tiene tutto tranne i tratti tolti. */
const keepExpr = (removed: [number, number][]) => (removed.length ? `not(${removed.map(([a, b]) => `between(t\\,${a.toFixed(3)}\\,${b.toFixed(3)})`).join('+')})` : '');

/** Gioco (traccia 1) + voce (traccia 2), senza i tratti tolti. */
// ───────── audio ─────────

/** Rapporto del ducking: su 3 minuti di voce il gioco scende di circa 5, 7 e 8 dB mentre parli, 0 in silenzio. */
const DUCK_RATIO: Record<Duck, number> = { spento: 1, leggero: 2, medio: 3, forte: 5 };

/**
 * Gioco (traccia 1) + voce (traccia 2). La voce passa dalla catena di src/lib/voice-eq.ts (parte dal volume
 * misurato, esce sempre allo stesso) e si alza di voiceDb; il gioco si abbassa mentre parli. −8 dB di margine:
 * il FLAC è a interi e la somma delle due tracce supera lo 0; il volume giusto lo dà gainTo14.
 */
function mixGraph(mix: AudioMix, voiceIn: number, src: VoiceSource): string {
  const voice = `${src.graph}${voiceGraph(src.label, 'voce', voiceIn, mix.clear, src.channels, mix.eq)};[voce]${src.channels === 1 ? 'pan=stereo|c0=c0|c1=c0,' : ''}volume=${mix.voiceDb}dB`;
  // alcuni tipi di voce hanno anche un compressore sul mix intero: tiene giù le botte del gioco
  const bus = voiceProfile(mix.eq).bus;
  const sum = `amix=inputs=2:normalize=0:duration=first,${bus ? `${bus},` : ''}volume=-8dB[a]`;
  if (mix.duck === 'spento') return `${voice}[v];[0:a:0][v]${sum}`;
  return `${voice},asplit=2[v][sc];[0:a:0][sc]sidechaincompress=threshold=0.05:ratio=${DUCK_RATIO[mix.duck]}:attack=15:release=350:knee=4[g];[g][v]${sum}`;
}

/**
 * Volume della voce grezza (LUFS). La traccia audio di Lucianus è la voce: si misura tutta in pochi secondi.
 * Senza, 12 tratti da 30 s sparsi nella registrazione (rileggerla tutta dal disco esterno vuol dire 10 minuti).
 */
function measureLufs(args: string[], graph: string): number {
  const r = Bun.spawnSync([FFMPEG, '-hide_banner', '-nostats', ...args, '-filter_complex', `${graph},ebur128[a]`, '-map', '[a]', '-f', 'null', '-'], { stdout: 'ignore', stderr: 'pipe' });
  const log = r.stderr.toString();
  return Number(/Summary:[\s\S]*?I:\s*(-?[\d.]+) LUFS/.exec(log)?.[1] ?? Number.NaN);
}

function voiceLufs(e: GameplayEdit): number {
  const measure = measureLufs;
  if (e.lucianus && existsSync(e.lucianus)) return measure(['-i', e.lucianus], '[0:a:0]anull');
  const n = 12;
  const len = 30;
  const starts = Array.from({ length: n }, (_, k) => Math.max(0, ((k + 0.5) / n) * e.duration - len / 2));
  return measure(starts.flatMap((s) => ['-ss', s.toFixed(1), '-t', String(len), '-i', video]), `${starts.map((_, k) => `[${k}:a:1]`).join('')}concat=n=${n}:v=0:a=1`);
}

interface VoiceSource {
  /** filtri da mettere prima della catena della voce (finiscono con ';'), o niente */
  graph: string;
  /** etichetta della voce da usare */
  label: string;
  /** canali della voce: 1 se viene dai filtri di OBS */
  channels: 1 | 2;
}

/** Ingressi della voce per ffmpeg, dopo quelli che il comando ha già (da `first` in poi). */
interface VoiceInputs {
  args: string[];
  /** etichetta della voce grezza: la traccia 2 della registrazione o il WAV con i filtri di OBS */
  voice: string;
  /** file della voce con i filtri di OBS, se il tipo di voce li usa */
  obsPath: string | null;
  channels: 1 | 2;
  outroIn: number | null;
  outroPath: string | null;
}

/**
 * Da dove viene la voce. Con il tipo "obs" la voce (e quella del pezzo finale) passa prima dai filtri di OBS del
 * 22/11 (src/lib/obs-voice.ts), in un WAV mono in work/<id>/gameplay/ che si rifà solo se cambia la registrazione.
 */
async function voiceInputs(e: GameplayEdit, first: number): Promise<VoiceInputs> {
  const mix = mixOf(e);
  const obs = mix.clear && !!voiceProfile(mix.eq).obsChain;
  const args: string[] = [];
  let next = first;
  let voice = '[0:a:1]';
  let obsPath: string | null = null;
  if (obs) {
    obsPath = await obsVoiceFile(video, '0:a:1', join(gameplayDir(id), 'voce-obs.wav'));
    args.push('-i', obsPath);
    voice = `[${next++}:a:0]`;
  }
  let outroPath = outroFile(e);
  let outroIn: number | null = null;
  if (outroPath) {
    if (obs) outroPath = await obsVoiceFile(outroPath, '0:a:0', join(gameplayDir(id), 'pezzo-finale-obs.wav'));
    args.push('-i', outroPath);
    outroIn = next++;
  }
  return { args, voice, obsPath, channels: obs ? 1 : 2, outroIn, outroPath };
}

/** Volume della voce che entra nella catena: quella grezza, o quella con i filtri di OBS. */
const inputLufs = (e: GameplayEdit, vi: VoiceInputs): number => (vi.obsPath ? measureLufs(['-i', vi.obsPath], '[0:a:0]anull') : voiceLufs(e));

/** Il pezzo finale c'è ancora sul disco? */
const outroFile = (e: GameplayEdit): string | null => (e.outro && existsSync(e.outro.path) ? e.outro.path : null);

/**
 * La voce: traccia 2 della registrazione. Con un pezzo finale, nei suoi secondi la voce del gameplay si
 * spegne e al suo posto entra quella del pezzo, portata al volume della voce grezza (`voiceIn`), così la
 * catena della voce la tratta come il resto. `outroIn`: l'ingresso di ffmpeg con il pezzo finale.
 */
function voiceSource(e: GameplayEdit, vi: VoiceInputs, voiceIn: number): VoiceSource {
  const pieces = vi.outroIn === null ? [] : outroPieces(e);
  if (!pieces.length) return { graph: '', label: vi.voice, channels: vi.channels };
  const outroIn = vi.outroIn!;
  const outroLufs = measureLufs(['-i', vi.outroPath!], '[0:a:0]anull');
  const gain = Number.isFinite(voiceIn) && Number.isFinite(outroLufs) ? Math.max(-20, Math.min(20, voiceIn - outroLufs)) : 0;
  console.log(`Pezzo finale: la sua voce (${outroLufs.toFixed(1)} LUFS, ${gain >= 0 ? '+' : ''}${gain.toFixed(1)} dB) al posto di quella del gameplay negli ultimi ${hms(e.outro!.duration)}.`);
  const fmt = `aresample=48000,aformat=sample_rates=48000:channel_layouts=${vi.channels === 1 ? 'mono' : 'stereo'}`;
  const mute = pieces.map((p) => `between(t\\,${p.s.toFixed(3)}\\,${p.e.toFixed(3)})`).join('+');
  const parts = [
    `${vi.voice}${fmt},volume=0:enable='${mute}'[vrec]`,
    `[${outroIn}:a:0]${fmt},volume=${gain.toFixed(2)}dB,asplit=${pieces.length}${pieces.map((_, i) => `[op${i}]`).join('')}`,
    ...pieces.map((p, i) => `[op${i}]atrim=start=${p.clip.toFixed(3)}:duration=${(p.e - p.s).toFixed(3)},asetpts=PTS-STARTPTS,adelay=delays=${Math.round(p.s * 1000)}:all=1[ov${i}]`),
    `[vrec]${pieces.map((_, i) => `[ov${i}]`).join('')}amix=inputs=${pieces.length + 1}:normalize=0:duration=first[vsrc]`,
  ];
  return { graph: `${parts.join(';')};`, label: '[vsrc]', channels: vi.channels };
}

/** Mix di tutta la registrazione in mix.flac; si rifà solo se cambiano registrazione o volumi. */
async function ensureMix(e: GameplayEdit): Promise<string> {
  const out = mixPath(id);
  const keyPath = `${out}.json`;
  const mix = mixOf(e);
  const key = mixKey(e);
  if (existsSync(out) && existsSync(keyPath) && readFileSync(keyPath, 'utf8') === key) {
    console.log('Mix di voce e gioco già pronto.');
    return out;
  }
  console.log(`Mixo voce e gioco (voce ${mix.voiceDb >= 0 ? '+' : ''}${mix.voiceDb} dB, gioco abbassato mentre parli: ${mix.duck})…`);
  const tmp = `${out}.part.flac`;
  // la cartella di lavoro può non esserci ancora: anteprima e rumeno non sono più obbligatori prima dell'export
  mkdirSync(dirname(out), { recursive: true });
  const vi = await voiceInputs(e, 1);
  const voiceIn = inputLufs(e, vi);
  console.log(`  voce ${vi.obsPath ? 'con i filtri di OBS' : 'grezza'} a ${voiceIn.toFixed(1)} LUFS`);
  const src = voiceSource(e, vi, voiceIn);
  await runProgress(
    ['-hide_banner', '-y', '-loglevel', 'error', '-i', video, ...vi.args, '-filter_complex', mixGraph(mix, voiceIn, src), '-map', '[a]', '-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24', tmp],
    e.duration,
  );
  renameSync(tmp, out);
  writeFileSync(keyPath, key);
  return out;
}

/** Limitatore a −1,5 dBTP: lavora a 192 kHz perché il picco vero tra un campione e l'altro non sfugga. */
const LIMITER = `aresample=192000,alimiter=limit=${(10 ** (-1.5 / 20)).toFixed(4)}:attack=5:release=50:level=false:latency=true,aresample=48000`;

/** Volume integrato (LUFS) dell'audio di `input` dopo `filter`. */
async function loudness(input: string[], filter: string, total: number): Promise<number> {
  const log = await runProgress(['-hide_banner', ...input, '-vn', '-af', `${filter},ebur128=peak=true:framelog=verbose`, '-f', 'null', '-'], total);
  const m = /Summary:[\s\S]*?I:\s*(-?[\d.]+) LUFS/.exec(log);
  if (!m) throw new Error('misura del volume non riuscita');
  return Number(m[1]);
}

/**
 * Guadagno che porta l'audio a −14 LUFS con il limitatore: si alza del dovuto, il limitatore toglie un po'
 * di volume sui picchi, quindi si rimisura e si corregge (di solito basta una volta, 3 al massimo).
 */
async function gainTo14(input: string[], pre: string, total: number, rounds = 3): Promise<number> {
  console.log('Misuro il volume…');
  let gain = -14 - (await loudness(input, pre, total));
  for (let k = 0; k < rounds; k++) {
    console.log(`Controllo con ${gain >= 0 ? '+' : ''}${gain.toFixed(1)} dB e il limitatore…`);
    const i = await loudness(input, `${pre},volume=${gain.toFixed(2)}dB,${LIMITER}`, total);
    console.log(`  ${i.toFixed(1)} LUFS`);
    if (Math.abs(-14 - i) <= 0.1) break;
    // il limitatore toglie più volume quanto più si alza: si corregge un po' di più della differenza
    gain += 1.5 * (-14 - i);
  }
  return gain;
}

/**
 * Guadagno del video finale (tutta la registrazione con i tagli attivi), salvato accanto al mix: una prova
 * di 30 s usa lo stesso volume del finale, anche se cade in un tratto tranquillo.
 */
async function finalGain(e: GameplayEdit, mix: string): Promise<number> {
  const removed = removedRanges(e);
  const keyPath = `${mix}.gain.json`;
  const key = `${readFileSync(`${mix}.json`, 'utf8')}|${JSON.stringify(removed)}`;
  if (existsSync(keyPath)) {
    const saved = JSON.parse(readFileSync(keyPath, 'utf8')) as { key: string; gain: number };
    if (saved.key === key) {
      console.log(`Volume del video finale già misurato: ${saved.gain >= 0 ? '+' : ''}${saved.gain.toFixed(1)} dB.`);
      return saved.gain;
    }
  }
  const keep = keepExpr(removed);
  const gain = await gainTo14(['-i', mix], keep ? `aselect='${keep}',asetpts=N/SR/TB` : 'anull', finalDuration(e));
  writeFileSync(keyPath, JSON.stringify({ key, gain }));
  return gain;
}

/** Ingressi di ffmpeg: la registrazione è sempre lo 0; Lucianus e pezzo finale, se ci sono. */
interface Inputs {
  args: string[];
  luc: number | null;
  outro: number | null;
  /** indice del prossimo ingresso */
  next: number;
}

/**
 * Grafo video di ffmpeg: gioco, Lucianus della registrazione (se si vede), i tagli, poi il pezzo finale, che sta
 * nel tempo del video finale. Posizione e grandezza da lookOf: le stesse per Lucianus e pezzo finale.
 */
function videoGraph(e: GameplayEdit, outHeight: number, removed: [number, number][], io: Inputs): string {
  const keep = keepExpr(removed);
  const look = lookOf(e);
  const lucH = Math.max(2, Math.round((look.h * outHeight) / 2) * 2);
  const key = (i: number, out: string) =>
    `[${i}:v]crop=${LOOK.crop},scale=in_color_matrix=bt709:in_range=tv,format=rgba,${LOOK.key},scale=-2:${lucH}:flags=lanczos:out_color_matrix=bt709:out_range=tv,format=yuva444p[${out}]`;
  const place = `x=trunc(W*${look.x.toFixed(5)}):y=trunc(H*${look.y.toFixed(5)}):eof_action=pass`;
  const parts = [outHeight === 2160 ? '[0:v]null[g]' : `[0:v]scale=-2:${outHeight}[g]`];
  let cur = '[g]';
  if (io.luc !== null) {
    parts.push(key(io.luc, 'l'), `${cur}[l]overlay=${place}[gl]`);
    cur = '[gl]';
  }
  parts.push(`${cur}${keep ? `select='${keep}',setpts=N/FRAME_RATE/TB` : 'null'}[c]`);
  cur = '[c]';
  if (io.outro !== null) {
    parts.push(key(io.outro, 'o'), `${cur}[o]overlay=${place}[co]`);
    cur = '[co]';
  }
  parts.push(`${cur}format=yuv420p[v]`);
  return parts.join(';');
}

/** Secondo del video finale che corrisponde al secondo `t` della registrazione. */
const toFinal = (removed: [number, number][], t: number) => t - removed.reduce((s, [a, b]) => s + Math.max(0, Math.min(b, t) - a), 0);

// Si decodifica sulla CPU, non con -hwaccel videotoolbox: sul M4 Max il decoder hardware regge
// ~180 fps sull'HEVC 4K a 100 Mbit/s, i 16 core più di 400, e il motore video resta libero per l'encoder.
// Il pezzo finale parte a outroStart nel video finale: in una prova si sposta rispetto all'inizio del pezzo provato.
function inputs(e: GameplayEdit, range: string[], test: { from?: number; dur?: number } = {}): Inputs {
  const args = [...range, '-i', video];
  let next = 1;
  let luc: number | null = null;
  if (showsFacecam(e)) {
    args.push('-itsoffset', ((e.offsetMs ?? 0) / 1000).toFixed(3), ...range, '-i', e.lucianus!);
    luc = next++;
  }
  let outro: number | null = null;
  const path = outroFile(e);
  if (path) {
    const at = outroStart(e) - toFinal(removedRanges(e), test.from ?? 0);
    if (at < (test.dur ?? Number.POSITIVE_INFINITY) && -at < e.outro!.duration) {
      args.push(...(at >= 0 ? ['-itsoffset', at.toFixed(3)] : ['-ss', (-at).toFixed(3)]), '-i', path);
      outro = next++;
    }
  }
  return { args, luc, outro, next };
}

const hasEncoder = (name: string) => Bun.spawnSync([FFMPEG, '-hide_banner', '-encoders'], { stdout: 'pipe' }).stdout.toString().includes(name);

// ───────── comandi ─────────

async function analizza() {
  let e = await load();
  if (e.lucianus && e.offsetMs === null) e = writeEdit(id, { ...e, offsetMs: measureOffset(e) });
  const menus = await findMenus();
  e = writeEdit(id, { ...replaceAuto(e, 'menu', menus), analyzed_at: new Date().toISOString() });
  console.log(`Impostazioni trovate: ${menus.length}`);
  for (const m of menus) console.log(`  ${hms(m.start)} – ${hms(m.end)}`);
  console.log(`Tagli in totale: ${e.cuts.length}. Rivedili nella dashboard, pagina Gameplay.`);
}

async function lingua() {
  checkSpace(gameplaySpace('lingua', id, await load()), 'il riconoscimento della lingua');
  const langs = (values.taglia ?? 'ro').split(',').map((s) => s.trim()).filter(Boolean);
  const found = await findLanguage(langs);
  const e = writeEdit(id, replaceAuto(await load(), 'lingua', found));
  console.log(`Tratti in ${langs.join(', ')} da togliere: ${found.length} (${Math.round(found.reduce((t, f) => t + f.end - f.start, 0))} s).`);
  console.log(`Tagli in totale: ${e.cuts.length}.`);
}

async function anteprima() {
  let e = await load();
  if (e.lucianus && e.offsetMs === null) e = writeEdit(id, { ...e, offsetMs: measureOffset(e) });
  checkSpace(gameplaySpace('anteprima', id, e), 'l’audio dell’anteprima');
  // Il video non si ricodifica: la dashboard riproduce la registrazione 4K e Lucianus così come sono
  // (decodifica hardware del browser). Qui si prepara solo l'audio: voce e gioco mixati, a circa −14 LUFS,
  // su tutta la registrazione (i tagli li salta il player).
  const out = previewPath(id);
  const tmp = `${out}.part.m4a`;
  const mix = await ensureMix(e);
  const gain = await gainTo14(['-i', mix], 'anull', e.duration, 0);
  console.log('Creo l’audio dell’anteprima…');
  await runProgress(['-hide_banner', '-y', '-loglevel', 'error', '-i', mix, '-af', `volume=${gain.toFixed(2)}dB,${LIMITER}`, '-c:a', hasEncoder('aac_at') ? 'aac_at' : 'aac', '-b:a', '160k', tmp], e.duration);
  renameSync(tmp, out);
  writeFileSync(`${out}.json`, readFileSync(`${mix}.json`, 'utf8'));
  rmSync(oldPreviewPath(id), { force: true });
  console.log(`Anteprima pronta: ${out}`);
}

async function esporta() {
  let e = await load();
  if (e.lucianus && e.offsetMs === null) e = writeEdit(id, { ...e, offsetMs: measureOffset(e) });
  const from = values.da ? Number(values.da) : undefined;
  const dur = values.durata ? Number(values.durata) : undefined;
  const test = from !== undefined || dur !== undefined;
  const range = [...(from ? ['-ss', String(from)] : []), ...(dur ? ['-t', String(dur)] : [])];
  // i tagli sono in secondi della registrazione: in una prova si spostano all'inizio del pezzo
  const removed = removedRanges(e)
    .map(([a, b]): [number, number] => [a - (from ?? 0), b - (from ?? 0)])
    .filter(([a, b]) => b > 0 && (dur === undefined || a < dur))
    .map(([a, b]): [number, number] => [Math.max(0, a), b]);
  const encoder = process.env.GAMEPLAY_ENCODER ?? 'hevc_videotoolbox';
  const q = readExport();
  console.log(`Qualità: video finale ${q.final.videoMbps} Mbit/s, audio ${q.final.audioKbps}k${test ? '' : ` · copia a 720p ${q.review.fps} fps, ${q.review.videoMbps} Mbit/s`} (config/export.json)`);
  if (!hasEncoder(encoder)) throw new Error(`questo ffmpeg non ha l'encoder ${encoder}: installalo con brew install ffmpeg`);
  console.log(`Tagli attivi: ${removed.length} (${Math.round(removed.reduce((t, [a, b]) => t + b - a, 0))} s in meno).`);
  checkSpace(gameplaySpace('esporta', id, e, test ? { duration: dur ?? 30 } : undefined), test ? 'la prova' : 'il video finale');

  const out = exportPath(id, video, test, e.title);
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.part.mp4`;
  // durata del video che esce, per la barra di avanzamento
  const end = dur ?? (await probe(video)).duration - (from ?? 0);
  const total = end - removed.reduce((t, [a, b]) => t + Math.max(0, Math.min(b, end) - a), 0);

  // L'audio parte dal mix (voce e gioco già sistemati, legge la registrazione una volta sola), con gli stessi
  // tagli del video; il volume a −14 LUFS si misura sul mix, che è piccolo: pochi minuti in tutto.
  const mix = await ensureMix(e);
  const mixIn = [...range, '-i', mix];
  const keep = keepExpr(removed);
  const cut = keep ? `aselect='${keep}',asetpts=N/SR/TB` : 'anull';
  const gain = await finalGain(e, mix);

  // GOP di mezzo secondo; bitrate da config/export.json. L'audio arriva al massimo a 320k: YouTube chiede 384k,
  // ma l'AAC di Apple in stereo si ferma a 320 ed è comunque migliore dell'aac di ffmpeg a 384.
  // Video e audio in due grafi separati: in uno solo, durante un taglio ffmpeg continua a leggere la
  // registrazione per l'audio e tiene in memoria i fotogrammi 4K in attesa di Lucianus (272 GB per 381 s tagliati).
  const io = inputs(e, range, { from, dur });
  const audioIn = io.next;
  if (e.lucianus && !showsFacecam(e)) console.log('Lucianus della registrazione tolto dal video (resta la sua voce).');
  if (io.outro !== null) console.log(`Pezzo finale: ${basename(e.outro!.path)} (${hms(e.outro!.duration)}), finisce con il video.`);
  else if (e.outro && !outroFile(e)) console.warn(`Attenzione: il pezzo finale non c'è più (${e.outro.path}).`);
  // Il video finale completo esce anche come copia a 720p (stessa decodifica, quasi gratis), accanto a lui:
  // per rivederlo quando registrazioni e video finale 4K saranno stati cancellati.
  const archTmp = `${archivePath(id)}.part.mp4`;
  const video4k = test ? videoGraph(e, 2160, removed, io) : `${videoGraph(e, 2160, removed, io)};[v]split=2[v4k][vlo];[vlo]${archiveVideo()}[varc]`;
  const audio = `[${audioIn}:a]${cut},volume=${gain.toFixed(2)}dB,${LIMITER}${test ? '[a]' : ',asplit=2[a][aarc]'}`;
  if (!test) mkdirSync(dirname(archTmp), { recursive: true });
  console.log(`Creo ${out}${test ? '' : ' e la copia a 720p'}…`);
  await runProgress([
    '-hide_banner', '-y', '-loglevel', 'error', ...io.args, ...mixIn,
    '-filter_complex', video4k, '-filter_complex', audio, '-map', test ? '[v]' : '[v4k]', '-map', '[a]',
    '-c:v', encoder, '-b:v', `${q.final.videoMbps}M`, '-profile:v', 'main', '-tag:v', 'hvc1', '-g', '30',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-c:a', hasEncoder('aac_at') ? 'aac_at' : 'aac', '-b:a', `${q.final.audioKbps}k`, '-movflags', '+faststart', tmp,
    ...(test ? [] : ['-map', '[varc]', '-map', '[aarc]', ...ARCHIVE_CODECS(), archTmp]),
  ], total);
  if (!test) finishArchive(archTmp);
  if (!test) await writeTracks(e, exportPath(id, video, false, readEdit(id)?.title));
  // il nome si può cambiare dalla dashboard mentre l'export gira: vale quello di adesso
  const dest = exportPath(id, video, test, readEdit(id)?.title);
  renameSync(tmp, dest);
  if (!test) {
    // il video finale compare tra i video della dashboard, pronto per gli short
    db.run('INSERT OR IGNORE INTO extra_videos (path, added_at) VALUES (?, ?)', [dest, now()]);
    // anteprima e mix non servono più: si rifanno se si torna a lavorare sui tagli
    for (const p of [previewPath(id), `${previewPath(id)}.json`, oldPreviewPath(id), mixPath(id), `${mixPath(id)}.json`, `${mixPath(id)}.gain.json`]) rmSync(p, { force: true });
    console.log('Anteprima e mix cancellati per liberare spazio.');
  }
  console.log(`Fatto: ${dest}`);
}

// ───────── gioco e voce separati per gli short ─────────

/** Le due tracce della registrazione (gioco stereo, voce mono) con i tagli del video finale, accanto al video. */
async function writeTracks(e: GameplayEdit, final: string): Promise<void> {
  const keep = keepExpr(removedRanges(e));
  const cut = keep ? `aselect='${keep}',asetpts=N/SR/TB` : 'anull';
  const out = tracksPath(final);
  const tmp = `${out}.part.m4a`;
  console.log('Salvo gioco e voce separati per gli short…');
  // con il pezzo finale, anche qui la sua voce al posto di quella del gameplay
  const vi = await voiceInputs(e, 1);
  const src = voiceSource(e, vi, vi.outroIn !== null ? inputLufs(e, vi) : Number.NaN);
  await runProgress([
    '-hide_banner', '-y', '-loglevel', 'error', '-i', video, ...vi.args,
    '-filter_complex', `${src.graph}[0:a:0]${cut}[g];${src.label}${cut},pan=mono|c0=c0[v]`, '-map', '[g]', '-map', '[v]',
    '-c:a', hasEncoder('aac_at') ? 'aac_at' : 'aac', '-b:a', '256k', tmp,
  ], finalDuration(e));
  renameSync(tmp, out);
  console.log(`Tracce per gli short: ${out}`);
}

/** Tracce separate per un video finale esportato prima che si facessero insieme all'export. */
async function tracce() {
  const e = await load();
  const final = exportPath(id, video, false, e.title);
  if (!existsSync(final)) throw new Error(`il video finale non c'è: ${final}`);
  checkSpace(gameplaySpace('tracce', id, e), 'gioco e voce separati');
  await writeTracks(e, final);
}

// ───────── copia a 720p per rivedere ─────────

/** 720p, fps e bitrate da config/export.json (di base 30 fps e 2,5 Mbit/s, circa 3 GB per 2 ore e mezza). */
const archiveVideo = () => `scale=-2:720:flags=bicubic,fps=${readExport().review.fps},format=yuv420p`;
const ARCHIVE_CODECS = () => {
  const r = readExport().review;
  return [
    '-c:v', hasEncoder('h264_videotoolbox') ? 'h264_videotoolbox' : 'libx264', '-b:v', `${Math.round(r.videoMbps * 1000)}k`, '-g', String(r.fps * 2),
    '-c:a', hasEncoder('aac_at') ? 'aac_at' : 'aac', '-b:a', `${r.audioKbps}k`, '-movflags', '+faststart',
  ];
};

/** Rinomina la copia finita e ne prende la copertina per la lista dei gameplay. */
function finishArchive(tmp: string): void {
  renameSync(tmp, archivePath(id));
  const dur = Number(Bun.spawnSync(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', archivePath(id)]).stdout.toString()) || 60;
  Bun.spawnSync([FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', '-ss', String(Math.round(dur / 3)), '-i', archivePath(id), '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', posterPath(id)]);
  console.log(`Copia per rivedere: ${archivePath(id)}`);
}

/** Copia a 720p da un video finale già esportato (prima che la copia si facesse insieme all'export). */
async function archivio() {
  const e = readEdit(id);
  if (!e) throw new Error(`nessun gameplay con id ${id}`);
  const final = exportPath(id, e.video, false, e.title);
  if (!existsSync(final)) throw new Error(`il video finale non c'è più: ${final}`);
  checkSpace(gameplaySpace('archivio', id, e), 'la copia a 720p');
  const tmp = `${archivePath(id)}.part.mp4`;
  mkdirSync(dirname(tmp), { recursive: true });
  console.log(`Creo la copia a 720p di ${basename(final)}…`);
  await runProgress(['-hide_banner', '-y', '-loglevel', 'error', '-i', final, '-map', '0:v:0', '-map', '0:a:0', '-vf', archiveVideo(), ...ARCHIVE_CODECS(), tmp], finalDuration(e));
  finishArchive(tmp);
}

const commands: Record<string, () => Promise<void>> = { analizza, lingua, anteprima, esporta, archivio, tracce };
const fn = commands[command];
if (!fn) {
  console.error(`comando sconosciuto: ${command}`);
  process.exit(2);
}
console.log(`${byId ? `ID: ${id}` : `Video: ${basename(video)}  ·  ID: ${id}`}  ·  stato: ${editPath(id)}\n`);
await fn();
