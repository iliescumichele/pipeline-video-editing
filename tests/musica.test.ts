// Sostituzione delle canzoni protette (docs/musica.md): audio sintetici, il parlato lo fa `say` di macOS.
// I casi con la separazione usano BandIt Plus (models/bandit-dnr): senza modello si saltano.
import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSegments, parseTime } from '../src/gameplay/musica';
import { PATHS } from '../src/lib/env';
import { py } from '../src/lib/py';

const dir = mkdtempSync(join(tmpdir(), 'musica-test-'));
const SR = 48000;
const hasModel = existsSync(join(PATHS.models, 'bandit-dnr', 'model_bandit_plus_dnr_sdr_11.47.chpt')) && existsSync(join(PATHS.tools, 'msst'));
const hasSay = !!Bun.which('say');

function ff(args: string[]): void {
  const r = Bun.spawnSync(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', ...args], { stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

/** Campioni interi a 24 bit di un FLAC (come li scrive e legge la pipeline), via ffmpeg. */
function samples(file: string, from = 0, dur?: number): Int32Array {
  const r = Bun.spawnSync(['ffmpeg', '-v', 'error', '-ss', String(from), ...(dur ? ['-t', String(dur)] : []), '-i', file, '-f', 's32le', '-'], { stdout: 'pipe' });
  return new Int32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.byteLength));
}

/** Campioni float (stereo interlacciati) di un file. */
function floats(file: string, from = 0, dur?: number): Float32Array {
  const r = Bun.spawnSync(['ffmpeg', '-v', 'error', '-ss', String(from), ...(dur ? ['-t', String(dur)] : []), '-i', file, '-ac', '2', '-ar', String(SR), '-f', 'f32le', '-'], { stdout: 'pipe' });
  return new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.byteLength));
}

const equal = (a: Int32Array, b: Int32Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const corr = (a: Float32Array, b: Float32Array) => {
  const n = Math.min(a.length, b.length);
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < n; i++) {
    ab += a[i]! * b[i]!;
    aa += a[i]! * a[i]!;
    bb += b[i]! * b[i]!;
  }
  return ab / Math.sqrt(aa * bb + 1e-20);
};
const flac24 = ['-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24', '-ar', String(SR), '-ac', '2'];

// "musica": un accordo che pulsa e un basso; "musica nuova": un altro accordo e un altro ritmo
const MUSIC = "0.12*(sin(2*PI*220*t)+sin(2*PI*277.2*t)+sin(2*PI*329.6*t))*(0.55+0.45*sin(2*PI*2*t))+0.15*sin(2*PI*55*t)*(0.5+0.5*sin(2*PI*4*t))";
const NEW_MUSIC = "0.12*(sin(2*PI*196*t)+sin(2*PI*246.9*t)+sin(2*PI*293.7*t))*(0.6+0.4*sin(2*PI*3*t))+0.15*sin(2*PI*49*t)*(0.5+0.5*sin(2*PI*6*t))";

beforeAll(() => {
  if (hasSay) {
    Bun.spawnSync(['say', '-o', join(dir, 'speech.aiff'), 'Hey, listen to me. We need to get out of the city before the cops find the car. Drive to the docks, and do not stop for anything, okay? I mean it this time.']);
    // dialogo da 8 s: 12 secondi di parlato, sopra un fondo di rumore
    ff(['-i', join(dir, 'speech.aiff'), '-af', 'adelay=8000:all=1,apad=whole_dur=30,volume=0.8', ...flac24, join(dir, 'speech.flac')]);
  }
  ff(['-f', 'lavfi', '-i', `aevalsrc=${MUSIC}:s=${SR}:d=30`, '-af', 'volume=enable=\'lt(t,5)+gt(t,25)\':volume=0', ...flac24, join(dir, 'music.flac')]);
  ff(['-f', 'lavfi', '-i', `aevalsrc=${NEW_MUSIC}:s=${SR}:d=40`, '-ac', '2', '-c:a', 'pcm_f32le', join(dir, 'new.wav')]);
  ff(['-f', 'lavfi', '-i', `anoisesrc=d=30:c=pink:a=0.004:r=${SR}`, ...flac24, join(dir, 'noise.flac')]);
});

describe('file dei tratti scritti a mano', () => {
  test('tempi in tutti i formati', () => {
    expect(parseTime('1:16:25')).toBe(4585);
    expect(parseTime('76:25')).toBe(4585);
    expect(parseTime('4585.5')).toBe(4585.5);
  });
  test('righe, brani e commenti', () => {
    const s = parseSegments('# copiati da YouTube Studio\n1:16:25 - 1:18:24 Patrick Patrikios - Crazy\n2:00:00–2:01:30\n');
    expect(s).toEqual([{ start: 4585, end: 4704, music: 'Patrick Patrikios - Crazy' }, { start: 7200, end: 7290 }]);
    expect(() => parseSegments('5:00 - 4:00')).toThrow();
  });
});

describe('sostituzione', () => {
  test('più tratti: fuori dai tratti e fra un tratto e l’altro il gioco resta identico bit per bit', async () => {
    const game = join(dir, 'game-multi.flac');
    ff(['-i', join(dir, 'music.flac'), '-i', join(dir, 'noise.flac'), '-filter_complex', 'amix=inputs=2:normalize=0', ...flac24, game]);
    const spec = join(dir, 'multi.json');
    writeFileSync(spec, JSON.stringify([
      { id: 'a', start: 6, end: 12, music: join(dir, 'new.wav'), mode: 'sostituisci' },
      { id: 'b', start: 16, end: 22, music: join(dir, 'new.wav'), mode: 'aggiungi' },
    ]));
    const out = join(dir, 'multi-out.flac');
    await py('replace_music.py', [game, out, '--segments', spec, '--no-separate'], { capture: true });
    for (const [a, b] of [[0, 6], [12, 4], [22, 8]] as const) expect(equal(samples(game, a, b), samples(out, a, b))).toBe(true);
    expect(equal(samples(game, 8, 2), samples(out, 8, 2))).toBe(false);
  });

  test.skipIf(!hasModel || !hasSay)('musica sotto un dialogo: il dialogo resta, la musica cambia, fuori tutto identico', async () => {
    const game = join(dir, 'game-dialog.flac');
    ff(['-i', join(dir, 'music.flac'), '-i', join(dir, 'speech.flac'), '-i', join(dir, 'noise.flac'), '-filter_complex', 'amix=inputs=3:normalize=0', ...flac24, game]);
    const out = join(dir, 'dialog-out.flac');
    const report = join(dir, 'dialog.json');
    const parts = join(dir, 'parti');
    await py('replace_music.py', [game, out, '--music', join(dir, 'new.wav'), '--start', '5', '--end', '25', '--stems-out', parts, '--report', report], { capture: true });
    const r = JSON.parse(readFileSync(report, 'utf8')) as { segments: { mode: string; music_present_pct: number }[] };
    expect(r.segments[0]!.mode).toBe('sostituisci');
    // fuori dal tratto identico
    expect(equal(samples(game, 0, 5), samples(out, 0, 5))).toBe(true);
    expect(equal(samples(game, 25), samples(out, 25))).toBe(true);
    // il dialogo separato è quello originale (dal secondo 8 al 20 del video, cioè 3–15 del tratto)
    const speech = floats(join(dir, 'speech.flac'), 9, 10);
    expect(corr(floats(join(parts, 'dialoghi.flac'), 4, 10), speech)).toBeGreaterThan(0.9);
    // nel risultato c'è ancora il dialogo, e la musica vecchia quasi non c'è più
    expect(corr(floats(out, 9, 10), speech)).toBeGreaterThan(0.6);
    expect(Math.abs(corr(floats(out, 9, 10), floats(join(dir, 'music.flac'), 9, 10)))).toBeLessThan(0.2);
  }, 240_000);

  test.skipIf(!hasModel || !hasSay)('nessuna musica nel tratto: niente da togliere, il gioco resta intatto e la musica si aggiunge', async () => {
    const game = join(dir, 'game-nomusic.flac');
    ff(['-i', join(dir, 'speech.flac'), '-i', join(dir, 'noise.flac'), '-filter_complex', 'amix=inputs=2:normalize=0', ...flac24, game]);
    const out = join(dir, 'nomusic-out.flac');
    const report = join(dir, 'nomusic.json');
    const parts = join(dir, 'parti-nomusic');
    await py('replace_music.py', [game, out, '--music', join(dir, 'new.wav'), '--start', '5', '--end', '25', '--stems-out', parts, '--report', report], { capture: true });
    const r = JSON.parse(readFileSync(report, 'utf8')) as { segments: { mode: string }[] };
    expect(r.segments[0]!.mode).toBe('aggiungi');
    // gioco nuovo − musica aggiunta = gioco originale (a meno dell'arrotondamento a 24 bit)
    const a = floats(game, 5, 20);
    const b = floats(out, 5, 20);
    const m = floats(join(parts, 'musica-nuova.flac'), 0, 20);
    let err = 0, pow = 0;
    for (let i = 0; i < a.length; i++) {
      err += (b[i]! - m[i]! - a[i]!) ** 2;
      pow += a[i]! ** 2;
    }
    expect(10 * Math.log10(err / pow)).toBeLessThan(-80);
    expect(equal(samples(game, 0, 5), samples(out, 0, 5))).toBe(true);
  }, 240_000);
});

describe('rilevamento (riconoscimento finto, senza rete)', () => {
  const run = async (fake: Record<string, unknown>, extra: string[] = []) => {
    const game = join(dir, 'game-detect.flac');
    if (!existsSync(game)) ff(['-f', 'lavfi', '-i', `aevalsrc=${MUSIC}:s=${SR}:d=120`, ...flac24, game]);
    const f = join(dir, `fake-${Object.keys(fake).length}-${extra.length}.json`);
    writeFileSync(f, JSON.stringify(fake));
    const out = `${f}.out.json`;
    await py('detect_songs.py', [game, out, '--fake', f, '--pause', '0', '--no-refine', ...extra], { capture: true });
    return JSON.parse(readFileSync(out, 'utf8')) as { status: string; segments: { start: number; end: number; title: string; hits: number }[]; errors: unknown[] };
  };
  const song = { key: '1', title: 'Kiss You All Over', artist: 'Exile' };

  test('finestre consecutive della stessa canzone → un tratto; una finestra sola non basta', async () => {
    const r = await run({ '24': song, '48': song, '30': song, '36': song, '42': song, '96': { key: '2', title: 'Falso', artist: 'x' } });
    expect(r.status).toBe('ok');
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]).toMatchObject({ title: 'Kiss You All Over', start: 24, end: 60 });
  });

  test('nessuna canzone: nessun tratto, si prosegue', async () => {
    const r = await run({});
    expect(r).toMatchObject({ status: 'ok', segments: [] });
  });

  test('Shazam non risponde: ci si ferma con quello che c’è e lo si segnala', async () => {
    const r = await run({ '0': 'errore', '24': 'errore', '48': 'errore', '72': song, '96': song });
    expect(r.status).toBe('bloccato');
    expect(r.errors).toHaveLength(3);
    expect(r.segments).toHaveLength(0);
  });
});
