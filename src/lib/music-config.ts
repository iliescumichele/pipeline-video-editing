// Impostazioni della sostituzione delle canzoni protette: config/musica.json (vedi docs/musica.md).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './env';

export interface MusicConfig {
  /** false: la traccia del gioco resta quella originale anche se c'è il gioco senza canzoni */
  enabled: boolean;
  /** cartella della musica libera (relativa al progetto) */
  library: string;
  /** rilevamento: finestre ascoltate da Shazam, avanzamento della prima passata e di quella fine, pausa fra le richieste */
  windowS: number;
  coarseHopS: number;
  hopS: number;
  pauseS: number;
  /** finestre più silenziose di così (dBFS) non si mandano a Shazam */
  silenceDb: number;
  /** quante finestre devono riconoscere la stessa canzone per tenerla */
  minHits: number;
  /** sostituzione: dissolvenza ai bordi, margine della separazione, tetto dell'amplificazione, soglia di "musica assente" */
  fadeS: number;
  marginS: number;
  maxGainDb: number;
  musicSilenceDb: number;
}

export const DEFAULT_MUSIC: MusicConfig = {
  enabled: true,
  library: 'data/musica-libera',
  windowS: 12,
  coarseHopS: 24,
  hopS: 6,
  pauseS: 3,
  silenceDb: -50,
  minHits: 2,
  fadeS: 1.5,
  marginS: 6,
  maxGainDb: 12,
  musicSilenceDb: -65,
};

export const MUSIC_CONFIG_PATH = join(ROOT, 'config', 'musica.json');

export function readMusicConfig(): MusicConfig {
  if (!existsSync(MUSIC_CONFIG_PATH)) return DEFAULT_MUSIC;
  try {
    return { ...DEFAULT_MUSIC, ...(JSON.parse(readFileSync(MUSIC_CONFIG_PATH, 'utf8')) as Partial<MusicConfig>) };
  } catch {
    return DEFAULT_MUSIC;
  }
}

export const libraryDir = (c = readMusicConfig()) => join(ROOT, c.library);
