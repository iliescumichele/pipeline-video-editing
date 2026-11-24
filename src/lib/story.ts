// Uno short è una storia: uno o più pezzi della sorgente, in ordine, montati con tagli netti.
// Qui le conversioni tra il tempo della sorgente e quello dello short.

export interface Segment {
  /** secondi della sorgente */
  s: number;
  e: number;
}

export const storyDuration = (segs: Segment[]) => segs.reduce((t, x) => t + (x.e - x.s), 0);

/** Istante dello short che corrisponde a `t` della sorgente, o null se `t` è in un pezzo tagliato via. */
export function toShort(segs: Segment[], t: number): number | null {
  let at = 0;
  for (const x of segs) {
    if (t >= x.s && t < x.e) return at + (t - x.s);
    at += x.e - x.s;
  }
  return null;
}

/** Istante della sorgente che corrisponde a `u` dello short. */
export function toSource(segs: Segment[], u: number): number {
  let at = 0;
  for (const x of segs) {
    if (u < at + (x.e - x.s)) return x.s + (u - at);
    at += x.e - x.s;
  }
  const last = segs.at(-1);
  return last ? last.e : 0;
}

/** Istanti dello short in cui c'è un taglio tra due pezzi. */
export function cutsIn(segs: Segment[]): number[] {
  const out: number[] = [];
  let at = 0;
  for (const x of segs.slice(0, -1)) {
    at += x.e - x.s;
    out.push(at);
  }
  return out;
}

/** Quanto di [s, e] cade dentro i pezzi della storia. */
export const overlapStory = (segs: Segment[], s: number, e: number) => segs.reduce((a, x) => a + Math.max(0, Math.min(e, x.e) - Math.max(s, x.s)), 0);

/**
 * Argomenti di ffmpeg per leggere i pezzi di `file` come ingressi separati (-ss/-t, veloce anche se lontani tra
 * loro) e il filtro che li unisce: `[0:v][1:v]…concat` o la versione audio. `first` è l'indice del primo ingresso.
 */
export function segmentInputs(file: string, segs: Segment[], offset = 0): string[] {
  return segs.flatMap((x) => ['-ss', Math.max(0, x.s + offset).toFixed(3), '-t', (x.e - x.s).toFixed(3), '-i', file]);
}

export function concatFilter(n: number, first: number, kind: 'v' | 'a', out: string): string {
  const ins = Array.from({ length: n }, (_, i) => `[${first + i}:${kind}:0]`).join('');
  return `${ins}concat=n=${n}:v=${kind === 'v' ? 1 : 0}:a=${kind === 'a' ? 1 : 0}[${out}]`;
}
