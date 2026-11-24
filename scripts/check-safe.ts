// bun scripts/check-safe.ts <work/<id>/08-render/<short>> <cartella di uscita>
//
// Renderizza tre fotogrammi dello short con le zone vietate in rosso (200 px in alto, 140 px a
// destra, 20% in basso): il gancio, la riga di sottotitoli più lunga e lo zoom più forte.
import { mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { ROOT } from '../src/lib/env';

const [dirArg, outArg] = process.argv.slice(2);
if (!dirArg || !outArg) {
  console.error('uso: bun scripts/check-safe.ts <cartella 08-render/<short>> <cartella di uscita>');
  process.exit(2);
}
// Remotion gira dentro remotion/: i percorsi devono essere assoluti.
const dir = resolve(dirArg);
const out = resolve(outArg);
mkdirSync(out, { recursive: true });
const props = await Bun.file(join(dir, 'props.json')).json();
const debugProps = join(out, `${basename(dir)}.props.json`);
await Bun.write(debugProps, JSON.stringify({ ...props, safeDebug: true }));

const longest = [...props.lines].sort(
  (a: { words: { w: string }[] }, b: { words: { w: string }[] }) => b.words.map((w) => w.w).join(' ').length - a.words.map((w) => w.w).join(' ').length,
)[0];
const moments: [string, number][] = [['gancio', 0.7]];
if (longest) moments.push(['riga-lunga', (longest.s + longest.e) / 2]);
if (props.zooms.length) moments.push(['zoom', props.zooms[0] + 0.3]);

for (const [name, t] of moments) {
  const file = join(out, `${basename(dir)}-${name}.png`);
  const proc = Bun.spawn(
    ['bunx', 'remotion', 'still', 'src/index.ts', 'Short', file, `--props=${debugProps}`, `--frame=${Math.round(t * props.fps)}`, `--public-dir=${dir}`, '--log=error'],
    { cwd: join(ROOT, 'remotion'), stdout: 'pipe', stderr: 'pipe' },
  );
  if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
  console.log(file);
}
