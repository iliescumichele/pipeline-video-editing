// bun run story:tools <comando> ...   Strumenti per trovare le storie degli short in un video lungo.
//
//   sheets <video> [--step 10] [--from s] [--to s] [--out dir]
//       un fotogramma ogni --step secondi, in fogli 6×6 con l'orario m:ss. Per avere la mappa del video.
//   strip <video> <inizio-s> <durata-s> [--fps 1] [--out file.jpg]
//       fotogrammi interi (640 px) uno sotto l'altro con l'orario: per controllare cosa succede davvero.
//   subs <video> <inizio-s> <durata-s> [--fps 2] [--out file.jpg]
//       solo la fascia dei sottotitoli del gioco, con l'orario: per leggere le battute e i loro tempi.
//   lucio <video> [--from s] [--to s]
//       in quali tratti si vede Lucianus (maglia turchese in basso a destra), un controllo al secondo.
//   words <transcript.json> <inizio-s> <fine-s>
//       le frasi della trascrizione nell'intervallo, con i tempi (parole raggruppate sulle pause > 0,6 s).
//
// Il video può essere il 4K o la copia 720p: le coordinate di ritaglio sono in frazioni del fotogramma.
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PATHS } from '../lib/env';
import { py } from '../lib/py';

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    step: { type: 'string', default: '10' },
    from: { type: 'string' },
    to: { type: 'string' },
    fps: { type: 'string' },
    out: { type: 'string' },
  },
});
const [cmd, ...args] = positionals;

async function ff(argv: string[]): Promise<Uint8Array> {
  const p = Bun.spawn(['ffmpeg', '-v', 'error', '-y', ...argv], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`ffmpeg: ${err.trim().split('\n').slice(-5).join('\n')}`);
  return new Uint8Array(out);
}

function tmpDir(name: string): string {
  const d = join(PATHS.work, '_story-tools', name);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  return d;
}

const fmt = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

switch (cmd) {
  case 'sheets': {
    const video = resolve(args[0]!);
    const step = Number(values.step);
    const from = Number(values.from ?? 0);
    const out = resolve(values.out ?? join(PATHS.work, '_story-tools', `${basename(video, '.mp4')}-fogli`));
    mkdirSync(out, { recursive: true });
    const frames = tmpDir('sheets');
    const range = values.to ? ['-t', String(Number(values.to) - from)] : [];
    await ff(['-hwaccel', 'videotoolbox', '-ss', String(from), ...range, '-i', video, '-vf', `fps=1/${step},scale=320:180`, '-q:v', '4', join(frames, 'f%04d.jpg')]);
    await py('storysheet.py', ['sheet', frames, join(out, 'foglio'), String(step), String(from)]);
    break;
  }
  case 'strip':
  case 'subs': {
    const [v, s, d] = args;
    const video = resolve(v!);
    const start = Number(s);
    const dur = Number(d);
    const fps = Number(values.fps ?? (cmd === 'subs' ? 2 : 1));
    // sottotitoli di GTA 6: centrati, nella fascia tra l'83% e il 93% dell'altezza
    const vf = cmd === 'subs' ? `fps=${fps},crop=iw*0.78:ih*0.1:iw*0.11:ih*0.83,scale=1000:-2` : `fps=${fps},scale=640:-2`;
    const frames = tmpDir(cmd);
    await ff(['-ss', String(start), '-t', String(dur), '-i', video, '-vf', vf, join(frames, 'f%04d.jpg')]);
    const out = resolve(values.out ?? join(PATHS.work, '_story-tools', `${cmd}-${start}.jpg`));
    await py('storysheet.py', ['strip', frames, out, String(1 / fps), String(start)]);
    break;
  }
  case 'lucio': {
    const video = resolve(args[0]!);
    const from = Number(values.from ?? 0);
    const range = values.to ? ['-t', String(Number(values.to) - from)] : [];
    // zona della maglia turchese di Lucianus nel composito (in basso a destra): 30×11 campioni al secondo
    const W = 30;
    const H = 11;
    const raw = await ff(['-hwaccel', 'videotoolbox', '-ss', String(from), ...range, '-i', video, '-vf', `fps=1,crop=iw*0.117:ih*0.076:iw*0.727:ih*0.917,scale=${W}:${H}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    const n = W * H * 3;
    const present: boolean[] = [];
    for (let o = 0; o + n <= raw.length; o += n) {
      let teal = 0;
      for (let i = o; i < o + n; i += 3) {
        const r = raw[i]!, g = raw[i + 1]!, b = raw[i + 2]!;
        if (g > 150 && b > 150 && r < 120 && Math.abs(g - b) < 70) teal++;
      }
      present.push(teal / (W * H) > 0.25);
    }
    const spans: [number, number][] = [];
    let st = -1;
    present.push(false);
    present.forEach((p, i) => {
      if (p && st < 0) st = i;
      if (!p && st >= 0) {
        if (i - st >= 3) spans.push([from + st, from + i]);
        st = -1;
      }
    });
    const tot = spans.reduce((a, [x, y]) => a + y - x, 0);
    console.log(`Lucianus visibile ${tot} s su ${present.length - 1} s`);
    for (const [a, b] of spans) console.log(`  ${fmt(a)}–${fmt(b)}  (${a}–${b} s)`);
    break;
  }
  case 'words': {
    const [tr, a, b] = args;
    const words: { w: string; s: number; e: number }[] = JSON.parse(readFileSync(resolve(tr!), 'utf8')).words;
    const lo = Number(a);
    const hi = Number(b);
    let line: string[] = [];
    let st = 0;
    let last = 0;
    const flush = () => line.length && console.log(`[${st.toFixed(1)}–${last.toFixed(1)}] ${line.join(' ')}`);
    for (const w of words.filter((x) => x.s >= lo && x.s <= hi)) {
      if (line.length && w.s - last > 0.6) {
        flush();
        line = [];
      }
      if (!line.length) st = w.s;
      line.push(w.w);
      last = w.e;
    }
    flush();
    break;
  }
  default:
    console.error('uso: bun run story:tools sheets|strip|subs|lucio|words ...  (vedi l\'intestazione di src/story/tools.ts)');
    process.exit(2);
}
