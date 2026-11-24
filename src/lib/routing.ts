import { join } from 'node:path';
import { ROOT } from './env';
import type { LlmTask } from './llm';

export type TaskName = 'meaning' | 'vision' | 'rank' | 'copy' | 'news_triage' | 'news_script' | 'news_factcheck' | 'media' | 'judge' | 'youtube';

export interface Route {
  provider: 'local' | 'claude' | 'clef';
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface Candidate extends Route {
  id: string;
  label: string;
}

export interface RoutingFile {
  tasks: Record<TaskName, Route>;
  candidates: Candidate[];
}

export const ROUTING_PATH = join(ROOT, 'config', 'routing.json');

export async function readRouting(): Promise<RoutingFile> {
  return Bun.file(ROUTING_PATH).json();
}

export async function route(task: TaskName): Promise<Route> {
  const r = (await readRouting()).tasks[task];
  if (!r) throw new Error(`config/routing.json: manca il compito ${task}`);
  return r;
}

/**
 * Traduce una scelta di routing nel task.json di llm.ts. Con le immagini un modello locale usa il
 * backend direct; think vale solo per i modelli locali (con Claude decide l'effort).
 */
export function toLlmTask(r: Route, opts: Omit<LlmTask, 'backend' | 'model' | 'effort'> = {}): LlmTask {
  if (r.provider === 'clef') return { backend: 'decide', images: opts.images };
  if (r.provider === 'claude') {
    if (!r.model) throw new Error('routing: per Claude il modello va indicato esplicitamente');
    const { think: _think, temperature: _t, max_tokens: _m, ...rest } = opts;
    return { ...rest, backend: 'claude', model: r.model, effort: r.effort };
  }
  return { ...opts, backend: opts.images?.length ? 'direct' : 'local', model: r.model };
}

/** Etichetta breve per log e report: "local qwen/qwen3.8-27b", "claude opus (medium)". */
export function routeLabel(r: Route): string {
  return [r.provider, r.model, r.effort && `(${r.effort})`].filter(Boolean).join(' ');
}
