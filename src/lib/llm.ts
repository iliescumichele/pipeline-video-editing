import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './env';

export interface LlmTask {
  backend: 'local' | 'direct' | 'claude' | 'decide' | 'embed';
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  think?: boolean;
  images?: string[];
  temperature?: number;
  max_tokens?: number;
  timeout_s?: number;
  retries?: number;
}

/** Prompt di un compito: prompts/<name>/system.md e schema.json, modificabili a mano. */
export async function loadPrompt(name: string): Promise<{ system: string; schema: unknown }> {
  const dir = join(ROOT, 'prompts', name);
  return { system: await Bun.file(join(dir, 'system.md')).text(), schema: await Bun.file(join(dir, 'schema.json')).json() };
}

/**
 * Prepara la cartella del compito e la fa eseguire a `bun llm.ts run`. llm.ts riusa output.json
 * se gli ingressi non sono cambiati, quindi una fase interrotta riparte dal compito mancante; `force` lo rifà comunque.
 */
export async function runTask<T>(dir: string, task: LlmTask, system: string, input: string, schema: unknown, force = false): Promise<T> {
  mkdirSync(dir, { recursive: true });
  await Bun.write(join(dir, 'task.json'), `${JSON.stringify(task, null, 2)}\n`);
  await Bun.write(join(dir, 'system.md'), system);
  await Bun.write(join(dir, 'input.md'), input);
  await Bun.write(join(dir, 'schema.json'), `${JSON.stringify(schema, null, 2)}\n`);
  await llm(['run', dir, ...(force ? ['--force'] : [])]);
  return Bun.file(join(dir, 'output.json')).json() as Promise<T>;
}

export async function llm(args: string[]): Promise<void> {
  const proc = Bun.spawn(['bun', join(ROOT, 'llm.ts'), ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const text = `${out}${err}`.trim();
  if (code !== 0) throw new Error(`llm.ts ${args[0]}: ${text.split('\n').slice(-4).join('\n')}`);
  if (args[0] !== 'run') console.log(`  ${text.split('\n').at(-1)}`);
}

/** Impronta di system.md e schema.json di un prompt: va nella key delle fasi che lo usano. */
export function promptHash(name: string): string {
  const dir = join(ROOT, 'prompts', name);
  return Bun.hash(['system.md', 'schema.json'].map((f) => readFileSync(join(dir, f), 'utf8')).join('\0')).toString();
}
