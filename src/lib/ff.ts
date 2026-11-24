import { dirname, join } from 'node:path';

/** ffmpeg e ffprobe di sistema (Homebrew). FFMPEG_PATH sposta entrambi: ffprobe si cerca accanto. */
export const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH ?? (process.env.FFMPEG_PATH ? join(dirname(process.env.FFMPEG_PATH), 'ffprobe') : 'ffprobe');

export interface VideoStream {
  index: number;
  codec: string;
  width: number;
  height: number;
  fps: number;
  pixFmt?: string;
}

export interface AudioStream {
  index: number;
  /** posizione tra le tracce audio: 0 = prima traccia (a:0) */
  order: number;
  codec: string;
  channels: number;
  sampleRate: number;
  title?: string;
}

export interface Chapter {
  start: number;
  end: number;
  title: string;
}

export interface MediaInfo {
  path: string;
  duration: number;
  video?: VideoStream;
  audio: AudioStream[];
  chapters: Chapter[];
  creationTime?: string;
}

export async function probe(path: string): Promise<MediaInfo> {
  const out = await exec([FFPROBE, '-v', 'error', '-show_format', '-show_streams', '-show_chapters', '-of', 'json', path]);
  const d = JSON.parse(out) as {
    format: { duration?: string; tags?: Record<string, string> };
    streams: Record<string, any>[];
    chapters?: { start_time: string; end_time: string; tags?: { title?: string } }[];
  };
  const v = d.streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = d.streams
    .filter((s) => s.codec_type === 'audio')
    .map((s, order) => ({
      index: s.index as number,
      order,
      codec: s.codec_name as string,
      channels: s.channels as number,
      sampleRate: Number(s.sample_rate),
      title: (s.tags?.title ?? s.tags?.handler_name) as string | undefined,
    }));
  return {
    path,
    duration: Number(d.format.duration ?? v?.duration ?? 0),
    video: v && {
      index: v.index,
      codec: v.codec_name,
      width: v.width,
      height: v.height,
      fps: parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate),
      pixFmt: v.pix_fmt,
    },
    audio,
    chapters: (d.chapters ?? []).map((c, i) => ({ start: Number(c.start_time), end: Number(c.end_time), title: c.tags?.title ?? `Chapter ${i + 1}` })),
    creationTime: d.format.tags?.creation_time,
  };
}

function parseRate(r?: string): number {
  if (!r) return 0;
  const [n, den] = r.split('/').map(Number);
  return den ? n! / den : n ?? 0;
}

/**
 * Argomenti di decodifica da mettere prima di `-i`. HEVC e H.264 (le registrazioni OBS) vanno in
 * hardware con VideoToolbox; l'AV1 resta su dav1d, che su M4 Max è più veloce (37× contro 7×).
 */
export function decodeArgs(info: MediaInfo): string[] {
  return info.video && ['hevc', 'h264', 'prores'].includes(info.video.codec) ? ['-hwaccel', 'videotoolbox'] : [];
}

/**
 * Lancia ffmpeg. Se gli argomenti contengono -hwaccel e il comando fallisce (un filtro che non
 * accetta i frame hardware), riprova una volta con la decodifica normale.
 */
export async function ffmpeg(args: string[]): Promise<string> {
  const base = [FFMPEG, '-hide_banner', '-nostdin', '-y', '-loglevel', 'error'];
  try {
    return await exec([...base, ...args], true);
  } catch (e) {
    const i = args.indexOf('-hwaccel');
    if (i < 0) throw e;
    console.warn(`  decodifica hardware non riuscita, riprovo in software: ${(e as Error).message.split('\n')[0]}`);
    return exec([...base, ...args.slice(0, i), ...args.slice(i + 2)], true);
  }
}

/** Esegue un comando e restituisce stdout (o stderr, per ffmpeg che scrive lì i filtri di analisi). */
export async function exec(argv: string[], stderrToo = false): Promise<string> {
  const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`${argv[0]} (codice ${code}): ${err.trim().split('\n').slice(-6).join('\n')}`);
  return stderrToo ? out + err : out;
}

export async function ffmpegVersion(): Promise<string> {
  return (await exec([FFMPEG, '-version'])).split('\n')[0] ?? '';
}

/** Loudness momentanea EBU R128 (finestra 400 ms) a 10 valori al secondo, in LUFS. */
export async function momentaryLoudness(wav: string): Promise<number[]> {
  const out = await exec([FFMPEG, '-hide_banner', '-nostdin', '-loglevel', 'error', '-i', wav, '-af', 'ebur128=metadata=1,ametadata=mode=print:key=lavfi.r128.M:file=-', '-f', 'null', '-']);
  return [...out.matchAll(/lavfi\.r128\.M=(-?[\d.]+|-?inf|nan)/g)].map((m) => {
    const v = Number(m[1]);
    return Number.isFinite(v) ? v : -120;
  });
}
