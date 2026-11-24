import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { DiscardedRow, ShortCard } from '../components/short-card';
import { q } from '../lib/queries';
import { useStartJob } from '../lib/jobs';
import { useToast } from '../lib/toast';
import { revealProject } from '../server/api.functions';

// Video → un video → Short: crearli, rivederli, approvarli. Gli approvati vanno in out/<id>/da-pubblicare/.
export const Route = createFileRoute('/video/$id/short')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(q.project(params.id)),
  component: Shorts,
});

const STAGE_NAMES = ['ingest', 'trascrizione', 'segnali', 'candidati', 'vision', 'classifica', 'testi', 'render', 'audio', 'uscita'];

function Shorts() {
  const { id } = Route.useParams();
  const { data: p } = useSuspenseQuery(q.project(id));
  const { data: run } = useQuery(q.run(id));
  const qc = useQueryClient();
  const show = useToast();
  const startChecked = useStartJob();
  const [count, setCount] = useState(8);
  const list = run?.shorts ?? [];
  const count_ = (st: string) => list.filter((s) => s.review.status === st).length;
  const discarded = list.filter((s) => s.review.status === 'scartato');
  const done = p.stages.filter((s) => s.done).length;
  const start = async (req: Parameters<typeof startChecked>[0], msg: string) => {
    try {
      if (!(await startChecked(req))) return;
      show(msg);
      await qc.invalidateQueries({ queryKey: ['project', id] });
    } catch (e) {
      show((e as Error).message);
    }
  };

  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="card">
        {p.source ? (
          <div className="row">
            <div style={{ flex: '1 1 260px', minWidth: 0 }}>
              <div className="small muted">
                Gli short partono da <b style={{ color: 'var(--text)' }}>{p.source.split('/').pop()}</b>
                {p.kind === 'gameplay' && ': il video finale, con il gioco pulito dalla registrazione e Lucianus dal suo file'}
              </div>
              <div className="stages" title={p.stages.map((s, i) => `${STAGE_NAMES[i]}: ${s.done ? 'fatta' : 'da fare'}`).join('\n')}>
                {p.stages.map((s, i) => (
                  <i key={i} className={s.done ? 'done' : 'partial' in s && s.partial ? 'part' : ''} />
                ))}
              </div>
              <div className="small muted">
                {done}/10 fasi{p.job ? ` · ${p.job}` : ''}
              </div>
            </div>
            <label style={{ width: 110 }}>
              Quanti short
              <input type="number" min={1} max={20} value={count} onChange={(e) => setCount(Number(e.target.value))} />
            </label>
            <button
              className={`btn ${list.length ? '' : 'primary'}`}
              disabled={!!p.job}
              onClick={() => start({ kind: 'shorts', video: p.source!, count }, 'Short in coda: segui il lavoro in Stato')}
              title={done === 10 ? 'Rifà solo le fasi che sono cambiate' : undefined}
            >
              {done === 10 ? 'Rifai gli short' : done ? 'Riprendi' : 'Crea gli short'}
            </button>
          </div>
        ) : p.kind === 'gameplay' ? (
          <div className="row small">
            <span className="muted">Gli short si fanno dal video finale: prima esportalo.</span>
            <span className="spacer" />
            <Link className="btn" to="/video/$id" params={{ id }}>
              1 · Video lungo →
            </Link>
          </div>
        ) : (
          <div className="small muted">Il video da cui sono partiti questi short non è più sul Mac: puoi ancora rivederli e pubblicarli.</div>
        )}
      </div>

      {list.length > 0 && (
        <div className="row">
          <span className="chip ok">
            {count_('approvato')} {count_('approvato') === 1 ? 'approvato' : 'approvati'}
          </span>
          <span className="chip warn">
            {count_('scartato')} {count_('scartato') === 1 ? 'scartato' : 'scartati'}
          </span>
          <span className="chip">{count_('da rivedere')} da rivedere</span>
          <span className="small muted">Gli approvati si copiano con i testi in da-pubblicare, pronti da trascinare nel browser.</span>
          <span className="spacer" />
          {p.source && (
            <button className="btn" disabled={!!p.job} onClick={() => start({ kind: 'rerender', run: id }, 'Render in coda: rifà solo gli short cambiati e salta gli scartati')}>
              Rifai il render
            </button>
          )}
          <button className="btn" onClick={() => revealProject({ data: { id, sub: 'da-pubblicare' } }).catch((e: Error) => show(e.message))}>
            Apri da pubblicare
          </button>
        </div>
      )}
      {!run && <div className="empty">Carico…</div>}
      {run && !list.length && <div className="empty">Nessuno short ancora.</div>}
      {list
        .filter((s) => s.review.status !== 'scartato')
        .map((s) => (
          <ShortCard key={s.id} runId={id} s={s} />
        ))}
      {discarded.length > 0 && (
        <details className="card">
          <summary>Scartati ({discarded.length}): "Rifai il render" li salta</summary>
          <div className="grid" style={{ gap: 8, marginTop: 10 }}>
            {discarded.map((s) => (
              <DiscardedRow key={s.id} runId={id} s={s} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
