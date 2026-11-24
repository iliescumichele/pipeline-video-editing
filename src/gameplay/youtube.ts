// Titolo YouTube e prompt della miniatura (da incollare su Higgsfield) per il gameplay lungo.
// Il modello vede la descrizione scritta da Lucio, fotogrammi del video finale, l'avatar ritagliato, le
// miniature di riferimento (data/thumbnails/riferimenti) e i fogli numerati degli screenshot ufficiali
// di Rockstar (data/thumbnails/rockstar). Il risultato sta in work/<id>/gameplay/youtube.json.
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA } from '../dashboard/db';
import { ROOT } from '../lib/env';
import { FFMPEG } from '../lib/ff';
import { loadPrompt, runTask } from '../lib/llm';
import { py } from '../lib/py';
import { route, routeLabel, toLlmTask } from '../lib/routing';
import { archivePath, finalDuration, type GameplayEdit, gameplayDir, keepDir, LOOK, removedRanges, youtubePath } from './edit';

export const THUMBS = join(DATA, 'thumbnails');
export const REFERENCES = join(THUMBS, 'riferimenti');
export const ROCKSTAR = join(THUMBS, 'rockstar');

export interface Youtube {
  titles: { title: string; why: string }[];
  thumbnail: { upload: { file: string; role: string }[]; prompt: string; text: string; notes: string };
  generated_at: string;
  route: string;
}

const IMAGE = /\.(jpe?g|png|webp)$/i;

/** Immagini di una cartella, in ordine di nome. */
export function images(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => IMAGE.test(f) && !f.startsWith('.'))
    .sort()
    .map((f) => join(dir, f));
}

/** Da un istante del video finale all'istante della registrazione, saltando i tagli. */
function sourceTime(removed: [number, number][], t: number): number {
  let s = t;
  for (const [a, b] of removed) if (a <= s) s += b - a;
  return s;
}

/**
 * Sei fotogrammi distribuiti sul video finale, larghi 1280: dalla registrazione (saltando i tagli) o, se non
 * c'è più, dalla copia a 720p, che è già il video finale.
 */
function frames(id: string, e: GameplayEdit, dir: string): string[] {
  const removed = removedRanges(e);
  const dur = finalDuration(e);
  const fromRecording = existsSync(e.video);
  if (!fromRecording && !existsSync(archivePath(id))) return [];
  return [1, 2, 3, 4, 5, 6].map((k) => {
    const out = join(dir, `fotogramma-${k}.jpg`);
    if (!existsSync(out)) {
      const t = fromRecording ? sourceTime(removed, (dur * k) / 7) : (dur * k) / 7;
      Bun.spawnSync([FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', '-ss', t.toFixed(2), '-i', fromRecording ? e.video : archivePath(id), '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '3', out]);
    }
    return out;
  }).filter((p) => existsSync(p));
}

/** Lucio ritagliato dal verde, con la trasparenza (PNG), da caricare come personaggio. Resta in data/. */
function lucio(id: string, e: GameplayEdit): string | null {
  const out = join(keepDir(id), 'lucio.png');
  if (!existsSync(out) && e.lucianus && existsSync(e.lucianus)) {
    const t = Math.max(0, e.duration * 0.4 - (e.offsetMs ?? 0) / 1000);
    Bun.spawnSync([FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', '-ss', t.toFixed(2), '-i', e.lucianus, '-frames:v', '1', '-vf', `crop=${LOOK.crop},format=rgba,${LOOK.key}`, out]);
  }
  return existsSync(out) ? out : null;
}

/** Fogli numerati degli screenshot di Rockstar; si rifanno quando cambia la cartella. */
async function rockstarSheets(shots: string[]): Promise<string[]> {
  if (!shots.length) return [];
  const prefix = join(THUMBS, `.fogli-rockstar-${shots.length}-${Math.round(statSync(ROCKSTAR).mtimeMs)}`);
  const existing = readdirSync(THUMBS).filter((f) => f.startsWith(`${prefix.split('/').pop()}-`)).map((f) => join(THUMBS, f));
  if (existing.length) return existing.sort();
  for (const f of readdirSync(THUMBS)) if (f.startsWith('.fogli-rockstar-')) Bun.spawnSync(['rm', '-f', join(THUMBS, f)]);
  const out = await py('contactsheet.py', [prefix, ...shots], { capture: true });
  return out.trim().split('\n').filter(Boolean);
}

export async function generateYoutube(id: string, e: GameplayEdit): Promise<Youtube> {
  if (!e.description?.trim()) throw new Error('scrivi prima di cosa parla il gameplay');
  const dir = join(gameplayDir(id), 'miniatura');
  mkdirSync(dir, { recursive: true });
  mkdirSync(REFERENCES, { recursive: true });

  const shots = images(ROCKSTAR);
  const refs = images(REFERENCES).slice(-10);
  const sheets = await rockstarSheets(shots);
  const pics = frames(id, e, dir);
  const avatar = lucio(id, e);

  const guide = await Bun.file(join(ROOT, 'style', 'CHANNEL.md')).text();
  const { system, schema } = await loadPrompt('youtube-long');
  const hms = (s: number) => `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
  const input = [
    '# The session, in the creator\'s words',
    '',
    e.description.trim(),
    '',
    `Final video length: ${hms(finalDuration(e))} (h:mm).`,
    '',
    '# Images',
    '',
    `- Frames from the final video, in order: ${pics.join(', ') || 'none'}`,
    `- Lucio, the avatar (transparent PNG): ${avatar ?? 'not available'}`,
    `- Thumbnails the creator likes (style references): ${refs.join(', ') || 'none yet'}`,
    `- Contact sheets of the official Rockstar screenshots: ${sheets.join(', ') || 'none'}`,
    '',
    '# Official Rockstar screenshots (number on the sheet → file)',
    '',
    ...shots.map((p, i) => `${i + 1}. ${p}`),
  ].join('\n');

  const r = await route('youtube');
  // uno screenshot tra le immagini apre a Read tutta la cartella: il modello può guardarne alcuni a piena risoluzione
  const task = toLlmTask(r, { images: [...pics, ...(avatar ? [avatar] : []), ...refs, ...sheets, ...shots.slice(0, 1)], timeout_s: 600 });
  const out = await runTask<Omit<Youtube, 'generated_at' | 'route'>>(join(dir, 'task'), task, `${system}\n\n---\n\n# Channel voice guide\n\n${guide}`, input, schema, true);
  const result: Youtube = { ...out, generated_at: new Date().toISOString(), route: routeLabel(r) };
  writeFileSync(youtubePath(id), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
