// bun scripts/make-obs-fixture.ts <clip.mp4> <cartella 01-ingest del clip> <cartella di uscita>
//
// Costruisce da un clip di prova (già passato dalla fase 1) i file che OBS produrrà dal 19 novembre,
// per provare quel ramo della pipeline prima di avere una registrazione vera:
//   "2026-11-19 20-15-33.mp4"  4K60 HEVC, 4 tracce audio (mix, gioco, microfono, musica), 2 chapter
//   vertical.mp4               1080×1920 che parte 2 s dopo, con un riquadro al posto di Lucio in basso
//   lucio.jsonl                log di lucio-vite con due reazioni finte (a 70,5 s e 92,5 s)
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ffmpeg, probe } from '../src/lib/ff';

const [clip, ingestDir, outDir] = process.argv.slice(2);
if (!clip || !ingestDir || !outDir) {
  console.error('uso: bun scripts/make-obs-fixture.ts <clip.mp4> <cartella 01-ingest> <cartella di uscita>');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const dur = (await probe(clip)).duration;
const START = Date.UTC(2026, 10, 19, 19, 15, 33); // 20:15:33 ora italiana
const main = join(outDir, '2026-11-19 20-15-33.mp4');
const MARKERS = [72, 101];

const chapters = join(outDir, 'chapters.txt');
const bounds = [0, ...MARKERS, dur].map((t) => Math.round(t * 1000));
await Bun.write(
  chapters,
  `;FFMETADATA1\n${bounds
    .slice(0, -1)
    .map((s, i) => `[CHAPTER]\nTIMEBASE=1/1000\nSTART=${s}\nEND=${bounds[i + 1]}\ntitle=${i === 0 ? 'Start' : `Marker ${i}`}\n`)
    .join('')}`,
);

console.log('principale 4K HEVC con 4 tracce e chapter…');
await ffmpeg([
  '-i', clip, '-i', join(ingestDir, 'game48k.wav'), '-i', join(ingestDir, 'voice48k.wav'),
  '-f', 'lavfi', '-t', dur.toFixed(3), '-i', 'sine=frequency=220:sample_rate=48000,volume=-30dB',
  '-f', 'ffmetadata', '-i', chapters,
  '-map', '0:v', '-map', '0:a', '-map', '1:a', '-map', '2:a', '-map', '3:a', '-map_chapters', '4',
  '-vf', 'scale=3840:2160:flags=lanczos', '-c:v', 'hevc_videotoolbox', '-b:v', '40M', '-tag:v', 'hvc1',
  '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
  '-metadata', `creation_time=${new Date(START).toISOString()}`,
  '-metadata:s:a:0', 'title=Mix', '-metadata:s:a:1', 'title=Game', '-metadata:s:a:2', 'title=Mic', '-metadata:s:a:3', 'title=Music',
  main,
]);

console.log('verticale 1080×1920 sfasato di 2 s…');
await ffmpeg([
  '-ss', '2', '-i', clip,
  '-vf', 'crop=ih*9/16:ih,scale=1080:1920,drawbox=x=240:y=1450:w=600:h=440:color=0x3FD0C9@1:t=fill,drawbox=x=300:y=1500:w=480:h=340:color=0xFFB547@1:t=fill',
  '-c:v', 'h264_videotoolbox', '-b:v', '12M', '-c:a', 'aac', '-b:a', '192k', join(outDir, 'vertical.mp4'),
]);

console.log('log di Lucio…');
const lines: string[] = [];
const rnd = (a: number) => (Math.random() - 0.5) * a;
for (let i = 0; i < dur * 30; i++) {
  const t = i / 30;
  const spike = (c: number, w: number) => Math.exp(-((t - c) ** 2) / (2 * w * w));
  const react = spike(92.5, 0.5);
  const turn = spike(70.5, 0.3);
  lines.push(
    JSON.stringify({
      t: START + Math.round(t * 1000),
      bs: {
        jawOpen: 0.12 + rnd(0.08) + 0.75 * react,
        eyeWideLeft: 0.1 + rnd(0.06) + 0.7 * react,
        eyeWideRight: 0.1 + rnd(0.06) + 0.7 * react,
        browInnerUp: 0.15 + rnd(0.08) + 0.6 * react,
        mouthSmileLeft: 0.2 + rnd(0.1),
        mouthSmileRight: 0.2 + rnd(0.1),
      },
      yaw: rnd(2) + 35 * Math.tanh((t - 70.5) * 8) * turn,
      pitch: rnd(1.5),
      roll: rnd(1),
    }),
  );
}
await Bun.write(join(outDir, 'lucio.jsonl'), `${lines.join('\n')}\n`);
console.log(`fatto: ${outDir}`);
