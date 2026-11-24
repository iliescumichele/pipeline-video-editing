// Quello che la dashboard legge e cambia nella pipeline. Solo lato server: il suffisso .server
// impedisce che finisca nel browser (bun:sqlite, file system, processi).
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';
import { files, inside, knownVideoPaths, MOVIES, recordingFolders, runs, runStatus, saveReview, secondFolder, setSecondFolder, shorts, shortStats, status, videos } from '../../../src/dashboard/data';
import { DATA, db, now } from '../../../src/dashboard/db';
import { cancel, enqueue, jobLog, listJobs } from '../../../src/dashboard/jobs';
import {
  archivePath, isAnalyzed, newEdit, type AudioMix, type Cut, DEFAULT_LOOK, DEFAULT_MIX, type Duck, exportPath, fileTitle, finalDuration, type GameplayEdit, gameplayIds, languagePath, type Look, lookOf, lucianusFor, mixKey, mixOf, posterPath,
  previewPath, readEdit, gameplaySpace, tracksPath, writeEdit, youtubePath,
} from '../../../src/gameplay/edit';
import { estimate, freeBytes, MARGIN, shortsSpace, type SpaceEstimate } from '../../../src/lib/space';
import { generateYoutube, images, REFERENCES, ROCKSTAR, THUMBS, type Youtube } from '../../../src/gameplay/youtube';
import { PATHS } from '../../../src/lib/env';
import { VOICE_PRESETS } from '../../../src/lib/voice-eq';
import { DEFAULT_EXPORT, type ExportSettings, readExport, writeExport } from '../../../src/lib/export-settings';
import { projectDir, publishDir } from '../../../src/lib/project';
import { ROUTING_PATH, readRouting, type RoutingFile } from '../../../src/lib/routing';
import { type Asset, type Manifest, manifestPath } from '../../../src/news/assets';
import { type LongChecks, type LongScript, longScriptMarkdown } from '../../../src/news/long';
import type { MediaVideo, ShotTags } from '../../../src/news/media';
import type { PrompterBeat } from '../../../src/news/montage';
import { scriptMarkdown } from '../../../src/news/news';

import { benchPair } from '../../../src/dashboard/bench';

export { benchRuns, benchSummary, benchVote } from '../../../src/dashboard/bench';
export { cancel, files, jobLog, readRouting, runStatus, saveReview, shorts, status };

const bun = (...args: string[]) => ['bun', ...args];

// ───────── lavori ─────────

export type JobRequest =
  | { kind: 'shorts'; video: string; count?: number; vertical?: string; lucioLog?: string }
  | { kind: 'rerender'; run: string }
  | { kind: 'news' }
  | { kind: 'script'; story: number }
  | { kind: 'long'; story: number }
  | { kind: 'bench'; tasks?: string }
  | { kind: 'media' }
  | { kind: 'assets'; script: number }
  | { kind: 'montage'; script: number }
  | { kind: 'gameplay'; step: GameplayStep; video: string; from?: number; duration?: number }
  | { kind: 'gameplay-archive'; id: string };

export type GameplayStep = 'analizza' | 'lingua' | 'anteprima' | 'esporta' | 'archivio' | 'tracce';
const GAMEPLAY_TITLES: Record<GameplayStep, string> = {
  analizza: 'Gameplay: menu e sincronia',
  lingua: 'Gameplay: parti in rumeno',
  anteprima: 'Gameplay: audio dell’anteprima',
  esporta: 'Gameplay: video finale 4K',
  archivio: 'Gameplay: copia a 720p per rivedere',
  tracce: 'Gameplay: gioco e voce separati per gli short',
};

/**
 * Quanto spazio occupa un lavoro e quanto ce n'è: la dashboard lo mostra prima di metterlo in coda.
 * items null = non si può stimare prima (download, montaggi); [] = trascurabile.
 */
export function estimateJob(r: JobRequest) {
  let e: SpaceEstimate;
  switch (r.kind) {
    case 'gameplay': {
      const v = videos().find((x) => x.path === r.video);
      const stored = v ? readEdit(v.id) : null;
      const test = r.step === 'esporta' && r.from !== undefined ? { duration: r.duration ?? 30 } : undefined;
      e = gameplaySpace(r.step, v?.id ?? '', stored ? { ...stored, video: r.video } : null, test);
      break;
    }
    case 'gameplay-archive':
      e = gameplaySpace('archivio', r.id, readEdit(r.id));
      break;
    case 'shorts': {
      const v = videos().find((x) => x.path === r.video);
      e = v
        ? shortsSpace({ duration: v.duration, ingestDone: existsSync(join(PATHS.work, v.id, '01-ingest', 'done.json')), separate: v.audio >= 3 || existsSync(tracksPath(r.video)) })
        : estimate(null);
      break;
    }
    case 'rerender':
      e = estimate([{ label: 'short rifatti', bytes: 1e9 }]);
      break;
    case 'media':
      e = estimate(null, 'scarica i video ufficiali nuovi (da 1080p a 4K): il peso dipende da quanti sono');
      break;
    case 'assets':
      e = estimate(null, 'scarica immagini e video per lo script: il peso dipende da quanti sono');
      break;
    case 'montage':
      e = estimate(null, 'crea il video 4K del montaggio: il peso dipende dalla sua durata');
      break;
    default:
      e = estimate([]);
  }
  return { ...e, free: freeBytes(), margin: MARGIN };
}

/** Mette in coda un comando della pipeline. Accetta solo video noti e storie esistenti. */
export function startJob(r: JobRequest) {
  switch (r.kind) {
    case 'shorts': {
      if (!knownVideoPaths().includes(r.video)) throw new Error('video sconosciuto');
      const argv = bun('src/cli.ts', r.video, '--count', String(r.count ?? 8));
      if (r.vertical) argv.push('--vertical', r.vertical);
      if (r.lucioLog) argv.push('--lucio-log', r.lucioLog);
      return enqueue('shorts', `Short da ${r.video.split('/').pop()}`, argv);
    }
    case 'rerender': {
      const src = runs().find((x) => x.id === r.run)?.source;
      if (!src || !existsSync(src)) throw new Error('video sorgente non trovato');
      return enqueue('shorts', `Render di nuovo: ${src.split('/').pop()}`, bun('src/cli.ts', src));
    }
    case 'news':
      return enqueue('news', 'Notizie: raccolta, raggruppamento e smistamento', bun('src/news/news.ts', 'all'));
    case 'script':
      return enqueue('script', `Script della storia ${r.story}`, bun('src/news/news.ts', 'script', String(r.story)));
    case 'long':
      return enqueue('long', `Video lungo della storia ${r.story}`, bun('src/news/news.ts', 'long', String(r.story)));
    case 'bench':
      return enqueue('bench', 'Banco di prova dei modelli', bun('src/bench/bench.ts', ...(r.tasks ? ['--tasks', r.tasks] : [])));
    case 'media':
      return enqueue('media', 'Libreria dei video ufficiali', bun('src/news/news.ts', 'media', 'sync'));
    case 'assets':
      return enqueue('assets', `Materiali dello script ${r.script}`, bun('src/news/news.ts', 'assets', String(r.script)));
    case 'montage':
      return enqueue('montage', `Video del montaggio dello script ${r.script}`, bun('src/news/news.ts', 'montage', String(r.script)));
    case 'gameplay': {
      if (!knownVideoPaths().includes(r.video)) throw new Error('video sconosciuto');
      if (!(r.step in GAMEPLAY_TITLES)) throw new Error('passaggio sconosciuto');
      const argv = bun('src/gameplay/gameplay.ts', r.step, r.video);
      const test = r.step === 'esporta' && r.from !== undefined;
      if (test) argv.push('--da', String(Math.max(0, Math.floor(r.from ?? 0))), '--durata', String(Math.min(120, Math.max(5, Math.floor(r.duration ?? 30)))));
      return enqueue('gameplay', `${GAMEPLAY_TITLES[r.step]}${test ? ' (prova)' : ''} · ${r.video.split('/').pop()}`, argv);
    }
    case 'gameplay-archive': {
      if (!gameplayIds().includes(r.id)) throw new Error('gameplay sconosciuto');
      return enqueue('gameplay', `${GAMEPLAY_TITLES.archivio} · ${r.id}`, bun('src/gameplay/gameplay.ts', 'archivio', r.id));
    }
  }
}

// ───────── gameplay lungo ─────────

const fileInfo = (p: string) => {
  if (!existsSync(p)) return null;
  const st = statSync(p);
  return { path: p, url: `/media/file?path=${encodeURIComponent(p)}&v=${st.mtimeMs}`, size: st.size, mtime: st.mtime.toISOString() };
};

const gameplayJobs = (video: string, id: string) =>
  listJobs(80)
    .filter((j) => j.kind === 'gameplay' && (j.argv.includes(JSON.stringify(video).slice(1, -1)) || j.argv.includes(`"${id}"`)))
    .map((j) => ({ id: j.id, title: j.title, status: j.status, step: (JSON.parse(j.argv) as string[])[2] as GameplayStep, finished_at: j.finished_at }));

const recordingUrl = (p: string) => `/media/recording?path=${encodeURIComponent(p)}`;

/**
 * Gameplay per la pagina Gameplay: le registrazioni con il loro Lucianus e tutti quelli con del lavoro
 * salvato, anche se registrazione e video finale sono stati cancellati (resta la copia a 720p).
 */
export function gameplayList() {
  const live = new Map(
    videos()
      .filter((v) => !v.name.startsWith('Lucianus_') && !inside(v.path, PATHS.out) && !/_(finale|prova)\.mp4$/.test(v.name) && (lucianusFor(v.path) || readEdit(v.id)))
      .map((v) => [v.id, v]),
  );
  const list = [...new Set([...live.keys(), ...gameplayIds()])].map((id) => {
    const v = live.get(id);
    const e = readEdit(id);
    const path = v?.path ?? e!.video;
    const poster = fileInfo(posterPath(id));
    return {
      id,
      path,
      name: v?.name ?? basename(path),
      title: e?.title ?? null,
      folder: v?.folder ?? null,
      available: !!v,
      thumb: v ? `/media/thumb?path=${encodeURIComponent(v.path)}` : (poster?.url ?? null),
      duration: v?.duration ?? e!.duration,
      mtime: v?.mtime ?? e!.updated_at,
      lucianus: v ? !!lucianusFor(v.path) : !!e?.lucianus,
      cuts: e?.cuts.filter((c) => c.enabled).length ?? null,
      analyzed: isAnalyzed(e),
      final: e ? finalDuration(e) : null,
      preview: existsSync(previewPath(id)),
      exported: existsSync(exportPath(id, path, false, e?.title)),
      archive: existsSync(archivePath(id)),
      jobs: gameplayJobs(path, id).filter((j) => j.status === 'in corso' || j.status === 'in coda'),
    };
  });
  return { folders: recordingFolders(), videos: list.sort((a, b) => b.mtime.localeCompare(a.mtime)) };
}

/** La registrazione di un gameplay: il suo video finale in out/<id>/ ha lo stesso id, ma non è lei. */
const recording = (id: string) => videos().find((x) => x.id === id && !inside(x.path, PATHS.out));

/** L'audio dell'anteprima è stato fatto con altri volumi (o per un'altra registrazione)? */
function previewStale(id: string, e: GameplayEdit): boolean {
  const key = `${previewPath(id)}.json`;
  try {
    return !existsSync(key) || readFileSync(key, 'utf8') !== mixKey(e);
  } catch {
    return true;
  }
}

export function gameplay(id: string) {
  const v = recording(id);
  const stored: GameplayEdit | null = readEdit(id);
  if (!v && !stored) throw new Error('video non trovato');
  // i percorsi veri sono quelli di adesso: la registrazione può essere stata spostata, o non esserci più
  const path = v?.path ?? stored!.video;
  const lucianus = v ? lucianusFor(v.path) : null;
  const edit = stored ? { ...stored, video: path, lucianus } : null;
  const preview = fileInfo(previewPath(id));
  return {
    id,
    video: path,
    name: v?.name ?? basename(path),
    folder: v?.folder ?? null,
    available: !!v,
    duration: v?.duration ?? stored!.duration,
    lucianus,
    recording: recordingUrl(path),
    lucianusUrl: lucianus ? recordingUrl(lucianus) : null,
    look: lookOf(edit),
    defaultLook: DEFAULT_LOOK,
    facecam: edit?.facecam !== false,
    outro: edit?.outro ? { ...edit.outro, name: basename(edit.outro.path), url: recordingUrl(edit.outro.path), missing: !existsSync(edit.outro.path) } : null,
    edit,
    analyzed: isAnalyzed(edit),
    mix: edit ? mixOf(edit) : DEFAULT_MIX,
    final: edit ? finalDuration(edit) : null,
    preview,
    previewStale: !!(v && preview && edit && previewStale(id, edit)),
    export: fileInfo(exportPath(id, path, false, edit?.title)),
    tracks: existsSync(tracksPath(exportPath(id, path, false, edit?.title))),
    test: fileInfo(exportPath(id, path, true, edit?.title)),
    archive: fileInfo(archivePath(id)),
    language: existsSync(languagePath(id)),
    youtube: readYoutube(id),
    references: images(REFERENCES).map((p) => ({ path: p, name: basename(p), url: fileInfo(p)!.url })),
    rockstar: images(ROCKSTAR).length,
    shorts: shortStats(id),
    jobs: gameplayJobs(path, id).slice(0, 8),
  };
}

/** Salva i tagli rivisti a mano. */
export function saveGameplayCuts(id: string, cuts: Cut[]) {
  // tagli segnati prima dell'analisi: lo stato nasce qui, e l'analisi non tocca quelli fatti a mano
  const rec = readEdit(id) ? null : recording(id);
  const e = readEdit(id) ?? (rec ? writeEdit(id, newEdit(rec.path, rec.duration)) : null);
  if (!e) throw new Error('video non trovato');
  return writeEdit(id, { ...e, cuts });
}

export interface GameplayMeta {
  title?: string | null;
  description?: string;
  mix?: AudioMix;
  /** posizione e grandezza di Lucianus; null = quelle di prima */
  look?: Look | null;
  /** il Lucianus della registrazione si vede nel video */
  facecam?: boolean;
  /** percorso del pezzo finale; null lo toglie */
  outro?: string | null;
}

/** Durata di un video con ffprobe, o null se non è un video leggibile. */
function videoDuration(p: string): number | null {
  const r = Bun.spawnSync(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'format=duration', '-of', 'csv=p=0', p]);
  const d = Number(r.stdout.toString().trim());
  return r.exitCode === 0 && d > 0 ? d : null;
}

/** I pezzi finali dei gameplay: la dashboard li riproduce nell'anteprima (vedi media.server.ts). */
export const outroPaths = (): string[] => gameplayIds().flatMap((id) => readEdit(id)?.outro?.path ?? []);

const DUCKS: Duck[] = ['spento', 'leggero', 'medio', 'forte'];

/**
 * Nome del video finale, descrizione e volumi. Se il video finale (o la prova) c'è già, prende subito il
 * nome nuovo, anche tra i video della dashboard.
 */
export function saveGameplayMeta(id: string, patch: GameplayMeta) {
  // nome, descrizione e volumi si possono dare anche prima di analizzare: lo stato nasce qui
  const rec = readEdit(id) ? null : recording(id);
  const e = readEdit(id) ?? (rec ? writeEdit(id, newEdit(rec.path, rec.duration)) : null);
  if (!e) throw new Error('video non trovato');
  const next: GameplayEdit = { ...e };
  if (patch.mix) {
    if (!DUCKS.includes(patch.mix.duck)) throw new Error('livello del gioco sconosciuto');
    const eq = patch.mix.eq ?? DEFAULT_MIX.eq!;
    if (!(eq in VOICE_PRESETS)) throw new Error('tipo di voce sconosciuto');
    next.mix = { voiceDb: Math.max(-6, Math.min(15, Math.round(Number(patch.mix.voiceDb) * 2) / 2 || 0)), duck: patch.mix.duck, clear: !!patch.mix.clear, eq };
  }
  if (patch.look !== undefined) {
    if (patch.look === null) delete next.look;
    else {
      const n = (v: unknown, lo: number, hi: number) => {
        const x = Number(v);
        if (!Number.isFinite(x)) throw new Error('posizione di Lucianus non valida');
        return Math.round(Math.max(lo, Math.min(hi, x)) * 10000) / 10000;
      };
      // può uscire dai bordi, ma almeno un pezzo resta dentro il fotogramma
      next.look = { x: n(patch.look.x, -0.9, 0.98), y: n(patch.look.y, -0.9, 0.98), h: n(patch.look.h, 0.05, 1.5) };
    }
  }
  if (patch.facecam !== undefined) {
    if (patch.facecam) delete next.facecam;
    else next.facecam = false;
  }
  if (patch.outro !== undefined) {
    if (patch.outro === null) delete next.outro;
    else {
      const p = resolve(patch.outro.trim().replace(/^~(?=\/)/, homedir()));
      if (!existsSync(p)) throw new Error(`non trovo il file: ${p}`);
      const duration = videoDuration(p);
      if (!duration) throw new Error('questo file non sembra un video');
      next.outro = { path: p, duration: Math.round(duration * 1000) / 1000 };
    }
  }
  if (patch.description !== undefined) next.description = patch.description.slice(0, 4000);
  if (patch.title !== undefined) {
    const title = patch.title?.trim() ? patch.title.trim().slice(0, 150) : undefined;
    if (title !== undefined && !fileTitle(title)) throw new Error('il nome non può essere fatto solo di simboli');
    for (const test of [false, true]) {
      const from = exportPath(id, e.video, test, e.title);
      const to = exportPath(id, e.video, test, title);
      if (from === to || !existsSync(from)) continue;
      if (existsSync(to)) throw new Error(`esiste già un video chiamato “${basename(to)}”`);
      renameSync(from, to);
      if (existsSync(tracksPath(from))) renameSync(tracksPath(from), tracksPath(to));
      db.run('UPDATE extra_videos SET path = ? WHERE path = ?', [to, from]);
    }
    next.title = title;
  }
  return writeEdit(id, next);
}

// ───────── cartelle delle registrazioni ─────────

export function gameplayFolders() {
  return recordingFolders();
}

/** Apre la finestra di macOS per scegliere una cartella (sul Mac dove gira la dashboard) e la salva. */
export async function chooseSecondFolder() {
  const proc = Bun.spawn(['osascript', '-e', 'POSIX path of (choose folder with prompt "Scegli la seconda cartella delle registrazioni")'], { stdout: 'pipe', stderr: 'pipe' });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) return { path: secondFolder(), cancelled: true };
  const p = out.trim().replace(/(.)\/$/, '$1');
  setSecondFolder(p);
  return { path: p, cancelled: false };
}

export function clearSecondFolder() {
  setSecondFolder(null);
  return { ok: true };
}

// ───────── titolo YouTube e miniatura ─────────

function readYoutube(id: string) {
  const p = youtubePath(id);
  if (!existsSync(p)) return null;
  const y = JSON.parse(readFileSync(p, 'utf8')) as Youtube;
  return { ...y, thumbnail: { ...y.thumbnail, upload: y.thumbnail.upload.map((u) => ({ ...u, name: basename(u.file), url: fileInfo(u.file)?.url ?? null })) } };
}

export async function gameplayYoutube(id: string) {
  const v = recording(id);
  const e = readEdit(id);
  if (!e) throw new Error('prima analizza il video');
  // senza registrazione i fotogrammi vengono dalla copia a 720p
  await generateYoutube(id, { ...e, video: v?.path ?? e.video, lucianus: v ? lucianusFor(v.path) : null });
  return readYoutube(id);
}

/** Salva una miniatura di riferimento caricata dalla dashboard. */
export function addReference(name: string, base64: string) {
  const ext = extname(name).toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) throw new Error('servono immagini JPG, PNG o WebP');
  mkdirSync(REFERENCES, { recursive: true });
  const base = basename(name, extname(name)).replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 80) || 'riferimento';
  let p = join(REFERENCES, `${base}${ext}`);
  for (let k = 2; existsSync(p); k++) p = join(REFERENCES, `${base}-${k}${ext}`);
  writeFileSync(p, Buffer.from(base64, 'base64'));
  return { path: p };
}

/** Toglie una miniatura di riferimento: va nel Cestino, non si cancella. */
export function removeReference(path: string) {
  const p = resolve(path);
  if (!inside(p, REFERENCES) || !existsSync(p)) throw new Error('riferimento non trovato');
  renameSync(p, join(homedir(), '.Trash', `${Date.now()}-${basename(p)}`));
  return { ok: true };
}

/** Apre nel Finder la cartella dei riferimenti o degli screenshot, oppure una cartella in out/, o mostra un file. */
export function revealInFinder(target: 'riferimenti' | 'rockstar' | string) {
  if (target === 'riferimenti' || target === 'rockstar') {
    const dir = target === 'riferimenti' ? REFERENCES : ROCKSTAR;
    mkdirSync(dir, { recursive: true });
    Bun.spawn(['open', dir]);
  } else {
    const p = resolve(target);
    if (!inside(p, THUMBS, PATHS.work, PATHS.out) || !existsSync(p)) throw new Error('file non trovato');
    Bun.spawn(statSync(p).isDirectory() ? ['open', p] : ['open', '-R', p]);
  }
  return { ok: true };
}

/** Apre nel Finder la cartella di un video in out/ (o la sua da-pubblicare), creandola se non c'è ancora. */
export function revealProject(id: string, sub: 'cartella' | 'da-pubblicare') {
  if (!projects().videos.some((v) => v.id === id)) throw new Error('video non trovato');
  const dir = sub === 'da-pubblicare' ? publishDir(id) : projectDir(id);
  mkdirSync(dir, { recursive: true });
  Bun.spawn(['open', dir]);
  return { ok: true };
}

// ───────── video ─────────

export function addVideo(path: string) {
  const p = resolve(path.replace(/^~/, process.env.HOME ?? '~'));
  if (!existsSync(p)) throw new Error('file non trovato');
  db.run('INSERT OR IGNORE INTO extra_videos (path, added_at) VALUES (?, ?)', [p, now()]);
  return { ok: true };
}

export function run(id: string) {
  return { ...runStatus(id), shorts: shorts(id) };
}

// ───────── video: gameplay e short insieme ─────────

const activeJob = (path: string) =>
  listJobs(50).find((j) => j.kind === 'shorts' && (j.status === 'in corso' || j.status === 'in coda') && j.argv.includes(JSON.stringify(path).slice(1, -1)))?.status ?? null;

/**
 * I video della scheda Video, ognuno con la sua cartella in out/<id>/: i gameplay (registrazione con il suo
 * Lucianus, o con del lavoro salvato) e gli altri video da cui fare short. Il video finale di un gameplay non
 * compare da solo: i suoi short stanno nel gameplay.
 */
type GameplayItem = ReturnType<typeof gameplayList>['videos'][number];

export interface Project {
  id: string;
  kind: 'gameplay' | 'video';
  title: string;
  name: string;
  folder: string | null;
  /** il file c'è ancora (la registrazione, per un gameplay) */
  available: boolean;
  thumb: string | null;
  duration: number;
  mtime: string;
  gameplay: Pick<GameplayItem, 'lucianus' | 'analyzed' | 'cuts' | 'final' | 'preview' | 'exported' | 'archive' | 'jobs'> | null;
  /** da dove partono gli short: per un gameplay il video finale, quando c'è */
  source: string | null;
  stages: ReturnType<typeof runStatus>['stages'];
  shorts: ReturnType<typeof shortStats>;
  /** lavoro degli short in coda o in corso */
  job: string | null;
}

export function projects() {
  const all = videos();
  const g = gameplayList();
  const seen = new Set<string>();
  const list = g.videos.map((v): Project => {
    seen.add(v.id);
    const e = readEdit(v.id);
    const final = exportPath(v.id, v.path, false, e?.title);
    return {
      id: v.id,
      kind: 'gameplay',
      title: v.title ?? v.name.replace(/\.[^.]+$/, ''),
      name: v.name,
      folder: v.folder,
      available: v.available,
      thumb: v.thumb,
      duration: v.duration,
      mtime: v.mtime,
      gameplay: { lucianus: v.lucianus, analyzed: v.analyzed, cuts: v.cuts, final: v.final, preview: v.preview, exported: v.exported, archive: v.archive, jobs: v.jobs },
      source: v.exported ? final : null,
      stages: runStatus(v.id).stages,
      shorts: shortStats(v.id),
      job: activeJob(final),
    };
  });
  for (const v of all) {
    if (seen.has(v.id) || v.name.startsWith('Lucianus_') || inside(v.path, PATHS.out)) continue;
    seen.add(v.id);
    list.push({
      id: v.id,
      kind: 'video',
      title: v.name.replace(/\.[^.]+$/, ''),
      name: v.name,
      folder: v.folder,
      available: true,
      thumb: `/media/thumb?path=${encodeURIComponent(v.path)}`,
      duration: v.duration,
      mtime: v.mtime,
      gameplay: null,
      source: v.path,
      stages: v.stages,
      shorts: shortStats(v.id),
      job: v.job,
    });
  }
  // short di video che non sono più sul Mac: si possono ancora rivedere e pubblicare
  for (const r of runs()) {
    const st = shortStats(r.id);
    if (seen.has(r.id) || !st.total) continue;
    seen.add(r.id);
    const name = r.source ? basename(r.source) : r.id;
    list.push({
      id: r.id,
      kind: 'video',
      title: name.replace(/\.[^.]+$/, ''),
      name,
      folder: null,
      available: false,
      thumb: `/media/out/${r.id}/short/s01.jpg`,
      duration: 0,
      mtime: statSync(join(PATHS.work, r.id)).mtime.toISOString(),
      gameplay: null,
      source: null,
      stages: runStatus(r.id).stages,
      shorts: st,
      job: null,
    });
  }
  return { folders: g.folders, movies: MOVIES, videos: list.sort((a, b) => b.mtime.localeCompare(a.mtime)) };
}

// ───────── qualità dei video ─────────

export function exportSettings() {
  return { settings: readExport(), defaults: DEFAULT_EXPORT };
}

export function saveExportSettings(s: ExportSettings) {
  return writeExport(s);
}

export function project(id: string) {
  const p = projects().videos.find((v) => v.id === id);
  if (!p) throw new Error('video non trovato');
  return p;
}

// ───────── notizie e script ─────────

interface StoryRow {
  id: number;
  title: string;
  first_seen: string;
  last_seen: string;
  items: number;
  triage: string | null;
  score: number | null;
  status: string;
}

export function stories(minScore: number) {
  const rows = db
    .query(`SELECT id, title, first_seen, last_seen, items, triage, score, status FROM stories WHERE COALESCE(score, 0) >= ? ORDER BY COALESCE(score, 0) DESC, last_seen DESC LIMIT 200`)
    .all(minScore) as StoryRow[];
  return rows.map((r) => ({ ...r, triage: r.triage ? JSON.parse(r.triage) : null }));
}

interface ScriptRow {
  id: number;
  story_id: number;
  created_at: string;
  route: string;
  content: string;
  edited: string | null;
  status: string;
  cost_usd: number | null;
  kind: 'short' | 'long';
  checks: string | null;
}

export function story(id: number) {
  const s = db.query('SELECT id, title, first_seen, last_seen, items, triage, score, status FROM stories WHERE id = ?').get(id) as StoryRow | null;
  if (!s) throw new Error('storia non trovata');
  const items = db.query('SELECT id, source, url, title, summary, published_at FROM news_items WHERE story_id = ? ORDER BY COALESCE(published_at, fetched_at) DESC').all(id) as {
    id: number;
    source: string;
    url: string;
    title: string;
    summary: string | null;
    published_at: string | null;
  }[];
  const scripts = (db.query('SELECT * FROM scripts WHERE story_id = ? ORDER BY id DESC').all(id) as ScriptRow[]).map((r) => ({
    ...r,
    content: JSON.parse(r.content),
    edited: r.edited ? JSON.parse(r.edited) : null,
    checks: r.checks ? (JSON.parse(r.checks) as LongChecks) : null,
  }));
  return { ...s, triage: s.triage ? JSON.parse(s.triage) : null, items, scripts };
}

export function setStoryStatus(id: number, st: string) {
  db.run('UPDATE stories SET status = ? WHERE id = ?', [st, id]);
  return { ok: true };
}

/** Salva le modifiche e/o lo stato di uno script e ne riscrive il markdown in data/scripts/. */
export async function saveScript(id: number, edited: unknown, st?: string) {
  const row = db.query('SELECT s.*, t.title FROM scripts s JOIN stories t ON t.id = s.story_id WHERE s.id = ?').get(id) as (ScriptRow & { title: string }) | null;
  if (!row) throw new Error('script non trovato');
  if (edited !== undefined) db.run('UPDATE scripts SET edited = ? WHERE id = ?', [JSON.stringify(edited), id]);
  if (st) db.run('UPDATE scripts SET status = ? WHERE id = ?', [st, id]);
  const final = edited ?? (row.edited ? JSON.parse(row.edited) : JSON.parse(row.content));
  const md =
    row.kind === 'long'
      ? longScriptMarkdown(row.title, final as LongScript, row.checks ? (JSON.parse(row.checks) as LongChecks) : null)
      : scriptMarkdown(row.title, final as Record<string, unknown>);
  mkdirSync(join(DATA, 'scripts'), { recursive: true });
  await Bun.write(join(DATA, 'scripts', `script-${id}.md`), md);
  return { ok: true };
}

// ───────── modelli ─────────

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** Le due risposte da votare sono l'output.json dei modelli: JSON qualsiasi. */
export function votePair(id?: string, task?: string) {
  const pair = benchPair(id, task);
  return pair && { ...pair, a: pair.a as Json, b: pair.b as Json };
}

export async function saveRouting(r: RoutingFile) {
  if (!r.tasks || !r.candidates) throw new Error('routing non valido');
  for (const [t, x] of Object.entries(r.tasks)) {
    if (!['local', 'claude', 'clef'].includes(x.provider)) throw new Error(`${t}: provider non valido`);
    if (x.provider !== 'clef' && !x.model) throw new Error(`${t}: manca il modello`);
  }
  await Bun.write(ROUTING_PATH, `${JSON.stringify(r, null, 2)}\n`);
  return { ok: true };
}

// ───────── libreria media e montaggio ─────────

/** URL di un file sotto data/ servito dalla route /media/file. */
const fileUrl = (p: string) => `/media/file?path=${encodeURIComponent(p)}`;

export function mediaLibrary() {
  const videos = db.query(`SELECT * FROM media_videos ORDER BY added_at`).all() as MediaVideo[];
  const shots = (db.query(`SELECT id, video_id, idx, s, e, frame, tags FROM media_shots ORDER BY video_id, idx`).all() as { id: number; video_id: string; idx: number; s: number; e: number; frame: string; tags: string | null }[]).map(
    (x) => ({ ...x, tags: x.tags ? (JSON.parse(x.tags) as ShotTags) : null, frame_url: fileUrl(x.frame) }),
  );
  return { videos: videos.map((v) => ({ ...v, proxy_url: v.proxy ? fileUrl(v.proxy) : null })), shots };
}

/** Il manifest dei materiali di uno script, con gli URL per la dashboard; null se non è ancora stato fatto. */
export async function manifest(scriptId: number) {
  const row = db.query('SELECT s.content, s.edited, t.title FROM scripts s JOIN stories t ON t.id = s.story_id WHERE s.id = ? AND s.kind = ?').get(scriptId, 'long') as {
    content: string;
    edited: string | null;
    title: string;
  } | null;
  if (!row) throw new Error('script lungo non trovato');
  const script = JSON.parse(row.edited ?? row.content) as LongScript;
  const video = join(DATA, 'assets', `script-${scriptId}`, 'montaggio.mp4');
  const montage = existsSync(video) ? { url: fileUrl(video), path: video, mtime: new Date(Bun.file(video).lastModified).toISOString(), size: Bun.file(video).size } : null;
  const head = { title: row.title, chapters: script.chapters.map((c) => c.title), montage };
  const f = Bun.file(manifestPath(scriptId));
  if (!(await f.exists())) return { ...head, manifest: null };
  const m = (await f.json()) as Manifest;
  return { ...head, manifest: {
    ...m,
    beats: m.beats.map((b) => ({ ...b, assets: b.assets.map((a) => ({ ...a, url_preview: fileUrl(a.type === 'shot' ? a.frame : a.file), url_video: a.type === 'shot' ? fileUrl(a.proxy) : null })) })),
  } };
}

/** Cambia i materiali di una scena (ordine, tolti, aggiunti dalla libreria). */
export async function setBeatAssets(scriptId: number, chapter: number, index: number, assets: Asset[]) {
  const path = manifestPath(scriptId);
  const m = (await Bun.file(path).json()) as Manifest;
  const b = m.beats.find((x) => x.chapter === chapter && x.index === index);
  if (!b) throw new Error('scena non trovata');
  b.assets = assets.map((a) => {
    if (a.type === 'image') return { type: 'image', file: a.file, url: a.url, page: a.page, from: a.from };
    const x = db.query(`SELECT m.id, m.video_id, v.title, m.s, m.e, m.frame, v.proxy FROM media_shots m JOIN media_videos v ON v.id = m.video_id WHERE m.id = ?`).get(a.shot_id) as
      | { id: number; video_id: string; title: string; s: number; e: number; frame: string; proxy: string }
      | null;
    if (!x) throw new Error(`inquadratura ${a.shot_id} non trovata`);
    return { type: 'shot', shot_id: x.id, video_id: x.video_id, video_title: x.title, s: x.s, e: x.e, frame: x.frame, proxy: x.proxy };
  });
  await Bun.write(path, JSON.stringify(m, null, 2));
  return { ok: true };
}

export function longScripts() {
  return db.query(`SELECT s.id, s.story_id, s.created_at, s.status, t.title FROM scripts s JOIN stories t ON t.id = s.story_id WHERE s.kind = 'long' ORDER BY s.id DESC`).all() as {
    id: number;
    story_id: number;
    created_at: string;
    status: string;
    title: string;
  }[];
}

/** La linea del tempo del montaggio per il gobbo; null se il montaggio non è ancora stato fatto. */
export async function timeline(scriptId: number) {
  const f = Bun.file(join(DATA, 'assets', `script-${scriptId}`, 'timeline.json'));
  if (!(await f.exists())) return null;
  return (await f.json()) as { script_id: number; fps: number; read_wpm: number; duration: number; beats: PrompterBeat[] };
}
