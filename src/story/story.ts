// bun run story <spec.json> [--out dir] [--draft]
//
// Monta uno short "a storia" da più spezzoni di un video lungo, secondo una scheda JSON scritta a mano
// (o da Claude). Tutti i tempi della scheda sono in secondi del video sorgente: lo script li porta sulla
// linea del tempo dello short.
//
// Formato della scheda, effetti e trappole: .agents/skills/shorts-storia/SCHEDA.md (unica fonte).
// Metodo per trovare le storie e stile: .agents/skills/shorts-storia/SKILL.md e STILE.md.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dir, '..', '..');
const FPS = 60;
// gioco sempre 4:3 (1080×810): vedi GEOM in remotion/src/StoryShort.tsx
const GEOM = { split: { faceH: 560, gameH: 810 }, panel: { gameH: 810 } } as const;

interface Seg {
  s: number;
  e: number;
  cx?: number;
  /** il 16:9 intero sopra lo stesso fotogramma sfocato (per dialoghi e sottotitoli del gioco) */
  fit?: boolean;
  /** schiarisce le scene buie */
  lift?: boolean;
  /** ritaglio esplicito [x, y, w, h] in pixel del sorgente (va scalato a 1080×gameH) */
  crop?: [number, number, number, number];
}
interface Spec {
  id: string;
  source: string;
  transcript?: string;
  layout: 'split' | 'panel';
  lucio?: { x: number; y: number; w: number; h: number };
  /** file da cui ritagliare Lucianus, se non è il sorgente (stessa linea del tempo; lucio è in pixel di questo file) */
  faceSource?: string;
  /** il ritaglio del gioco non va oltre questo x (pixel del sorgente): per non mostrare due volte Lucianus */
  avoidRight?: number;
  hook?: string;
  hookDur?: number;
  header?: string;
  segments: Seg[];
  cards?: ({ say: [number, number]; color?: string; max?: number; text?: string } | { tag: string; at: number; dur?: number; color?: string } | { big: string; at: number; dur?: number; color?: string })[];
  flashes?: { at: number; color?: string }[];
  zooms?: number[];
  shakes?: number[];
  end?: { text: string; dur?: number };
}
interface Word {
  w: string;
  s: number;
  e: number;
}

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: { out: { type: 'string' }, draft: { type: 'boolean', default: false } },
});
const specPath = positionals[0] && resolve(positionals[0]);
if (!specPath) {
  console.error('uso: bun run story <spec.json> [--out dir] [--draft]');
  process.exit(2);
}
const spec: Spec = JSON.parse(readFileSync(specPath, 'utf8'));
const outDir = resolve(values.out ?? dirname(specPath));
const work = join(outDir, `.${spec.id}`);
mkdirSync(work, { recursive: true });

async function run(cmd: string[], cwd?: string): Promise<string> {
  const p = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd[0]} ${cmd[1] ?? ''}: ${(e || o).trim().split('\n').slice(-12).join('\n')}`);
  return o + e;
}

// ── linea del tempo: sorgente → short ──────────────────────────────────────────────────────────────
const segs = spec.segments.map((x) => ({ ...x, dur: +(x.e - x.s).toFixed(3) }));
const offsets: number[] = [];
let acc = 0;
for (const s of segs) {
  offsets.push(acc);
  acc += s.dur;
}
const total = +acc.toFixed(3);

/** Istante dello short che corrisponde al secondo t del sorgente (il primo spezzone che lo contiene). */
function map(t: number): number | undefined {
  for (let i = 0; i < segs.length; i++) if (t >= segs[i]!.s - 1e-3 && t <= segs[i]!.e + 1e-3) return offsets[i]! + Math.max(0, t - segs[i]!.s);
  return undefined;
}
function mustMap(t: number, what: string): number {
  const m = map(t);
  if (m === undefined) throw new Error(`${what}: il secondo ${t} del sorgente non sta in nessuno spezzone`);
  return m;
}

/** Parolacce con l'asterisco nelle scritte (l'audio resta com'è), come nei short di riferimento. */
function censor(w: string): string {
  return w.replace(/f(u)(ck)/gi, (m) => m[0] + '*' + m.slice(2)).replace(/b(i)(tch)/gi, (m) => m[0] + '*' + m.slice(2)).replace(/sh(i)t/gi, (m) => m.slice(0, 2) + '*' + m.slice(3));
}

// ── scritte ────────────────────────────────────────────────────────────────────────────────────────
const words: Word[] = spec.transcript ? JSON.parse(readFileSync(spec.transcript, 'utf8')).words : [];
type Card = { s: number; e: number; kind: 'say' | 'tag' | 'big'; text: string; words?: Word[]; color?: string };
const cards: Card[] = [];
for (const c of spec.cards ?? []) {
  if ('say' in c) {
    const [a, b] = c.say;
    let ws = words
      .filter((w) => w.s >= a - 0.05 && w.s < b)
      .map((w) => ({ w: censor(w.w).replace(/[.,!?;:"]+$/g, (m) => (m.includes('?') ? '?' : m.includes('!') ? '!' : '')), s: map(w.s), e: map(Math.min(w.e, b)) }))
      .filter((w): w is Word => w.s !== undefined && w.e !== undefined && w.w.length > 0);
    // testo corretto a mano (la trascrizione ha sbagliato): stesse durate, parole distribuite in modo uniforme
    if (c.text && ws.length) {
      const t0 = ws[0]!.s;
      const t1 = ws[ws.length - 1]!.e;
      const tok = censor(c.text).split(/\s+/).filter(Boolean);
      const step = (t1 - t0) / tok.length;
      ws = tok.map((w, k) => ({ w, s: t0 + k * step, e: t0 + (k + 1) * step }));
    }
    // righe da max 3 parole / 16 caratteri; si va a capo anche su una pausa o su un taglio
    const max = c.max ?? 3;
    let line: Word[] = [];
    const flush = () => {
      if (!line.length) return;
      const s = line[0]!.s;
      const e = Math.max(line[line.length - 1]!.e, s + 0.35);
      cards.push({ s, e, kind: 'say', text: line.map((w) => w.w).join(' '), words: line, color: c.color });
      line = [];
    };
    for (const w of ws) {
      const prev = line[line.length - 1];
      const chars = line.reduce((n, x) => n + x.w.length + 1, 0) + w.w.length;
      if (prev && (line.length >= max || chars > 16 || w.s - prev.e > 0.35 || w.s < prev.s)) flush();
      line.push(w);
    }
    flush();
  } else if ('tag' in c) {
    const s = mustMap(c.at, `tag "${c.tag}"`);
    cards.push({ s, e: Math.min(total, s + (c.dur ?? 1.4)), kind: 'tag', text: c.tag, color: c.color });
  } else {
    const s = mustMap(c.at, `big "${c.big}"`);
    cards.push({ s, e: Math.min(total, s + (c.dur ?? 1.2)), kind: 'big', text: c.big, color: c.color });
  }
}
cards.sort((a, b) => a.s - b.s);
// una riga detta resta a schermo finché non arriva la successiva (max 0,6 s in più), così non lampeggia
for (let i = 0; i < cards.length; i++) {
  const c = cards[i]!;
  const next = cards[i + 1];
  if (c.kind === 'say') c.e = Math.min(next ? next.s : total, c.e + 0.6);
}

// ── video e audio con ffmpeg ──────────────────────────────────────────────────────────────────────
const probe = JSON.parse(await run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', spec.source]));
const SW: number = probe.streams[0].width;
const SH: number = probe.streams[0].height;
const gameH = spec.layout === 'split' ? GEOM.split.gameH : GEOM.panel.gameH;
const cropW = Math.round((SH * 1080) / gameH / 2) * 2;
const lucioRight = spec.avoidRight ?? (spec.layout === 'split' && spec.lucio && !spec.faceSource ? spec.lucio.x + spec.lucio.w * 0.25 : SW);

const inputs: string[] = [];
const filters: string[] = [];
segs.forEach((s, i) => {
  inputs.push('-ss', s.s.toFixed(3), '-t', s.dur.toFixed(3), '-i', spec.source);
  let x = Math.round((s.cx ?? 0.5) * SW - cropW / 2);
  // nello split il gioco non deve mostrare di nuovo Lucianus (sta in basso a destra)
  x = Math.min(x, Math.round(lucioRight - cropW));
  x = Math.max(0, Math.min(SW - cropW, x));
  const lift = s.lift ? ',eq=gamma=1.35:brightness=0.03:saturation=1.1' : '';
  if (s.fit) {
    const fh = Math.round((1080 * SH) / SW / 2) * 2;
    filters.push(
      `[${i}:v]fps=${FPS}${lift},split[fa${i}][fb${i}]`,
      `[fa${i}]scale=-2:${gameH},crop=1080:${gameH},boxblur=24:2,eq=brightness=-0.12[bg${i}]`,
      `[fb${i}]scale=1080:${fh}:flags=lanczos[fg${i}]`,
      `[bg${i}][fg${i}]overlay=0:(H-h)/2,setsar=1,setpts=PTS-STARTPTS[g${i}]`,
    );
  } else if (s.crop) {
    const [cx0, cy0, cw, ch] = s.crop;
    filters.push(`[${i}:v]fps=${FPS}${lift},crop=${cw}:${ch}:${cx0}:${cy0},scale=1080:${gameH}:flags=lanczos,setsar=1,setpts=PTS-STARTPTS[g${i}]`);
  } else {
    filters.push(`[${i}:v]fps=${FPS}${lift},crop=${cropW}:${SH}:${x}:0,scale=1080:${gameH}:flags=lanczos,setsar=1,setpts=PTS-STARTPTS[g${i}]`);
  }
  if (spec.layout === 'split' && spec.lucio) {
    const L = spec.lucio;
    const faceW = Math.round((GEOM.split.faceH * L.w) / L.h / 2) * 2;
    const fi = spec.faceSource ? segs.length + i : i;
    filters.push(`[${fi}:v]fps=${FPS},crop=${L.w}:${L.h}:${L.x}:${L.y},scale=${faceW}:${GEOM.split.faceH}:flags=lanczos,setsar=1,setpts=PTS-STARTPTS[f${i}]`);
  }
  const fo = Math.max(0, s.dur - 0.03).toFixed(3);
  filters.push(`[${i}:a]asetpts=PTS-STARTPTS,aresample=48000,afade=t=in:d=0.02,afade=t=out:st=${fo}:d=0.03[a${i}]`);
});
const n = segs.length;
if (spec.layout === 'split' && spec.faceSource) for (const s of segs) inputs.push('-ss', s.s.toFixed(3), '-t', s.dur.toFixed(3), '-i', spec.faceSource);
filters.push(`${segs.map((_, i) => `[g${i}]`).join('')}concat=n=${n}:v=1:a=0[gv]`);
if (spec.layout === 'split' && spec.lucio) filters.push(`${segs.map((_, i) => `[f${i}]`).join('')}concat=n=${n}:v=1:a=0[fv]`);
filters.push(`${segs.map((_, i) => `[a${i}]`).join('')}concat=n=${n}:v=0:a=1[av]`);

const enc = ['-c:v', 'h264_videotoolbox', '-b:v', '40M', '-pix_fmt', 'yuv420p'];
console.log(`${spec.id}: ${n} spezzoni, ${total.toFixed(1)} s → taglio e ritaglio`);
await run([
  'ffmpeg', '-v', 'error', '-y', '-hwaccel', 'videotoolbox', ...inputs,
  '-filter_complex', filters.join(';'),
  '-map', '[gv]', ...enc, join(work, 'game.mp4'),
  ...(spec.layout === 'split' && spec.lucio ? ['-map', '[fv]', ...enc, join(work, 'face.mp4')] : []),
  '-map', '[av]', '-c:a', 'pcm_s16le', join(work, 'audio.wav'),
]);

// ── Remotion ──────────────────────────────────────────────────────────────────────────────────────
const props = {
  fps: FPS,
  duration: total,
  layout: spec.layout,
  game: 'game.mp4',
  face: spec.layout === 'split' && spec.lucio ? 'face.mp4' : undefined,
  faceW: spec.lucio ? Math.min(1080, Math.round((GEOM.split.faceH * spec.lucio.w) / spec.lucio.h / 2) * 2) : undefined,
  header: spec.header,
  hook: spec.hook,
  hookDur: spec.hookDur,
  cards,
  flashes: (spec.flashes ?? []).map((f) => ({ t: mustMap(f.at, 'flash'), color: f.color ?? '#FFFFFF' })),
  zooms: (spec.zooms ?? []).map((t) => mustMap(t, 'zoom')),
  shakes: (spec.shakes ?? []).map((t) => mustMap(t, 'shake')),
  cuts: offsets.slice(1),
  end: spec.end ? { s: Math.max(0, total - (spec.end.dur ?? 1.6)), text: spec.end.text } : undefined,
};
const propsPath = join(work, 'props.json');
writeFileSync(propsPath, JSON.stringify(props, null, 1));
const silent = join(work, 'video.mp4');
console.log(`${spec.id}: render Remotion (${Math.round(total * FPS)} fotogrammi)`);
await run(
  ['bunx', 'remotion', 'render', 'src/index.ts', 'StoryShort', silent, `--props=${propsPath}`, `--public-dir=${work}`,
    '--codec=h264', `--crf=${values.draft ? 28 : 16}`, '--concurrency=75%', ...(values.draft ? ['--scale=0.5'] : [])],
  join(ROOT, 'remotion'),
);

// ── audio: loudnorm in due passate a −14 LUFS, poi mux ────────────────────────────────────────────
const wav = join(work, 'audio.wav');
const m = await run(['ffmpeg', '-hide_banner', '-nostats', '-i', wav, '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json', '-f', 'null', '-']);
const j = JSON.parse(m.slice(m.lastIndexOf('{'), m.lastIndexOf('}') + 1));
const out = join(outDir, `${spec.id}.mp4`);
await run([
  'ffmpeg', '-v', 'error', '-y', '-i', silent, '-i', wav,
  '-af', `loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true,aresample=48000`,
  '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-shortest', '-movflags', '+faststart', out,
]);
console.log(`✓ ${out} (${total.toFixed(1)} s)`);
if (!existsSync(out)) process.exit(1);
