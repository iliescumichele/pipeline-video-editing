import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodeArgs, ffmpeg } from '../lib/ff';
import { loadPrompt, promptHash, runTask } from '../lib/llm';
import { route, toLlmTask } from '../lib/routing';
import { stage, stamp, type Ctx } from '../lib/stage';
import type { Candidate } from './candidates';
import type { Ingest } from './ingest';
import { mapLimit } from '../lib/pool';

export interface Box {
  kind: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Vision {
  id: string;
  frames: { start: string; peak: string; end: string; first7s: string; timeline: string };
  /** la griglia 4×3: istante del primo riquadro e passo tra i riquadri */
  timeline: { t0: number; step: number };
  what: string;
  graphic_violence_first7s: boolean;
  violence_note: string;
  cutscene: boolean;
  ingame_screen: boolean;
  standalone: boolean;
  standalone_why: string;
  overlays: Box[];
  action_x: number;
  wide_shot: boolean;
  webcam_tiles: number[];
  cutscene_tiles: number[];
  /** tratti di webcam a tutto schermo ricavati dai riquadri, in secondi del video */
  webcam: { s: number; e: number }[];
}

const VERSION = 2;
const TILES = 12;
const WIDTH = 768;

export async function vision(ctx: Ctx, ing: Ingest, cands: Candidate[]): Promise<Vision[]> {
  return stage(ctx, '05-vision', { VERSION, after: stamp(ctx, '04-candidates'), prompt: promptHash('vision'), route: await route('vision') }, async (dir) => {
    const r = await route('vision');
    const { system, schema } = await loadPrompt('vision');
    // con Claude 4 candidati alla volta; un modello locale li fa comunque uno dopo l'altro
    const out = await mapLimit(cands, r.provider === 'claude' ? 4 : 1, async (c): Promise<Vision> => {
      const t0 = performance.now();
      const { frames, timeline } = await extractFrames(ctx, ing, c);
      const input =
        `Clip ${c.id}: ${(c.e - c.s).toFixed(0)} s. Peak at ${(c.peak - c.s).toFixed(1)} s from the start.\n` +
        `Image 5 covers ${(timeline.t0 - c.s).toFixed(0)} s to ${(timeline.t0 + timeline.step * TILES - c.s).toFixed(0)} s relative to the clip start, one tile every ${timeline.step.toFixed(1)} s.\n\n` +
        `What the streamer says:\n${c.transcript || '(nothing)'}\n`;
      const v = await runTask<Omit<Vision, 'id' | 'frames' | 'timeline' | 'webcam'>>(
        join(ctx.workDir, 'llm', 'vision', c.id),
        toLlmTask(r, { think: false, temperature: 0.2, images: [frames.start, frames.peak, frames.end, frames.first7s, frames.timeline] }),
        system,
        input,
        schema,
      );
      // Ogni riquadro con la webcam copre mezzo passo prima e dopo il suo istante.
      const webcam = [...new Set(v.webcam_tiles)]
        .filter((k) => k >= 1 && k <= TILES)
        .map((k) => ({ s: timeline.t0 + (k - 1.5) * timeline.step, e: timeline.t0 + (k - 0.5) * timeline.step }));
      const flags = [v.graphic_violence_first7s && 'violenza nei primi 7 s', webcam.length && `webcam in ${webcam.length} riquadri`, v.cutscene && 'cutscene', v.ingame_screen && 'schermo nel gioco', !v.standalone && 'serve contesto', v.wide_shot && 'inquadratura larga']
        .filter(Boolean)
        .join(', ');
      console.log(`  ${c.id} (${((performance.now() - t0) / 1000).toFixed(0)} s) ${v.what.slice(0, 90)}${flags ? ` [${flags}]` : ''}`);
      return { id: c.id, frames, timeline, ...v, webcam };
    });
    await Bun.write(join(dir, 'vision.json'), JSON.stringify(out, null, 2));
    return out;
  });
}

/**
 * Frame di inizio, picco e fine (768 px), una griglia 2×2 dei secondi 1, 3, 5 e 7 e una griglia 4×3
 * su tutto il tratto (con 5 s prima e 10 s dopo, dove la classifica può spostare i confini).
 * Si rifanno solo se mancano.
 */
export async function extractFrames(ctx: Ctx, ing: Ingest, c: Candidate): Promise<{ frames: Vision['frames']; timeline: Vision['timeline'] }> {
  const dir = join(ctx.workDir, 'frames', `${c.id}-${c.s.toFixed(2)}`);
  mkdirSync(dir, { recursive: true });
  const frames = { start: join(dir, 'start.jpg'), peak: join(dir, 'peak.jpg'), end: join(dir, 'end.jpg'), first7s: join(dir, 'first7s.jpg'), timeline: join(dir, 'timeline.jpg') };
  const t0 = Math.max(0, c.s - 5);
  const span = Math.min(ing.main.duration, c.e + 10) - t0;
  const timeline = { t0, step: span / TILES };
  const dec = decodeArgs(ing.main);
  const at = { start: c.s + 0.1, peak: c.peak, end: Math.max(c.s, c.e - 0.2) };
  for (const [k, t] of Object.entries(at) as [keyof typeof at, number][]) {
    if (!existsSync(frames[k])) await ffmpeg([...dec, '-ss', t.toFixed(3), '-i', ctx.video, '-frames:v', '1', '-vf', `scale=${WIDTH}:-2`, '-q:v', '3', frames[k]]);
  }
  if (!existsSync(frames.first7s)) {
    const inputs = [1, 3, 5, 7].flatMap((d) => [...dec, '-ss', (c.s + d).toFixed(3), '-i', ctx.video]);
    const half = WIDTH / 2;
    await ffmpeg([
      ...inputs,
      '-filter_complex',
      `[0:v]scale=${half}:-2[a];[1:v]scale=${half}:-2[b];[2:v]scale=${half}:-2[c];[3:v]scale=${half}:-2[d];[a][b][c][d]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0`,
      '-frames:v', '1', '-q:v', '3', frames.first7s,
    ]);
  }
  if (!existsSync(frames.timeline)) {
    await ffmpeg([
      ...dec, '-ss', t0.toFixed(3), '-t', span.toFixed(3), '-i', ctx.video,
      '-vf', `fps=${TILES}/${span.toFixed(3)},scale=256:144,tile=4x3`, '-frames:v', '1', '-q:v', '3', frames.timeline,
    ]);
  }
  return { frames, timeline };
}


/** Un fotogramma al tempo `t` (secondi del video), largo `width` px. Non si rifà se esiste. */
export async function still(ctx: Ctx, ing: Ingest, t: number, out: string, width = WIDTH): Promise<string> {
  if (!existsSync(out)) await ffmpeg([...decodeArgs(ing.main), '-ss', t.toFixed(3), '-i', ctx.video, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '2', out]);
  return out;
}
