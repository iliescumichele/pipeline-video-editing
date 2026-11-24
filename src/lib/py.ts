import { join } from 'node:path';
import { localEnv, PATHS } from './env';

/**
 * Esegue uno script di python/ con l'interprete del venv del progetto. stderr passa a terminale
 * (barre di avanzamento comprese); stdout pure, oppure torna come stringa con `capture`.
 * Se lo script fallisce, l'errore riporta le ultime righe.
 */
export async function py(script: string, args: string[], opts: { env?: Record<string, string>; capture?: boolean; stdin?: ReadableStream } = {}): Promise<string> {
  // -I ignora le variabili PYTHON*: bytecode, output senza buffer e avvisi si impostano qui.
  const flags = ['-I', '-u', '-W', 'ignore', '-X', `pycache_prefix=${join(PATHS.tools, 'pycache')}`];
  const argv = [join(PATHS.venv, 'bin', 'python'), ...flags, join(PATHS.python, script), ...args];
  const proc = Bun.spawn(argv, {
    env: localEnv({ HF_HUB_OFFLINE: '1', TRANSFORMERS_VERBOSITY: 'error', HF_HUB_DISABLE_PROGRESS_BARS: '1', ...opts.env }),
    stdin: opts.stdin ?? 'ignore',
    stdout: opts.capture ? 'pipe' : 'inherit',
    stderr: 'pipe',
  });
  const stdout = opts.capture ? new Response(proc.stdout as ReadableStream).text() : Promise.resolve('');
  let tail = '';
  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const text = decoder.decode(value);
    process.stderr.write(text);
    tail = (tail + text).slice(-2000);
  }
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${script} è uscito con codice ${code}:\n${tail.trim().split('\n').slice(-8).join('\n')}`);
  return stdout;
}
