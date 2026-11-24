// Materiali per ogni scena di uno script lungo: inquadrature ufficiali, immagini degli articoli,
// foto da Wikipedia. Le scene "card" le disegna Remotion, le "lucio" vengono dalla registrazione.
//   bun run news assets <script>   scrive data/assets/script-<id>/manifest.json e scarica le immagini
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { db, DATA, now } from '../dashboard/db';
import { loadPrompt, runTask } from '../lib/llm';
import { route, toLlmTask } from '../lib/routing';
import { LLM_DIR, UA } from './common';
import { findLeaks } from './leaks';
import { type Beat, type LongScript, WORDS_PER_MIN } from './long';
import type { ShotTags } from './media';

/** Un cambio di inquadratura ogni 3,5 s circa, come nel video d'esempio (2,5 s) ma meno frenetico. */
const SECONDS_PER_SHOT = 3.5;

export type Asset =
  | { type: 'shot'; shot_id: number; video_id: string; video_title: string; s: number; e: number; frame: string; proxy: string }
  | { type: 'image'; file: string; url: string; page: string; from: 'article' | 'wikipedia' };

export interface ManifestBeat {
  chapter: number;
  index: number;
  at: string;
  kind: Beat['kind'];
  show: string;
  card_text: string;
  source: string;
  /** durata stimata dalla voce, prima della registrazione */
  seconds: number;
  assets: Asset[];
  note: string;
}

export interface Manifest {
  script_id: number;
  story_id: number;
  created_at: string;
  beats: ManifestBeat[];
}

interface ShotRow {
  id: number;
  video_id: string;
  title: string;
  source: 'official' | 'leak';
  s: number;
  e: number;
  frame: string;
  proxy: string;
  tags: string;
}

export const manifestPath = (scriptId: number) => join(DATA, 'assets', `script-${scriptId}`, 'manifest.json');

export async function buildAssets(scriptId: number): Promise<Manifest> {
  const row = db.query(`SELECT story_id, content, edited, kind FROM scripts WHERE id = ?`).get(scriptId) as { story_id: number; content: string; edited: string | null; kind: string } | null;
  if (!row || row.kind !== 'long') throw new Error(`script lungo ${scriptId} non trovato`);
  const script = JSON.parse(row.edited ?? row.content) as LongScript;
  const dir = join(DATA, 'assets', `script-${scriptId}`);
  mkdirSync(dir, { recursive: true });

  const beats: ManifestBeat[] = script.chapters.flatMap((ch, ci) =>
    ch.beats.map((b, bi) => ({ chapter: ci + 1, index: bi + 1, at: b.at, kind: b.kind, show: b.show, card_text: b.card_text, source: b.source, seconds: beatSeconds(ch.voice, ch.beats, bi), assets: [], note: '' })),
  );

  // Immagini e foto: dalla pagina indicata dalla scena; se non c'è nulla, si ripiega sulle inquadrature.
  for (const b of beats.filter((x) => x.kind === 'image' || x.kind === 'photo')) {
    const img = b.source ? await pageImage(b.source) : null;
    if (img) {
      const file = await downloadImage(img.url, join(dir, `img-${b.chapter}-${b.index}`));
      if (file) b.assets.push({ type: 'image', file, url: img.url, page: b.source, from: img.from });
    }
    if (!b.assets.length) b.note = b.source ? 'nessuna immagine nella pagina indicata: inquadrature al posto dell\'immagine' : 'nessuna fonte per l\'immagine: inquadrature al posto dell\'immagine';
  }
  for (const b of beats.filter((x) => x.kind === 'gameplay')) b.note = 'gameplay del canale non ancora disponibile: inquadrature ufficiali al posto del gameplay';

  // Inquadrature ufficiali: per i trailer e per tutto quello che non ha trovato altro.
  const needShots = beats.filter((b) => b.kind === 'trailer' || b.kind === 'gameplay' || ((b.kind === 'image' || b.kind === 'photo') && !b.assets.length));
  const shots = db
    .query(`SELECT m.id, m.video_id, v.title, v.source, m.s, m.e, m.frame, v.proxy, m.tags FROM media_shots m JOIN media_videos v ON v.id = m.video_id WHERE m.tags IS NOT NULL ORDER BY v.id, m.idx`)
    .all() as ShotRow[];
  // Le scene ufficiali non pescano mai dai leak.
  const usable = shots.filter((x) => x.source === 'official' && (JSON.parse(x.tags) as ShotTags).usable);
  if (needShots.length && usable.length) {
    const picks = await pickShots(join(LLM_DIR, 'assets', `script-${scriptId}`), needShots, usable);
    const byId = new Map(usable.map((x) => [x.id, x]));
    for (const [i, b] of needShots.entries()) {
      const p = picks.find((x) => x.scene === i + 1);
      for (const id of p?.shots ?? []) {
        const x = byId.get(id);
        if (x) b.assets.push({ type: 'shot', shot_id: x.id, video_id: x.video_id, video_title: x.title, s: x.s, e: x.e, frame: x.frame, proxy: x.proxy });
      }
      if (p?.note) b.note = b.note ? `${b.note}; ${p.note}` : p.note;
    }
  } else if (needShots.length) {
    for (const b of needShots) b.note = 'libreria vuota: lancia bun run news media sync';
  }

  // Leak: si cercano su YouTube e ogni scena sceglie solo tra le inquadrature dei leak trovati per lei.
  // Al loro posto non si mette mai un trailer: dire "leak" su immagini ufficiali sarebbe falso.
  const leakBeats = beats.filter((b) => b.kind === 'leak');
  if (leakBeats.length) {
    const story = (db.query(`SELECT title FROM stories WHERE id = ?`).get(row.story_id) as { title: string } | null)?.title ?? '';
    const found = await findLeaks(join(LLM_DIR, 'assets', `script-${scriptId}`, 'leaks'), leakBeats.map((b) => ({ show: b.show, context: story })));
    for (const [i, b] of leakBeats.entries()) {
      const videos = new Set(found[i]?.videos ?? []);
      const pool = db
        .query(`SELECT m.id, m.video_id, v.title, v.source, m.s, m.e, m.frame, v.proxy, m.tags FROM media_shots m JOIN media_videos v ON v.id = m.video_id WHERE m.tags IS NOT NULL AND v.source = 'leak' ORDER BY v.id, m.idx`)
        .all()
        .filter((x) => videos.has((x as ShotRow).video_id) && (JSON.parse((x as ShotRow).tags) as ShotTags).usable) as ShotRow[];
      if (!pool.length) {
        b.note = `leak non trovato su YouTube${found[i]?.note ? `: ${found[i]!.note}` : ''}`;
        continue;
      }
      const [pick] = await pickShots(join(LLM_DIR, 'assets', `script-${scriptId}`, `leak-${b.chapter}-${b.index}`), [b], pool);
      const byId = new Map(pool.map((x) => [x.id, x]));
      for (const id of pick?.shots ?? []) {
        const x = byId.get(id);
        if (x) b.assets.push({ type: 'shot', shot_id: x.id, video_id: x.video_id, video_title: x.title, s: x.s, e: x.e, frame: x.frame, proxy: x.proxy });
      }
      b.note = ['leak: materiale non ufficiale, dirlo nel parlato', found[i]?.note, pick?.note].filter(Boolean).join('; ');
    }
  }

  const manifest: Manifest = { script_id: scriptId, story_id: row.story_id, created_at: now(), beats };
  await Bun.write(manifestPath(scriptId), JSON.stringify(manifest, null, 2));
  const missing = beats.filter((b) => !b.assets.length && b.kind !== 'card' && b.kind !== 'lucio').length;
  const leaks = beats.filter((b) => b.kind === 'leak').length;
  console.log(`  ${beats.length} scene: ${beats.filter((b) => b.assets.some((a) => a.type === 'shot')).length} con inquadrature, ${beats.filter((b) => b.assets.some((a) => a.type === 'image')).length} con immagini, ${beats.filter((b) => b.kind === 'card').length} cartelli, ${beats.filter((b) => b.kind === 'lucio').length} Lucio, ${missing} senza materiale${leaks ? ` (di cui ${leaks} leak da trovare)` : ''}`);
  return manifest;
}

/** Dalla parola d'inizio di questa scena a quella della successiva (o alla fine del capitolo). */
function beatSeconds(voice: string, beats: Beat[], i: number): number {
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const text = norm(voice);
  const start = Math.max(0, text.indexOf(norm(beats[i]!.at)));
  const next = beats[i + 1] ? text.indexOf(norm(beats[i + 1]!.at), start + 1) : -1;
  const words = text.slice(start, next > start ? next : undefined).split(' ').filter(Boolean).length;
  return Math.round((words / WORDS_PER_MIN) * 60 * 10) / 10;
}

async function pickShots(dir: string, scenes: ManifestBeat[], shots: ShotRow[]): Promise<{ scene: number; shots: number[]; note: string }[]> {
  const rt = await route('media');
  const { system, schema } = await loadPrompt('media-pick');
  const catalogue = shots.map((x) => {
    const t = JSON.parse(x.tags) as ShotTags;
    return `${x.id} | ${x.title.replace('Grand Theft Auto VI', 'GTA VI')} | ${(x.e - x.s).toFixed(1)} s | ${t.who.join('+')} | ${t.framing} | ${t.time} | ${t.place} | ${t.action}${t.text_on_screen ? ' | TEXT ON SCREEN' : ''} | ${t.description}`;
  });
  const input = [
    '## Scenes',
    ...scenes.map((b, i) => `${i + 1}. needs ${Math.max(1, Math.round(b.seconds / SECONDS_PER_SHOT))} shots | show: ${b.show} | words start: "${b.at}"`),
    '',
    '## Catalogue (id | video | length | who | framing | time | place | action | description)',
    ...catalogue,
  ].join('\n');
  const out = await runTask<{ scenes: { scene: number; shots: number[]; note: string }[] }>(dir, toLlmTask(rt, { think: false, temperature: 0.2, timeout_s: 900 }), system, input, schema);
  return out.scenes;
}

/** Immagine principale di una pagina: per Wikipedia l'immagine della voce, altrimenti og:image. */
async function pageImage(page: string): Promise<{ url: string; from: 'article' | 'wikipedia' } | null> {
  try {
    const wiki = page.match(/^https:\/\/en\.wikipedia\.org\/wiki\/(.+)$/);
    if (wiki) {
      const u = `https://en.wikipedia.org/w/api.php?action=query&prop=pageimages&piprop=original&redirects=1&format=json&titles=${wiki[1]}`;
      const d = (await (await fetch(u, { headers: { 'User-Agent': 'lucio-pipeline/1.0 (local news research script)' }, signal: AbortSignal.timeout(20_000) })).json()) as {
        query?: { pages?: Record<string, { original?: { source: string } }> };
      };
      const src = Object.values(d.query?.pages ?? {})[0]?.original?.source;
      return src ? { url: src, from: 'wikipedia' } : null;
    }
    const res = await fetch(page, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)/i) ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']/i);
    return m ? { url: m[1]!.replaceAll('&amp;', '&'), from: 'article' } : null;
  } catch {
    return null;
  }
}

/** Solo immagini vere, al massimo 20 MB; l'estensione segue il tipo dichiarato dal server. */
async function downloadImage(url: string, base: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) });
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !type.startsWith('image/')) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 20e6) return null;
    const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : type.includes('avif') ? 'avif' : 'jpg';
    const file = `${base}.${ext}`;
    await Bun.write(file, buf);
    return file;
  } catch {
    return null;
  }
}
