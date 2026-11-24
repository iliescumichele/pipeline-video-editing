// llm.ts — l'unico punto da cui la pipeline parla con i modelli.
//
//   bun llm.ts up [qwen|clef]     accende LM Studio con $LUCIO_MODEL_KEY e il server locale di Clef
//   bun llm.ts check              controlla Qwen (testo e immagini), Clef e l'abbonamento Claude
//   bun llm.ts run <task-dir>     esegue un compito, scrive output.json e meta.json
//   bun llm.ts down [qwen|clef]   scarica Qwen (e spegne LM Studio se non serve ad altro) e ferma Clef
//
// Un compito è una cartella con:
//   task.json    { backend, model?, effort?, think?, images?, temperature?, max_tokens?, timeout_s?, retries? }
//   system.md    istruzioni (facoltativo)
//   input.md     materiale da elaborare
//   schema.json  JSON Schema della risposta
//
// Backend:
//   local   Qwen su LM Studio, solo testo
//   direct  Qwen su LM Studio con le immagini di `images` nel messaggio, in base64
//   claude  `claude -p --model <model> [--effort <effort>]` sull'abbonamento; le immagini le legge con Read
//   decide  Clef-Flash in locale (MLX, models/clef-flash-8bit): un modello di decisione che non
//           scrive testo ma dà la probabilità di ogni risposta. input.md è lo stato, schema.json le
//           domande nel formato Clef ({ id: { type: noul|choice|score, instructions, criteria } }),
//           output.json le risposte; system.md non si usa.
//   embed   embedding con LM Studio (model = modello di embedding): input.md è un array JSON di testi,
//           output.json { vectors }; schema.json e system.md non si usano.
//
// model (local/direct): una chiave di LM Studio; se non è caricato, `run` lo carica (e `down` lo scarica).
// Senza model si usa $LUCIO_MODEL_KEY.
//
// think (solo local/direct): false = risposta vincolata dallo schema, senza ragionamento (veloce);
// true = Qwen ragiona liberamente e poi scrive il JSON, che qui viene controllato contro lo schema.
// LM Studio non permette le due cose insieme: con lo schema attivo il ragionamento non parte.
//
// Regole: mai ANTHROPIC_API_KEY (né altre variabili ANTHROPIC_*) verso claude, mai --bare,
// modello sempre esplicito. Se gli input non cambiano, `run` riusa output.json (--force per rifare).

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';

const HERE = import.meta.dir;
loadDotEnv(join(HERE, '.env'));

const LMSTUDIO_URL = process.env.LMSTUDIO_URL ?? 'http://localhost:1234';
const CONTEXT = process.env.LUCIO_CONTEXT ?? '65536';
const MODEL_KEY = process.env.LUCIO_MODEL_KEY;
const CLEF_URL = process.env.LUCIO_CLEF_URL ?? 'http://127.0.0.1:8766';
const CLEF_DIR = resolve(HERE, process.env.LUCIO_CLEF_DIR ?? 'models/clef-flash-8bit');
const CLEF_PID = join(HERE, '.tools', 'clef.pid');
const CLEF_LOG = join(HERE, '.tools', 'clef.log');
/** Modelli di LM Studio caricati da llm.ts: `down` scarica questi e non tocca gli altri. */
const LOADED_BY_US = join(HERE, '.tools', 'lmstudio-loaded.json');

/** PNG rosso 64×64 per il controllo delle immagini in `check`. */
const RED_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAYElEQVR4nO3PwQkAIBDAMAX3H/lwCB9BaCZo96y/HR3wqgGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQGtAa0BrQHtAgK6AfwYG1VIAAAAAElFTkSuQmCC';

type Backend = 'local' | 'direct' | 'claude' | 'decide' | 'embed';

interface Task {
  backend: Backend;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  think?: boolean;
  images?: string[];
  temperature?: number;
  max_tokens?: number;
  timeout_s?: number;
  retries?: number;
}

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  reasoning_tokens?: number;
}

interface Answer {
  output: unknown;
  raw: string;
  usage: Usage;
  extra?: Record<string, unknown>;
}

type Json = Record<string, unknown>;

// ───────────────────────────── comandi ─────────────────────────────

async function up(which?: string): Promise<void> {
  if (which !== 'clef') await qwenUp();
  if (which !== 'qwen' && clefInstalled()) await clefUp();
}

async function down(which?: string): Promise<void> {
  if (which !== 'clef') await qwenDown();
  if (which !== 'qwen') clefDown();
}

async function qwenUp(): Promise<void> {
  const key = requireModelKey();
  if (!(await serverUp())) {
    console.log('Avvio il server di LM Studio…');
    await sh(['lms', 'server', 'start']);
  }
  const loaded = await loadedModels();
  if (!loaded.some((m) => m.identifier === key)) {
    await loadLocal(key);
  }
  const m = (await loadedModels()).find((x) => x.identifier === key);
  if (!m) throw new Error(`${key} non risulta caricato`);
  console.log(`Pronto: ${key}, contesto ${m.contextLength}, immagini ${m.vision ? 'sì' : 'no'}, su ${LMSTUDIO_URL}`);
}

async function qwenDown(): Promise<void> {
  const ours = new Set<string>([requireModelKey(), ...readLoadedByUs()]);
  for (const m of await loadedModels()) {
    if (!ours.has(m.identifier)) continue;
    await sh(['lms', 'unload', m.identifier]);
    console.log(`Scaricato ${m.identifier}`);
  }
  rmSync(LOADED_BY_US, { force: true });
  const others = await loadedModels();
  if (others.length) {
    console.log(`Server lasciato acceso: ci sono altri modelli caricati (${others.map((m) => m.identifier).join(', ')})`);
  } else if (await serverUp()) {
    await sh(['lms', 'server', 'stop']);
    console.log('Server di LM Studio spento');
  }
}

async function check(): Promise<boolean> {
  const results: [string, boolean, string][] = [];
  const add = (name: string, ok: boolean, info: string) => {
    results.push([name, ok, info]);
    console.log(`${ok ? '✓' : '✗'} ${name.padEnd(22)} ${info}`);
  };

  add('ANTHROPIC_API_KEY', true, process.env.ANTHROPIC_API_KEY ? 'impostata nell\'ambiente: viene tolta da ogni chiamata a claude' : 'non impostata');
  add('LUCIO_MODEL_KEY', !!MODEL_KEY, MODEL_KEY ?? 'mancante (mettila in .env)');

  const server = await serverUp();
  add('Server LM Studio', server, server ? LMSTUDIO_URL : 'spento: lancia `bun llm.ts up`');
  if (server && MODEL_KEY) {
    const m = (await loadedModels()).find((x) => x.identifier === MODEL_KEY);
    add('Modello caricato', !!m, m ? `contesto ${m.contextLength}, immagini ${m.vision ? 'sì' : 'no'}` : 'non caricato: lancia `bun llm.ts up`');
    if (m) {
      const schema = { type: 'object', properties: { answer: { type: 'integer' } }, required: ['answer'], additionalProperties: false };
      let t0 = performance.now();
      try {
        const a = await lmCall({ backend: 'local' }, '', 'How much is 17 + 25? Reply with the number.', schema, []);
        const ok = (a.output as Json).answer === 42;
        add('local (testo)', ok, `${JSON.stringify(a.output)} in ${secs(t0)}`);
      } catch (e) {
        add('local (testo)', false, (e as Error).message);
      }
      t0 = performance.now();
      try {
        const vschema = { type: 'object', properties: { color: { type: 'string' } }, required: ['color'], additionalProperties: false };
        const a = await lmCall({ backend: 'direct' }, '', 'What is the dominant color of this image? One word.', vschema, [{ mime: 'image/png', b64: RED_PNG }]);
        const ok = String((a.output as Json).color).toLowerCase().includes('red');
        add('direct (immagini)', ok, `${JSON.stringify(a.output)} in ${secs(t0)}`);
      } catch (e) {
        add('direct (immagini)', false, (e as Error).message);
      }
    }
  }

  if (clefInstalled()) {
    const up = await clefHealthy();
    add('Server Clef', up, up ? CLEF_URL : 'spento: lancia `bun llm.ts up clef`');
    if (up) {
      const t0 = performance.now();
      try {
        const a = await clefCall({ backend: 'decide' }, 'The sky is green and grass is purple.', { correct: { type: 'noul', instructions: 'Is the state factually correct?' } }, []);
        const p = Number(((a.output as Json).correct as Json).noul);
        add('decide (Clef)', p < 0.2, `p(corretto) = ${p} (atteso basso) in ${secs(t0)}`);
      } catch (e) {
        add('decide (Clef)', false, (e as Error).message);
      }
    }
  }

  try {
    const st = await claudeAuth();
    const ok = st.loggedIn === true && st.authMethod === 'claude.ai';
    add('claude (abbonamento)', ok, ok ? 'accesso con claude.ai, nessuna API key' : `accesso: ${String(st.authMethod)}, serve l'abbonamento claude.ai`);
  } catch (e) {
    add('claude (abbonamento)', false, (e as Error).message);
  }

  return results.every(([, ok]) => ok);
}

async function run(dir: string, force: boolean): Promise<void> {
  const task = (await readJson(join(dir, 'task.json'))) as Task;
  const system = existsSync(join(dir, 'system.md')) ? readFileSync(join(dir, 'system.md'), 'utf8') : '';
  const input = readFileSync(join(dir, 'input.md'), 'utf8');
  const schema = (await readJson(join(dir, 'schema.json'))) as Json;
  const images = (task.images ?? []).map((p) => (isAbsolute(p) ? p : join(dir, p)));
  for (const p of images) if (!existsSync(p)) throw new Error(`immagine mancante: ${p}`);

  const hash = hashInputs(dir, images);
  const metaPath = join(dir, 'meta.json');
  if (!force && existsSync(join(dir, 'output.json')) && existsSync(metaPath)) {
    const old = (await readJson(metaPath)) as Json;
    if (old.ok === true && old.hash === hash) {
      console.log(`${dir}: già fatto, riuso output.json`);
      return;
    }
  }

  const model = task.backend === 'claude' ? task.model : task.backend === 'decide' ? (task.model ?? 'clef-flash') : (task.model ?? MODEL_KEY);
  if (task.backend === 'embed') {
    if (!model) throw new Error('task.json: per embed serve il modello di embedding');
    await ensureLocal(model);
    const t0 = performance.now();
    const res = await fetch(`${LMSTUDIO_URL}/v1/embeddings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, input: JSON.parse(input) }), timeout: false });
    const d = (await res.json()) as { data?: { embedding: number[] }[]; error?: unknown };
    if (!res.ok || !d.data) throw new Error(`LM Studio embeddings ${res.status}: ${JSON.stringify(d.error ?? d)}`);
    await Bun.write(join(dir, 'output.json'), JSON.stringify({ vectors: d.data.map((x) => x.embedding) }));
    await writeMeta(metaPath, { ok: true, backend: 'embed', model, hash, started_at: new Date().toISOString(), duration_s: round((performance.now() - t0) / 1000), attempts: 1 });
    console.log(`${dir}: ok (embed, ${model}, ${secs(t0)})`);
    return;
  }
  if (!model) throw new Error(task.backend === 'claude' ? 'task.json: per claude il modello va indicato esplicitamente (es. "sonnet")' : 'manca LUCIO_MODEL_KEY');

  const t0 = performance.now();
  const startedAt = new Date().toISOString();
  const retries = task.retries ?? 2;
  let lastError = '';
  let lastRaw = '';
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const feedback = attempt > 1 ? { raw: lastRaw, error: lastError } : undefined;
      if (task.backend === 'local' || task.backend === 'direct') await ensureLocal(model);
      if (task.backend === 'decide' && !(await clefHealthy())) {
        if (!clefInstalled()) throw new Error('Clef non è installato (bun run setup)');
        await clefUp();
      }
      const a =
        task.backend === 'claude'
          ? await claudeCall(task, model, system, input, schema, images, dir, feedback)
          : task.backend === 'decide'
            ? await clefCall(task, input, schema, await loadImages(task, images))
            : await lmCall({ ...task, model }, system, input, schema, await loadImages(task, images), feedback);
      lastRaw = a.raw;
      // Per decide lo schema è l'elenco delle domande: basta che ci sia una risposta per ognuna.
      const errors = task.backend === 'decide' ? Object.keys(schema).filter((q) => !(q in (a.output as Json))).map((q) => `${q} senza risposta`) : validate(a.output, schema);
      if (errors.length) throw new SchemaError(errors.join('; '), a.raw);
      await Bun.write(join(dir, 'output.json'), `${JSON.stringify(a.output, null, 2)}\n`);
      await writeMeta(metaPath, { ok: true, backend: task.backend, model, think: task.think ?? false, hash, started_at: startedAt, duration_s: round((performance.now() - t0) / 1000), attempts: attempt, usage: a.usage, ...a.extra });
      console.log(`${dir}: ok (${task.backend}, ${model}, ${secs(t0)}, tentativi ${attempt})`);
      return;
    } catch (e) {
      lastError = (e as Error).message;
      if (e instanceof SchemaError || e instanceof ParseError) lastRaw = e.raw;
      if (!(e instanceof SchemaError) && !(e instanceof ParseError)) break; // errori di rete/processo: inutile riprovare
      console.error(`${dir}: tentativo ${attempt} non valido: ${lastError}`);
    }
  }
  await Bun.write(join(dir, 'raw.txt'), lastRaw);
  await writeMeta(metaPath, { ok: false, backend: task.backend, model, hash, started_at: startedAt, duration_s: round((performance.now() - t0) / 1000), error: lastError });
  throw new Error(`${dir}: fallito: ${lastError}`);
}

// ───────────────────────────── LM Studio ─────────────────────────────

interface Img {
  mime: string;
  b64: string;
}

async function loadImages(task: Task, paths: string[]): Promise<Img[]> {
  if (paths.length && task.backend === 'local') throw new Error('il backend local è solo testo: per le immagini usa "direct"');
  const mimes: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
  return Promise.all(
    paths.map(async (p) => {
      const mime = mimes[extname(p).toLowerCase()];
      if (!mime) throw new Error(`formato immagine non supportato: ${p}`);
      return { mime, b64: Buffer.from(await Bun.file(p).arrayBuffer()).toString('base64') };
    }),
  );
}

async function lmCall(task: Task, system: string, input: string, schema: Json, images: Img[], feedback?: { raw: string; error: string }): Promise<Answer> {
  const think = task.think ?? false;
  const sys = think ? `${system}\n\nAt the end, reply with a single JSON object that matches this JSON Schema, and nothing else:\n${JSON.stringify(schema)}`.trim() : system;
  const user = images.length
    ? [{ type: 'text', text: input }, ...images.map((im) => ({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.b64}` } }))]
    : input;
  const messages: Json[] = [];
  if (sys) messages.push({ role: 'system', content: sys });
  messages.push({ role: 'user', content: user });
  if (feedback) {
    messages.push({ role: 'assistant', content: feedback.raw });
    messages.push({ role: 'user', content: `That reply is not valid: ${feedback.error}. Reply again with only the corrected JSON.` });
  }

  const body: Json = {
    model: task.model ?? MODEL_KEY,
    messages,
    temperature: task.temperature ?? 0.2,
    max_tokens: task.max_tokens ?? (think ? 8192 : 4096),
  };
  if (!think) {
    body.reasoning_effort = 'none';
    body.response_format = { type: 'json_schema', json_schema: { name: 'output', strict: true, schema: forGrammar(schema) } };
  }

  const res = await fetch(`${LMSTUDIO_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    // LM Studio non manda niente finché non ha finito: senza `timeout: false` Bun chiude la
    // connessione ferma dopo 5 minuti. La scadenza vera è timeout_s.
    timeout: false,
    signal: AbortSignal.timeout((task.timeout_s ?? (think ? 1800 : 900)) * 1000),
  });
  const d = (await res.json()) as Json;
  if (!res.ok) throw new Error(`LM Studio ${res.status}: ${JSON.stringify(d.error ?? d)}`);
  const choice = (d.choices as Json[] | undefined)?.[0];
  const msg = (choice?.message ?? {}) as Json;
  if (choice?.finish_reason === 'length') throw new ParseError('risposta troncata: alza max_tokens', String(msg.content ?? ''));
  // Con lo schema attivo LM Studio a volte mette il JSON in reasoning_content e lascia vuoto content.
  const raw = String(msg.content || (think ? '' : msg.reasoning_content) || '').trim();
  const u = (d.usage ?? {}) as Json;
  const usage: Usage = {
    prompt_tokens: u.prompt_tokens as number,
    completion_tokens: u.completion_tokens as number,
    reasoning_tokens: (u.completion_tokens_details as Json | undefined)?.reasoning_tokens as number,
  };
  return { output: parseJson(raw), raw, usage };
}

/**
 * Lo schema per la grammatica di LM Studio, senza `pattern`: il motore non sa combinarli con i
 * limiti di lunghezza ("Unable to determine if regex is empty"). I pattern restano nel controllo
 * dopo la risposta, che fa riprovare il modello.
 */
function forGrammar(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(forGrammar);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema as Json).filter(([k]) => k !== 'pattern').map(([k, v]) => [k, forGrammar(v)]));
}

async function serverUp(): Promise<boolean> {
  try {
    return (await fetch(`${LMSTUDIO_URL}/v1/models`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

async function loadedModels(): Promise<{ identifier: string; contextLength?: number; vision?: boolean }[]> {
  const out = await sh(['lms', 'ps', '--json'], true);
  try {
    return JSON.parse(out);
  } catch {
    return [];
  }
}

/** Carica un modello di LM Studio (accende il server se serve) e lo segna come caricato da noi. */
async function loadLocal(key: string): Promise<void> {
  if (!(await serverUp())) await sh(['lms', 'server', 'start']);
  // I modelli di embedding hanno il loro contesto (es. 2048): non si forza quello dei modelli di chat.
  const embedding = /embed/i.test(key);
  console.log(`Carico ${key}${embedding ? '' : ` (contesto ${CONTEXT})`}…`);
  await sh(['lms', 'load', key, ...(embedding ? [] : ['--context-length', CONTEXT]), '--gpu', 'max', '-y']);
  const ours = new Set(readLoadedByUs());
  ours.add(key);
  mkdirSync(dirname(LOADED_BY_US), { recursive: true });
  writeFileSync(LOADED_BY_US, JSON.stringify([...ours]));
}

async function ensureLocal(key: string): Promise<void> {
  if (!(await serverUp()) || !(await loadedModels()).some((m) => m.identifier === key)) await loadLocal(key);
}

function readLoadedByUs(): string[] {
  try {
    return JSON.parse(readFileSync(LOADED_BY_US, 'utf8')) as string[];
  } catch {
    return [];
  }
}

// ───────────────────────────── Clef ─────────────────────────────

/** Installato quando `bun run setup` ha finito di scaricarlo (scrive .complete alla fine). */
function clefInstalled(): boolean {
  return existsSync(join(CLEF_DIR, '.complete')) && existsSync(join(CLEF_DIR, 'clef_mlx.py'));
}

async function clefHealthy(): Promise<boolean> {
  try {
    return (await fetch(`${CLEF_URL}/health`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

/** Avvia `clef_mlx.py serve` con il Python del progetto, staccato, solo su 127.0.0.1. */
async function clefUp(): Promise<void> {
  if (await clefHealthy()) {
    console.log(`Clef già acceso su ${CLEF_URL}`);
    return;
  }
  const url = new URL(CLEF_URL);
  mkdirSync(dirname(CLEF_PID), { recursive: true });
  const log = openSync(CLEF_LOG, 'a');
  const python = join(HERE, 'python', '.venv', 'bin', 'python');
  const child = spawn(
    python,
    ['-I', '-u', '-W', 'ignore', join(CLEF_DIR, 'clef_mlx.py'), 'serve', '--model', CLEF_DIR, '--name', 'clef-flash',
      '--host', '127.0.0.1', '--port', url.port, '--quiet', '--no-truncate'],
    { detached: true, stdio: ['ignore', log, log], env: { ...process.env, HF_HUB_OFFLINE: '1', HF_HOME: join(HERE, '.tools', 'hf') } },
  );
  child.unref();
  writeFileSync(CLEF_PID, String(child.pid));
  console.log('Avvio Clef…');
  const t0 = performance.now();
  while (!(await clefHealthy())) {
    if (performance.now() - t0 > 180_000) throw new Error(`Clef non risponde dopo 3 minuti: guarda ${CLEF_LOG}`);
    await Bun.sleep(1000);
  }
  console.log(`Pronto: Clef su ${CLEF_URL} (${secs(t0)})`);
}

function clefDown(): void {
  if (!existsSync(CLEF_PID)) return;
  const pid = Number(readFileSync(CLEF_PID, 'utf8'));
  try {
    process.kill(pid, 'SIGTERM');
    console.log('Clef spento');
  } catch {
    // già uscito
  }
  rmSync(CLEF_PID, { force: true });
}

async function clefCall(task: Task, state: string, questions: Json, images: Img[]): Promise<Answer> {
  const res = await fetch(`${CLEF_URL}/v1/systemone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'clef-flash', state, questions, images: images.map((im) => `data:${im.mime};base64,${im.b64}`), truncate: false }),
    timeout: false,
    signal: AbortSignal.timeout((task.timeout_s ?? 300) * 1000),
  });
  const d = (await res.json()) as Json;
  if (!res.ok) throw new Error(`Clef ${res.status}: ${JSON.stringify(d.error ?? d)}`);
  const u = (d.usage ?? {}) as Json;
  return { output: d.answers, raw: JSON.stringify(d.answers), usage: { prompt_tokens: u.input_tokens as number }, extra: { latency_ms: u.latency_ms } };
}

// ───────────────────────────── Claude ─────────────────────────────

async function claudeCall(task: Task, model: string, system: string, input: string, schema: Json, images: string[], dir: string, feedback?: { raw: string; error: string }): Promise<Answer> {
  const auth = await claudeAuth();
  if (auth.authMethod !== 'claude.ai') throw new Error(`claude non usa l'abbonamento (accesso: ${String(auth.authMethod)})`);

  let prompt = input;
  if (images.length) prompt += `\n\nImages (open each one with the Read tool before answering):\n${images.map((p) => `- ${p}`).join('\n')}\n`;
  if (feedback) prompt += `\n\nA previous answer was rejected: ${feedback.error}. Fix it.\n`;

  const sysFile = join(dir, '.system.claude.md');
  await Bun.write(sysFile, system || 'Reply only with the structured output.');
  const argv = [
    'claude', '-p',
    '--model', model,
    ...(task.effort ? ['--effort', task.effort] : []),
    '--output-format', 'json',
    '--json-schema', JSON.stringify(schema),
    '--system-prompt-file', sysFile,
    '--tools', images.length ? 'Read' : '',
    ...(images.length ? ['--allowedTools', 'Read', ...[...new Set(images.map(dirname))].flatMap((d) => ['--add-dir', d])] : []),
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--no-session-persistence',
  ];
  if (argv.includes('--bare')) throw new Error('--bare non è ammesso sul backend claude');

  const proc = Bun.spawn(argv, { cwd: dir, env: claudeEnv(), stdin: new Blob([prompt]), stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), (task.timeout_s ?? 300) * 1000);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  let d: Json;
  try {
    d = JSON.parse(out);
  } catch {
    throw new Error(`claude è uscito con codice ${code}: ${(err || out).slice(0, 500)}`);
  }
  if (d.is_error) throw new Error(`claude: ${String(d.result ?? d.subtype).slice(0, 500)}`);
  const raw = typeof d.result === 'string' ? d.result : JSON.stringify(d.structured_output);
  const output = d.structured_output ?? parseJson(raw);
  const u = (d.usage ?? {}) as Json;
  return {
    output,
    raw,
    usage: { prompt_tokens: u.input_tokens as number, completion_tokens: u.output_tokens as number },
    // total_cost_usd è il prezzo che la chiamata avrebbe con le API: sull'abbonamento non si paga, ma misura la quota usata.
    extra: { cost_usd: d.total_cost_usd, claude: { session_id: d.session_id, num_turns: d.num_turns, duration_api_ms: d.duration_api_ms, effort: task.effort, models: Object.keys((d.modelUsage ?? {}) as Json) } },
  };
}

/** Ambiente per claude: niente variabili ANTHROPIC_* né provider esterni, così usa solo l'abbonamento. */
function claudeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith('ANTHROPIC_') || /^CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY)$/.test(k)) continue;
    env[k] = v;
  }
  return env;
}

async function claudeAuth(): Promise<Json> {
  const proc = Bun.spawn(['claude', 'auth', 'status'], { env: claudeEnv(), stdout: 'pipe', stderr: 'pipe' });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  try {
    return JSON.parse(out);
  } catch {
    throw new Error(`claude auth status non leggibile: ${out.slice(0, 200)}`);
  }
}

// ───────────────────────────── JSON e schema ─────────────────────────────

class ParseError extends Error {
  constructor(message: string, readonly raw: string) {
    super(message);
  }
}

class SchemaError extends Error {
  constructor(message: string, readonly raw: string) {
    super(message);
  }
}

function parseJson(raw: string): unknown {
  const candidates = [raw, raw.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1], raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)];
  for (const c of candidates) {
    if (!c?.trim()) continue;
    try {
      return JSON.parse(c);
    } catch {}
  }
  throw new ParseError(`la risposta non contiene JSON valido: ${raw.slice(0, 200)}`, raw);
}

/** Controllo dello schema: type, enum, pattern, $ref locali, properties, required, additionalProperties, items e limiti. */
function validate(v: unknown, schema: Json, path = '$', root: Json = schema): string[] {
  const s = resolveRef(schema, root);
  const errs: string[] = [];
  if (Array.isArray(s.enum) && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) errs.push(`${path} non è tra ${JSON.stringify(s.enum)}`);
  const types = s.type === undefined ? [] : ([s.type].flat() as string[]);
  if (types.length && !types.some((t) => typeOk(v, t))) return [...errs, `${path} dovrebbe essere ${types.join('|')}`];
  if (typeof v === 'string') {
    if (typeof s.minLength === 'number' && v.length < s.minLength) errs.push(`${path} più corto di ${s.minLength} caratteri`);
    if (typeof s.maxLength === 'number' && v.length > s.maxLength) errs.push(`${path} più lungo di ${s.maxLength} caratteri`);
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(v)) errs.push(`${path} ("${v}") non rispetta il pattern ${s.pattern}`);
  }
  if (typeof v === 'number') {
    if (typeof s.minimum === 'number' && v < s.minimum) errs.push(`${path} sotto ${s.minimum}`);
    if (typeof s.maximum === 'number' && v > s.maximum) errs.push(`${path} sopra ${s.maximum}`);
  }
  if (Array.isArray(v)) {
    if (typeof s.minItems === 'number' && v.length < s.minItems) errs.push(`${path} ha meno di ${s.minItems} elementi`);
    if (typeof s.maxItems === 'number' && v.length > s.maxItems) errs.push(`${path} ha più di ${s.maxItems} elementi`);
    if (s.items) v.forEach((x, i) => errs.push(...validate(x, s.items as Json, `${path}[${i}]`, root)));
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Json;
    const props = (s.properties ?? {}) as Record<string, Json>;
    for (const k of (s.required as string[] | undefined) ?? []) if (!(k in o)) errs.push(`${path}.${k} manca`);
    for (const [k, x] of Object.entries(o)) {
      if (props[k]) errs.push(...validate(x, props[k], `${path}.${k}`, root));
      else if (s.additionalProperties === false) errs.push(`${path}.${k} non previsto`);
    }
  }
  return errs;
}

function resolveRef(s: Json, root: Json): Json {
  const ref = s.$ref;
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return s;
  let node: unknown = root;
  for (const part of ref.slice(2).split('/')) node = (node as Json | undefined)?.[part];
  if (!node || typeof node !== 'object') throw new Error(`schema: riferimento non trovato ${ref}`);
  return resolveRef(node as Json, root);
}

function typeOk(v: unknown, t: string): boolean {
  if (t === 'integer') return Number.isInteger(v);
  if (t === 'number') return typeof v === 'number' && Number.isFinite(v);
  if (t === 'array') return Array.isArray(v);
  if (t === 'null') return v === null;
  if (t === 'object') return !!v && typeof v === 'object' && !Array.isArray(v);
  return typeof v === t;
}

// ───────────────────────────── utilità ─────────────────────────────

function hashInputs(dir: string, images: string[]): string {
  const h = new Bun.CryptoHasher('sha256');
  for (const f of ['task.json', 'system.md', 'input.md', 'schema.json']) {
    const p = join(dir, f);
    h.update(f);
    if (existsSync(p)) h.update(readFileSync(p));
  }
  for (const p of images) h.update(readFileSync(p));
  return h.digest('hex').slice(0, 16);
}

async function readJson(path: string): Promise<unknown> {
  if (!existsSync(path)) throw new Error(`manca ${path}`);
  return Bun.file(path).json();
}

async function writeMeta(path: string, meta: Json): Promise<void> {
  await Bun.write(path, `${JSON.stringify(meta, null, 2)}\n`);
}

async function sh(argv: string[], quiet = false): Promise<string> {
  const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0 && !quiet) throw new Error(`${argv.join(' ')}: ${(err || out).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim().slice(-400)}`);
  return out;
}

function requireModelKey(): string {
  if (!MODEL_KEY) throw new Error('manca LUCIO_MODEL_KEY (mettila in .env)');
  return MODEL_KEY;
}

function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m?.[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2]!.replace(/^["']|["']$/g, '');
  }
}

function secs(t0: number): string {
  return `${((performance.now() - t0) / 1000).toFixed(1)} s`;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// ───────────────────────────── avvio ─────────────────────────────
// In fondo al file, così classi e costanti sono già inizializzate quando parte il comando.

const [cmd, ...args] = process.argv.slice(2);
try {
  if (cmd === 'up') await up(args[0]);
  else if (cmd === 'down') await down(args[0]);
  else if (cmd === 'check') process.exitCode = (await check()) ? 0 : 1;
  else if (cmd === 'run' && args[0]) await run(resolve(args[0]), args.includes('--force'));
  else {
    console.error('uso: bun llm.ts up [qwen|clef] | check | run <task-dir> [--force] | down [qwen|clef]');
    process.exitCode = 2;
  }
} catch (e) {
  console.error(`llm.ts: ${(e as Error).message}`);
  process.exitCode = 1;
}
