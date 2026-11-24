import { join, resolve } from 'node:path';

/** Cartella del progetto: tutto quello che installiamo o scarichiamo resta qui dentro. */
// dirname (non dir): vale sia in Bun sia nel modulo runner di Vite usato dalla dashboard.
export const ROOT = resolve(import.meta.dirname, '../..');

const TOOLS = join(ROOT, '.tools');

export const PATHS = {
  tools: TOOLS,
  models: join(ROOT, 'models'),
  python: join(ROOT, 'python'),
  venv: join(ROOT, 'python', '.venv'),
  work: join(ROOT, 'work'),
  out: join(ROOT, 'out'),
};

/**
 * Ambiente per i processi figli (uv, Python, bun install): cache, interprete Python
 * e download puntano dentro il progetto, mai in ~/.cache o ~/.local.
 * ANTHROPIC_API_KEY viene sempre tolta: Claude si usa solo con l'abbonamento.
 */
export function localEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env.ANTHROPIC_API_KEY;

  return {
    ...env,
    UV_CACHE_DIR: join(TOOLS, 'uv-cache'),
    UV_PYTHON_INSTALL_DIR: join(TOOLS, 'python'),
    UV_PYTHON_BIN_DIR: join(TOOLS, 'python-bin'),
    UV_PYTHON_PREFERENCE: 'only-managed',
    UV_PROJECT_ENVIRONMENT: PATHS.venv,
    BUN_INSTALL_CACHE_DIR: join(TOOLS, 'bun-cache'),
    HF_HOME: join(TOOLS, 'hf'),
    HF_HUB_DISABLE_TELEMETRY: '1',
    TORCH_HOME: join(PATHS.models, 'torch'),
    XDG_CACHE_HOME: join(TOOLS, 'xdg-cache'),
    MPLCONFIGDIR: join(TOOLS, 'matplotlib'),
    NUMBA_CACHE_DIR: join(TOOLS, 'numba'),
    PYTHONPYCACHEPREFIX: join(TOOLS, 'pycache'),
    ...extra,
  };
}

/** Un modello da Hugging Face (repo + revision) oppure un file scaricato direttamente (url + sha256_prefix). */
export type ModelSpec = { dir: string; note?: string } & ({ repo: string; revision: string; include?: string[] } | { url: string; sha256_prefix: string });

export async function readModels(): Promise<Record<string, ModelSpec>> {
  return Bun.file(join(ROOT, 'models.json')).json();
}
