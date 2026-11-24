import { join } from 'node:path';
import { readModels, ROOT } from '../lib/env';
import { py } from '../lib/py';
import { stage, stamp, type Ctx } from '../lib/stage';
import { detectLanguage, norm, timedText, toSentences, type Transcript, type Word } from '../lib/transcript';
import type { Ingest } from './ingest';

export interface TranscribeResult {
  path: string;
  textPath: string;
  language: Transcript['language'];
  words: number;
  corrections: number;
}

const VERSION = 2;

export async function transcribe(ctx: Ctx, ing: Ingest): Promise<TranscribeResult> {
  const vocabText = await Bun.file(join(ROOT, 'vocab.json')).text();
  return stage(ctx, '02-transcribe', { VERSION, after: stamp(ctx, '01-ingest'), vocab: Bun.hash(vocabText).toString() }, async (dir) => {
    const models = await readModels();
    const raw = join(dir, 'words.raw.json');
    await py('transcribe.py', [ing.audio.voice16k, join(ROOT, models.parakeet!.dir), raw]);

    const asr = (await Bun.file(raw).json()) as { duration: number; words: Word[] };
    const vocab = JSON.parse(vocabText) as { names: Record<string, string[]> };
    const { words, corrections } = applyVocab(asr.words, vocab.names);
    const t: Transcript = {
      language: detectLanguage(words),
      duration: asr.duration,
      words,
      sentences: toSentences(words),
      corrections,
    };

    const path = join(dir, 'transcript.json');
    const textPath = join(dir, 'transcript.txt');
    await Bun.write(path, JSON.stringify(t));
    await Bun.write(textPath, `${timedText(t)}\n`);
    console.log(`  ${words.length} parole, lingua ${t.language}, ${corrections.length} correzioni dal vocabolario`);
    for (const c of corrections.slice(0, 10)) console.log(`    ${c.at.toFixed(1)} s: "${c.from}" → "${c.to}"`);
    return { path, textPath, language: t.language, words: words.length, corrections: corrections.length };
  });
}

/**
 * Corregge i nomi con vocab.json: varianti esplicite (anche di più parole), maiuscole delle forme
 * corrette e, per i nomi di una parola lunghi almeno 6 lettere, parole a distanza di modifica 1.
 */
export function applyVocab(input: Word[], names: Record<string, string[]>) {
  const table = new Map<string, string>();
  for (const [canon, variants] of Object.entries(names)) {
    for (const v of [canon, ...variants]) table.set(v.split(/\s+/).map(norm).join(' '), canon);
  }
  const maxN = Math.max(...[...table.keys()].map((k) => k.split(' ').length));
  const fuzzy = Object.keys(names).filter((n) => !n.includes(' ') && n.length >= 6);

  const words: Word[] = [];
  const corrections: Transcript['corrections'] = [];
  for (let i = 0; i < input.length; ) {
    let matched = false;
    for (let n = Math.min(maxN, input.length - i); n >= 1 && !matched; n--) {
      const span = input.slice(i, i + n);
      const canon = table.get(span.map((x) => norm(x.w)).join(' '));
      if (!canon) continue;
      const from = span.map((x) => x.w).join(' ');
      const trail = span.at(-1)!.w.match(/[^\p{L}\p{N}]+$/u)?.[0] ?? '';
      const lead = span[0]!.w.match(/^[^\p{L}\p{N}]+/u)?.[0] ?? '';
      const to = `${lead}${canon}${trail}`;
      words.push({ w: to, s: span[0]!.s, e: span.at(-1)!.e, c: Math.min(...span.map((x) => x.c)) });
      if (to !== from) corrections.push({ at: span[0]!.s, from, to });
      i += n;
      matched = true;
    }
    if (matched) continue;

    const w = input[i]!;
    const k = norm(w.w);
    const near = k.length >= 6 ? fuzzy.find((f) => f[0]!.toLowerCase() === k[0] && editDistance(f.toLowerCase(), k) === 1) : undefined;
    if (near) {
      const to = w.w.replace(/[\p{L}\p{N}'’]+/u, near);
      words.push({ ...w, w: to });
      corrections.push({ at: w.s, from: w.w, to });
    } else {
      words.push(w);
    }
    i++;
  }
  return { words, corrections };
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length]!;
}

