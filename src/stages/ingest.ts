import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ffmpeg, probe, type MediaInfo } from '../lib/ff';
import { py } from '../lib/py';
import { stage, type Ctx } from '../lib/stage';

export interface Ingest {
  main: MediaInfo;
  vertical?: MediaInfo;
  /** secondi del file principale in cui parte il verticale */
  verticalOffset?: number;
  verticalSync?: string;
  lucioLog?: string;
  /**
   * obs-4: mix, gioco, microfono, musica. gameplay: video finale del gameplay lungo con accanto <nome>.tracce.m4a
   * (gioco e voce separati). single: una sola traccia, voce separata con Demucs.
   */
  layout: 'obs-4' | 'gameplay' | 'single';
  voiceSource: string;
  gameSource: string;
  audio: {
    /** mix originale, 48 kHz stereo */
    mix48k: string;
    /** voce, 48 kHz mono: per il montaggio */
    voice48k: string;
    /** gioco senza voce, 48 kHz stereo: per il montaggio e i picchi del gioco */
    game48k: string;
    /** voce, 16 kHz mono: per la trascrizione */
    voice16k: string;
  };
  signals: { chapters: boolean; multitrack: boolean; vertical: boolean; lucioLog: boolean };
}

const VERSION = 1;
const F32_48K = ['-c:a', 'pcm_f32le', '-ar', '48000'];

export function ingest(ctx: Ctx): Promise<Ingest> {
  // il video finale di un gameplay lungo ha accanto gioco e voce separati (vedi tracksPath in src/gameplay/edit.ts)
  const tracks = ctx.video.replace(/\.mp4$/i, '.tracce.m4a');
  const hasTracks = tracks !== ctx.video && existsSync(tracks);
  const key = { VERSION, video: ctx.video, vertical: ctx.vertical, lucioLog: ctx.lucioLog, ...(hasTracks ? { tracks: statSync(tracks).mtimeMs } : {}) };
  return stage(ctx, '01-ingest', key, async (dir) => {
    const main = await probe(ctx.video);
    if (!main.video) throw new Error(`${ctx.video}: nessuna traccia video`);
    if (!main.audio.length) throw new Error(`${ctx.video}: nessuna traccia audio`);
    console.log(
      `  ${main.video.codec} ${main.video.width}×${main.video.height} ${main.video.fps.toFixed(2)} fps, ` +
        `${(main.duration / 60).toFixed(1)} min, ${main.audio.length} tracce audio, ${main.chapters.length} chapter`,
    );

    let vertical: MediaInfo | undefined;
    let verticalOffset: number | undefined;
    let verticalSync: string | undefined;
    if (ctx.vertical) {
      vertical = await probe(ctx.vertical);
      const v = vertical.video;
      if (!v) throw new Error(`${ctx.vertical}: nessuna traccia video`);
      if (v.width !== 1080 || v.height !== 1920) console.warn(`  attenzione: il verticale è ${v.width}×${v.height}, non 1080×1920`);
      ({ offset: verticalOffset, how: verticalSync } = await syncVertical(ctx, vertical, dir));
      console.log(`  verticale: ${verticalSync}`);
    }
    if (ctx.lucioLog && !existsSync(ctx.lucioLog)) throw new Error(`${ctx.lucioLog}: file non trovato`);

    const audio = {
      mix48k: join(dir, 'mix48k.wav'),
      voice48k: join(dir, 'voice48k.wav'),
      game48k: join(dir, 'game48k.wav'),
      voice16k: join(dir, 'voice16k.wav'),
    };
    const multitrack = main.audio.length >= 3;

    if (multitrack) {
      // Registrazione OBS: 1 mix, 2 gioco, 3 microfono pulito, 4 musica (non usata).
      await ffmpeg([
        '-i', ctx.video,
        '-map', '0:a:0', '-ac', '2', ...F32_48K, audio.mix48k,
        '-map', '0:a:1', '-ac', '2', ...F32_48K, audio.game48k,
        '-map', '0:a:2', '-ac', '1', ...F32_48K, audio.voice48k,
        '-map', '0:a:2', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audio.voice16k,
      ]);
    } else if (hasTracks) {
      // Video finale del gameplay: il mix è la sua traccia, gioco e voce vengono già separati dalla registrazione.
      await ffmpeg([
        '-i', ctx.video, '-i', tracks,
        '-map', '0:a:0', '-ac', '2', ...F32_48K, audio.mix48k,
        '-map', '1:a:0', '-ac', '2', ...F32_48K, audio.game48k,
        '-map', '1:a:1', '-ac', '1', ...F32_48K, audio.voice48k,
        '-map', '1:a:1', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audio.voice16k,
      ]);
    } else {
      // Una sola traccia: Demucs (htdemucs lavora a 44.1 kHz) separa la voce dal resto.
      const mix44k = join(dir, 'mix44k.wav');
      const sep = join(dir, 'demucs');
      await ffmpeg([
        '-i', ctx.video,
        '-map', '0:a:0', '-ac', '2', ...F32_48K, audio.mix48k,
        '-map', '0:a:0', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_f32le', mix44k,
      ]);
      await py('separate.py', [mix44k, sep]);
      await ffmpeg([
        '-i', join(sep, 'vocals.wav'),
        '-ac', '1', ...F32_48K, audio.voice48k,
        '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audio.voice16k,
      ]);
      await ffmpeg(['-i', join(sep, 'no_vocals.wav'), '-ac', '2', ...F32_48K, audio.game48k]);
      rmSync(mix44k);
      rmSync(sep, { recursive: true });
    }

    return {
      main,
      vertical,
      verticalOffset,
      verticalSync,
      lucioLog: ctx.lucioLog,
      layout: multitrack ? 'obs-4' : hasTracks ? 'gameplay' : 'single',
      voiceSource: multitrack ? 'traccia 3 (microfono)' : hasTracks ? 'microfono dalla registrazione (tracce.m4a)' : 'Demucs htdemucs (vocals) dalla traccia 1',
      gameSource: multitrack ? 'traccia 2 (gioco)' : hasTracks ? 'gioco dalla registrazione (tracce.m4a)' : 'Demucs htdemucs (no_vocals) dalla traccia 1',
      audio,
      signals: { chapters: main.chapters.length > 0, multitrack, vertical: !!vertical, lucioLog: !!ctx.lucioLog },
    } satisfies Ingest;
  });
}

/** Allinea il verticale al file principale confrontando i primi 120 s di audio (mix contro mix). */
async function syncVertical(ctx: Ctx, vertical: MediaInfo, dir: string): Promise<{ offset: number; how: string }> {
  if (!vertical.audio.length) return { offset: 0, how: 'nessun audio nel verticale: si assume che parta insieme al principale' };
  const a = join(dir, 'sync-main.wav');
  const b = join(dir, 'sync-vertical.wav');
  const pcm = ['-ac', '1', '-ar', '8000', '-t', '120', '-c:a', 'pcm_s16le'];
  await ffmpeg(['-i', ctx.video, '-map', '0:a:0', ...pcm, a]);
  await ffmpeg(['-i', ctx.vertical!, '-map', '0:a:0', ...pcm, b]);
  const r = JSON.parse(await py('syncoffset.py', [a, b], { capture: true })) as { offset: number; confidence: number };
  rmSync(a);
  rmSync(b);
  if (r.confidence < 0.2) return { offset: 0, how: `audio poco correlato (${r.confidence}): si assume che parta insieme al principale` };
  return { offset: r.offset, how: `parte a ${r.offset.toFixed(3)} s del principale (correlazione audio ${r.confidence})` };
}
