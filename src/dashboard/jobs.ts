import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib/env';
import { DATA, db, now } from './db';

export interface Job {
  id: number;
  kind: string;
  title: string;
  argv: string;
  status: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
}

const LOGS = join(DATA, 'jobs');
mkdirSync(LOGS, { recursive: true });
// Il dev server della dashboard (Vite) può rivalutare questo modulo mentre un lavoro gira: lo stato
// sta su globalThis, così non si perde il processo in corso e non ne parte un secondo.
const state = ((globalThis as { __lucioJobs?: { running?: { id: number; proc: ReturnType<typeof Bun.spawn> }; started: boolean } }).__lucioJobs ??= { started: false });

// Un riavvio della dashboard interrompe i lavori che erano in corso.
if (!state.started) {
  state.started = true;
  db.run(`UPDATE jobs SET status = 'interrotto', finished_at = ? WHERE status = 'in corso'`, [now()]);
}

/**
 * Mette in coda un comando del progetto (bun ...). I lavori pesanti usano la GPU, quindi ne gira
 * uno alla volta; l'output va in data/jobs/<id>.log.
 */
export function enqueue(kind: string, title: string, argv: string[]): Job {
  const r = db.query(`INSERT INTO jobs (kind, title, argv, status, created_at) VALUES (?, ?, ?, 'in coda', ?) RETURNING *`).get(kind, title, JSON.stringify(argv), now()) as Job;
  void next();
  return r;
}

export function listJobs(limit = 30): Job[] {
  return db.query(`SELECT * FROM jobs ORDER BY id DESC LIMIT ?`).all(limit) as Job[];
}

export function jobLog(id: number, tail = 400): string {
  const p = join(LOGS, `${id}.log`);
  if (!existsSync(p)) return '';
  // Le barre di avanzamento usano \r: si tiene solo l'ultimo stato di ogni riga.
  const lines = readFileSync(p, 'utf8').split('\n').map((l) => l.split('\r').filter(Boolean).at(-1) ?? '');
  return lines.slice(-tail).join('\n');
}

export function cancel(id: number): boolean {
  if (state.running?.id === id) {
    state.running.proc.kill('SIGINT');
    return true;
  }
  return db.run(`UPDATE jobs SET status = 'annullato', finished_at = ? WHERE id = ? AND status = 'in coda'`, [now(), id]).changes > 0;
}

async function next(): Promise<void> {
  if (state.running) return;
  const job = db.query(`SELECT * FROM jobs WHERE status = 'in coda' ORDER BY id LIMIT 1`).get() as Job | null;
  if (!job) return;
  db.run(`UPDATE jobs SET status = 'in corso', started_at = ? WHERE id = ?`, [now(), job.id]);
  const proc = Bun.spawn(JSON.parse(job.argv) as string[], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  state.running = { id: job.id, proc };
  // stdout e stderr nello stesso log, nell'ordine in cui arrivano, scritti subito per la vista dal vivo.
  const sink = Bun.file(join(LOGS, `${job.id}.log`)).writer();
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) {
      sink.write(chunk);
      sink.flush();
    }
  };
  await Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>), pump(proc.stderr as ReadableStream<Uint8Array>)]);
  await sink.end();
  const code = await proc.exited;
  db.run(`UPDATE jobs SET status = ?, finished_at = ?, exit_code = ? WHERE id = ?`, [code === 0 ? 'finito' : proc.signalCode ? 'interrotto' : 'fallito', now(), code, job.id]);
  state.running = undefined;
  void next();
}

export function runningJob(): number | undefined {
  return state.running?.id;
}
