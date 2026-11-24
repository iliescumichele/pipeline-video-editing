import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib/env';
import { finalToRecording, gameplayOf, LOOK } from '../gameplay/edit';
import { ffmpeg, probe } from '../lib/ff';
import { py } from '../lib/py';
import type { SignalName } from '../lib/signal';
import { stage, stamp, type Ctx } from '../lib/stage';
import { loadTranscript, type Word } from '../lib/transcript';
import type { Short } from './copy';
import type { Ingest } from './ingest';
import type { Signals } from './signals';
import type { TranscribeResult } from './transcribe';
import type { Vision } from './vision';
import { mapLimit } from '../lib/pool';
import { concatFilter, cutsIn, type Segment, segmentInputs, storyDuration, toShort } from '../lib/story';

export interface Rendered {
  id: string;
  layout: 'gameplay' | 'crop' | 'blur' | 'vertical';
  layoutWhy: string;
  fps: number;
  video: string;
  propsPath: string;
  zooms: number[];
  track?: { outside_mean: number; outside_excess: number; range: [number, number] };
}

const VERSION = 4;

/**
 * Impaginazione dei gameplay: il gioco nella zona libera tra le interfacce delle app (in alto ~230 px,
 * in basso da ~1500: descrizione, nome, pulsanti), sopra e sotto lo stesso gioco sfocato; Lucio scontornato
 * in alto a sinistra, sopra il gioco.
 */
const CONTENT = { top: 230, bottom: 1500 };
const CAM = { left: 24, top: CONTENT.top + 16, height: 430 };
/**
 * Si passa allo sfondo sfocato se fuori dal ritaglio c'è almeno 12 punti di movimento in più di
 * quanto ce ne sarebbe con un movimento spalmato uniformemente su tutta la larghezza.
 */
const EXCESS_MAX = 0.12;
/** layout verticale (Aitum): centro dei sottotitoli, sopra Lucio. Da tarare sul primo file vero. */
const VERTICAL_CAPTION_Y = Number(process.env.LUCIO_VERTICAL_CAPTION_Y ?? 1180);

export function render(ctx: Ctx, ing: Ingest, tr: TranscribeResult, sig: Signals, shorts: Short[], vis: Vision[]): Promise<Rendered[]> {
  const remotionSrc = ['Short.tsx', 'Root.tsx', 'fonts.ts'].map((f) => Bun.hash(readFileSync(join(ROOT, 'remotion', 'src', f), 'utf8')).toString());
  // Dalla dashboard: ganci corretti a mano e short scartati, { "s01": { "hook": "..." }, "s03": { "skip": true } }.
  const overridesPath = join(ctx.workDir, 'overrides.json');
  const overrides = (existsSync(overridesPath) ? JSON.parse(readFileSync(overridesPath, 'utf8')) : {}) as Record<string, { hook?: string; skip?: boolean }>;
  const key = { VERSION, after: stamp(ctx, '07-copy'), remotionSrc, vertical: ctx.vertical, overrides };
  const todo = shorts.filter((sh) => !overrides[sh.id]?.skip);
  if (todo.length < shorts.length) console.log(`  ${shorts.length - todo.length} short scartati: non si rifanno`);
  return stage(ctx, '08-render', key, async () => {
    const t = await loadTranscript(tr.path);
    const src = ing.main.video!;
    const fps = Math.min(60, Math.round(src.fps * 1000) / 1000);
    // video finale di un gameplay con la registrazione ancora sul Mac: gioco pulito (senza il Lucio stampato
    // nell'angolo) dalla registrazione, con gli stessi tagli, e Lucio scontornato dal suo file
    const g = ctx.vertical ? null : gameplayOf(ctx.video);
    if (g?.lucianus) console.log(`  gioco dalla registrazione originale, Lucio da ${g.lucianus.split('/').pop()}`);
    else if (!ctx.vertical) console.log('  niente registrazione originale con Lucianus: impaginazione classica dal video');
    // due short alla volta: spezzone, ritaglio e Remotion di uno si sovrappongono a quelli dell'altro
    return mapLimit(todo, 2, async (sh): Promise<Rendered> => {
      const t0 = performance.now();
      const v = vis.find((x) => x.id === sh.candidate);
      // Ogni short fuori dalla cartella della fase, con la sua chiave: se cambia solo un gancio si rifà solo quello.
      const sdir = join(ctx.workDir, '08-render-shorts', sh.id);
      const cachePath = join(sdir, 'rendered.json');
      const shortKey = Bun.hash(JSON.stringify({ VERSION, after: key.after, remotionSrc, vertical: ctx.vertical, hook: overrides[sh.id]?.hook, sh, v })).toString();
      const cached = existsSync(cachePath) ? (JSON.parse(readFileSync(cachePath, 'utf8')) as { key: string; result: Rendered }) : null;
      if (cached?.key === shortKey && existsSync(cached.result.video)) {
        console.log(`  ${sh.id} uguale a prima, si tiene`);
        return cached.result;
      }
      rmSync(sdir, { recursive: true, force: true });
      mkdirSync(sdir, { recursive: true });
      const dur = storyDuration(sh.segments);

      // 1. I pezzi della storia dalla sorgente (o dal verticale), uniti, a qualità alta, senza audio. Il 4K si
      // porta a 1440 righe: nello short se ne vedono al massimo ~1400, e il resto è solo lavoro in più.
      const clip = join(sdir, 'clip.mp4');
      const gameplay = !!g?.lucianus;
      const source = ctx.vertical ?? (g ? g.recording : ctx.video);
      const segs: Segment[] = ctx.vertical
        ? sh.segments.map((x) => ({ s: x.s - (ing.verticalOffset ?? 0), e: x.e - (ing.verticalOffset ?? 0) }))
        : g
          ? sh.segments.flatMap((x) => finalToRecording(g.removed, x.s, x.e))
          : sh.segments;
      if (segs[0]!.s < 0) console.warn(`  ${sh.id}: il verticale inizia dopo questo short, si parte dal suo inizio`);
      const size = ctx.vertical ? '' : ",scale=-2:'min(ih,1440)'";
      await ffmpeg([
        ...segmentInputs(source, segs), '-filter_complex', `${concatFilter(segs.length, 0, 'v', 'c')};[c]fps=${fps}${size}[v]`, '-map', '[v]', '-an',
        '-c:v', 'libx264', '-crf', '12', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', String(Math.round(fps)), clip,
      ]);
      // Lucio: stessi pezzi del suo file (in ritardo di offsetMs come nell'export), senza il verde, con la trasparenza
      let facecam: string | undefined;
      if (gameplay) {
        facecam = 'facecam.mov';
        await ffmpeg([
          ...segmentInputs(g!.lucianus!, segs, -(g!.edit.offsetMs ?? 0) / 1000),
          '-filter_complex', `${concatFilter(segs.length, 0, 'v', 'c')};[c]fps=${fps},crop=${LOOK.crop},format=rgba,${LOOK.key},scale=-2:${CAM.height * 2}:flags=lanczos,format=yuva444p10le[v]`,
          '-map', '[v]', '-an', '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', join(sdir, facecam),
        ]);
      }
      const clipInfo = await probe(clip);
      const cw = clipInfo.video!.width;
      const ch = clipInfo.video!.height;

      // 2. Layout: verticale se c'è, altrimenti ritaglio che segue l'azione o, se taglierebbe troppo, 16:9 su sfondo sfocato.
      let layout: Rendered['layout'] = gameplay ? 'gameplay' : 'crop';
      let layoutWhy = '';
      let crop = { hz: 10, centres: [0.5] };
      let track: Rendered['track'];
      let fit = false;
      if (ctx.vertical) {
        layout = 'vertical';
        layoutWhy = 'file verticale di Aitum';
      } else {
        // larghezza del ritaglio: tutto lo schermo, o la zona libera tra le interfacce delle app
        const cropW = gameplay ? (ch * 1080) / (CONTENT.bottom - CONTENT.top) / cw : ((ch * 9) / 16) / cw;
        const masks = (v?.overlays ?? []).flatMap((o) => ['--mask', [o.x0, o.y0, o.x1, o.y1].map((x) => (x / 100).toFixed(3)).join(',')]);
        const trackPath = join(sdir, 'track.json');
        await py('track.py', [clip, trackPath, '--crop-w', cropW.toFixed(4), '--hint', ((v?.action_x ?? 50) / 100).toFixed(3), ...masks]);
        const tj = (await Bun.file(trackPath).json()) as { fps: number; centres: number[]; outside_mean: number; outside_excess: number; range: [number, number] };
        track = { outside_mean: tj.outside_mean, outside_excess: tj.outside_excess, range: tj.range };
        crop = { hz: tj.fps, centres: tj.centres };
        // con Lucio il gioco resta nella zona libera: se il ritaglio perde l'azione, il 16:9 intero lì dentro
        if (v?.wide_shot) {
          if (gameplay) fit = true;
          else layout = 'blur';
          layoutWhy = 'la vision vede un\'inquadratura larga';
        } else if (tj.outside_excess > EXCESS_MAX) {
          if (gameplay) fit = true;
          else layout = 'blur';
          layoutWhy = `il ritaglio lascerebbe fuori troppa azione (${Math.round(tj.outside_excess * 100)} punti oltre l'uniforme)`;
        } else {
          layoutWhy = `ritaglio che segue l'azione (fuori ${Math.round(tj.outside_mean * 100)}% del movimento, ${tj.outside_excess >= 0 ? '+' : ''}${Math.round(tj.outside_excess * 100)} sull'uniforme)`;
        }
      }
      let bg: string | undefined;
      if (layout === 'blur' || layout === 'gameplay') {
        bg = 'bg.mp4';
        await ffmpeg([
          '-i', clip, '-vf', 'scale=-2:480,crop=270:480,boxblur=18:3,eq=brightness=-0.12:saturation=1.25,scale=1080:1920',
          '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', join(sdir, bg),
        ]);
      }

      // 3. Sottotitoli, zoom e posizioni.
      // parole di ogni pezzo, sul tempo dello short (niente parole a cavallo di un taglio)
      const words = sh.segments.flatMap((x) =>
        t.words
          .filter((w) => w.s >= x.s - 0.05 && w.s < x.e - 0.1)
          .map((w) => {
            const at = toShort(sh.segments, Math.max(x.s, w.s)) ?? 0;
            return { ...w, s: at, e: Math.min(at + (Math.min(w.e, x.e) - Math.max(x.s, w.s)), dur) };
          }),
      );
      const lines = captionLines(words, dur);
      const zooms = pickZooms(sig, sh, dur);
      const blurTop = 640;
      const fitH = (1080 * ch) / cw;
      const captionY =
        layout === 'vertical' ? VERTICAL_CAPTION_Y
        : layout === 'blur' ? blurTop + fitH + 125
        // in basso nell'immagine GTA mette i suoi sottotitoli: i nostri stanno più su
        : layout === 'gameplay' ? (fit ? Math.min(CONTENT.bottom - 90, (CONTENT.top + CONTENT.bottom + fitH) / 2 + 110) : CONTENT.bottom - 330)
        : 1290;
      const props = {
        fps, duration: Math.round(dur * fps) / fps, layout, src: 'clip.mp4', bg, srcWidth: cw, srcHeight: ch, crop,
        hook: overrides[sh.id]?.hook ?? sh.copy.hook, lines, zooms, captionY, hookY: layout === 'gameplay' ? 760 : 250, blurTop, loopSeconds: 0.35,
        ...(layout === 'gameplay' ? { facecam, content: CONTENT, cam: CAM, fit } : {}),
      };
      const propsPath = join(sdir, 'props.json');
      await Bun.write(propsPath, JSON.stringify(props));

      // 4. Render con Remotion (usa il suo ffmpeg interno): H.264, CRF 16, senza audio.
      const video = join(sdir, 'video.mp4');
      const proc = Bun.spawn(
        ['bunx', 'remotion', 'render', 'src/index.ts', 'Short', video, `--props=${propsPath}`, `--public-dir=${sdir}`,
          '--codec=h264', '--crf=16', '--pixel-format=yuv420p', '--x264-preset=medium', '--muted', '--log=error'],
        { cwd: join(ROOT, 'remotion'), stdout: 'pipe', stderr: 'pipe' },
      );
      const [o, e, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      if (code !== 0) throw new Error(`remotion render ${sh.id}: ${(e || o).trim().split('\n').slice(-10).join('\n')}`);

      console.log(`  ${sh.id} ${layout} (${layoutWhy}), ${lines.length} righe, ${zooms.length} zoom, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
      const result: Rendered = { id: sh.id, layout, layoutWhy, fps, video, propsPath, zooms, track };
      await Bun.write(cachePath, JSON.stringify({ key: shortKey, result }));
      return result;
    });
  });
}

/**
 * Righe da 2–4 parole: si va a capo dopo 4 parole, oltre 16 caratteri, su una pausa di 0,45 s o a
 * fine frase. Le parole rimaste sole si uniscono alla riga vicina quando ci stanno. Ogni riga resta
 * a schermo fino all'inizio della successiva se la pausa è breve, così non lampeggia.
 */
export function captionLines(input: Word[], dur: number) {
  const words = input
    .map((w) => ({ w: w.w.replace(/[.,;:"“”«»…]+/g, '').replace(/^[-–—]+|[-–—]+$/g, '').trim(), s: w.s, e: w.e, end: /[.?!…]$/.test(w.w) }))
    .filter((w) => w.w);
  const groups: (typeof words)[] = [];
  let cur: typeof words = [];
  const chars = (g: typeof words) => g.map((x) => x.w).join(' ').length;
  for (const w of words) {
    const prev = cur.at(-1);
    const brk = prev && (cur.length >= 4 || chars([...cur, w]) > 16 || w.s - prev.e > 0.45 || prev.end);
    if (brk) {
      groups.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);

  // Niente righe di una parola: si unisce alla riga vicina se ci sta, altrimenti le prende una parola.
  const close = (a: (typeof words)[number], b: (typeof words)[number]) => b.s - a.e < 0.8;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!;
    if (g.length !== 1) continue;
    const w = g[0]!;
    const prev = groups[i - 1];
    const next = groups[i + 1];
    if (prev && prev.length < 4 && chars([...prev, w]) <= 20 && close(prev.at(-1)!, w) && !prev.at(-1)!.end) {
      prev.push(w);
      groups.splice(i--, 1);
    } else if (next && next.length < 4 && chars([w, ...next]) <= 20 && close(w, next[0]!) && !w.end) {
      next.unshift(w);
      groups.splice(i--, 1);
    } else if (prev && prev.length >= 3 && close(prev.at(-1)!, w) && chars([prev.at(-1)!, w]) <= 18 && !prev.at(-1)!.end) {
      g.unshift(prev.pop()!);
    } else if (next && next.length >= 3 && close(w, next[0]!) && chars([w, next[0]!]) <= 18 && !w.end) {
      g.push(next.shift()!);
    } else if (prev && close(prev.at(-1)!, w) && chars([...prev, w]) <= 22) {
      // ultima possibilità: una riga un po' più lunga (il font si riduce) invece di una parola sola
      prev.push(w);
      groups.splice(i--, 1);
    }
  }

  return groups.map((g, i) => {
    const next = groups[i + 1];
    const last = g.at(-1)!;
    const e = next && next[0]!.s - last.e < 0.6 ? next[0]!.s : Math.min(dur, last.e + 0.3);
    return { s: g[0]!.s, e, words: g.map(({ w, s, e: we }) => ({ w, s, e: we })) };
  });
}

/** Fino a 3 zoom sulle reazioni più forti, lontani dal gancio e dal finale (che deve tornare all'inizio). */
function pickZooms(sig: Signals, sh: Short, dur: number): number[] {
  const kinds: SignalName[] = ['voice', 'lucio', 'markers'];
  // niente zoom a cavallo di un taglio: tra i pezzi l'immagine cambia di colpo
  const cuts = cutsIn(sh.segments);
  const clear = (t: number) => cuts.every((c) => t < c - 2 || t > c + 0.6);
  const cands = kinds
    .flatMap((k) => sig[k].windows.map((w) => ({ t: toShort(sh.segments, w.peak) ?? -1, v: w.score, label: w.label })))
    .filter((x) => x.t > 1.8 && x.t < dur - 2.8 && x.v >= 0.3 && clear(x.t))
    .sort((a, b) => b.v - a.v);
  const peak = toShort(sh.segments, sh.peak) ?? -1;
  if (peak > 1.8 && peak < dur - 2.8 && clear(peak)) cands.unshift({ t: peak, v: 1, label: 'peak' });
  const out: number[] = [];
  for (const c of cands) if (out.length < 3 && out.every((x) => Math.abs(x - c.t) >= 4)) out.push(Math.round(c.t * 100) / 100);
  return out.sort((a, b) => a - b);
}
