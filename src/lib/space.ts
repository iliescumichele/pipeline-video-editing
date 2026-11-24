// Spazio su disco: quanto occupa un lavoro prima di partire, e lo stop se non c'è posto.
// I pesi sono misurati su una sessione vera (2:45 di registrazione 4K, 2:37 di video finale, 20/11/2026):
// cambiano poco da una sessione all'altra perché dipendono dai bitrate fissati nella pipeline. Video finale e
// copia per rivedere invece seguono config/export.json (vedi exportRates).
import { ROOT } from './env';
import { bytesPerSecond, readExport } from './export-settings';

/** Video finale e copia per rivedere, con i bitrate scelti nella dashboard. */
export function exportRates() {
  const s = readExport();
  return { final: bytesPerSecond(s.final.videoMbps, s.final.audioKbps), archive: bytesPerSecond(s.review.videoMbps, s.review.audioKbps) };
}

/** Byte al secondo di ogni file, misurati. */
export const RATE = {
  /** gioco e voce separati per gli short (AAC 256k) */
  tracks: 65_000,
  /** mix di voce e gioco (FLAC 24 bit), sulla durata della registrazione */
  mix: 161_500,
  /** audio dell'anteprima (AAC 160k), sulla durata della registrazione */
  preview: 20_200,
  /** voce a 16 kHz per il riconoscimento della lingua */
  voice16k: 32_000,
  /** WAV della fase di ingest degli short: mix, gioco, voce a 48 kHz float e voce a 16 kHz */
  shortsIngest: 990_000,
  /** in più, solo senza tracce separate: mix a 44,1 kHz e le due tracce di Demucs */
  demucs: 1_060_000,
} as const;

/** Margine da lasciare sempre libero: sotto qualche GB macOS e le app aperte cominciano a soffrire. */
export const MARGIN = 3e9;

export interface SpaceItem {
  label: string;
  bytes: number;
  /** temporaneo: si cancella a fine lavoro */
  temporary?: boolean;
}

export interface SpaceEstimate {
  /** null: non si può stimare prima (download, montaggi) */
  items: SpaceItem[] | null;
  /** picco di spazio occupato durante il lavoro */
  peak: number;
  /** quanto resta occupato alla fine */
  kept: number;
  note?: string;
}

export const estimate = (items: SpaceItem[] | null, note?: string): SpaceEstimate => ({
  items,
  peak: items ? items.reduce((t, i) => t + i.bytes, 0) : 0,
  kept: items ? items.filter((i) => !i.temporary).reduce((t, i) => t + i.bytes, 0) : 0,
  note,
});

/**
 * Short da un video: i WAV della fase di ingest (si saltano se è già fatta), Demucs se non ci sono tracce
 * separate, e i file degli short (8 short da ~60 MB, più trascrizione e fasi intermedie).
 */
export function shortsSpace(o: { duration: number; ingestDone: boolean; separate: boolean }): SpaceEstimate {
  const items: SpaceItem[] = [];
  if (!o.ingestDone) {
    items.push({ label: 'audio della fase di ingest (WAV, resta in work/ finché non lo pulisci)', bytes: RATE.shortsIngest * o.duration });
    if (!o.separate) items.push({ label: 'separazione della voce con Demucs (temporanea)', bytes: RATE.demucs * o.duration, temporary: true });
  }
  items.push({ label: 'short e fasi intermedie', bytes: 1e9 });
  return estimate(items, o.separate || o.ingestDone ? undefined : 'senza tracce separate la voce si separa con Demucs: prepara gioco e voce per gli short per risparmiare spazio');
}

/** Spazio libero sul disco del progetto (dove finiscono work/, out/ e data/). */
export function freeBytes(): number {
  const out = Bun.spawnSync(['df', '-k', ROOT]).stdout.toString().split('\n')[1]?.split(/\s+/);
  return out ? Number(out[3]) * 1024 : 0;
}

export const gbText = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1).replace('.', ',')} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);

/**
 * Prima di un lavoro pesante: se non c'è posto si ferma subito con un messaggio chiaro, invece di riempire
 * il disco a metà strada. Vale anche per i lavori rimasti in coda mentre lo spazio cambiava.
 */
export function checkSpace(e: SpaceEstimate, what: string): void {
  const free = freeBytes();
  console.log(`Spazio: ${what} occupa circa ${gbText(e.peak)}${e.peak !== e.kept ? ` durante il lavoro (${gbText(e.kept)} alla fine)` : ''}; liberi ${gbText(free)}.`);
  if (e.peak + MARGIN > free) {
    throw new Error(
      `spazio insufficiente: servono circa ${gbText(e.peak)} più ${gbText(MARGIN)} di margine, liberi ${gbText(free)}. ` +
        'Libera spazio (o sposta registrazioni su un disco esterno) e rilancia.',
    );
  }
}
