export type SignalName = 'markers' | 'lucio' | 'voice' | 'game' | 'scenes' | 'meaning';

/** Finestra candidata trovata da un segnale. score va da 0 a 1; peak è l'istante più forte. */
export interface Win {
  s: number;
  e: number;
  peak: number;
  score: number;
  label: string;
  why?: string;
  quote?: string;
}

export interface Signal {
  name: SignalName;
  available: boolean;
  /** perché il segnale manca (finisce nel report) */
  missing?: string;
  windows: Win[];
  /** serie nel tempo, JSON con { hop, ...valori } */
  seriesPath?: string;
  info?: Record<string, unknown>;
}

export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function median(xs: number[]): number {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return Number.NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}

/** z-score robusto (mediana e MAD) calcolato sui soli valori finiti; gli altri restano NaN. */
export function robustZ(xs: number[]): number[] {
  const med = median(xs);
  const mad = median(xs.map((x) => Math.abs(x - med))) * 1.4826 || 1e-6;
  return xs.map((x) => (Number.isFinite(x) ? (x - med) / mad : Number.NaN));
}

/** Mediana mobile centrata su `n` campioni (per misurare i picchi rispetto al contesto). */
export function rollingMedian(xs: number[], n: number): number[] {
  const half = n >> 1;
  return xs.map((_, i) => median(xs.slice(Math.max(0, i - half), i + half + 1)));
}

/**
 * Massimi locali sopra `thr`, tenendo il più alto in ogni intorno di `minSep` secondi.
 * `hop` è la distanza in secondi tra due campioni.
 */
export function peaks(xs: number[], hop: number, thr: number, minSep: number): { t: number; v: number }[] {
  const cand = xs
    .map((v, i) => ({ i, v }))
    .filter(({ i, v }) => v >= thr && Number.isFinite(v) && v >= (xs[i - 1] ?? -Infinity) && v >= (xs[i + 1] ?? -Infinity))
    .sort((a, b) => b.v - a.v);
  const kept: { i: number; v: number }[] = [];
  for (const c of cand) if (kept.every((k) => Math.abs(k.i - c.i) * hop >= minSep)) kept.push(c);
  return kept.sort((a, b) => a.i - b.i).map(({ i, v }) => ({ t: i * hop, v }));
}

/** Finestra attorno a un picco, dentro [0, dur]. */
export function around(t: number, before: number, after: number, dur: number): { s: number; e: number } {
  return { s: Math.max(0, t - before), e: Math.min(dur, t + after) };
}

/** Riduce una serie da `hop` secondi a 1 valore al secondo, tenendo il massimo. */
export function perSecond(xs: number[], hop: number): number[] {
  const k = Math.round(1 / hop);
  const out: number[] = [];
  for (let i = 0; i < xs.length; i += k) {
    const v = Math.max(...xs.slice(i, i + k).filter(Number.isFinite));
    out.push(Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);
  }
  return out;
}
