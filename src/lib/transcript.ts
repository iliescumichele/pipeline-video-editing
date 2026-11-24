/** Parola trascritta: testo, inizio e fine in secondi dall'inizio del video, confidenza 0–1. */
export interface Word {
  w: string;
  s: number;
  e: number;
  c: number;
}

export interface Sentence {
  s: number;
  e: number;
  /** indici delle parole: [i0, i1) */
  i0: number;
  i1: number;
  text: string;
}

export interface Transcript {
  language: 'it' | 'en' | 'other';
  duration: number;
  words: Word[];
  sentences: Sentence[];
  corrections: { at: number; from: string; to: string }[];
}

export async function loadTranscript(path: string): Promise<Transcript> {
  return Bun.file(path).json();
}

/** Parole che iniziano dentro [s, e). */
export function wordsIn(t: Transcript, s: number, e: number): Word[] {
  return t.words.filter((w) => w.s >= s && w.s < e);
}

/** Testo con inizio e fine di ogni frase, in secondi: "[312.4-318.0] testo". È il formato che leggono i modelli. */
export function timedText(t: Transcript, s = 0, e = Number.POSITIVE_INFINITY): string {
  return t.sentences
    .filter((x) => x.e > s && x.s < e)
    .map((x) => `[${x.s.toFixed(1)}-${x.e.toFixed(1)}] ${x.text}`)
    .join('\n');
}

/** Frasi: si chiude su . ? ! oppure dopo una pausa di almeno 1 s, o dopo 30 parole. */
export function toSentences(words: Word[]): Sentence[] {
  const out: Sentence[] = [];
  let i0 = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const next = words[i + 1];
    const end = /[.?!…]$/.test(w.w) || !next || next.s - w.e >= 1 || i + 1 - i0 >= 30;
    if (!end) continue;
    const slice = words.slice(i0, i + 1);
    out.push({ s: slice[0]!.s, e: w.e, i0, i1: i + 1, text: slice.map((x) => x.w).join(' ') });
    i0 = i + 1;
  }
  return out;
}

const STOP = {
  it: new Set(['che', 'non', 'di', 'è', 'il', 'la', 'una', 'per', 'sono', 'ho', 'ma', 'questo', 'questa', 'ragazzi', 'perché', 'come', 'anche', 'mi', 'ci', 'del', 'della', 'sta', 'cosa']),
  en: new Set(['the', 'and', 'is', 'you', 'it', 'that', 'this', 'what', 'to', 'of', 'we', 'my', 'just', 'like', 'was', 'are', 'he', 'they', 'with', 'have', "i'm", "it's", 'bro']),
};

export function detectLanguage(words: Word[]): Transcript['language'] {
  let it = 0;
  let en = 0;
  for (const { w } of words) {
    const k = norm(w);
    if (STOP.it.has(k)) it++;
    if (STOP.en.has(k)) en++;
  }
  if (it + en < 10) return 'other';
  return it > en * 2 ? 'it' : en > it * 2 ? 'en' : 'other';
}

/** minuscolo, senza punteggiatura ai bordi (gli apostrofi interni restano). */
export function norm(w: string): string {
  return w
    .normalize('NFC')
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}
