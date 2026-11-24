// Video del montaggio di uno script lungo: le scene scelte (assets.ts) messe in fila con i tempi di
// lettura dello script, renderizzate in 4K con Remotion (composizione NewsMontage). È la sorgente da
// mettere in OBS: Lucio ci registra sopra leggendo lo script dal gobbo della dashboard, che usa la
// stessa linea del tempo (timeline.json).
//   bun run news montage <script> [--frames 0-899]   (--frames: prova veloce su un tratto)
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { db, DATA } from '../dashboard/db';
import { ROOT } from '../lib/env';
import { type Manifest, manifestPath } from './assets';
import type { LongScript } from './long';

/** Ritmo di lettura sul montaggio: un po' più lento del parlato, per respirare e reagire. */
export const READ_WPM = 150;
const FPS = 30;
/** Secondi dello stacco con il titolo tra un capitolo e l'altro. */
const CHAPTER_GAP = 1.5;
/** Una scena non dura meno di così, anche se ha due parole. */
const MIN_BEAT = 2.5;
/** Un'inquadratura non resta a schermo meno di così. */
const MIN_SHOT = 1.2;
/** Rallentamento massimo per allungare un'inquadratura corta. */
const MAX_SLOW = 0.75;

export type MontageItem =
  | { kind: 'shot'; from: number; dur: number; src: string; trim: number; rate: number; leak: boolean }
  | { kind: 'image'; from: number; dur: number; src: string; credit: string }
  | { kind: 'card'; from: number; dur: number; text: string; bg?: string }
  | { kind: 'lucio'; from: number; dur: number }
  | { kind: 'chapter'; from: number; dur: number; n: number; title: string };

export interface MontageProps {
  fps: number;
  width: number;
  height: number;
  /** in fotogrammi */
  duration: number;
  items: MontageItem[];
  chapters: { from: number; n: number; title: string }[];
  /** da dove la composizione legge i file (server locale del render) */
  mediaBase?: string;
  [key: string]: unknown;
}

/** Per il gobbo: il testo da leggere scena per scena, in secondi. */
export interface PrompterBeat {
  chapter: number;
  title: string;
  start: number;
  end: number;
  text: string;
  cue: string;
}

export async function buildMontage(scriptId: number, opts: { frames?: string; render?: boolean } = {}): Promise<{ dir: string; video: string | null; props: MontageProps }> {
  const row = db.query(`SELECT content, edited FROM scripts WHERE id = ? AND kind = 'long'`).get(scriptId) as { content: string; edited: string | null } | null;
  if (!row) throw new Error(`script lungo ${scriptId} non trovato`);
  if (!existsSync(manifestPath(scriptId))) throw new Error('materiali non ancora scelti: bun run news assets <script>');
  const script = JSON.parse(row.edited ?? row.content) as LongScript;
  const manifest = (await Bun.file(manifestPath(scriptId)).json()) as Manifest;
  const dir = join(DATA, 'assets', `script-${scriptId}`);
  const pub = join(dir, 'render');
  rmSync(pub, { recursive: true, force: true });
  mkdirSync(pub, { recursive: true });
  // Remotion legge i file dalla sua cartella pubblica: link agli originali 4K, niente copie.
  const linked = new Map<string, string>();
  const publicFile = (path: string) => {
    if (!linked.has(path)) {
      const name = `${linked.size}${extname(path)}`;
      symlinkSync(path, join(pub, name));
      linked.set(path, name);
    }
    return linked.get(path)!;
  };
  const leakVideos = new Set((db.query(`SELECT id FROM media_videos WHERE source = 'leak'`).all() as { id: string }[]).map((x) => x.id));
  const officialPath = new Map((db.query(`SELECT id, path FROM media_videos WHERE path IS NOT NULL`).all() as { id: string; path: string }[]).map((x) => [x.id, x.path]));

  const items: MontageItem[] = [];
  const chapters: MontageProps['chapters'] = [];
  const prompter: PrompterBeat[] = [];
  let t = 0; // in fotogrammi
  // fotogramma dell'ultima inquadratura mostrata: sfondo sfocato dei cartelli; prima della prima, la prima
  let lastFrame = manifest.beats.flatMap((b) => b.assets).find((a) => a.type === 'shot')?.frame;
  for (const [ci, ch] of script.chapters.entries()) {
    if (ci > 0) {
      // Stacco tra i capitoli: numero e titolo per un momento, il gobbo intanto è fermo.
      items.push({ kind: 'chapter', from: t, dur: CHAPTER_GAP * FPS, n: ci + 1, title: ch.title });
      t += CHAPTER_GAP * FPS;
    }
    chapters.push({ from: t, n: ci + 1, title: ch.title });
    const texts = splitVoice(ch.voice, ch.beats.map((b) => b.at));
    for (const [bi, b] of ch.beats.entries()) {
      const mb = manifest.beats.find((x) => x.chapter === ci + 1 && x.index === bi + 1);
      const text = texts[bi] ?? '';
      const dur = Math.round(Math.max(MIN_BEAT, (words(text) / READ_WPM) * 60) * FPS);
      const shots = (mb?.assets ?? []).filter((a) => a.type === 'shot');
      const images = (mb?.assets ?? []).filter((a) => a.type === 'image');
      if (b.kind === 'card') items.push({ kind: 'card', from: t, dur, text: b.card_text || b.show, bg: lastFrame && publicFile(lastFrame) });
      else if (b.kind === 'lucio' || (!shots.length && !images.length)) items.push({ kind: 'lucio', from: t, dur });
      else if (images.length && !shots.length) {
        const each = Math.round(dur / images.length);
        images.forEach((a, k) => items.push({ kind: 'image', from: t + k * each, dur: k === images.length - 1 ? dur - k * each : each, src: publicFile(a.file), credit: host(a.page) }));
      } else {
        lastFrame = shots.at(-1)!.frame;
        for (const s of fillShots(shots, dur)) {
          const path = officialPath.get(s.video_id);
          if (!path) continue;
          items.push({ kind: 'shot', from: t + s.from, dur: s.dur, src: publicFile(path), trim: s.trim, rate: s.rate, leak: leakVideos.has(s.video_id) });
        }
      }
      prompter.push({ chapter: ci + 1, title: ch.title, start: t / FPS, end: (t + dur) / FPS, text, cue: cue(b.kind) });
      t += dur;
    }
  }
  const props: MontageProps = { fps: FPS, width: 3840, height: 2160, duration: t, items, chapters };
  await Bun.write(join(dir, 'montage-props.json'), JSON.stringify(props));
  await Bun.write(join(dir, 'timeline.json'), JSON.stringify({ script_id: scriptId, fps: FPS, read_wpm: READ_WPM, duration: t / FPS, beats: prompter }, null, 2));
  console.log(`  montaggio: ${(t / FPS / 60).toFixed(1)} min, ${items.length} elementi, ${linked.size} file sorgente`);
  if (opts.render === false) return { dir, video: null, props };

  const video = join(dir, opts.frames ? `montaggio-prova-${opts.frames}.mp4` : 'montaggio.mp4');
  const t0 = performance.now();
  // Remotion copierebbe la cartella pubblica (GB di originali) nel suo pacchetto: i file si servono
  // invece da qui, solo su 127.0.0.1 e solo per la durata del render.
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req) => serveFile(pub, req) });
  await Bun.write(join(dir, 'montage-props.json'), JSON.stringify({ ...props, mediaBase: `http://127.0.0.1:${server.port}` }));
  const proc = Bun.spawn(
    [
      'bunx', 'remotion', 'render', 'src/index.ts', 'NewsMontage', video,
      `--props=${join(dir, 'montage-props.json')}`,
      // H.264 4K ad alto bitrate con l'encoder hardware del Mac: OBS lo riproduce senza fatica.
      '--codec=h264', '--hardware-acceleration=if-possible', '--video-bitrate=60M', '--pixel-format=yuv420p', '--muted',
      ...(opts.frames ? [`--frames=${opts.frames}`] : []),
    ],
    { cwd: join(ROOT, 'remotion'), stdout: 'inherit', stderr: 'inherit' },
  );
  const code = await proc.exited;
  server.stop(true);
  if (code !== 0) throw new Error('render del montaggio non riuscito');
  console.log(`  ${basename(video)} in ${((performance.now() - t0) / 60000).toFixed(1)} min`);
  return { dir, video, props };
}

/** Un file della cartella del render, con le richieste a pezzi (Range) che servono a leggere i video. */
function serveFile(pub: string, req: Request): Response {
  const name = decodeURIComponent(new URL(req.url).pathname.slice(1));
  if (!name || name.includes('/') || !existsSync(join(pub, name))) return new Response('non trovato', { status: 404 });
  const f = Bun.file(realpathSync(join(pub, name)));
  const headers = { 'Content-Type': f.type || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' };
  const m = req.headers.get('range')?.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (!m[1] && !m[2])) return new Response(f, { headers: { ...headers, 'Content-Length': String(f.size) } });
  const start = m[1] ? Number(m[1]) : Math.max(0, f.size - Number(m[2]));
  const end = Math.min(m[1] && m[2] ? Number(m[2]) : f.size - 1, f.size - 1);
  if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${f.size}` } });
  return new Response(f.slice(start, end + 1), { status: 206, headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${f.size}` } });
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
/** Una parola senza punteggiatura: "there's" e "there’s" diventano entrambe "theres". */
const key = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Il testo del capitolo diviso alle parole d'inizio delle scene (`at`), con la punteggiatura originale. */
function splitVoice(voice: string, anchors: string[]): string[] {
  const tokens = voice.split(/\s+/).filter(Boolean);
  const keys = tokens.map(key);
  const starts: number[] = [];
  for (const a of anchors) {
    const want = a.split(/\s+/).map(key).filter(Boolean);
    const from = starts.at(-1) ?? 0;
    let found = -1;
    for (let i = from; i < keys.length && found < 0; i++) if (want.every((w, k) => keys[i + k] === w)) found = i;
    starts.push(found < 0 ? from : found);
  }
  starts[0] = 0;
  return starts.map((s, i) => tokens.slice(s, starts[i + 1] ?? tokens.length).join(' '));
}

type ShotAsset = Extract<Manifest['beats'][number]['assets'][number], { type: 'shot' }>;

/**
 * Riempie la scena con le sue inquadrature, in ordine: ognuna prende una parte uguale del tempo;
 * se è più corta si rallenta (al massimo a 0,75×) e, se ancora non basta, si ricomincia dalla prima.
 */
function fillShots(shots: ShotAsset[], dur: number): { video_id: string; from: number; dur: number; trim: number; rate: number }[] {
  const out: { video_id: string; from: number; dur: number; trim: number; rate: number }[] = [];
  const per = Math.max(MIN_SHOT * FPS, dur / shots.length);
  let t = 0;
  for (let k = 0; t < dur && k < shots.length * 6; k++) {
    const a = shots[k % shots.length]!;
    const len = (a.e - a.s) * FPS;
    const left = dur - t;
    const want = left - per < MIN_SHOT * FPS ? left : Math.min(per, left);
    const rate = len >= want ? 1 : Math.max(MAX_SLOW, len / want);
    const shown = Math.max(1, Math.min(Math.round(want), Math.floor(len / rate), left));
    out.push({ video_id: a.video_id, from: t, dur: shown, trim: a.s, rate });
    t += shown;
  }
  if (t < dur && out.length) out.at(-1)!.dur += dur - t; // l'ultima tiene l'ultimo fotogramma
  return out;
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function cue(kind: string): string {
  return kind === 'lucio' ? 'Lucio a tutto schermo' : kind === 'leak' ? 'leak: dillo che è materiale trapelato' : kind === 'card' ? 'cartello' : '';
}
