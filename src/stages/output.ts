import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readModels, ROOT } from '../lib/env';
import { ffmpeg, ffmpegVersion, probe } from '../lib/ff';
import { py } from '../lib/py';
import type { SignalName } from '../lib/signal';
import { fmtDuration, stage, stamp, type Ctx, type StageRecord } from '../lib/stage';
import { norm } from '../lib/transcript';
import { CHOICES, OPEN_ISSUES } from '../report/notes';
import { reviewHtml, type ReviewShort } from '../report/review';
import type { Mixed } from './audio';
import type { Candidate } from './candidates';
import type { Short } from './copy';
import type { Ingest } from './ingest';
import type { Rendered } from './render';
import type { Signals } from './signals';
import type { Vision } from './vision';
import { overlapStory, type Segment, toShort } from '../lib/story';

const VERSION = 1;
/** quota media di musica nella traccia gioco oltre la quale si avvisa (Content ID) */
const MUSIC_WARN = 0.35;

interface SyncCheck {
  id: string;
  matched: number;
  total: number;
  medianMs: number;
  p90Ms: number;
  maxMs: number;
}

export function output(ctx: Ctx, ing: Ingest, sig: Signals, cands: Candidate[], vis: Vision[], shorts: Short[], rendered: Rendered[], mixed: Mixed[], t0: number) {
  return stage(ctx, '10-output', { VERSION, after: stamp(ctx, '09-audio'), out: ctx.outDir }, async (dir) => {
    mkdirSync(ctx.outDir, { recursive: true });
    // short di un giro di prima che in questo non ci sono più (gli scartati restano: sono ancora in `shorts`)
    for (const f of readdirSync(ctx.outDir)) {
      const sid = f.match(/^(s\d+)\.(mp4|jpg|json)$/)?.[1];
      if (sid && !shorts.some((sh) => sh.id === sid)) rmSync(join(ctx.outDir, f));
    }
    const music = await gameMusic(sig);
    const missing = (Object.keys(sig) as SignalName[]).filter((k) => !sig[k].available);
    const review: ReviewShort[] = [];

    for (const sh of shorts) {
      const m = mixed.find((x) => x.id === sh.id);
      const r = rendered.find((x) => x.id === sh.id);
      if (!m || !r) continue;
      const c = cands.find((x) => x.id === sh.candidate)!;
      const v = vis.find((x) => x.id === sh.candidate);
      const file = `${sh.id}.mp4`;
      const thumb = `${sh.id}.jpg`;
      copyFileSync(m.mp4, join(ctx.outDir, file));
      await ffmpeg(['-ss', (toShort(sh.segments, sh.peak) ?? 1).toFixed(3), '-i', join(ctx.outDir, file), '-frames:v', '1', '-q:v', '2', join(ctx.outDir, thumb)]);

      const info = await probe(join(ctx.outDir, file));
      const warnings: string[] = [];
      if (v?.graphic_violence_first7s) warnings.push(`violenza grafica nei primi 7 s (${v.violence_note})`);
      const cam = (v?.webcam ?? []).reduce((a, w) => a + overlapStory(sh.segments, w.s, w.e), 0);
      if (cam > 0) warnings.push(`webcam a tutto schermo per circa ${cam.toFixed(0)} s`);
      if (v?.cutscene) warnings.push('solo cutscene: contenuto Rockstar, rischio reclami');
      if (v?.ingame_screen) warnings.push('soprattutto uno schermo nel gioco (TV, telefono, menu)');
      if (v && !v.standalone) warnings.push(`potrebbe servire contesto: ${v.standalone_why}`);
      const mus = musicShare(music, sh.segments);
      if (mus >= MUSIC_WARN) warnings.push(`musica nella traccia gioco per il ${Math.round(mus * 100)}% dello short: possibile Content ID (radio del gioco)`);
      if (sh.copy.score < 7) warnings.push(`voto di Claude ${sh.copy.score}/10: sotto la soglia "pubblica così"`);

      const entry: ReviewShort = {
        id: sh.id,
        rank: sh.rank,
        file,
        thumb,
        duration: Math.round(info.duration * 100) / 100,
        source: { s: sh.s, e: sh.e, turn: sh.turn, peak: sh.peak, segments: sh.segments },
        layout: r.layout,
        layoutWhy: r.layoutWhy,
        hook: sh.copy.hook,
        score: sh.copy.score,
        score_reason: sh.copy.score_reason,
        reason: sh.reason,
        what: v?.what,
        warnings,
        signals: c.signals,
        missing,
        labels: c.labels,
        copy: { youtube: sh.copy.youtube, instagram: sh.copy.instagram, tiktok: sh.copy.tiktok },
        measures: { lufs: m.lufs, truePeak: m.truePeak, width: info.video!.width, height: info.video!.height, fps: Math.round(info.video!.fps * 100) / 100 },
      };
      review.push(entry);
      await Bun.write(
        join(ctx.outDir, `${sh.id}.json`),
        JSON.stringify({ ...entry, video: basename(ctx.video), candidate: sh.candidate, zooms: r.zooms, track: r.track, vision: v, adjusted: sh.adjusted, music_share: Math.round(mus * 100) / 100 }, null, 2),
      );
    }
    await Bun.write(join(ctx.outDir, 'review.html'), reviewHtml(basename(ctx.video), review));

    // Verifica: misure, 3 frame per short da guardare e sincronia dei sottotitoli su 2 short.
    const vdir = join(ctx.workDir, 'verify');
    mkdirSync(vdir, { recursive: true });
    for (const s of review) {
      for (const [name, at] of [['hook', 0.7], ['mid', s.duration / 2], ['end', s.duration - 0.1]] as const) {
        await ffmpeg(['-ss', at.toFixed(3), '-i', join(ctx.outDir, s.file), '-frames:v', '1', '-q:v', '3', join(vdir, `${s.id}-${name}.jpg`)]);
      }
    }
    const sync: SyncCheck[] = [];
    for (const s of review.slice(0, 2)) sync.push(await captionSync(ctx, s.id, rendered.find((x) => x.id === s.id)!.propsPath, vdir));

    const report = await buildReport(ctx, ing, sig, cands, review, sync, (performance.now() - t0) / 1000);
    await Bun.write(join(ctx.outDir, 'REPORT.md'), report);
    console.log(`  ${review.length} short in ${ctx.outDir}`);
    for (const s of review) console.log(`    ${s.file} ${s.duration} s ${s.measures.width}×${s.measures.height} ${s.measures.fps} fps ${s.measures.lufs} LUFS ${s.measures.truePeak} dBTP — ${s.score}/10 "${s.hook}"${s.warnings.length ? ` ⚠ ${s.warnings.length}` : ''}`);
    for (const x of sync) console.log(`    sincronia ${x.id}: ${x.matched}/${x.total} parole, scarto mediano ${x.medianMs} ms, p90 ${x.p90Ms} ms`);
    return { shorts: review.length, sync };
  });
}

/** Ritrascrive l'audio dello short finito e confronta l'inizio di ogni parola con i sottotitoli. */
async function captionSync(ctx: Ctx, id: string, propsPath: string, vdir: string): Promise<SyncCheck> {
  const wav = join(vdir, `${id}.16k.wav`);
  await ffmpeg(['-i', join(ctx.outDir, `${id}.mp4`), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav]);
  const words = join(vdir, `${id}.words.json`);
  const models = await readModels();
  await py('transcribe.py', [wav, join(ROOT, models.parakeet!.dir), words]);
  const asr = ((await Bun.file(words).json()) as { words: { w: string; s: number }[] }).words.map((w) => ({ k: norm(w.w), s: w.s }));
  const props = (await Bun.file(propsPath).json()) as { lines: { words: { w: string; s: number }[] }[] };
  const caps = props.lines.flatMap((l) => l.words).map((w) => ({ k: norm(w.w), s: w.s }));
  const deltas: number[] = [];
  let j = 0;
  for (const c of caps) {
    // la parola uguale più vicina in avanti, entro 1,5 s
    for (let k = j; k < asr.length && asr[k]!.s < c.s + 1.5; k++) {
      if (asr[k]!.k === c.k && Math.abs(asr[k]!.s - c.s) <= 1.5) {
        deltas.push(Math.abs(asr[k]!.s - c.s) * 1000);
        j = k + 1;
        break;
      }
    }
  }
  const sorted = deltas.sort((a, b) => a - b);
  const q = (p: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? Number.NaN);
  return { id, matched: deltas.length, total: caps.length, medianMs: q(0.5), p90Ms: q(0.9), maxMs: Math.round(sorted.at(-1) ?? Number.NaN) };
}

async function gameMusic(sig: Signals): Promise<number[]> {
  if (!sig.game.seriesPath || !existsSync(sig.game.seriesPath)) return [];
  const s = (await Bun.file(sig.game.seriesPath).json()) as { music?: number[] };
  return s.music ?? [];
}

/** Quota di secondi con musica (probabilità ≥ 0,5) nella traccia gioco tra s ed e. */
function musicShare(music: number[], segs: Segment[]): number {
  const slice = segs.flatMap((x) => music.slice(Math.floor(x.s), Math.ceil(x.e)));
  return slice.length ? slice.filter((x) => x >= 0.5).length / slice.length : 0;
}

async function buildReport(ctx: Ctx, ing: Ingest, sig: Signals, cands: Candidate[], shorts: ReviewShort[], sync: SyncCheck[], totalS: number): Promise<string> {
  const stages = listStages(ctx.workDir);
  const llmMeta = (task: string) => {
    const d = join(ctx.workDir, 'llm', task);
    if (!existsSync(d)) return [];
    const metas = existsSync(join(d, 'meta.json')) ? [join(d, 'meta.json')] : readdirSync(d).map((x) => join(d, x, 'meta.json')).filter(existsSync);
    return metas.map((p) => JSON.parse(readFileSync(p, 'utf8')) as { backend: string; attempts?: number; duration_s: number; ok: boolean });
  };
  const claude = llmMeta('copy').filter((m) => m.backend === 'claude');
  const qwen = ['meaning', 'vision', 'rank'].map((t) => [t, llmMeta(t)] as const);
  const remotion = JSON.parse(readFileSync(join(ROOT, 'remotion', 'package.json'), 'utf8')).dependencies.remotion as string;
  const models = await readModels();
  const m = ing.main;
  const lines: string[] = [];
  const row = (...c: (string | number)[]) => lines.push(`| ${c.join(' | ')} |`);

  lines.push(`# Report: ${basename(ctx.video)}`, '');
  lines.push(`- ID: \`${ctx.id}\``);
  lines.push(`- Sorgente: ${m.video!.codec} ${m.video!.width}×${m.video!.height} ${m.video!.fps.toFixed(2)} fps, ${(m.duration / 60).toFixed(1)} min, ${m.audio.length} tracce audio, ${m.chapters.length} chapter`);
  lines.push(`- Voce: ${ing.voiceSource}. Gioco: ${ing.gameSource}.`);
  lines.push(`- Generato il ${new Date().toLocaleString('it-IT')}, tempo totale di questa esecuzione ${fmtDuration(totalS)}`, '');

  lines.push('## Tempi per fase', '', 'Durata dell\'ultima esecuzione vera di ogni fase (le fasi riprese non si ripetono).', '');
  row('Fase', 'Durata', 'Finita');
  row('---', '---:', '---');
  let sum = 0;
  for (const s of stages) {
    sum += s.duration_s;
    row(s.name, fmtDuration(s.duration_s), new Date(s.finished_at).toLocaleTimeString('it-IT'));
  }
  row('**Totale fasi**', `**${fmtDuration(sum)}**`, '');
  lines.push('');

  lines.push('## Segnali', '');
  row('Segnale', 'Stato', 'Finestre', 'Note');
  row('---', '---', '---:', '---');
  for (const s of Object.values(sig)) {
    const info = s.info ? Object.entries(s.info).filter(([k]) => k !== 'path').map(([k, v]) => `${k}: ${v}`).join(', ') : '';
    row(s.name, s.available ? 'trovato' : `**mancante**: ${s.missing}`, s.windows.length, info);
  }
  lines.push('', `Candidati: ${cands.length} (${((cands.length * 3600) / m.duration).toFixed(0)} per ora di video).`, '');

  lines.push('## Short', '');
  row('Short', 'Durata', 'Risoluzione', 'fps', 'LUFS', 'True peak', 'Layout', 'Voto', 'Gancio', 'Avvisi');
  row('---', '---:', '---', '---:', '---:', '---:', '---', '---:', '---', '---');
  for (const s of shorts) {
    row(s.file, `${s.duration} s`, `${s.measures.width}×${s.measures.height}`, s.measures.fps, s.measures.lufs, `${s.measures.truePeak} dBTP`, s.layout, `${s.score}/10`, s.hook, s.warnings.join('; ') || '—');
  }
  lines.push('');

  lines.push('## Sincronia dei sottotitoli', '', "L'audio di ogni short finito viene ritrascritto e l'inizio di ogni parola confrontato con quello del sottotitolo.", '');
  row('Short', 'Parole confrontate', 'Scarto mediano', 'p90', 'Massimo');
  row('---', '---:', '---:', '---:', '---:');
  for (const x of sync) row(x.id, `${x.matched}/${x.total}`, `${x.medianMs} ms`, `${x.p90Ms} ms`, `${x.maxMs} ms`);
  lines.push('');

  lines.push('## Modelli e chiamate', '');
  lines.push(`- Chiamate a Claude (\`claude -p --model sonnet\`, abbonamento): **${claude.reduce((a, x) => a + (x.attempts ?? 1), 0)}** (${claude.length} short, ${claude.reduce((a, x) => a + x.duration_s, 0).toFixed(0)} s in tutto)`);
  for (const [t, ms] of qwen) lines.push(`- Qwen (${process.env.LUCIO_MODEL_KEY ?? 'LUCIO_MODEL_KEY'}) per ${t}: ${ms.length} chiamate, ${ms.reduce((a, x) => a + x.duration_s, 0).toFixed(0)} s`);
  for (const [name, spec] of Object.entries(models)) lines.push(`- ${name}: ${'repo' in spec ? `${spec.repo}@${spec.revision.slice(0, 7)}` : spec.url}`);
  lines.push(`- Remotion ${remotion}`);
  lines.push(`- ffmpeg di sistema: \`${await ffmpegVersion()}\``, '');

  lines.push('## Problemi aperti', '');
  for (const s of Object.values(sig)) if (!s.available) lines.push(`- Segnale ${s.name} mancante: ${s.missing}.`);
  for (const s of shorts) if (s.warnings.length) lines.push(`- ${s.id}: ${s.warnings.join('; ')}.`);
  for (const x of OPEN_ISSUES) lines.push(`- ${x}`);
  lines.push('', '## Scelte fatte da me', '');
  for (const x of CHOICES) lines.push(`- ${x}`);
  lines.push('');
  return lines.join('\n');
}

function listStages(workDir: string): ({ name: string } & StageRecord)[] {
  const out: ({ name: string } & StageRecord)[] = [];
  const walk = (d: string, prefix: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || !/^\d\d-/.test(prefix || e.name)) continue;
      const p = join(d, e.name);
      const name = prefix ? `${prefix}/${e.name}` : e.name;
      if (existsSync(join(p, 'done.json'))) out.push({ name, ...(JSON.parse(readFileSync(join(p, 'done.json'), 'utf8')) as StageRecord) });
      else walk(p, name);
    }
  };
  walk(workDir, '');
  return out;
}

