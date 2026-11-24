// Canzoni protette nella traccia del gioco (vedi docs/musica.md): i tratti, trovati da Shazam o segnati a mano,
// la musica libera scelta per ciascuno, e la ricostruzione del gioco senza canzoni con python/replace_music.py
// (separazione BandIt: dialoghi ed effetti restano gli originali). Il risultato è cleanGamePath(id): mix e
// tracce per gli short lo usano al posto della traccia 1 della registrazione.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { FFMPEG } from '../lib/ff';
import { libraryDir, readMusicConfig } from '../lib/music-config';
import { projectDir } from '../lib/project';
import { py } from '../lib/py';
import { cleanGamePath, type GameplayEdit, gameplayDir, removedRanges } from './edit';

/** La musica libera scelta per un tratto. */
export interface MusicChoice {
  /** file audio nella libreria */
  file: string;
  title: string;
  artist: string;
  origin: 'libreria' | 'youtube' | 'incompetech';
  url?: string;
  license?: string;
  /** testo da mettere nella descrizione del video, se la licenza lo chiede */
  attribution?: string;
}

/** Un tratto della registrazione con una canzone protetta (tempi della registrazione, in secondi). */
export interface MusicSegment {
  id: string;
  start: number;
  end: number;
  source: 'rilevata' | 'manuale';
  /** la canzone trovata da Shazam, o indicata a mano */
  song?: { title: string; artist?: string; url?: string };
  /** sostituisci: la canzone si sente; aggiungi: era disattivata nel gioco; auto: decide la separazione */
  mode?: 'auto' | 'sostituisci' | 'aggiungi';
  /** con "aggiungi": quanto sopra (o sotto) il livello del gioco nel tratto, in dB */
  addLevelDb?: number;
  /** lo stile cercato, per le proposte quando la canzone nel tratto non si sente (per esempio "soft rock anni 70") */
  style?: string;
  choice?: MusicChoice;
}

/** Una traccia della libreria: il file e quello che si sa di lei (dal file .json accanto, o dal nome). */
export interface LibraryTrack {
  file: string;
  title: string;
  artist: string;
  origin: MusicChoice['origin'];
  url?: string;
  license?: string;
  attribution?: string;
  /** BPM e impronta sonora, se la libreria è stata indicizzata */
  bpm?: number;
}

const AUDIO = /\.(mp3|m4a|wav|flac|ogg|opus|webm|aac)$/i;

export const musicDir = (id: string) => join(gameplayDir(id), 'musica');
/** Il tratto ricostruito (gioco senza la canzone), da ascoltare nel player al posto della traccia 1. */
export const previewAudioPath = (id: string, segId: string) => join(musicDir(id), `anteprima-${segId}.m4a`);
const keyPath = (id: string) => join(musicDir(id), 'chiave.json');
const internalReport = (id: string) => join(musicDir(id), 'report.json');
/** Il report per te: tratti, canzoni, sostituti e attribuzioni, con i tempi del video pubblicato. */
export const musicReportPath = (id: string) => join(projectDir(id), 'musica.json');

/** Le tracce della libreria: data/musica-libera (o quella di config/musica.json). */
export function libraryTracks(): LibraryTrack[] {
  const dir = libraryDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => AUDIO.test(f) && !f.startsWith('.'))
    .sort()
    .map((f) => {
      const file = join(dir, f);
      const stem = basename(f, extname(f));
      const meta = existsSync(join(dir, `${stem}.json`)) ? (JSON.parse(readFileSync(join(dir, `${stem}.json`), 'utf8')) as Partial<LibraryTrack>) : {};
      const txt = existsSync(join(dir, `${stem}.txt`)) ? readFileSync(join(dir, `${stem}.txt`), 'utf8').trim() : undefined;
      // "Autore - Titolo" nel nome del file, se il .json non dice altro
      const [artist, title] = stem.includes(' - ') ? stem.split(' - ', 2) : ['', stem];
      return { file, title: meta.title ?? title!, artist: meta.artist ?? artist!, origin: meta.origin ?? 'libreria', url: meta.url, license: meta.license, attribution: meta.attribution ?? txt, bpm: meta.bpm };
    });
}

/** I tratti con una musica scelta, in ordine: quelli che entrano nel gioco senza canzoni. */
export const chosenSegments = (e: GameplayEdit): MusicSegment[] =>
  (e.music ?? []).filter((s) => s.choice && existsSync(s.choice.file)).sort((a, b) => a.start - b.start);

/** Impronta di quello che è stato ricostruito: se cambia, il gioco senza canzoni va rifatto. */
export function musicKey(e: GameplayEdit): string {
  const c = readMusicConfig();
  const segs = chosenSegments(e).map((s) => ({ s: s.start, e: s.end, m: s.mode ?? 'auto', l: s.addLevelDb ?? 0, f: s.choice!.file, t: statSync(s.choice!.file).mtimeMs }));
  return JSON.stringify({ v: 1, video: e.video, segs, fade: c.fadeS, margin: c.marginS, gain: c.maxGainDb, silence: c.musicSilenceDb });
}

/** Il gioco senza canzoni corrisponde ai tratti scelti adesso? */
export function musicReady(id: string, e: GameplayEdit): boolean {
  if (!chosenSegments(e).length) return !existsSync(cleanGamePath(id));
  return existsSync(cleanGamePath(id)) && existsSync(keyPath(id)) && readFileSync(keyPath(id), 'utf8') === musicKey(e);
}

const hms = (s: number) => `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
/** Secondo del video finale che corrisponde al secondo `t` della registrazione. */
const toFinal = (removed: [number, number][], t: number) => t - removed.reduce((s, [a, b]) => s + Math.max(0, Math.min(b, t) - a), 0);

function ff(args: string[]): void {
  const r = Bun.spawnSync([FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', ...args], { stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`ffmpeg: ${r.stderr.toString().trim().split('\n').slice(-3).join(' ')}`);
}

/**
 * Ricostruisce il gioco senza canzoni per i tratti scelti (o lo toglie, se non ce ne sono più), con le anteprime
 * dei tratti per il player e il report. `video`: la registrazione da cui prendere la traccia 1.
 */
export async function rebuildGame(id: string, e: GameplayEdit, video: string): Promise<void> {
  const c = readMusicConfig();
  const dir = musicDir(id);
  mkdirSync(dir, { recursive: true });
  const segs = chosenSegments(e);
  for (const f of readdirSync(dir)) if (f.startsWith('anteprima-')) rmSync(join(dir, f));
  if (!segs.length) {
    rmSync(cleanGamePath(id), { force: true });
    rmSync(keyPath(id), { force: true });
    writeReport(id, e, null);
    console.log('Nessun tratto con una musica scelta: il gioco resta quello originale.');
    return;
  }
  console.log(`Gioco senza canzoni: ${segs.length} ${segs.length === 1 ? 'tratto' : 'tratti'}.`);
  const orig = join(dir, 'gioco-originale.flac');
  console.log('  estraggo la traccia del gioco (24 bit, senza perdite)…');
  ff(['-i', video, '-map', '0:a:0', '-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24', orig]);
  // le musiche scelte a 48 kHz stereo, una volta per file
  const tracks = join(dir, 'brani');
  mkdirSync(tracks, { recursive: true });
  const spec = segs.map((s) => {
    const f = s.choice!.file;
    const wav = join(tracks, `${createHash('sha1').update(`${f}:${statSync(f).mtimeMs}`).digest('hex').slice(0, 12)}.wav`);
    if (!existsSync(wav)) ff(['-i', f, '-map', '0:a:0', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_f32le', wav]);
    console.log(`  ${hms(s.start)}–${hms(s.end)}: ${s.choice!.artist} – ${s.choice!.title}`);
    return { id: s.id, start: s.start, end: s.end, music: wav, mode: s.mode ?? 'auto', add_level_db: s.addLevelDb ?? 0 };
  });
  const segFile = join(dir, 'tratti.json');
  writeFileSync(segFile, JSON.stringify(spec, null, 2));
  const tmp = `${cleanGamePath(id)}.part.flac`;
  const previews = join(dir, 'anteprime-wav');
  rmSync(previews, { recursive: true, force: true });
  console.log('  separo dialoghi, musica ed effetti nei tratti e metto la musica nuova (BandIt Plus)…');
  await py('replace_music.py', [
    orig, tmp, '--segments', segFile, '--previews', previews, '--report', internalReport(id),
    '--fade', String(c.fadeS), '--margin', String(c.marginS), '--max-gain-db', String(c.maxGainDb), '--silence-db', String(c.musicSilenceDb),
  ]);
  renameSync(tmp, cleanGamePath(id));
  for (const s of segs) ff(['-i', join(previews, `${s.id}.wav`), '-c:a', 'aac', '-b:a', '192k', previewAudioPath(id, s.id)]);
  rmSync(previews, { recursive: true, force: true });
  rmSync(orig, { force: true });
  writeFileSync(keyPath(id), musicKey(e));
  writeReport(id, e, JSON.parse(readFileSync(internalReport(id), 'utf8')));
  console.log(`Fatto: ${cleanGamePath(id)}`);
}

/** Come è andata l'ultima ricerca delle canzoni (per il riquadro e il report). */
export interface DetectStatus {
  status: 'ok' | 'con errori' | 'bloccato';
  requests: number;
  found: number;
  errors: { at: number | null; error: string }[];
  at: string;
}
export const detectStatusPath = (id: string) => join(musicDir(id), 'rilevamento.json');
export const readDetectStatus = (id: string): DetectStatus | null => (existsSync(detectStatusPath(id)) ? (JSON.parse(readFileSync(detectStatusPath(id), 'utf8')) as DetectStatus) : null);

/** Le parti della registrazione che restano nel video (fuori dai tagli attivi): solo lì si cercano canzoni. */
function keptRanges(e: GameplayEdit): [number, number][] {
  const out: [number, number][] = [];
  let at = 0;
  for (const [a, b] of removedRanges(e)) {
    if (a > at) out.push([at, a]);
    at = Math.max(at, b);
  }
  if (at < e.duration) out.push([at, e.duration]);
  return out;
}

/**
 * Cerca le canzoni protette nella traccia del gioco (python/detect_songs.py, Shazam) e le aggiunge come tratti
 * "rilevata" senza musica scelta: proposte, che non cambiano niente finché non scegli una musica. Restano i tratti
 * segnati a mano e quelli con una musica già scelta; se Shazam non risponde, si salva quello che c'è e si va avanti.
 */
export async function detectSongs(id: string, e: GameplayEdit, video: string): Promise<GameplayEdit> {
  const c = readMusicConfig();
  const dir = musicDir(id);
  mkdirSync(dir, { recursive: true });
  const orig = join(dir, 'gioco-originale.flac');
  console.log('Estraggo la traccia del gioco…');
  ff(['-i', video, '-map', '0:a:0', '-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24', orig]);
  const keepFile = join(dir, 'da-ascoltare.json');
  writeFileSync(keepFile, JSON.stringify(keptRanges(e)));
  const out = join(dir, 'canzoni.json');
  console.log('Shazam ascolta la traccia del gioco (prima ogni 24 s, poi più fitto attorno alle canzoni)…');
  try {
    await py('detect_songs.py', [
      orig, out, '--keep', keepFile, '--window', String(c.windowS), '--coarse-hop', String(c.coarseHopS), '--hop', String(c.hopS),
      '--pause', String(c.pauseS), '--silence-db', String(c.silenceDb), '--min-hits', String(c.minHits),
    ]);
  } finally {
    rmSync(orig, { force: true });
  }
  const r = JSON.parse(readFileSync(out, 'utf8')) as { status: DetectStatus['status']; requests: number; errors: DetectStatus['errors']; segments: { start: number; end: number; title: string; artist: string; url?: string; hits: number }[] };
  // restano i tratti a mano e quelli con una musica scelta; le proposte di prima si rifanno
  const kept = (e.music ?? []).filter((s) => s.source === 'manuale' || s.choice);
  const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;
  const fresh: MusicSegment[] = [];
  // fra due canzoni sovrapposte vince quella riconosciuta più volte
  for (const s of [...r.segments].sort((a, b) => b.hits - a.hits)) {
    if ([...kept, ...fresh].some((k) => overlaps(k, s))) continue;
    fresh.push({ id: crypto.randomUUID().slice(0, 8), start: s.start, end: Math.min(e.duration, s.end), source: 'rilevata', song: { title: s.title, artist: s.artist, url: s.url }, mode: 'auto' });
  }
  const status: DetectStatus = { status: r.status, requests: r.requests, found: fresh.length, errors: r.errors, at: new Date().toISOString() };
  writeFileSync(detectStatusPath(id), JSON.stringify(status, null, 2));
  console.log(`Canzoni trovate: ${fresh.length}${r.status !== 'ok' ? ` (Shazam: ${r.status}, ${r.errors.length} errori)` : ''}.`);
  for (const s of fresh) console.log(`  ${hms(s.start)}–${hms(s.end)}  ${s.song!.artist} – ${s.song!.title}`);
  const next = { ...e, music: [...kept, ...fresh].sort((a, b) => a.start - b.start) };
  writeReport(id, next, existsSync(internalReport(id)) ? JSON.parse(readFileSync(internalReport(id), 'utf8')) : null);
  return next;
}

/** Le proposte per un tratto: dalla libreria (con l'impronta sonora) e dal catalogo di Kevin MacLeod. */
export interface Proposals {
  source: string | null;
  bpm?: number | null;
  library: { file: string; bpm: number; score: number }[];
  catalog: { title: string; artist: string; url: string; bpm: number; length: string; feel: string; instruments: string; description: string; score: number }[];
  note?: string;
  at: string;
}
export const proposalsPath = (id: string, segId: string) => join(musicDir(id), `proposte-${segId}.json`);
export const readProposals = (id: string, segId: string): Proposals | null =>
  existsSync(proposalsPath(id, segId)) ? (JSON.parse(readFileSync(proposalsPath(id, segId), 'utf8')) as Proposals) : null;
const libraryIndex = () => join(libraryDir(), '.indice.json');
const catalogPath = () => join(libraryDir(), '.catalogo-incompetech.json');

/**
 * Proposte di musica libera per i tratti senza una musica scelta (o per `onlyId`): la libreria si indicizza
 * (solo i brani nuovi), il catalogo si scarica una volta al mese; poi python/music_index.py confronta.
 */
export async function proposeMusic(id: string, e: GameplayEdit, video: string, onlyId?: string): Promise<void> {
  const segs = (e.music ?? []).filter((s) => (onlyId ? s.id === onlyId : !s.choice));
  if (!segs.length) return console.log('Nessun tratto senza musica scelta.');
  mkdirSync(libraryDir(), { recursive: true });
  console.log('Indicizzo la libreria (solo i brani nuovi)…');
  await py('music_index.py', ['index', libraryDir(), libraryIndex()]);
  if (!existsSync(catalogPath()) || Date.now() - statSync(catalogPath()).mtimeMs > 30 * 86_400_000) {
    console.log('Scarico il catalogo di Kevin MacLeod (incompetech.com)…');
    try {
      await py('music_index.py', ['catalog', catalogPath()]);
    } catch (err) {
      console.warn(`  catalogo non disponibile: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  const dir = musicDir(id);
  mkdirSync(dir, { recursive: true });
  for (const s of segs) {
    // al massimo 2 minuti dal centro del tratto: bastano per l'impronta e la separazione resta veloce
    const len = Math.min(120, s.end - s.start);
    const from = s.start + (s.end - s.start - len) / 2;
    const wav = join(dir, `proposte-${s.id}.wav`);
    ff(['-ss', from.toFixed(3), '-t', len.toFixed(3), '-i', video, '-map', '0:a:0', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_f32le', wav]);
    const exclude = (e.music ?? []).filter((x) => x.id !== s.id && x.choice).map((x) => x.choice!.file);
    const text = s.style || (s.song ? `${s.song.title}${s.song.artist ? ` by ${s.song.artist}` : ''}` : '');
    const req = join(dir, `proposte-${s.id}.richiesta.json`);
    writeFileSync(req, JSON.stringify({ audio: wav, text, library_index: libraryIndex(), catalog: catalogPath(), exclude, n: 6, silence_db: readMusicConfig().musicSilenceDb }));
    const out = proposalsPath(id, s.id);
    console.log(`  ${hms(s.start)}–${hms(s.end)}: cerco musica simile…`);
    await py('music_index.py', ['propose', req, out]);
    const p = JSON.parse(readFileSync(out, 'utf8')) as Omit<Proposals, 'at'>;
    writeFileSync(out, JSON.stringify({ ...p, at: new Date().toISOString() }));
    console.log(`    da ${p.source ?? 'niente'}: ${p.library.length} dalla libreria, ${p.catalog.length} dal catalogo`);
    rmSync(wav, { force: true });
    rmSync(req, { force: true });
  }
}

interface PyReport {
  separation: { model: string; device: string } | null;
  segments: { id: string; mode: string; music_present_pct: number; levels_db: Record<string, number>; peak_limited: boolean }[];
}

/** Il report leggibile in out/<id>/musica.json: per controllare a orecchio e per la descrizione del video. */
function writeReport(id: string, e: GameplayEdit, r: PyReport | null): void {
  const removed = removedRanges(e);
  const segs = (e.music ?? []).slice().sort((a, b) => a.start - b.start);
  const report = {
    video: basename(e.video),
    aggiornato: new Date().toISOString(),
    separazione: r?.separation ?? null,
    rilevamento: readDetectStatus(id),
    nota: 'Tempi del video pubblicato (con i tagli) e della registrazione. Fuori dai tratti la traccia del gioco è identica alla registrazione; la voce non è toccata.',
    tratti: segs.map((s) => {
      const py = r?.segments.find((x) => x.id === s.id);
      return {
        inizio: hms(toFinal(removed, s.start)),
        fine: hms(toFinal(removed, s.end)),
        registrazione: `${hms(s.start)}–${hms(s.end)}`,
        canzone: s.song ? `${s.song.artist ? `${s.song.artist} – ` : ''}${s.song.title}` : null,
        trovata: s.source,
        sostituto: s.choice ? `${s.choice.artist} – ${s.choice.title}` : null,
        licenza: s.choice?.license ?? null,
        attribuzione: s.choice?.attribution ?? null,
        modo: py?.mode ?? null,
        musica_originale_presente: py ? `${py.music_present_pct}% del tratto` : null,
        livelli_db: py?.levels_db ?? null,
        avvisi: [
          ...(!s.choice ? ['nessuna musica scelta: la canzone resta'] : []),
          ...(py?.peak_limited ? ['picchi abbassati nel tratto ricostruito'] : []),
        ],
      };
    }),
    attribuzioni: [...new Set(segs.map((s) => s.choice?.attribution).filter(Boolean))],
  };
  mkdirSync(projectDir(id), { recursive: true });
  writeFileSync(musicReportPath(id), `${JSON.stringify(report, null, 2)}\n`);
}
