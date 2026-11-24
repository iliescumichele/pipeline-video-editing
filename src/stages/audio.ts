import { join } from 'node:path';
import { DEFAULT_MIX, mixOf, readEdit } from '../gameplay/edit';
import { exec, FFMPEG, ffmpeg } from '../lib/ff';
import { VOICE_OUT_LUFS, voiceGraph } from '../lib/voice-eq';
import { stage, stamp, type Ctx } from '../lib/stage';
import { type Segment, segmentInputs, storyDuration } from '../lib/story';
import type { Short } from './copy';
import type { Ingest } from './ingest';
import type { Rendered } from './render';

export interface Mixed {
  id: string;
  mp4: string;
  gameGainDb: number;
  /** misure finali sul file .mp4 (dopo l'AAC) */
  lufs: number;
  truePeak: number;
  targetTp: number;
}

const VERSION = 6;

/** I pezzi della storia da un WAV, uniti, con 8 ms di dissolvenza ai tagli perché non facciano clic. */
async function storyWav(wav: string, segs: Segment[], out: string): Promise<string> {
  const f = 0.008;
  const parts = segs.map((x, i) => `[${i}:a:0]afade=t=in:d=${f},afade=t=out:st=${(x.e - x.s - f).toFixed(3)}:d=${f}[p${i}]`);
  const join_ = `${segs.map((_, i) => `[p${i}]`).join('')}concat=n=${segs.length}:v=0:a=1[o]`;
  await ffmpeg([...segmentInputs(wav, segs), '-filter_complex', [...parts, join_].join(';'), '-map', '[o]', '-c:a', 'pcm_f32le', '-ar', '48000', out]);
  return out;
}
const TARGET_I = -14;
const TARGET_TP = -1;
/** Il gioco sta almeno 12 LU sotto la voce (già passata dalla sua catena) prima del ducking. */
const GAME_BELOW_VOICE = 12;

export function audio(ctx: Ctx, ing: Ingest, shorts: Short[], rendered: Rendered[]): Promise<Mixed[]> {
  // "Voce più chiara" come nel gameplay di questo video (stesso id), se lo è; altrimenti quella di sempre
  const edit = readEdit(ctx.id);
  const clear = edit ? mixOf(edit).clear : DEFAULT_MIX.clear;
  // anche il tipo di voce scelto nel gameplay (equalizzazione e compressione)
  const eq = edit ? mixOf(edit).eq : DEFAULT_MIX.eq;
  if (!clear) console.log('  voce senza equalizzazione (scelta nel gameplay)');
  else if (eq && eq !== 'chiara') console.log(`  voce: tipo "${eq}" (scelto nel gameplay)`);
  return stage(ctx, '09-audio', { VERSION, after: stamp(ctx, '08-render'), clear, ...(eq && eq !== 'chiara' ? { eq } : {}) }, async (dir) => {
    const out: Mixed[] = [];
    for (const sh of shorts) {
      const r = rendered.find((x) => x.id === sh.id);
      if (!r) continue;
      const dur = storyDuration(sh.segments);
      const voiceWav = await storyWav(ing.audio.voice48k, sh.segments, join(dir, `${sh.id}.voice.wav`));
      const gameWav = await storyWav(ing.audio.game48k, sh.segments, join(dir, `${sh.id}.game.wav`));

      // Livelli di partenza del pezzo: servono a mettere il gioco sotto la voce.
      const iv = (await loudness(['-i', voiceWav])).i;
      const ig = (await loudness(['-i', gameWav])).i;
      const gameGainDb = Number.isFinite(ig) ? clamp(VOICE_OUT_LUFS - GAME_BELOW_VOICE - ig, -30, 6) : 0;

      // Voce: la catena di src/lib/voice-eq.ts (parte da iv, esce a VOICE_OUT_LUFS; afftdn perché DeepFilterNet non si installa),
      // poi copiata uguale sui due canali (aformat=stereo la abbasserebbe di 3 dB per canale).
      // Gioco: guadagno, poi ducking con la voce come chiave. Dissolvenze minime agli estremi per il loop.
      const mix = join(dir, `${sh.id}.mix.wav`);
      await ffmpeg([
        ...['-i', voiceWav], ...['-i', gameWav],
        '-filter_complex',
        [
          `${voiceGraph('[0:a]', 'voce', iv, clear, 1, eq)};[voce]pan=stereo|c0=c0|c1=c0,asplit=2[v][key]`,
          `[1:a]volume=${gameGainDb.toFixed(2)}dB,aformat=channel_layouts=stereo[g0]`,
          '[g0][key]sidechaincompress=threshold=0.03:ratio=5:attack=20:release=400[g]',
          `[v][g]amix=inputs=2:normalize=0:duration=first,afade=t=in:d=0.03,afade=t=out:st=${(dur - 0.25).toFixed(3)}:d=0.25[m]`,
        ].join(';'),
        '-map', '[m]', '-c:a', 'pcm_f32le', '-ar', '48000', mix,
      ]);

      // loudnorm in due passate, poi AAC. Se dopo l'AAC il true peak supera −1 dBTP si rifà con più margine.
      let mixed: Mixed | undefined;
      for (const targetTp of [-1.5, -2.2, -3]) {
        const m = await loudnormMeasure(mix, targetTp);
        const norm = join(dir, `${sh.id}.norm.wav`);
        await ffmpeg([
          '-i', mix,
          '-af', `loudnorm=I=${TARGET_I}:TP=${targetTp}:LRA=11:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`,
          '-c:a', 'pcm_f32le', '-ar', '48000', norm,
        ]);
        const mp4 = join(dir, `${sh.id}.mp4`);
        await ffmpeg([
          '-i', r.video, '-i', norm, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy',
          '-c:a', 'aac', '-b:a', '320k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', '-shortest', mp4,
        ]);
        const fin = await loudness(['-i', mp4]);
        mixed = { id: sh.id, mp4, gameGainDb: Math.round(gameGainDb * 10) / 10, lufs: fin.i, truePeak: fin.tp, targetTp };
        if (fin.tp <= TARGET_TP && Math.abs(fin.i - TARGET_I) <= 0.5) break;
      }
      console.log(`  ${sh.id} gioco ${mixed!.gameGainDb >= 0 ? '+' : ''}${mixed!.gameGainDb} dB, finale ${mixed!.lufs} LUFS, ${mixed!.truePeak} dBTP`);
      out.push(mixed!);
    }
    return out;
  });
}

/** Loudness integrata e true peak con ebur128 (gli argomenti sono quelli di ingresso a ffmpeg). */
export async function loudness(input: string[]): Promise<{ i: number; tp: number }> {
  const log = await exec([FFMPEG, '-hide_banner', '-nostdin', '-nostats', ...input, '-map', '0:a:0', '-af', 'ebur128=peak=true', '-f', 'null', '-'], true);
  const summary = log.slice(log.lastIndexOf('Summary:'));
  const i = Number(summary.match(/I:\s+(-?[\d.]+|-inf)\s+LUFS/)?.[1]);
  const tp = Number(summary.match(/True peak:\s+Peak:\s+(-?[\d.]+|-inf)\s+dBFS/)?.[1]);
  return { i: Number.isFinite(i) ? i : Number.NEGATIVE_INFINITY, tp: Number.isFinite(tp) ? tp : Number.NEGATIVE_INFINITY };
}

async function loudnormMeasure(wav: string, tp: number): Promise<Record<string, string>> {
  const log = await exec([FFMPEG, '-hide_banner', '-nostdin', '-nostats', '-i', wav, '-af', `loudnorm=I=${TARGET_I}:TP=${tp}:LRA=11:print_format=json`, '-f', 'null', '-'], true);
  const json = log.slice(log.lastIndexOf('{'), log.lastIndexOf('}') + 1);
  return JSON.parse(json);
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
