// Libreria dei video ufficiali di GTA VI, per le immagini dei video lunghi di notizie.
//   bun run news media sync    scarica i video "Grand Theft Auto VI" del canale YouTube di Rockstar
//                              (solo immagine: l'audio dei trailer ha canzoni con licenza), li divide
//                              in inquadrature e le fa etichettare (routing media)
//   bun run news media add <file> <id YouTube>   aggiunge un video scaricato a mano
//   bun run news media upgrade riscarica i video già in libreria nel formato migliore disponibile
//                              (stesse inquadrature ed etichette: cambia solo il file originale)
// File in data/media/, inquadrature nella tabella media_shots di data/lucio.db. Si può rilanciare:
// rifà solo quello che manca.
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { db, DATA, now } from '../dashboard/db';
import { PATHS } from '../lib/env';
import { exec, FFMPEG, ffmpeg, probe } from '../lib/ff';
import { loadPrompt, runTask } from '../lib/llm';
import { route, toLlmTask } from '../lib/routing';
import { LLM_DIR } from './common';

const CHANNEL = 'https://www.youtube.com/@RockstarGames/videos';
const TITLE = /grand theft auto vi\b|\bgta vi\b|\bgta 6\b/i;
const MEDIA = join(DATA, 'media');
export const DIRS = { official: join(MEDIA, 'official'), leak: join(MEDIA, 'leak'), proxy: join(MEDIA, 'proxy'), frames: join(MEDIA, 'frames'), grids: join(MEDIA, 'grids') };
export const YTDLP = join(PATHS.venv, 'bin', 'yt-dlp');
/** Sotto questa durata un'inquadratura si unisce alla precedente: sono flash e dissolvenze. */
const MIN_SHOT = 0.5;
/** Oltre questa durata un'inquadratura si divide in pezzi uguali per il catalogo. */
const MAX_SHOT = 8;
/** Soglia di scdet (0–100) per un taglio: i trailer Rockstar hanno molte dissolvenze rapide. */
const CUT_THRESHOLD = 12;
const TILES = 12;
/**
 * Il formato migliore tra 1080p e 4K: prima la risoluzione più alta, poi il bitrate più alto.
 * A pari 4K YouTube offre AV1 a ~10 Mbps e VP9 fino a ~19 Mbps: vince il secondo.
 */
const FORMAT = ['-f', 'bv*[height<=2160][height>=1080]', '-S', 'res,vbr'];

export interface ShotTags {
  who: ('lucia' | 'jason' | 'other_people' | 'nobody')[];
  framing: 'close' | 'medium' | 'wide' | 'aerial';
  time: 'day' | 'golden' | 'night' | 'interior';
  place: string;
  action: string;
  text_on_screen: boolean;
  usable: boolean;
  description: string;
}

export interface MediaVideo {
  id: string;
  title: string;
  url: string;
  duration: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  path: string | null;
  proxy: string | null;
  status: 'scaricato' | 'diviso' | 'etichettato' | 'saltato';
  note: string | null;
  added_at: string;
  source: 'official' | 'leak';
  query: string | null;
}

export async function syncMedia(): Promise<void> {
  for (const d of Object.values(DIRS)) mkdirSync(d, { recursive: true });
  const listed = (await exec([YTDLP, '--flat-playlist', '--print', '%(id)s\t%(title)s', CHANNEL]))
    .trim()
    .split('\n')
    .map((l) => l.split('\t') as [string, string])
    .filter(([, t]) => TITLE.test(t ?? ''));
  console.log(`  canale Rockstar: ${listed.length} video su GTA VI`);
  for (const [id, title] of listed) {
    const row = db.query(`SELECT * FROM media_videos WHERE id = ?`).get(id) as MediaVideo | null;
    if (row?.status === 'saltato' && !process.env.LUCIO_YT_COOKIES_BROWSER) continue;
    if (!row || row.status === 'saltato') await download(id, title);
    const v = db.query(`SELECT * FROM media_videos WHERE id = ?`).get(id) as MediaVideo;
    if (v.status === 'saltato') continue;
    if (v.status === 'scaricato') await splitShots(v);
    if ((db.query(`SELECT COUNT(*) AS n FROM media_shots WHERE video_id = ? AND tags IS NULL`).get(id) as { n: number }).n) await tagShots(v);
  }
  const n = db.query(`SELECT COUNT(*) AS n, SUM(tags IS NOT NULL) AS tagged FROM media_shots`).get() as { n: number; tagged: number };
  console.log(`  libreria: ${n.n} inquadrature, ${n.tagged} etichettate`);
}

/**
 * Solo la traccia video. Qualità: prima il 4K, poi la risoluzione più alta disponibile, mai sotto
 * il 1080p (sotto, il video si salta). I video con limite d'età chiedono l'accesso: si scaricano con
 * i cookie di YouTube del browser (LUCIO_YT_COOKIES_BROWSER=chrome), altrimenti si saltano.
 */
async function download(id: string, title: string): Promise<void> {
  const url = `https://www.youtube.com/watch?v=${id}`;
  const cookies = process.env.LUCIO_YT_COOKIES_BROWSER ? ['--cookies-from-browser', process.env.LUCIO_YT_COOKIES_BROWSER] : [];
  console.log(`  scarico ${title}`);
  try {
    await exec([YTDLP, ...cookies, ...FORMAT, '--no-playlist', '-o', join(DIRS.official, `${id}.%(ext)s`), url]);
  } catch (e) {
    const msg = (e as Error).message;
    const note = /confirm your age/i.test(msg)
      ? 'limite di età: serve LUCIO_YT_COOKIES_BROWSER'
      : /requested format is not available/i.test(msg)
        ? 'nessun formato da almeno 1080p'
        : msg.split('\n').at(-1)!.slice(0, 200);
    console.log(`    saltato: ${note}`);
    db.run(`INSERT OR REPLACE INTO media_videos (id, title, url, status, note, added_at) VALUES (?, ?, ?, 'saltato', ?, ?)`, [id, title, url, note, now()]);
    return;
  }
  const file = readdirSync(DIRS.official).find((f) => f.startsWith(`${id}.`))!;
  await register(id, title, url, join(DIRS.official, file));
}

/** Copia leggera per la dashboard e per i fotogrammi (H.264 640 px decodifica in un attimo), poi la riga in libreria. */
export async function register(id: string, title: string, url: string, path: string, source: MediaVideo['source'] = 'official', query: string | null = null): Promise<void> {
  const info = await probe(path);
  const proxy = join(DIRS.proxy, `${id}.mp4`);
  await ffmpeg(['-i', path, '-an', '-vf', 'scale=640:-2', '-c:v', 'libx264', '-crf', '26', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', proxy]);
  db.run(
    `INSERT OR REPLACE INTO media_videos (id, title, url, duration, width, height, fps, path, proxy, status, note, added_at, source, query) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'scaricato', NULL, ?, ?, ?)`,
    [id, title, url, info.duration, info.video?.width ?? null, info.video?.height ?? null, info.video?.fps ?? null, path, proxy, now(), source, query],
  );
}

/**
 * Riscarica gli originali quando YouTube ha un formato migliore (più risoluzione o più bitrate).
 * Il video è lo stesso, quindi inquadrature, etichette e copia leggera restano valide; se la durata
 * non torna entro un decimo di secondo il file nuovo si scarta.
 */
export async function upgradeMedia(): Promise<void> {
  const videos = db.query(`SELECT * FROM media_videos WHERE path IS NOT NULL AND source = 'official' ORDER BY added_at`).all() as MediaVideo[];
  const tmp = join(MEDIA, 'upgrade');
  mkdirSync(tmp, { recursive: true });
  for (const v of videos) {
    const best = (await exec([YTDLP, ...FORMAT, '--no-playlist', '--print', '%(format_id)s\t%(height)s\t%(vbr)s', v.url]).catch(() => '')).trim().split('\t');
    const old = await probe(v.path!);
    const oldKbps = old.duration ? (Bun.file(v.path!).size * 8) / old.duration / 1000 : 0;
    if (best.length < 3 || (Number(best[1]) <= (old.video?.height ?? 0) && Number(best[2]) <= oldKbps * 1.1)) {
      console.log(`  ${v.title}: già al meglio`);
      continue;
    }
    console.log(`  ${v.title}: ${old.video?.height}p ${Math.round(oldKbps)} kbps → ${best[1]}p ${Math.round(Number(best[2]))} kbps`);
    await exec([YTDLP, ...FORMAT, '--no-playlist', '-o', join(tmp, `${v.id}.%(ext)s`), v.url]);
    const file = readdirSync(tmp).find((f) => f.startsWith(`${v.id}.`))!;
    const fresh = join(tmp, file);
    const info = await probe(fresh);
    if (Math.abs(info.duration - (v.duration ?? 0)) > 0.1) {
      console.log(`    durata diversa (${info.duration.toFixed(2)} s contro ${v.duration?.toFixed(2)} s): tengo il vecchio`);
      rmSync(fresh);
      continue;
    }
    const dest = join(DIRS.official, file);
    rmSync(v.path!);
    renameSync(fresh, dest);
    db.run(`UPDATE media_videos SET path = ?, width = ?, height = ?, fps = ? WHERE id = ?`, [dest, info.video?.width ?? null, info.video?.height ?? null, info.video?.fps ?? null, v.id]);
  }
  rmSync(tmp, { recursive: true, force: true });
}

/**
 * Un video ufficiale scaricato a mano (per esempio uno con limite d'età): si sposta nella libreria,
 * si controlla la qualità (almeno 1080p; sotto il 4K solo un avviso) e si cataloga come gli altri.
 */
export async function addLocalVideo(file: string, id: string): Promise<void> {
  if (!existsSync(file)) throw new Error(`file non trovato: ${file}`);
  const info = await probe(file);
  const h = info.video?.height ?? 0;
  if (h < 1080) throw new Error(`${info.video?.width}×${h}: sotto il 1080p, non entra in libreria`);
  if (h < 2160) console.log(`  attenzione: ${info.video?.width}×${h}, non è 4K`);
  const row = db.query(`SELECT * FROM media_videos WHERE id = ?`).get(id) as MediaVideo | null;
  const url = `https://www.youtube.com/watch?v=${id}`;
  const title = row?.title ?? basename(file, extname(file));
  for (const d of Object.values(DIRS)) mkdirSync(d, { recursive: true });
  const dest = join(DIRS.official, `${id}${extname(file).toLowerCase()}`);
  // Stesso disco: rename. Altrimenti copia e cancella l'originale (è uno spostamento).
  try {
    renameSync(file, dest);
  } catch {
    copyFileSync(file, dest);
    rmSync(file);
  }
  console.log(`  spostato in ${dest}`);
  await register(id, title, url, dest);
  const v = db.query(`SELECT * FROM media_videos WHERE id = ?`).get(id) as MediaVideo;
  await splitShots(v);
  await tagShots(v);
}

/** Tagli con scdet sulla copia leggera; le inquadrature troppo corte si uniscono alla precedente. */
export async function splitShots(v: MediaVideo): Promise<void> {
  const log = await exec([FFMPEG, '-hide_banner', '-nostdin', '-i', v.proxy!, '-vf', `scdet=threshold=${CUT_THRESHOLD}`, '-an', '-f', 'null', '-'], true);
  const cuts = [...log.matchAll(/lavfi\.scd\.time:\s*([\d.]+)/g)].map((m) => Number(m[1]));
  const dur = v.duration ?? 0;
  const bounds = [0, ...cuts.filter((t) => t > 0 && t < dur), dur];
  const shots: [number, number][] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const [s, e] = [bounds[i]!, bounds[i + 1]!];
    if (e - s < MIN_SHOT && shots.length) shots.at(-1)![1] = e;
    else shots.push([s, e]);
  }
  // Le riprese lunghe (gameplay continuo) si catalogano a pezzi: un fotogramma per un minuto non dice cosa succede.
  for (let i = shots.length - 1; i >= 0; i--) {
    const [s, e] = shots[i]!;
    const parts = Math.ceil((e - s) / MAX_SHOT);
    if (parts > 1) shots.splice(i, 1, ...Array.from({ length: parts }, (_, k): [number, number] => [s + ((e - s) * k) / parts, s + ((e - s) * (k + 1)) / parts]));
  }
  const dir = join(DIRS.frames, v.id);
  mkdirSync(dir, { recursive: true });
  db.run(`DELETE FROM media_shots WHERE video_id = ?`, [v.id]);
  for (const [idx, [s, e]] of shots.entries()) {
    const frame = join(dir, `${String(idx).padStart(3, '0')}.jpg`);
    await ffmpeg(['-ss', ((s + e) / 2).toFixed(3), '-i', v.proxy!, '-frames:v', '1', '-q:v', '3', frame]);
    db.run(`INSERT INTO media_shots (video_id, idx, s, e, frame) VALUES (?, ?, ?, ?, ?)`, [v.id, idx, Math.round(s * 1000) / 1000, Math.round(e * 1000) / 1000, frame]);
  }
  db.run(`UPDATE media_videos SET status = 'diviso' WHERE id = ?`, [v.id]);
  console.log(`    ${v.title}: ${shots.length} inquadrature`);
}

/** Griglie numerate di 12 fotogrammi, una chiamata per griglia. */
export async function tagShots(v: MediaVideo): Promise<void> {
  const rt = await route('media');
  const { system, schema } = await loadPrompt('media-tag');
  const shots = db.query(`SELECT id, idx, frame FROM media_shots WHERE video_id = ? AND tags IS NULL ORDER BY idx`).all(v.id) as { id: number; idx: number; frame: string }[];
  for (let k = 0; k < shots.length; k += TILES) {
    const batch = shots.slice(k, k + TILES);
    const grid = join(DIRS.grids, `${v.id}-${batch[0]!.idx}.jpg`);
    await gridImage(batch.map((x) => x.frame), grid);
    const out = await runTask<{ tiles: ({ i: number } & ShotTags)[] }>(
      join(LLM_DIR, 'media', `${v.id}-${batch[0]!.idx}`),
      toLlmTask(rt, { think: false, temperature: 0.1, images: [grid], timeout_s: 600 }),
      system,
      `Video: ${v.title}\nTiles 1–${batch.length}.`,
      schema,
    );
    for (const { i, ...tags } of out.tiles) {
      const shot = batch[i - 1];
      if (shot) db.run(`UPDATE media_shots SET tags = ? WHERE id = ?`, [JSON.stringify(tags), shot.id]);
    }
    console.log(`    ${v.title}: etichettate ${Math.min(k + TILES, shots.length)}/${shots.length}`);
  }
  const left = (db.query(`SELECT COUNT(*) AS n FROM media_shots WHERE video_id = ? AND tags IS NULL`).get(v.id) as { n: number }).n;
  if (!left) db.run(`UPDATE media_videos SET status = 'etichettato' WHERE id = ?`, [v.id]);
}

/** 4×3 riquadri da 384 px con il numero in alto a sinistra. */
async function gridImage(frames: string[], out: string): Promise<void> {
  if (existsSync(out)) return;
  const inputs = frames.flatMap((f) => ['-i', f]);
  const pad = Array.from({ length: TILES - frames.length }, (_, i) => `color=c=black:s=384x216:d=1[p${i}]`);
  const tiles = frames.map((_, i) => `[${i}:v]scale=384:216:force_original_aspect_ratio=decrease,pad=384:216:(ow-iw)/2:(oh-ih)/2,drawbox=x=0:y=0:w=44:h=34:color=black@0.8:t=fill[t${i}]`);
  const labels = [...frames.map((_, i) => `[t${i}]`), ...pad.map((_, i) => `[p${i}]`)].join('');
  const layout = Array.from({ length: TILES }, (_, i) => `${(i % 4) * 384}_${Math.floor(i / 4) * 216}`).join('|');
  await ffmpeg([...inputs, '-filter_complex', [...tiles, ...pad, `${labels}xstack=inputs=${TILES}:layout=${layout}`].join(';'), '-frames:v', '1', '-q:v', '3', out]);
  await numberTiles(out, frames.length);
}

/** I numeri dei riquadri: l'ffmpeg di sistema non ha drawtext, si scrivono con Pillow. */
async function numberTiles(path: string, n: number): Promise<void> {
  const code = [
    'import sys',
    'from PIL import Image, ImageDraw, ImageFont',
    'p, n = sys.argv[1], int(sys.argv[2])',
    'im = Image.open(p); d = ImageDraw.Draw(im)',
    'f = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 26)',
    'for i in range(n):',
    '    d.text(((i % 4) * 384 + 6, (i // 4) * 216 + 3), str(i + 1), font=f, fill=(255, 181, 71))',
    'im.save(p, quality=90)',
  ].join('\n');
  await exec([join(PATHS.venv, 'bin', 'python'), '-I', '-c', code, path, String(n)]);
}
