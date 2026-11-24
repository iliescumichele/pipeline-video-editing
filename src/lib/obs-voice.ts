// La voce come la registrerebbe OBS con i filtri sull'Insta360 Mic Pro scelti a orecchio il 22/11 sera:
//   Noise Suppression (RNNoise) → 3-Band Equalizer (bassi −7,3, medi −2,8, alti +10,5 dB)
//   → Expander (RMS, soglia −35,2 dB, rapporto 2,5, uscita +27,7 dB) → Compressor (−21,9 dB, 3,5:1, 2/100 ms)
//   → Limiter (−0,2 dB), poi il taglio a 0 dBFS della registrazione.
// Gli algoritmi sono quelli di obs-filters (eq-filter.c, expander-filter.c, compressor-filter.c, limiter-filter.c);
// la riduzione del rumore la fa ffmpeg con arnndn e il modello standard di RNNoise (models/rnnoise/std.rnnn).
// Serve al tipo di voce "obs": si applica a registrazioni fatte senza filtri in OBS (livello del microfono del 22/11).
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FFMPEG } from './ff';
import { PATHS } from './env';

const SR = 48000;
export const RNNOISE_MODEL = join(PATHS.models, 'rnnoise', 'std.rnnn');

const db2mul = (db: number) => 10 ** (db / 20);
const mul2db = (m: number) => (m > 0 ? 20 * Math.log10(m) : Number.NEGATIVE_INFINITY);
const coef = (seconds: number) => Math.exp(-1 / (SR * seconds));

/** I filtri di OBS dopo la riduzione del rumore, su voce mono a 48 kHz. Restituisce i campioni tagliati a 0 dBFS. */
export function obsFilters(y: Float32Array): number {
  const n = y.length;
  // 3-Band Equalizer: l'algoritmo "3 band EQ" di musicdsp, bassi sotto 800 Hz, alti sopra 5 kHz
  {
    const low = db2mul(-7.3), mid = db2mul(-2.8), high = db2mul(10.5);
    const lf = 2 * Math.sin((Math.PI * 800) / SR);
    const hf = 2 * Math.sin((Math.PI * 5000) / SR);
    const EPS = 1 / 4294967295;
    let f1p0 = 0, f1p1 = 0, f1p2 = 0, f1p3 = 0, f2p0 = 0, f2p1 = 0, f2p2 = 0, f2p3 = 0, sdm1 = 0, sdm2 = 0, sdm3 = 0;
    for (let i = 0; i < n; i++) {
      const s = y[i]!;
      f1p0 += lf * (s - f1p0) + EPS;
      f1p1 += lf * (f1p0 - f1p1);
      f1p2 += lf * (f1p1 - f1p2);
      f1p3 += lf * (f1p2 - f1p3);
      const l = f1p3;
      f2p0 += hf * (s - f2p0) + EPS;
      f2p1 += hf * (f2p0 - f2p1);
      f2p2 += hf * (f2p1 - f2p2);
      f2p3 += hf * (f2p2 - f2p3);
      const h = sdm3 - f2p3;
      const m = sdm3 - (h + l);
      sdm3 = sdm2;
      sdm2 = sdm1;
      sdm1 = s;
      y[i] = l * low + m * mid + h * high;
    }
  }
  // Expander: rilevatore RMS, attacco 10 ms e rilascio 50 ms; sotto la soglia toglie (rapporto − 1) dB per dB
  {
    const threshold = -35.2, ratio = 2.5, out = db2mul(27.7);
    const atk = coef(0.01), rel = coef(0.05), rmscoef = 2 ** (-100 / SR);
    let env = 0, rms = 0;
    for (let i = 0; i < n; i++) {
      const s = y[i]!;
      rms = rmscoef * rms + (1 - rmscoef) * s * s;
      const e = Math.sqrt(rms);
      env = env < e ? e + atk * (env - e) : e + rel * (env - e);
      const diff = threshold - mul2db(env);
      const gain = diff > 0 ? Math.max((1 - ratio) * diff, -60) : 0;
      y[i] = s * db2mul(gain) * out;
    }
  }
  const compress = (threshold: number, ratio: number, attack: number, release: number) => {
    const atk = coef(attack), rel = coef(release), slope = 1 - 1 / ratio;
    let env = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(y[i]!);
      env = env < a ? a + atk * (env - a) : a + rel * (env - a);
      y[i] = y[i]! * db2mul(Math.min(0, slope * (threshold - mul2db(env))));
    }
  };
  compress(-21.9, 3.5, 0.002, 0.1);
  // Limiter: un compressore a rapporto infinito, attacco 1 ms, rilascio 60 ms
  compress(-0.2, Number.POSITIVE_INFINITY, 0.001, 0.06);
  let clipped = 0;
  for (let i = 0; i < n; i++) {
    if (y[i]! > 1) (y[i] = 1), clipped++;
    else if (y[i]! < -1) (y[i] = -1), clipped++;
  }
  return clipped;
}

/**
 * Voce di `input` (stream `map`, per esempio "0:a:1") passata dai filtri di OBS, in un WAV mono float a 48 kHz.
 * Si rifà solo se cambia il file d'ingresso. Tutta la voce sta in memoria: circa 0,8 GB all'ora.
 */
export async function obsVoiceFile(input: string, map: string, out: string): Promise<string> {
  if (!existsSync(RNNOISE_MODEL)) throw new Error(`manca il modello di RNNoise: ${RNNOISE_MODEL}`);
  const st = statSync(input);
  const key = JSON.stringify({ input, map, size: st.size, mtime: st.mtimeMs, version: 1 });
  if (existsSync(out) && existsSync(`${out}.json`) && readFileSync(`${out}.json`, 'utf8') === key) return out;
  mkdirSync(dirname(out), { recursive: true });
  const dec = Bun.spawn([FFMPEG, '-v', 'error', '-i', input, '-map', map, '-af', `pan=mono|c0=c0,arnndn=m=${RNNOISE_MODEL}`, '-ar', String(SR), '-f', 'f32le', '-'], { stdout: 'pipe', stderr: 'inherit' });
  const raw = new Uint8Array(await new Response(dec.stdout).arrayBuffer());
  if ((await dec.exited) !== 0) throw new Error('lettura della voce non riuscita');
  const y = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
  const clipped = obsFilters(y);
  const tmp = `${out}.part.wav`;
  const enc = Bun.spawn([FFMPEG, '-v', 'error', '-y', '-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', '-', '-c:a', 'pcm_f32le', tmp], { stdin: 'pipe', stderr: 'inherit' });
  enc.stdin.write(new Uint8Array(y.buffer, y.byteOffset, y.byteLength));
  await enc.stdin.end();
  if ((await enc.exited) !== 0) throw new Error('scrittura della voce non riuscita');
  renameSync(tmp, out);
  writeFileSync(`${out}.json`, key);
  console.log(`Voce con i filtri di OBS: ${out} (${clipped} campioni tagliati a 0 dBFS)`);
  return out;
}
