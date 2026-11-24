// Ritaglio del file di Lucianus prima dello scontorno del verde. Di base si tolgono solo i bordi della finestra
// catturata; se il file ha bande nere sopra e sotto (il 23/11 l'immagine utile era la fascia centrale 1080×648 di
// un 1080×1296), l'analisi del gameplay le trova e le toglie. Nessun import: lo usano ffmpeg e il browser.

/** Quanto togliere da ogni lato, in frazioni del lato del file di Lucianus. */
export interface LucianusCrop {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** Dimensioni dei file di Lucianus (sempre 1080×1296 finora): servono alle proporzioni nel browser. */
export const LUCIANUS_SIZE = { w: 1080, h: 1296 };

/** Di base: i bordi della finestra catturata (12 px ai lati, 6 sopra, 12 sotto sul 1080×1296). */
export const DEFAULT_CROP: LucianusCrop = { left: 12 / 1080, right: 12 / 1080, top: 6 / 1296, bottom: 12 / 1296 };
/** Lo stesso ritaglio di base come argomenti di crop di ffmpeg (quelli di sempre: niente cambia nei video già fatti). */
export const DEFAULT_CROP_FFMPEG = 'iw-24:ih-18:12:6';

export const cropOf = (c: LucianusCrop | undefined): LucianusCrop => c ?? DEFAULT_CROP;

/** Il filtro crop di ffmpeg. */
export const cropFilter = (c: LucianusCrop | undefined): string => {
  if (!c) return `crop=${DEFAULT_CROP_FFMPEG}`;
  const f = (n: number) => n.toFixed(5);
  return `crop=iw*${f(1 - c.left - c.right)}:ih*${f(1 - c.top - c.bottom)}:iw*${f(c.left)}:ih*${f(c.top)}`;
};

/** Larghezza / altezza di Lucianus dopo il ritaglio. */
export const cropAspect = (c: LucianusCrop | undefined): number => {
  const k = cropOf(c);
  return (LUCIANUS_SIZE.w * (1 - k.left - k.right)) / (LUCIANUS_SIZE.h * (1 - k.top - k.bottom));
};

/**
 * Di quanto cambia l'altezza dell'immagine rispetto al ritaglio di base: moltiplicando l'altezza di Lucianus per
 * questo numero, i personaggi restano grandi come prima anche se il ritaglio toglie le bande nere.
 */
export const cropScale = (c: LucianusCrop | undefined): number => (1 - cropOf(c).top - cropOf(c).bottom) / (1 - DEFAULT_CROP.top - DEFAULT_CROP.bottom);
