// bun run setup — installa tutto dentro il progetto: pacchetti JS, Python 3.12 con le sue
// librerie (uv) e i modelli elencati in models.json. Si può rilanciare: salta quello che c'è già.
import { existsSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { localEnv, PATHS, readModels, ROOT } from '../src/lib/env';

const env = localEnv();

async function run(cmd: string[], cwd = ROOT): Promise<void> {
  console.log(`  $ ${cmd.join(' ')}`);
  const proc = Bun.spawn(cmd, { cwd, env, stdout: 'inherit', stderr: 'inherit' });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd.slice(0, 3).join(' ')} è uscito con codice ${code}`);
}

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  const t0 = performance.now();
  console.log(`\n▸ ${name}`);
  await fn();
  console.log(`  ✓ ${name} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
}

await step('Strumenti di sistema', async () => {
  const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
  const required = [ffmpeg, 'ffprobe', 'uv', 'lms', 'claude'];
  const missing = required.filter((t) => !Bun.which(t));
  if (missing.length) throw new Error(`mancano: ${missing.join(', ')} (installali con brew)`);
  console.log(`  ${required.map((t) => `${t} → ${Bun.which(t)}`).join('\n  ')}`);

  // Il modello di LM Studio vive nell'app, non nel progetto: qui si controlla soltanto che ci sia.
  const key = process.env.LUCIO_MODEL_KEY;
  if (!key) throw new Error('manca LUCIO_MODEL_KEY in .env');
  const models = JSON.parse(Bun.spawnSync(['lms', 'ls', '--json']).stdout.toString() || '[]') as { modelKey: string }[];
  if (!models.some((m) => m.modelKey === key)) throw new Error(`${key} non è scaricato in LM Studio (lms get ${key})`);
  console.log(`  LM Studio → ${key} presente`);
});

await step('Pacchetti JS', async () => {
  for (const dir of [ROOT, join(ROOT, 'remotion'), join(ROOT, 'studio')]) {
    if (existsSync(join(dir, 'package.json'))) await run(['bun', 'install'], dir);
  }
  // Chrome Headless Shell per Remotion: finisce in remotion/node_modules/.remotion
  await run(['bunx', 'remotion', 'browser', 'ensure'], join(ROOT, 'remotion'));
});

await step('Python 3.12 e librerie', async () => {
  await run(['uv', 'python', 'install', '--no-bin', '3.12']);
  await run(['uv', 'sync', '--project', PATHS.python]);
});

await step('Modelli', async () => {
  for (const [name, m] of Object.entries(await readModels())) {
    const dir = join(ROOT, m.dir);
    if ('git' in m) {
      // codice da una repo git, a un commit fisso
      if (existsSync(join(dir, '.git')) && Bun.spawnSync(['git', '-C', dir, 'rev-parse', 'HEAD']).stdout.toString().trim() === m.commit) {
        console.log(`  ${name}: già presente (${m.commit.slice(0, 7)})`);
        continue;
      }
      rmSync(dir, { recursive: true, force: true });
      await run(['git', 'clone', '-q', m.git, dir]);
      await run(['git', '-C', dir, 'checkout', '-q', m.commit]);
      continue;
    }
    if ('url' in m) {
      const file = join(dir, basename(new URL(m.url).pathname));
      if (await Bun.file(file).exists()) {
        console.log(`  ${name}: già presente`);
        continue;
      }
      console.log(`  ${name}: scarico ${m.url}`);
      const res = await fetch(m.url);
      if (!res.ok) throw new Error(`${name}: download fallito (${res.status})`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const sha = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
      if (!sha.startsWith(m.sha256_prefix)) throw new Error(`${name}: sha256 ${sha} non inizia con ${m.sha256_prefix}`);
      await Bun.write(file, bytes);
      continue;
    }
    const marker = Bun.file(join(dir, '.complete'));
    if ((await marker.exists()) && (await marker.text()).trim() === m.revision) {
      console.log(`  ${name}: già presente (${m.revision.slice(0, 7)})`);
      continue;
    }
    await run([
      'uv', 'run', '--project', PATHS.python, '--no-sync',
      'hf', 'download', m.repo, ...(m.include ?? []), '--revision', m.revision, '--local-dir', dir,
    ]);
    // I file .incomplete restano se un download è stato interrotto e poi ripreso: non servono più.
    for (const f of new Bun.Glob('.cache/huggingface/download/*.incomplete').scanSync({ cwd: dir, dot: true })) rmSync(join(dir, f));
    await Bun.write(marker, `${m.revision}\n`);
  }
});

console.log('\nPronto. Per pulire tutto: bun run clean');
