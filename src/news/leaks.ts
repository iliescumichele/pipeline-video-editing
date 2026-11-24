// Ricerca automatica dei leak di GTA VI su YouTube, per le scene "leak" dei video lunghi.
//   bun run news leaks "<cosa deve vedersi>"   cerca, scarica e cataloga i leak per una descrizione
// Per ogni scena: ricerche scritte dal modello → risultati di YouTube (yt-dlp) → il modello sceglie
// i video che contengono il filmato trapelato (non reaction o commenti) → si scaricano alla qualità
// più alta disponibile (per i leak niente soglia del 1080p) → inquadrature ed etichette come per gli
// ufficiali, con source = 'leak'. I file stanno in data/media/leak/.
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../dashboard/db';
import { exec } from '../lib/ff';
import { loadPrompt, runTask } from '../lib/llm';
import { route, toLlmTask } from '../lib/routing';
import { DIRS, type MediaVideo, register, splitShots, tagShots, YTDLP } from './media';

/** Risultati per ricerca: abbastanza per trovare l'upload originale tra le reaction. */
const RESULTS = 8;
/** Oltre questa durata è quasi sempre un commento o una diretta, non il leak. */
const MAX_SECONDS = 20 * 60;
/** Qualità: la più alta che c'è, prima la risoluzione poi il bitrate (i leak sono spesso bassi). */
const FORMAT = ['-f', 'bv*', '-S', 'res,vbr'];

export interface LeakScene {
  show: string;
  /** la storia o il contesto, per ricerche più precise */
  context: string;
}

interface Result {
  id: string;
  title: string;
  channel: string;
  duration: number;
  views: number | null;
  date: string;
}

/** Per ogni scena gli id dei video leak in libreria (già presenti o appena scaricati), nell'ordine scelto. */
export async function findLeaks(dir: string, scenes: LeakScene[]): Promise<{ videos: string[]; note: string }[]> {
  if (!scenes.length) return [];
  const rt = await route('media');
  const task = toLlmTask(rt, { think: false, temperature: 0.2, timeout_s: 600 });

  const q = await loadPrompt('media-leak-query');
  const queries = await runTask<{ scenes: { scene: number; queries: string[] }[] }>(
    join(dir, 'query'),
    task,
    q.system,
    scenes.map((s, i) => `${i + 1}. show: ${s.show}\n   story: ${s.context}`).join('\n'),
    q.schema,
  );

  const found: Result[][] = [];
  for (const [i] of scenes.entries()) {
    const seen = new Map<string, Result>();
    for (const query of queries.scenes.find((x) => x.scene === i + 1)?.queries ?? []) {
      for (const r of await search(query)) if (!seen.has(r.id)) seen.set(r.id, r);
    }
    found.push([...seen.values()].filter((r) => r.duration > 0 && r.duration <= MAX_SECONDS));
    console.log(`  scena ${i + 1}: ${found[i]!.length} risultati da ${queries.scenes.find((x) => x.scene === i + 1)?.queries.map((x) => `"${x}"`).join(', ')}`);
  }

  const p = await loadPrompt('media-leak-pick');
  const picks = await runTask<{ scenes: { scene: number; ids: string[]; note: string }[] }>(
    join(dir, 'pick'),
    task,
    p.system,
    scenes
      .map((s, i) =>
        [
          `## Scene ${i + 1}: ${s.show}`,
          ...found[i]!.map((r) => `${r.id} | ${r.title} | ${r.channel} | ${Math.round(r.duration)} s | ${r.views ?? '?'} views | ${r.date}`),
          found[i]!.length ? '' : '(no results)',
        ].join('\n'),
      )
      .join('\n\n'),
    p.schema,
  );

  const out: { videos: string[]; note: string }[] = [];
  for (const [i, s] of scenes.entries()) {
    const pick = picks.scenes.find((x) => x.scene === i + 1);
    const videos: string[] = [];
    for (const id of pick?.ids ?? []) {
      const r = found[i]!.find((x) => x.id === id);
      if (r && (await ensureLeak(r, s.show))) videos.push(id);
    }
    out.push({ videos, note: pick?.note ?? '' });
  }
  return out;
}

async function search(query: string): Promise<Result[]> {
  try {
    const out = await exec([YTDLP, '--flat-playlist', '--print', '%(id)s\t%(title)s\t%(channel)s\t%(duration)s\t%(view_count)s\t%(upload_date)s', `ytsearch${RESULTS}:${query}`]);
    return out
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [id, title, channel, duration, views, date] = l.split('\t');
        return { id: id!, title: title ?? '', channel: channel ?? '', duration: Number(duration) || 0, views: Number(views) || null, date: date && date !== 'NA' ? date : '' };
      });
  } catch {
    return [];
  }
}

/** Scarica e cataloga un leak se non è già in libreria. false se non si riesce a scaricarlo. */
async function ensureLeak(r: Result, query: string): Promise<boolean> {
  const row = db.query(`SELECT * FROM media_videos WHERE id = ?`).get(r.id) as MediaVideo | null;
  if (row?.status === 'etichettato') return true;
  if (row?.status === 'saltato') return false;
  mkdirSync(DIRS.leak, { recursive: true });
  const url = `https://www.youtube.com/watch?v=${r.id}`;
  if (!row) {
    console.log(`  scarico il leak "${r.title}"`);
    try {
      await exec([YTDLP, ...FORMAT, '--no-playlist', '-o', join(DIRS.leak, `${r.id}.%(ext)s`), url]);
    } catch (e) {
      const note = (e as Error).message.split('\n').at(-1)!.slice(0, 200);
      console.log(`    non scaricato: ${note}`);
      db.run(`INSERT OR REPLACE INTO media_videos (id, title, url, status, note, added_at, source, query) VALUES (?, ?, ?, 'saltato', ?, datetime('now'), 'leak', ?)`, [r.id, r.title, url, note, query]);
      return false;
    }
    const file = readdirSync(DIRS.leak).find((f) => f.startsWith(`${r.id}.`))!;
    await register(r.id, r.title, url, join(DIRS.leak, file), 'leak', query);
  }
  const v = db.query(`SELECT * FROM media_videos WHERE id = ?`).get(r.id) as MediaVideo;
  console.log(`    ${v.width}×${v.height}, ${Math.round(v.duration ?? 0)} s`);
  if (v.status === 'scaricato') await splitShots(v);
  await tagShots(db.query(`SELECT * FROM media_videos WHERE id = ?`).get(r.id) as MediaVideo);
  return true;
}
