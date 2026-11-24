import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join, relative, resolve } from 'node:path';
import { gameplayIdOf } from '../gameplay/edit';
import { PATHS, ROOT } from '../lib/env';
import { publishDir, shortsDir } from '../lib/project';
import { readRouting } from '../lib/routing';
import type { ReviewShort } from '../report/review';
import { videoId } from '../lib/video-id';
import { DATA, db, now } from './db';
import { listJobs, runningJob } from './jobs';

export const MOVIES = join(homedir(), 'Movies');
const FOLDERS = join(DATA, 'folders.json');

/** Seconda cartella delle registrazioni (per esempio su un disco esterno), scelta dalla dashboard. */
export function secondFolder(): string | null {
  if (!existsSync(FOLDERS)) return null;
  return (safeJson(readFileSync(FOLDERS, 'utf8')) as { second?: string | null } | null)?.second ?? null;
}

export function setSecondFolder(path: string | null): void {
  writeFileSync(FOLDERS, `${JSON.stringify({ second: path }, null, 2)}\n`);
}

/** Cartelle in cui si cercano le registrazioni: ~/Movies (dove salva OBS) e la seconda, se c'è ed è collegata. */
export function recordingFolders(): { path: string; label: string; online: boolean }[] {
  const second = secondFolder();
  return [{ path: MOVIES, label: '~/Movies', online: true }, ...(second ? [{ path: second, label: relativeHome(join(second, 'x')), online: existsSync(second) }] : [])];
}
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.m4v']);
export const STAGES = ['01-ingest', '02-transcribe', '03-signals', '04-candidates', '05-vision', '06-rank', '07-copy', '08-render', '09-audio', '10-output'];

// ───────── stato ─────────

let claudeCache: { at: number; value: unknown } | undefined;
let diskCache: { at: number; value: Record<string, number> } | undefined;

export async function status() {
  const lm = await fetchJson('http://localhost:1234/v1/models');
  const ps = lm ? safeJson(Bun.spawnSync(['lms', 'ps', '--json']).stdout.toString()) : [];
  const clef = await fetchJson('http://127.0.0.1:8766/health');
  if (!claudeCache || Date.now() - claudeCache.at > 10 * 60_000) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ANTHROPIC_'))) as Record<string, string>;
    claudeCache = { at: Date.now(), value: safeJson(Bun.spawnSync(['claude', 'auth', 'status'], { env }).stdout.toString()) };
  }
  if (!diskCache || Date.now() - diskCache.at > 60_000) {
    const sizes: Record<string, number> = {};
    for (const d of ['work', 'out', 'models', '.tools', 'python/.venv', 'remotion/node_modules', 'studio/node_modules', 'data']) {
      const p = join(ROOT, d);
      sizes[d] = existsSync(p) ? Number.parseInt(Bun.spawnSync(['du', '-sk', p]).stdout.toString(), 10) * 1024 : 0;
    }
    diskCache = { at: Date.now(), value: sizes };
  }
  const c = claudeCache.value as { loggedIn?: boolean; authMethod?: string } | null;
  return {
    lmstudio: { up: !!lm, models: (Array.isArray(ps) ? ps : []).map((m: { identifier: string; contextLength?: number; vision?: boolean }) => ({ id: m.identifier, context: m.contextLength, vision: m.vision })) },
    clef: { up: !!clef },
    claude: { ok: !!c?.loggedIn && c.authMethod === 'claude.ai', method: c?.authMethod ?? null },
    disk: diskCache.value,
    free: freeDisk(),
    jobs: listJobs(15),
    running: runningJob() ?? null,
    routing: (await readRouting()).tasks,
  };
}

function freeDisk(): number {
  const out = Bun.spawnSync(['df', '-k', ROOT]).stdout.toString().split('\n')[1]?.split(/\s+/);
  return out ? Number(out[3]) * 1024 : 0;
}

// ───────── video e corse ─────────

const idCache = new Map<string, string>();
const probeCache = new Map<string, { duration: number; width?: number; height?: number; codec?: string; audio: number }>();

function cachedId(path: string, size: number, mtime: number): string {
  const k = `${path}:${size}:${mtime}`;
  if (!idCache.has(k)) idCache.set(k, videoId(path));
  return idCache.get(k)!;
}

function probe(path: string, size: number, mtime: number) {
  const k = `${path}:${size}:${mtime}`;
  if (!probeCache.has(k)) {
    const d = safeJson(Bun.spawnSync(['ffprobe', '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height', '-of', 'json', path]).stdout.toString()) as {
      format?: { duration?: string };
      streams?: { codec_type: string; codec_name: string; width?: number; height?: number }[];
    } | null;
    const v = d?.streams?.find((s) => s.codec_type === 'video');
    probeCache.set(k, { duration: Number(d?.format?.duration ?? 0), width: v?.width, height: v?.height, codec: v?.codec_name, audio: d?.streams?.filter((s) => s.codec_type === 'audio').length ?? 0 });
  }
  return probeCache.get(k)!;
}

/** Tutti i video noti: le cartelle delle registrazioni (due livelli), quelli aggiunti a mano e le sorgenti delle corse già fatte. */
export function knownVideoPaths(): string[] {
  const paths = new Set<string>();
  const walk = (dir: string, depth: number) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory() && depth > 0) walk(p, depth - 1);
      else if (e.isFile() && VIDEO_EXT.has(extname(e.name).toLowerCase())) paths.add(p);
    }
  };
  for (const f of recordingFolders()) if (f.online) walk(f.path, 2);
  for (const r of db.query('SELECT path FROM extra_videos').all() as { path: string }[]) if (existsSync(r.path)) paths.add(r.path);
  for (const run of runs()) if (run.source && existsSync(run.source)) paths.add(run.source);
  return [...paths];
}

export function videos() {
  const jobs = listJobs(50).filter((j) => j.status === 'in corso' || j.status === 'in coda');
  return knownVideoPaths()
    .map((path) => {
      const st = statSync(path);
      // il video finale di un gameplay ha la cartella della sua registrazione
      const id = gameplayIdOf(path) ?? cachedId(path, st.size, st.mtimeMs);
      const pr = probe(path, st.size, st.mtimeMs);
      const run = runStatus(id);
      return {
        path,
        name: basename(path),
        folder: path.startsWith(`${MOVIES}/`) ? '~/Movies' : relativeHome(path),
        size: st.size,
        mtime: st.mtime.toISOString(),
        id,
        ...pr,
        vertical: (pr.height ?? 0) > (pr.width ?? 0),
        stages: run.stages,
        shorts: run.shorts,
        job: jobs.find((j) => j.argv.includes(path))?.status ?? null,
      };
    })
    // Solo registrazioni vere: con una traccia video e lunghe almeno 30 s (in ~/Movies finiscono anche audio e clip).
    .filter((v) => v.width && v.duration >= 30)
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

function relativeHome(p: string): string {
  const h = homedir();
  return p.startsWith(h) ? `~/${relative(h, resolve(p, '..'))}` : resolve(p, '..');
}

/** Corse già iniziate in work/: id e video sorgente. */
export function runs(): { id: string; source?: string }[] {
  if (!existsSync(PATHS.work)) return [];
  return readdirSync(PATHS.work)
    .filter((d) => !d.startsWith('_') && existsSync(join(PATHS.work, d, '01-ingest', 'done.json')))
    .map((id) => {
      const r = safeJson(readFileSync(join(PATHS.work, id, '01-ingest', 'done.json'), 'utf8')) as { result?: { main?: { path?: string } } } | null;
      return { id, source: r?.result?.main?.path };
    });
}

export function runStatus(id: string) {
  const w = join(PATHS.work, id);
  const stages = STAGES.map((name) => {
    if (name === '03-signals') {
      const subs = ['markers', 'lucio', 'voice', 'game', 'scenes', 'meaning'].map((s) => readDone(join(w, name, s)));
      const done = subs.every(Boolean);
      return { name, done, duration_s: done ? subs.reduce((a, s) => a + (s?.duration_s ?? 0), 0) : null, partial: subs.filter(Boolean).length };
    }
    const d = readDone(join(w, name));
    return { name, done: !!d, duration_s: d?.duration_s ?? null };
  });
  const outDir = shortsDir(id);
  const shorts = existsSync(outDir) ? readdirSync(outDir).filter((f) => /^s\d+\.mp4$/.test(f)).length : 0;
  return { stages, shorts };
}

function readDone(dir: string): { duration_s: number; finished_at: string } | null {
  const p = join(dir, 'done.json');
  return existsSync(p) ? (safeJson(readFileSync(p, 'utf8')) as { duration_s: number; finished_at: string }) : null;
}

// ───────── short ─────────

export function shorts(id: string) {
  const dir = shortsDir(id);
  if (!existsSync(dir)) return [];
  const reviews = currentReviews(id);
  return readdirSync(dir)
    .filter((f) => /^s\d+\.json$/.test(f))
    .sort()
    .map((f) => {
      const s = safeJson(readFileSync(join(dir, f), 'utf8')) as ReviewShort;
      const r = reviews.get(s.id);
      return {
        ...s,
        video_url: `/media/out/${id}/short/${s.id}.mp4?v=${statSync(join(dir, `${s.id}.mp4`)).mtimeMs}`,
        thumb_url: `/media/out/${id}/short/${s.id}.jpg?v=${statSync(join(dir, `${s.id}.jpg`)).mtimeMs}`,
        file: join(dir, `${s.id}.mp4`),
        published: publishedFiles(id, s.id).find((f) => f.endsWith('.mp4')) ?? null,
        review: { status: r?.status ?? 'da rivedere', copy: r?.copy ? (JSON.parse(r.copy) as ReviewShort['copy']) : null, hook: r?.hook ?? null, note: r?.note ?? null },
      };
    });
}

interface Review {
  run_id: string;
  short_id: string;
  status: string;
  copy: string | null;
  hook: string | null;
  note: string | null;
  updated_at: string;
}

/**
 * Le revisioni degli short di adesso: quelle salvate prima dell'ultimo giro dei testi (07-copy) erano per
 * short che non ci sono più, anche se avevano lo stesso nome (s01, s02…).
 */
function currentReviews(id: string): Map<string, Review> {
  const done = safeJson(existsSync(join(PATHS.work, id, '07-copy', 'done.json')) ? readFileSync(join(PATHS.work, id, '07-copy', 'done.json'), 'utf8') : 'null') as { finished_at?: string } | null;
  const since = done?.finished_at ?? '';
  const rows = db.query('SELECT * FROM short_reviews WHERE run_id = ? AND updated_at >= ?').all(id, since) as Review[];
  return new Map(rows.map((r) => [r.short_id, r]));
}

/** Quanti short ha un video e come sono stati rivisti. */
export function shortStats(id: string) {
  const dir = shortsDir(id);
  const ids = existsSync(dir) ? readdirSync(dir).filter((f) => /^s\d+\.mp4$/.test(f)).map((f) => f.slice(0, -4)) : [];
  const reviews = currentReviews(id);
  const count = (st: string) => ids.filter((s) => reviews.get(s)?.status === st).length;
  return { total: ids.length, approvato: count('approvato'), scartato: count('scartato') };
}

/**
 * Salva la revisione. Ganci nuovi e short scartati vanno in work/<id>/overrides.json, che il render legge al
 * prossimo giro; gli approvati si copiano con i testi in da-pubblicare/. Un gancio nuovo cambia il video,
 * quindi lo short torna da rivedere.
 */
export async function saveReview(id: string, sid: string, patch: { status?: string; copy?: unknown; hook?: string | null; note?: string }) {
  const cur = currentReviews(id).get(sid) ?? { status: 'da rivedere', copy: null, hook: null, note: null };
  const hookChanged = patch.hook !== undefined && patch.hook !== cur.hook;
  const next = {
    status: patch.status ?? (hookChanged && cur.status === 'approvato' ? 'da rivedere' : cur.status),
    copy: patch.copy !== undefined ? JSON.stringify(patch.copy) : cur.copy,
    hook: patch.hook !== undefined ? patch.hook : cur.hook,
    note: patch.note ?? cur.note,
  };
  db.run(
    `INSERT INTO short_reviews (run_id, short_id, status, copy, hook, note, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (run_id, short_id) DO UPDATE SET status = excluded.status, copy = excluded.copy, hook = excluded.hook, note = excluded.note, updated_at = excluded.updated_at`,
    [id, sid, next.status, next.copy, next.hook, next.note, now()],
  );
  if (hookChanged || next.status !== cur.status) {
    const p = join(PATHS.work, id, 'overrides.json');
    const o = existsSync(p) ? (safeJson(readFileSync(p, 'utf8')) as Record<string, { hook?: string; skip?: boolean }>) : {};
    const entry = { ...(next.hook ? { hook: next.hook } : {}), ...(next.status === 'scartato' ? { skip: true } : {}) };
    if (Object.keys(entry).length) o[sid] = entry;
    else delete o[sid];
    await Bun.write(p, `${JSON.stringify(o, null, 2)}\n`);
  }
  for (const f of publishedFiles(id, sid)) unlinkSync(f);
  if (next.status === 'approvato') publish(id, sid, next.copy ? (JSON.parse(next.copy) as ReviewShort['copy']) : null);
  else if (existsSync(publishDir(id)) && !readdirSync(publishDir(id)).length) rmdirSync(publishDir(id));
  return next;
}

// ───────── da pubblicare ─────────

function publishedFiles(id: string, sid: string) {
  const dir = publishDir(id);
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(`${sid} - `)).map((f) => join(dir, f)) : [];
}

/**
 * Copia lo short e i testi in da-pubblicare/. Il file prende il titolo di YouTube, che lo usa come titolo
 * iniziale quando lo carichi; su APFS la copia non occupa altro spazio.
 */
function publish(id: string, sid: string, edited: ReviewShort['copy'] | null) {
  const s = safeJson(readFileSync(join(shortsDir(id), `${sid}.json`), 'utf8')) as ReviewShort;
  const copy = edited ?? s.copy;
  const dir = publishDir(id);
  mkdirSync(dir, { recursive: true });
  const title = copy.youtube.title.replace(/[/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || sid;
  copyFileSync(join(shortsDir(id), `${sid}.mp4`), join(dir, `${sid} - ${title}.mp4`));
  const names = { youtube: 'YouTube Shorts', instagram: 'Instagram Reels', tiktok: 'TikTok' } as const;
  const text = (Object.keys(names) as (keyof typeof names)[])
    .map((k) => `${names[k]}\n\nTitolo: ${copy[k].title}\n\n${copy[k].description}\n\n${copy[k].hashtags.join(' ')}`)
    .join('\n\n────────\n\n');
  writeFileSync(join(dir, `${sid} - testi.txt`), `${text}\n`);
}

// ───────── file ─────────

export function files() {
  const out: { path: string; kind: string; size: number; mtime: string }[] = [];
  const add = (dir: string, kind: string, re: RegExp, depth = 2) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory() && depth > 0) add(p, kind, re, depth - 1);
      else if (e.isFile() && re.test(e.name)) {
        const st = statSync(p);
        out.push({ path: relative(ROOT, p), kind, size: st.size, mtime: st.mtime.toISOString() });
      }
    }
  };
  add(PATHS.out, 'video', /\.(mp4|json|jpg|md|html|txt)$/);
  add(join(DATA, 'scripts'), 'script', /\.(md|json)$/);
  add(join(ROOT, 'style'), 'guida', /\.md$/, 0);
  add(join(ROOT, 'config'), 'config', /\.json$/, 0);
  add(join(ROOT, 'prompts'), 'prompt', /\.(md|json)$/, 1);
  return out.sort((a, b) => b.mtime.localeCompare(a.mtime)).slice(0, 120);
}

// ───────── utilità ─────────

/** Un percorso è servibile solo se sta dentro una di queste cartelle. */
export function inside(path: string, ...roots: string[]): boolean {
  const p = resolve(path);
  return roots.some((r) => {
    const rel = relative(resolve(r), p);
    return rel !== '' && !rel.startsWith('..') && !rel.startsWith('/');
  });
}

async function fetchJson(url: string): Promise<unknown> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

export function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
