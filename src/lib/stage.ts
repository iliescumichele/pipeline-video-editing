import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export interface Ctx {
  /** <slug>-<hash>, nome della cartella in work/ e out/ */
  id: string;
  video: string;
  vertical?: string;
  lucioLog?: string;
  count: number;
  workDir: string;
  outDir: string;
  /** fasi da rifare anche se già fatte */
  force: Set<string>;
}

export interface StageRecord {
  hash: string;
  duration_s: number;
  finished_at: string;
  result: unknown;
}

/**
 * Esegue una fase in work/<id>/<name>/ e ne salva il risultato in done.json. Se done.json esiste e
 * `key` (versione, parametri, risultati delle fasi precedenti) non è cambiata, la fase si salta.
 */
export async function stage<T>(ctx: Ctx, name: string, key: unknown, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = join(ctx.workDir, name);
  const donePath = join(dir, 'done.json');
  const hash = new Bun.CryptoHasher('sha256').update(JSON.stringify(key)).digest('hex').slice(0, 16);

  if (!ctx.force.has(name) && existsSync(donePath)) {
    const done = (await Bun.file(donePath).json()) as StageRecord;
    if (done.hash === hash) {
      console.log(`↷ ${name} già fatta (${fmtDuration(done.duration_s)})`);
      return done.result as T;
    }
  }

  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  console.log(`▸ ${name}`);
  const t0 = performance.now();
  const result = await fn(dir);
  const duration_s = Math.round((performance.now() - t0) / 100) / 10;
  const record: StageRecord = { hash, duration_s, finished_at: new Date().toISOString(), result };
  await Bun.write(donePath, `${JSON.stringify(record, null, 2)}\n`);
  appendFileSync(join(ctx.workDir, 'log.jsonl'), `${JSON.stringify({ stage: name, duration_s, at: record.finished_at })}\n`);
  console.log(`✓ ${name} (${fmtDuration(duration_s)})`);
  return result;
}

/**
 * Quando è finita l'ultima esecuzione di una fase: va nella `key` delle fasi che ne dipendono,
 * così se una fase viene rifatta anche quelle a valle si rifanno.
 */
export function stamp(ctx: Ctx, name: string): string {
  const path = join(ctx.workDir, name, 'done.json');
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as StageRecord).finished_at : '';
}

export function fmtDuration(s: number): string {
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}
