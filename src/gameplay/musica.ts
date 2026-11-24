// bun run musica — canzoni protette su un audio qualsiasi, anche già esportato (vedi docs/musica.md).
//
//   bun run musica cerca     <audio o video>                         canzoni trovate da Shazam → <file>.canzoni.json
//   bun run musica pulisci   <audio o video> --tratti tratti.txt     sostituisce i tratti → <file>.senza-canzoni.flac
//                            [--musica brano] [--modo auto|sostituisci|aggiungi] [--out file]
//   bun run musica indicizza                                         impronte e BPM della libreria (solo i brani nuovi)
//
// tratti.txt: una riga per tratto, "inizio - fine [brano]", tempi come 1:16:25 o 76:25 o 4585 (per esempio copiati dai
// "Controlli" di YouTube Studio dopo un caricamento privato). Il brano è un file, o "Autore - Titolo" della libreria;
// senza, quello di --musica. Le righe che cominciano con # si saltano. Con --tratti il rilevamento non si fa.
// Si usa la prima traccia audio del file: su un video esportato è il mix (la voce finisce nei "dialoghi" e resta).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { FFMPEG } from '../lib/ff';
import { libraryDir, readMusicConfig } from '../lib/music-config';
import { py } from '../lib/py';
import { libraryTracks } from './music';

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: { tratti: { type: 'string' }, musica: { type: 'string' }, modo: { type: 'string', default: 'auto' }, out: { type: 'string' } },
});
const [command, input] = positionals;

/** "1:16:25", "76:25", "4585" o "4585.5" → secondi. */
export function parseTime(t: string): number {
  const parts = t.trim().split(':').map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) throw new Error(`tempo non valido: ${t}`);
  return parts.reduce((s, n) => s * 60 + n, 0);
}

/** Le righe di un file di tratti: inizio, fine e (facoltativo) il brano. */
export function parseSegments(text: string): { start: number; end: number; music?: string }[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const m = /^([\d:.]+)\s*[-–—]\s*([\d:.]+)\s*(.*)$/.exec(l);
      if (!m) throw new Error(`riga non valida: "${l}" (serve "inizio - fine [brano]")`);
      const start = parseTime(m[1]!);
      const end = parseTime(m[2]!);
      if (!(end > start)) throw new Error(`la fine viene prima dell'inizio: "${l}"`);
      return { start, end, ...(m[3] ? { music: m[3].trim() } : {}) };
    });
}

function ff(args: string[]): void {
  const r = Bun.spawnSync([FFMPEG, '-hide_banner', '-loglevel', 'error', '-y', ...args], { stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`ffmpeg: ${r.stderr.toString().trim().split('\n').slice(-3).join(' ')}`);
}

/** Un brano: un file, o "Autore - Titolo" (o solo il titolo) della libreria. */
function findMusic(name: string): string {
  if (existsSync(resolve(name))) return resolve(name);
  const n = name.toLowerCase();
  const t = libraryTracks().find((x) => `${x.artist} - ${x.title}`.toLowerCase() === n || x.title.toLowerCase() === n);
  if (!t) throw new Error(`brano non trovato né come file né nella libreria (${libraryDir()}): ${name}`);
  return t.file;
}

async function main(): Promise<void> {
  const c = readMusicConfig();
  if (command === 'indicizza') {
    await py('music_index.py', ['index', libraryDir(), join(libraryDir(), '.indice.json')]);
    return;
  }
  if (!input || !['cerca', 'pulisci'].includes(command ?? '')) {
    console.error('uso: bun run musica cerca <file> | pulisci <file> --tratti tratti.txt [--musica brano] | indicizza');
    process.exit(2);
  }
  const file = resolve(input);
  if (!existsSync(file)) throw new Error(`file non trovato: ${file}`);
  const base = join(dirname(file), basename(file, extname(file)));
  const work = `${base}.musica`;
  mkdirSync(work, { recursive: true });
  const game = join(work, 'audio.flac');
  console.log(`Estraggo l'audio di ${basename(file)} (24 bit, senza perdite)…`);
  ff(['-i', file, '-map', '0:a:0', '-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24', '-ar', '48000', game]);

  if (command === 'cerca') {
    const out = values.out ? resolve(values.out) : `${base}.canzoni.json`;
    await py('detect_songs.py', [game, out, '--window', String(c.windowS), '--coarse-hop', String(c.coarseHopS), '--hop', String(c.hopS), '--pause', String(c.pauseS), '--silence-db', String(c.silenceDb), '--min-hits', String(c.minHits)]);
    const r = JSON.parse(readFileSync(out, 'utf8')) as { status: string; segments: { start: number; end: number; artist: string; title: string }[] };
    // le stesse righe che `pulisci --tratti` legge: si aggiunge il brano e si passa a pulisci
    const lines = r.segments.map((s) => `${s.start.toFixed(1)} - ${s.end.toFixed(1)}   # ${s.artist} – ${s.title}`);
    writeFileSync(`${base}.tratti.txt`, `# canzoni trovate (Shazam: ${r.status}): aggiungi il brano dopo i tempi, poi bun run musica pulisci\n${lines.join('\n')}\n`);
    console.log(`Canzoni trovate: ${r.segments.length} (Shazam: ${r.status}). Tratti in ${base}.tratti.txt`);
    return;
  }

  if (!values.tratti) throw new Error('servono i tratti: --tratti tratti.txt (o prima bun run musica cerca)');
  const segs = parseSegments(readFileSync(resolve(values.tratti), 'utf8').replace(/#.*$/gm, ''));
  if (!segs.length) {
    console.log('Nessun tratto: niente da sostituire.');
    return;
  }
  const spec = segs.map((s, i) => {
    const name = s.music ?? values.musica;
    if (!name) throw new Error(`manca il brano per il tratto ${i + 1}: scrivilo nella riga o usa --musica`);
    const wav = join(work, `brano-${i + 1}.wav`);
    ff(['-i', findMusic(name), '-map', '0:a:0', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_f32le', wav]);
    return { id: `t${i + 1}`, start: s.start, end: s.end, music: wav, mode: values.modo, add_level_db: 0 };
  });
  const specFile = join(work, 'tratti.json');
  writeFileSync(specFile, JSON.stringify(spec, null, 2));
  const out = values.out ? resolve(values.out) : `${base}.senza-canzoni.flac`;
  await py('replace_music.py', [game, out, '--segments', specFile, '--report', `${base}.musica.json`, '--fade', String(c.fadeS), '--margin', String(c.marginS), '--max-gain-db', String(c.maxGainDb), '--silence-db', String(c.musicSilenceDb)]);
  console.log(`Fatto: ${out}\nReport: ${base}.musica.json\nPer rimetterlo in un video senza ricodificarlo: ffmpeg -i video.mp4 -i "${out}" -map 0:v -map 1:a -c:v copy -c:a aac -b:a 320k uscita.mp4`);
}

if (import.meta.main) await main();
