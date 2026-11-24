import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import type { LongScript } from '../../../src/news/long';
import { q } from '../lib/queries';
import { useStartJob } from '../lib/jobs';
import { useToast } from '../lib/toast';
import { pct, when } from '../lib/util';
import { type getStory, saveScript, setStoryStatus } from '../server/api.functions';

interface Search {
  story?: number;
  min?: number;
  all?: boolean;
}

export const Route = createFileRoute('/notizie')({
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...(s.story != null && !Number.isNaN(Number(s.story)) ? { story: Number(s.story) } : {}),
    ...(s.min != null && Number(s.min) > 0 ? { min: Number(s.min) } : {}),
    ...(s.all === true || s.all === 'true' ? { all: true } : {}),
  }),
  loaderDeps: ({ search }) => ({ min: search.min ?? 0 }),
  loader: ({ context, deps }) => context.queryClient.ensureQueryData(q.stories(deps.min)),
  component: News,
});

const KIND: Record<string, string> = { official: 'ufficiale', leak: 'leak', rumor: 'rumor', analysis: 'analisi', community: 'community', business: 'affari', other: 'altro' };

function News() {
  const { story: sel, min = 0, all = false } = Route.useSearch();
  const navigate = useNavigate({ from: '/notizie' });
  const show = useToast();
  const startChecked = useStartJob();
  const { data: stories } = useSuspenseQuery(q.stories(min));
  const list = stories.filter((s) => all || s.status !== 'scartata');
  return (
    <div className="split">
      <div className="card">
        <div className="row">
          <h2 style={{ margin: 0 }}>Notizie</h2>
          <span className="spacer" />
          <button
            className="btn primary"
            onClick={async () => {
              if (!(await startChecked({ kind: 'news' }))) return;
              show('Aggiornamento notizie in coda');
            }}
          >
            Aggiorna
          </button>
        </div>
        <div className="row small" style={{ margin: '8px 0' }}>
          <label style={{ width: 150 }}>
            Punteggio minimo
            <select value={min} onChange={(e) => navigate({ search: (s) => ({ ...s, min: Number(e.target.value) || undefined }), replace: true })}>
              {[0, 0.2, 0.4, 0.6].map((x) => (
                <option key={x} value={x}>
                  {x === 0 ? 'tutte' : `≥ ${x}`}
                </option>
              ))}
            </select>
          </label>
          <label className="row" style={{ display: 'flex', width: 'auto', marginTop: 16 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={!all} onChange={(e) => navigate({ search: (s) => ({ ...s, all: e.target.checked ? undefined : true }), replace: true })} /> nascondi
            scartate
          </label>
        </div>
        <div className="list">
          {list.length === 0 && <div className="muted small">Nessuna storia: premi Aggiorna.</div>}
          {list.map((s) => (
            <div key={s.id} className={`item ${s.id === sel ? 'sel' : ''}`} onClick={() => navigate({ search: (x) => ({ ...x, story: s.id }) })}>
              <div className="small">
                <b>{s.title}</b>
              </div>
              <div className="row small muted" style={{ marginTop: 4 }}>
                <span>{s.items} articoli</span>
                <span>· {when(s.last_seen)}</span>
                {s.triage && <span className="chip teal">{KIND[s.triage.kind] ?? s.triage.kind}</span>}
                {s.triage && <span className="chip amber">interesse {s.triage.interest.toFixed(1)}/4</span>}
                {s.triage?.clickbait > 0.5 && <span className="chip warn">acchiappaclic</span>}
                {s.triage?.copyright_risk > 0.5 && <span className="chip warn">rischio copyright</span>}
                {s.status !== 'nuova' && <span className="chip">{s.status}</span>}
                <span className="spacer" />
                <b style={{ color: 'var(--amber)' }}>{s.score != null ? Math.round(s.score * 100) : '—'}</b>
              </div>
            </div>
          ))}
        </div>
      </div>
      {sel ? <Story id={sel} /> : <div className="card empty">Scegli una storia per vedere articoli e script.</div>}
    </div>
  );
}

type StoryData = Awaited<ReturnType<typeof getStory>>;
type ScriptData = StoryData['scripts'][number];

function Story({ id }: { id: number }) {
  const { data: s } = useQuery(q.story(id));
  const qc = useQueryClient();
  const show = useToast();
  const startChecked = useStartJob();
  if (!s) return <div className="card empty">Carico…</div>;
  const t = s.triage;
  const reload = () => qc.invalidateQueries({ queryKey: ['story', id] });
  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="card">
        <h2>{s.title}</h2>
        {t && (
          <div className="row small">
            <span className="chip teal">{KIND[t.kind] ?? t.kind}</span>
            <span className="chip">GTA 6: {pct(t.about_gta6)}</span>
            <span className="chip amber">interesse {t.interest.toFixed(1)}/4</span>
            <span className={`chip ${t.clickbait > 0.5 ? 'warn' : ''}`}>acchiappaclic {pct(t.clickbait)}</span>
            <span className={`chip ${t.copyright_risk > 0.5 ? 'warn' : ''}`}>rischio copyright {pct(t.copyright_risk)}</span>
            <span className="muted">smistata da {t.route}</span>
          </div>
        )}
        <div className="row" style={{ marginTop: 10 }}>
          <button
            className="btn primary"
            onClick={async () => {
              if (!(await startChecked({ kind: 'script', story: id }))) return;
              show('Script in coda');
            }}
          >
            Scrivi script
          </button>
          <button
            className="btn"
            onClick={async () => {
              if (!(await startChecked({ kind: 'long', story: id }))) return;
              show('Video lungo in coda');
            }}
          >
            Scrivi video lungo
          </button>
          <button
            className="btn danger"
            onClick={async () => {
              await setStoryStatus({ data: { id, status: 'scartata' } });
              await Promise.all([reload(), qc.invalidateQueries({ queryKey: ['stories'] })]);
            }}
          >
            Scarta storia
          </button>
        </div>
        <h3 style={{ marginTop: 14 }}>Articoli ({s.items.length})</h3>
        {s.items.map((it) => (
          <div key={it.id} className="small" style={{ marginBottom: 6 }}>
            <a href={it.url} target="_blank" rel="noreferrer">
              {it.title}
            </a>{' '}
            <span className="muted">
              · {it.source} · {when(it.published_at)}
            </span>
          </div>
        ))}
      </div>
      {s.scripts.map((sc) => (sc.kind === 'long' ? <LongScriptCard key={sc.id} sc={sc} reload={reload} /> : <ScriptCard key={sc.id} sc={sc} reload={reload} />))}
    </div>
  );
}

function useSave(id: number, reload: () => Promise<void>) {
  const show = useToast();
  return async (patch: { edited?: unknown; status?: string }, msg = 'Salvato') => {
    await saveScript({ data: { id, ...patch } });
    show(msg);
    await reload();
  };
}

function ScriptCard({ sc, reload }: { sc: ScriptData; reload: () => Promise<void> }) {
  const [d, setD] = useState(() => sc.edited ?? sc.content);
  const save = useSave(sc.id, reload);
  const words = (d.script ?? '').split(/\s+/).filter(Boolean).length;
  return (
    <div className="card">
      <div className="row">
        <h3 style={{ margin: 0 }}>Script #{sc.id}</h3>
        <span className={`chip ${d.status_of_info === 'confirmed' ? 'ok' : d.status_of_info === 'rumor' ? 'warn' : 'amber'}`}>{d.status_of_info}</span>
        <span className="chip">{sc.route}</span>
        {sc.cost_usd != null && <span className="chip">costo API equivalente ${sc.cost_usd.toFixed(3)}</span>}
        <span className={`chip ${sc.status === 'approvato' ? 'ok' : ''}`}>{sc.status}</span>
      </div>
      <p className="small muted">{d.angle}</p>
      <div className="grid" style={{ gap: 8 }}>
        <label>
          Gancio
          <input value={d.hook} onChange={(e) => setD({ ...d, hook: e.target.value })} />
        </label>
        <label>
          Voce ({words} parole, circa {Math.round(words / 2.5)} s)
          <textarea style={{ minHeight: 170 }} value={d.script} onChange={(e) => setD({ ...d, script: e.target.value })} />
        </label>
        <label>
          A schermo (una riga per momento)
          <textarea value={d.on_screen.join('\n')} onChange={(e) => setD({ ...d, on_screen: e.target.value.split('\n') })} />
        </label>
      </div>
      <h3 style={{ marginTop: 10 }}>Fonti</h3>
      {d.facts.map((f: { claim: string; source: string }, i: number) => (
        <div key={i} className="small">
          {f.claim} —{' '}
          <a href={f.source} target="_blank" rel="noreferrer">
            fonte
          </a>
        </div>
      ))}
      <ScriptButtons onSave={() => save({ edited: d })} onApprove={() => save({ edited: d, status: 'approvato' }, 'Script approvato')} onDiscard={() => save({ status: 'scartato' }, 'Script scartato')} />
    </div>
  );
}

const VERDICT: Record<string, [string, string]> = {
  supported: ['confermato', 'ok'],
  partial: ['in parte', 'amber'],
  unsupported: ['non confermato', 'warn'],
  no_text: ['fonte non leggibile', ''],
};

/** Video lungo: capitoli con voce e scene, fonti col controllo dei fatti, testi per YouTube. */
function LongScriptCard({ sc, reload }: { sc: ScriptData; reload: () => Promise<void> }) {
  const [d, setD] = useState<LongScript>(() => sc.edited ?? sc.content);
  const save = useSave(sc.id, reload);
  const c = sc.checks;
  const count = (t: string) => t.split(/\s+/).filter(Boolean).length;
  const words = d.chapters.reduce((a, ch) => a + count(ch.voice), 0);
  const setChapter = (i: number, patch: Partial<LongScript['chapters'][number]>) => setD({ ...d, chapters: d.chapters.map((ch, j) => (j === i ? { ...ch, ...patch } : ch)) });
  return (
    <div className="card">
      <div className="row">
        <h3 style={{ margin: 0 }}>Video lungo #{sc.id}</h3>
        <span className={`chip ${d.status_of_info === 'confirmed' ? 'ok' : d.status_of_info === 'rumor' ? 'warn' : 'amber'}`}>{d.status_of_info}</span>
        <span className={`chip ${words / 160 >= 8.5 ? 'ok' : 'warn'}`}>
          {words} parole · circa {(words / 160).toFixed(1)} min
        </span>
        <span className="chip">{sc.route}</span>
        {sc.cost_usd != null && <span className="chip">costo API equivalente ${sc.cost_usd.toFixed(3)}</span>}
        <span className={`chip ${sc.status === 'approvato' ? 'ok' : ''}`}>{sc.status}</span>
        <span className="spacer" />
        <Link className="btn primary" to="/montaggio/$id" params={{ id: String(sc.id) }}>
          Montaggio
        </Link>
      </div>
      <p className="small muted">{d.angle}</p>
      <p className="small muted" style={{ whiteSpace: 'pre-wrap' }}>
        {d.notes}
      </p>
      {c && c.problems.length > 0 && (
        <div className="small" style={{ marginBottom: 8 }}>
          {c.problems.map((p) => (
            <div key={p} className="chip warn" style={{ marginRight: 6 }}>
              ⚠ {p}
            </div>
          ))}
        </div>
      )}
      <h3>Titoli</h3>
      <div className="grid" style={{ gap: 6 }}>
        {d.titles.map((t, i) => (
          <input key={i} value={t} onChange={(e) => setD({ ...d, titles: d.titles.map((x, j) => (j === i ? e.target.value : x)) })} />
        ))}
      </div>
      <h3 style={{ marginTop: 10 }}>Miniature</h3>
      {d.thumbnails.map((t, i) => (
        <div key={i} className="small">
          <b style={{ color: 'var(--amber)' }}>{t.text}</b> — {t.image}
        </div>
      ))}
      {d.chapters.map((ch, i) => (
        <div key={i} style={{ marginTop: 14 }}>
          <div className="row">
            <b>{i + 1}.</b>
            <input style={{ flex: 1 }} value={ch.title} onChange={(e) => setChapter(i, { title: e.target.value })} />
            <span className="chip">
              {count(ch.voice)} parole · {Math.round((count(ch.voice) / 160) * 60)} s
            </span>
          </div>
          <textarea style={{ minHeight: 150, marginTop: 6 }} value={ch.voice} onChange={(e) => setChapter(i, { voice: e.target.value })} />
          <div className="small muted" style={{ marginTop: 4 }}>
            {ch.beats.map((b, k) => (
              <div key={k}>
                <i>{b.at}…</i> → <span className="chip teal">{b.kind}</span> {b.show}
                {b.card_text && <b style={{ color: 'var(--amber)' }}> «{b.card_text}»</b>}
              </div>
            ))}
          </div>
        </div>
      ))}
      <h3 style={{ marginTop: 14 }}>Fonti {c && <span className="muted small">(controllo: {c.factcheck_route})</span>}</h3>
      {d.facts.map((f, i) => {
        const v = c?.factcheck.checks.find((x) => x.i === i + 1);
        const [label, cls] = (v && VERDICT[v.verdict]) ?? ['', ''];
        return (
          <div key={i} className="small" style={{ marginBottom: 4 }}>
            {v && <span className={`chip ${cls}`}>{label}</span>} {f.claim} —{' '}
            <a href={f.source} target="_blank" rel="noreferrer">
              fonte
            </a>
            {v?.fix && <div className="muted">→ {v.fix}</div>}
          </div>
        );
      })}
      {c && c.factcheck.uncovered.length > 0 && (
        <>
          <h3 style={{ marginTop: 10 }}>Frasi senza fonte</h3>
          {c.factcheck.uncovered.map((u, i) => (
            <div key={i} className="small">
              <span className="chip warn">senza fonte</span> “{u.sentence}” <span className="muted">— {u.note}</span>
            </div>
          ))}
        </>
      )}
      <h3 style={{ marginTop: 10 }}>YouTube</h3>
      <textarea style={{ minHeight: 120 }} value={d.youtube.description} onChange={(e) => setD({ ...d, youtube: { ...d.youtube, description: e.target.value } })} />
      <div className="small muted">{d.youtube.tags.join(', ')}</div>
      <ScriptButtons onSave={() => save({ edited: d })} onApprove={() => save({ edited: d, status: 'approvato' }, 'Script approvato')} onDiscard={() => save({ status: 'scartato' }, 'Script scartato')} />
    </div>
  );
}

function ScriptButtons({ onSave, onApprove, onDiscard }: { onSave: () => void; onApprove: () => void; onDiscard: () => void }) {
  return (
    <div className="row" style={{ marginTop: 10 }}>
      <button className="btn" onClick={onSave}>
        Salva
      </button>
      <span className="spacer" />
      <button className="btn ok" onClick={onApprove}>
        Approva
      </button>
      <button className="btn danger" onClick={onDiscard}>
        Scarta
      </button>
    </div>
  );
}
