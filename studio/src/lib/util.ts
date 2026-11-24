export const gb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
export const mins = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : `${s.toFixed(1)} s`);
/** Orario nel video: 2:28 (anche sotto il minuto, per leggere i tempi tutti allo stesso modo). */
export const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
export const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
export const pct = (x?: number | null) => (x == null ? '—' : `${Math.round(x * 100)}%`);

export const TASK_NAMES: Record<string, string> = {
  meaning: 'Senso della trascrizione',
  vision: 'Controllo visivo',
  rank: 'Classifica',
  copy: 'Testi degli short',
  news_triage: 'Smistamento notizie',
  news_script: 'Script delle notizie',
  news_factcheck: 'Controllo dei fatti (notizie)',
  media: 'Etichette dei video ufficiali',
  judge: 'Giudice del banco di prova',
  youtube: 'Titolo e miniatura del gameplay',
};

/** Orario lungo: 1:05:09 (o 5:09 sotto l'ora). */
export const hms = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};

/** "1:05:09", "5:09", "309" o "309.5" → secondi; null se non si legge. */
export const parseHms = (t: string): number | null => {
  const parts = t.trim().split(':').map(Number);
  if (!parts.length || parts.some((n) => Number.isNaN(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
};
