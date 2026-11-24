// Montaggio del gameplay lungo: registrazione di OBS + file di Lucianus, con tagli che si rivedono
// nella dashboard (Video → Video lungo). Lo stato (tagli, nome, titoli) sta in data/gameplay/<id>/; i file
// che escono (video finale, copia a 720p, short) in out/<id>/ (vedi src/lib/project.ts); in
// work/<id>/gameplay/ ci sono solo file intermedi che si rifanno (mix, audio dell'anteprima, lingua).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import { PATHS, ROOT } from '../lib/env';
import { projectDir } from '../lib/project';
import { estimate, exportRates, RATE, type SpaceEstimate, type SpaceItem } from '../lib/space';
import { videoId } from '../lib/video-id';
import type { VoicePreset } from '../lib/voice-eq';

export type CutReason = 'inizio' | 'fine' | 'menu' | 'lingua' | 'manuale';

export interface Cut {
  id: string;
  /** secondi dall'inizio della registrazione di OBS */
  start: number;
  end: number;
  reason: CutReason;
  enabled: boolean;
  note?: string;
  /** toccato a mano: un'analisi rifatta non lo sovrascrive */
  edited?: boolean;
}

/** Quanto si abbassa il gioco mentre parli (misurato su 3 minuti di voce: circa −5, −7, −8 dB). */
export type Duck = 'spento' | 'leggero' | 'medio' | 'forte';

/** Volume della voce (traccia 2) sopra il gioco (traccia 1). */
export interface AudioMix {
  /** guadagno sulla voce già compressa, in dB */
  voiceDb: number;
  duck: Duck;
  /** "Voce più chiara": l'equalizzazione di src/lib/voice-eq.ts (senza, solo il passa-alto; pulizia e compressione ci sono sempre) */
  clear: boolean;
  /** quale tipo di voce (equalizzazione e compressione, vedi VOICE_PRESETS); senza, quello di DEFAULT_MIX */
  eq?: VoicePreset;
}

/**
 * Di base la voce non si pulisce: dal 23/11 lo fanno i filtri di OBS. I gameplay registrati prima hanno il loro
 * tipo salvato in edit.json ("chiara" o "obs").
 */
export const DEFAULT_MIX: AudioMix = { voiceDb: 2, duck: 'medio', clear: true, eq: 'nessuna' };

/**
 * Dove sta Lucianus nel video: angolo in alto a sinistra (x, y) e altezza (h), in frazioni del fotogramma,
 * così valgono uguali nel 4K, nella copia a 720p e nell'anteprima della dashboard. Può uscire dai bordi.
 */
export interface Look {
  x: number;
  y: number;
  h: number;
}

/**
 * Pezzo di Lucianus registrato a parte e messo in fondo: finisce insieme al video finale, sopra il gameplay.
 * Ha la sua voce, che in quel tratto prende il posto di quella del gameplay (il gioco resta).
 */
export interface Outro {
  path: string;
  /** secondi */
  duration: number;
}

export interface GameplayEdit {
  video: string;
  lucianus: string | null;
  duration: number;
  /** ritardo da dare a Lucianus per allinearlo (ms); null = non ancora misurato */
  offsetMs: number | null;
  cuts: Cut[];
  /** posizione e grandezza di Lucianus; senza, DEFAULT_LOOK */
  look?: Look;
  /** false: il Lucianus della registrazione non si vede (per esempio se si è bloccato); la sua voce resta */
  facecam?: boolean;
  /** pezzo di Lucianus in fondo al video */
  outro?: Outro;
  /** voce e gioco; senza, DEFAULT_MIX */
  mix?: AudioMix;
  /** nome del video finale; senza, quello della registrazione con "_finale" */
  title?: string;
  /** di cosa parla il gameplay, per il titolo YouTube e il prompt della miniatura */
  description?: string;
  /** quando è finita l'analisi di menu e sincronia (lo stato può nascere prima, dando il nome al video) */
  analyzed_at?: string;
  updated_at: string;
}

/** Menu e sincronia già analizzati? Gli stati di prima non hanno analyzed_at, ma hanno la sincronia misurata. */
export const isAnalyzed = (e: GameplayEdit | null): boolean => !!e && (!!e.analyzed_at || e.offsetMs !== null);

export const mixOf = (e: GameplayEdit): AudioMix => ({ ...DEFAULT_MIX, ...e.mix });

/**
 * Impronta di registrazione e volumi: mix e anteprima la salvano accanto a sé e si rifanno quando cambia.
 * Con un pezzo finale conta anche dove cade, cioè i tagli: la sua voce entra nel mix in quei secondi.
 */
export function mixKey(e: GameplayEdit): string {
  const st = statSync(e.video);
  const outro = e.outro ? { path: e.outro.path, pieces: outroPieces(e) } : undefined;
  // voice: versione della catena della voce (src/lib/voice-eq.ts), perché un mix vecchio non sembri pronto
  return JSON.stringify({ size: st.size, mtime: st.mtimeMs, mix: mixOf(e), voice: 5, ...(outro ? { outro } : {}) });
}

/** Il file di Lucianus senza i bordi della finestra catturata (vedi LOOK.crop): 1080×1296 → 1056×1278. */
export const LUCIANUS_ASPECT = 1056 / 1278;

/** Posizione di prima: alto il 30%, appoggiato in basso, a 560 px dal bordo destro del 4K. */
export const DEFAULT_LOOK: Look = {
  h: 648 / 2160,
  y: 1 - 648 / 2160,
  x: (3840 - 560 - 648 * LUCIANUS_ASPECT) / 3840,
};

export const lookOf = (e: GameplayEdit | null): Look => ({ ...DEFAULT_LOOK, ...e?.look });

/** Il Lucianus della registrazione finisce nel video? */
export const showsFacecam = (e: GameplayEdit): boolean => !!e.lucianus && e.facecam !== false;

/** Secondo del video finale in cui parte il pezzo finale (finisce con il video). */
export const outroStart = (e: GameplayEdit): number => (e.outro ? Math.max(0, finalDuration(e) - e.outro.duration) : 0);

/**
 * Dove cade il pezzo finale nella registrazione: tratti [s, e] (secondi della registrazione) e, per ognuno,
 * da che secondo del pezzo si parte. Più di un tratto se c'è un taglio dentro gli ultimi secondi.
 */
export function outroPieces(e: GameplayEdit): { s: number; e: number; clip: number }[] {
  if (!e.outro) return [];
  const fin = finalDuration(e);
  let clip = Math.max(0, e.outro.duration - fin);
  return finalToRecording(removedRanges(e), outroStart(e), fin).map((r) => {
    const piece = { s: round(r.s), e: round(r.e), clip: round(clip) };
    clip += r.e - r.s;
    return piece;
  });
}

/** Aspetto deciso sulle anteprime, in pixel del 4K (2160 righe). */
export const LOOK = {
  height: 648, // Lucianus alto il 30%
  marginRight: 560,
  crop: 'iw-24:ih-18:12:6', // bordi della finestra catturata (angoli e riga in alto)
  key: 'colorkey=0x00B140:0.22:0.08', // il verde esatto di Lucianus: la maglia turchese resta
};

export const gameplayDir = (id: string) => join(PATHS.work, id, 'gameplay');
const KEEP = join(ROOT, 'data', 'gameplay');
/** Lavoro da tenere: `bun run clean --work` non lo tocca. */
export const keepDir = (id: string) => join(KEEP, id);
export const editPath = (id: string) => join(keepDir(id), 'edit.json');
/** Copia a 720p del video finale, fatta insieme all'export: per rivederlo quando gli originali non ci sono più. */
export const archivePath = (id: string) => join(projectDir(id), 'copia-720p.mp4');
export const posterPath = (id: string) => join(keepDir(id), 'copertina.jpg');
/** Anteprima: la registrazione originale si guarda così com'è, qui c'è solo l'audio già mixato. */
export const previewPath = (id: string) => join(gameplayDir(id), 'anteprima.m4a');
/** Anteprima video delle versioni di prima (720p): si cancella con il video finale. */
export const oldPreviewPath = (id: string) => join(gameplayDir(id), 'anteprima.mp4');
/** Voce e gioco mixati su tutta la registrazione (FLAC a −8 dB): da qui partono anteprima ed esportazione. */
export const mixPath = (id: string) => join(gameplayDir(id), 'mix.flac');
export const languagePath = (id: string) => join(gameplayDir(id), 'lingua.json');
export const youtubePath = (id: string) => join(keepDir(id), 'youtube.json');

export type GameplayStepName = 'analizza' | 'lingua' | 'anteprima' | 'esporta' | 'archivio' | 'tracce';

/** Spazio che occupa un passaggio del gameplay (stime dai pesi misurati in src/lib/space.ts). */
export function gameplaySpace(step: GameplayStepName, id: string, e: GameplayEdit | null, test?: { duration: number }): SpaceEstimate {
  if (!e || step === 'analizza') return estimate([]);
  const rates = exportRates();
  const fin = finalDuration(e);
  let mixReady = false;
  try {
    mixReady = existsSync(mixPath(id)) && readFileSync(`${mixPath(id)}.json`, 'utf8') === mixKey(e);
  } catch {}
  const mix = (temporary: boolean): SpaceItem[] => (mixReady ? [] : [{ label: 'mix di voce e gioco (FLAC)', bytes: RATE.mix * e.duration, temporary }]);
  switch (step) {
    case 'lingua':
      return estimate([{ label: 'voce a 16 kHz (temporanea)', bytes: RATE.voice16k * e.duration, temporary: true }]);
    case 'anteprima':
      return estimate([...mix(false), { label: 'audio dell’anteprima', bytes: RATE.preview * e.duration }]);
    case 'archivio':
      return estimate([{ label: 'copia a 720p', bytes: rates.archive * fin }]);
    case 'tracce':
      return estimate([{ label: 'gioco e voce separati', bytes: RATE.tracks * fin }]);
    case 'esporta':
      if (test) return estimate([...mix(false), { label: 'prova 4K', bytes: rates.final * test.duration }]);
      return estimate(
        [
          ...mix(true),
          { label: 'video finale 4K', bytes: rates.final * fin },
          { label: 'copia a 720p per rivedere', bytes: rates.archive * fin },
          { label: 'gioco e voce separati per gli short', bytes: RATE.tracks * fin },
        ],
        'a fine export si cancellano mix e audio dell’anteprima',
      );
  }
}

/** Gameplay di cui c'è del lavoro salvato, anche senza più i file. */
export function gameplayIds(): string[] {
  migrate();
  return existsSync(KEEP) ? readdirSync(KEEP).filter((d) => existsSync(join(KEEP, d, 'edit.json'))) : [];
}

/** Le versioni di prima tenevano tutto in work/: edit.json e youtube.json passano in data/gameplay/. */
function migrate(): void {
  if (!existsSync(PATHS.work)) return;
  for (const id of readdirSync(PATHS.work)) {
    for (const f of ['edit.json', 'youtube.json']) {
      const from = join(gameplayDir(id), f);
      const to = join(keepDir(id), f);
      if (existsSync(from) && !existsSync(to)) {
        mkdirSync(keepDir(id), { recursive: true });
        renameSync(from, to);
      }
    }
  }
}

/** Il titolo come nome di file: niente barre, due punti o caratteri di controllo. */
export const fileTitle = (title: string) =>
  title
    .replace(/[/\\:*?"<>|\p{Cc}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

export function exportPath(id: string, video: string, test = false, title?: string): string {
  const t = title ? fileTitle(title) : '';
  const name = t ? (test ? `${t} (prova)` : t) : `${basename(video, extname(video))}_${test ? 'prova' : 'finale'}`;
  return join(projectDir(id), `${name}.mp4`);
}

/** L'id del gameplay di cui questo è il video finale, se lo è. */
export function gameplayIdOf(video: string): string | null {
  const [id, ...rest] = relative(PATHS.out, video).split('/');
  if (!id || id === '..' || rest.length !== 1) return null;
  const e = readEdit(id);
  return e && exportPath(id, e.video, false, e.title) === video ? id : null;
}

/** La cartella di un video in out/ e work/: il video finale di un gameplay sta con la sua registrazione. */
export const projectId = (video: string): string => gameplayIdOf(video) ?? videoId(video);

/**
 * Gioco e voce separati del video finale (stessi tagli, AAC), accanto al video: la pipeline degli short li usa
 * al posto di Demucs, che dovrebbe separarli di nuovo dal mix (più spazio, più tempo, voce meno pulita).
 */
export const tracksPath = (finalVideo: string) => finalVideo.replace(/\.mp4$/i, '.tracce.m4a');

/**
 * La copia a 720p di un video finale (out/<id>/…), se c'è e dura quanto lui: chi analizza l'immagine a bassa
 * risoluzione (le scene degli short) la legge al posto del 4K.
 */
export function proxyFor(video: string, duration: number): string | null {
  const [id, ...rest] = relative(PATHS.out, video).split('/');
  if (!id || id === '..' || !rest.length) return null;
  const p = archivePath(id);
  if (!existsSync(p)) return null;
  const d = Number(Bun.spawnSync(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p]).stdout.toString());
  return Math.abs(d - duration) < 1 ? p : null;
}

/**
 * Per gli short di un video finale di gameplay: la registrazione originale (gioco senza Lucio stampato sopra),
 * il file di Lucianus e i tagli dell'export, se ci sono ancora. null per tutti gli altri video.
 */
export function gameplayOf(video: string): { edit: GameplayEdit; recording: string; lucianus: string | null; removed: [number, number][] } | null {
  const id = gameplayIdOf(video);
  const e = id ? readEdit(id) : null;
  if (!e || !existsSync(e.video)) return null;
  // Lucianus tolto dal video (si era bloccato): neanche gli short lo usano
  const lucianus = e.facecam === false ? null : e.lucianus && existsSync(e.lucianus) ? e.lucianus : lucianusFor(e.video);
  return { edit: e, recording: e.video, lucianus, removed: removedRanges(e) };
}

/** Pezzi della registrazione che corrispondono a [s, e] del video finale: un taglio dell'export in mezzo lo divide. */
export function finalToRecording(removed: [number, number][], s: number, e: number): { s: number; e: number }[] {
  const out: { s: number; e: number }[] = [];
  let at = 0; // inizio, nel video finale, del tratto tenuto che si sta guardando
  let from = 0;
  for (const [a, b] of [...removed, [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY] as [number, number]]) {
    const len = a - from;
    const lo = Math.max(s, at);
    const hi = Math.min(e, at + len);
    if (hi > lo) out.push({ s: from + (lo - at), e: from + (hi - at) });
    at += len;
    from = b;
    if (at >= e) break;
  }
  return out;
}

/** "Lucianus_<stesso nome>" nella stessa cartella della registrazione. */
export function lucianusFor(video: string): string | null {
  const p = join(dirname(video), `Lucianus_${basename(video)}`);
  return existsSync(p) ? p : null;
}

export function readEdit(id: string): GameplayEdit | null {
  const p = editPath(id);
  if (!existsSync(p)) migrate();
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as GameplayEdit) : null;
}

/**
 * Stato di partenza di una registrazione: senza tagli, o con quelli preparati a mano accanto al video
 * (<nome>_tagli.json). Lo crea la prima analisi, o il nome dato dalla dashboard prima di analizzare.
 */
export function newEdit(video: string, duration: number): GameplayEdit {
  let e: GameplayEdit = { video, lucianus: lucianusFor(video), duration, offsetMs: null, cuts: [], updated_at: new Date().toISOString() };
  const manual = join(dirname(video), `${basename(video, extname(video))}_tagli.json`);
  if (existsSync(manual)) {
    const t = JSON.parse(readFileSync(manual, 'utf8')) as { tagli: [number, number][] };
    e = replaceAuto(e, 'menu', t.tagli.filter(([a]) => a > 1).map(([start, end]) => ({ start, end })));
    e = replaceAuto(e, 'inizio', t.tagli.filter(([a]) => a <= 1).map(([start, end]) => ({ start, end })));
    // sono tagli decisi a mano: le analisi rifatte non li devono sostituire
    e = { ...e, cuts: e.cuts.map((c) => ({ ...c, edited: true })) };
    console.log(`Presi ${t.tagli.length} tagli da ${basename(manual)}.`);
  }
  return e;
}

export function writeEdit(id: string, e: GameplayEdit): GameplayEdit {
  mkdirSync(keepDir(id), { recursive: true });
  const clean: GameplayEdit = {
    ...e,
    cuts: e.cuts
      .map((c) => ({ ...c, start: Math.max(0, round(Math.min(c.start, c.end))), end: Math.min(e.duration, round(Math.max(c.start, c.end))) }))
      .filter((c) => c.end - c.start >= 0.2)
      .sort((a, b) => a.start - b.start),
    updated_at: new Date().toISOString(),
  };
  writeFileSync(editPath(id), `${JSON.stringify(clean, null, 2)}\n`);
  return clean;
}

const round = (s: number) => Math.round(s * 100) / 100;
export const cutId = () => crypto.randomUUID().slice(0, 8);

/** Sostituisce i tagli automatici di un motivo; quelli toccati a mano restano come sono. */
export function replaceAuto(e: GameplayEdit, reason: CutReason, found: { start: number; end: number; note?: string }[]): GameplayEdit {
  const kept = e.cuts.filter((c) => c.reason !== reason || c.edited);
  const fresh = found
    .filter((f) => !kept.some((k) => k.reason === reason && overlap(k, f) > 0))
    .map((f): Cut => ({ id: cutId(), start: f.start, end: f.end, reason, enabled: true, ...(f.note ? { note: f.note } : {}) }));
  return { ...e, cuts: [...kept, ...fresh] };
}

const overlap = (a: { start: number; end: number }, b: { start: number; end: number }) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));

/** Tratti tolti (tagli attivi uniti dove si sovrappongono). */
export function removedRanges(e: GameplayEdit): [number, number][] {
  const r = e.cuts
    .filter((c) => c.enabled)
    .map((c): [number, number] => [c.start, c.end])
    .sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [a, b] of r) {
    const last = out.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export const finalDuration = (e: GameplayEdit) => e.duration - removedRanges(e).reduce((t, [a, b]) => t + (b - a), 0);
