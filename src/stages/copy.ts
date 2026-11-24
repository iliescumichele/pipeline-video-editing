import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib/env';
import { loadPrompt, promptHash, runTask } from '../lib/llm';
import { route, toLlmTask } from '../lib/routing';
import type { SignalName } from '../lib/signal';
import { stage, stamp, type Ctx } from '../lib/stage';
import { loadTranscript, type Transcript } from '../lib/transcript';
import { WEIGHTS } from './candidates';
import type { Ingest } from './ingest';
import type { Pick } from './rank';
import type { Signals } from './signals';
import type { TranscribeResult } from './transcribe';
import { still, type Vision } from './vision';
import { mapLimit } from '../lib/pool';
import { cutsIn, type Segment, storyDuration, toShort } from '../lib/story';

export interface PlatformCopy {
  title: string;
  description: string;
  hashtags: string[];
}

export interface Copy {
  hook: string;
  youtube: PlatformCopy;
  instagram: PlatformCopy;
  tiktok: PlatformCopy;
  score: number;
  score_reason: string;
}

export interface Short extends Pick {
  /** istante più forte dentro lo short (miniatura e zoom), in secondi del video */
  peak: number;
  frames: { start: string; peak: string; end: string };
  copy: Copy;
}

const VERSION = 1;

export async function copy(ctx: Ctx, ing: Ingest, tr: TranscribeResult, sig: Signals, picks: Pick[], vis: Vision[]): Promise<Short[]> {
  const guide = await Bun.file(join(ROOT, 'style', 'CHANNEL.md')).text();
  const r = await route('copy');
  const key = { VERSION, after: stamp(ctx, '06-rank'), prompt: promptHash('copy'), guide: Bun.hash(guide).toString(), route: r };
  return stage(ctx, '07-copy', key, async (dir) => {
    // short nuovi: i ganci corretti e gli scarti della dashboard valevano per quelli di prima
    rmSync(join(ctx.workDir, 'overrides.json'), { force: true });
    const t = await loadTranscript(tr.path);
    const { system, schema } = await loadPrompt('copy');
    const fullSystem = `${system}\n\n---\n\n# Channel voice guide\n\n${guide}`;
    // con Claude 4 short alla volta; un modello locale li fa comunque uno dopo l'altro
    const out = await mapLimit(picks, r.provider === 'claude' ? 4 : 1, async (p): Promise<Short> => {
      const peak = strongestPeak(sig, p);
      const fdir = join(ctx.workDir, 'frames', `${p.id}-${p.s.toFixed(2)}-${p.e.toFixed(2)}`);
      mkdirSync(fdir, { recursive: true });
      const frames = {
        start: await still(ctx, ing, p.s + 0.1, join(fdir, 'start.jpg')),
        peak: await still(ctx, ing, peak, join(fdir, 'peak.jpg')),
        end: await still(ctx, ing, p.e - 0.2, join(fdir, 'end.jpg')),
      };
      const v = vis.find((x) => x.id === p.candidate);
      const at = (x: number) => (toShort(p.segments, x) ?? 0).toFixed(1);
      const parts = p.segments.length > 1 ? ` in ${p.segments.length} parts cut together (cuts at ${cutsIn(p.segments).map((x) => `${x.toFixed(1)} s`).join(', ')})` : '';
      const input = [
        `Short ${p.id}: ${storyDuration(p.segments).toFixed(1)} s${parts}. The turn is at ${at(p.turn)} s, the peak at ${at(peak)} s.`,
        v ? `On screen: ${v.what}` : '',
        `Why the editor picked it: ${p.reason}`,
        `Transcript (seconds from the start of the short, language: ${t.language}):\n${relativeText(t, p.segments)}`,
      ]
        .filter(Boolean)
        .join('\n\n');
      const t0 = performance.now();
      const c = await runTask<Copy>(
        join(ctx.workDir, 'llm', 'copy', p.id),
        toLlmTask(r, { images: [frames.start, frames.peak, frames.end], timeout_s: 300, think: false, temperature: 0.7 }),
        fullSystem,
        `${input}\n`,
        schema,
      );
      console.log(`  ${p.id} (${((performance.now() - t0) / 1000).toFixed(0)} s) "${c.hook}" — ${c.score}/10`);
      return { ...p, peak, frames, copy: c };
    });
    await Bun.write(join(dir, 'shorts.json'), JSON.stringify(out, null, 2));
    return out;
  });
}

/** Il picco più forte dentro lo short (voce, gioco, Lucio, marker), altrimenti 2 s dopo la svolta. */
/** Il picco più forte dentro i pezzi della storia (lontano un secondo dai tagli); se non c'è, poco dopo la svolta. */
function strongestPeak(sig: Signals, p: Pick): number {
  const fallback = toShort(p.segments, p.turn + 2) !== null ? p.turn + 2 : p.turn;
  let best = { t: fallback, v: 0 };
  for (const n of ['voice', 'game', 'lucio', 'markers'] as SignalName[]) {
    for (const w of sig[n].windows) {
      const v = WEIGHTS[n] * w.score;
      const inside = p.segments.some((x) => w.peak > x.s + 1 && w.peak < x.e - 1);
      if (inside && v > best.v) best = { t: w.peak, v };
    }
  }
  return best.t;
}

/** Frasi dello short con l'orario relativo all'inizio dello short, pezzo per pezzo; [CUT] tra un pezzo e l'altro. */
function relativeText(t: Transcript, segs: Segment[]): string {
  return segs
    .map((seg) =>
      t.sentences
        .filter((x) => x.e > seg.s && x.s < seg.e)
        .map((x) => {
          const words = t.words.slice(x.i0, x.i1).filter((w) => w.s >= seg.s - 0.05 && w.s < seg.e);
          return words.length ? `[${(toShort(segs, Math.max(seg.s, words[0]!.s)) ?? 0).toFixed(1)}] ${words.map((w) => w.w).join(' ')}` : '';
        })
        .filter(Boolean)
        .join('\n') || '(no speech)',
    )
    .join('\n[CUT]\n');
}
