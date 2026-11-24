import { useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { q } from '../lib/queries';
import { gb, mins, TASK_NAMES, when } from '../lib/util';
import { cancelJob } from '../server/api.functions';

export const Route = createFileRoute('/')({
  validateSearch: (s: Record<string, unknown>): { job?: number } => (s.job != null && !Number.isNaN(Number(s.job)) ? { job: Number(s.job) } : {}),
  loader: ({ context }) => context.queryClient.ensureQueryData(q.status()),
  component: Status,
});

function Status() {
  const { data: status } = useSuspenseQuery(q.status());
  const { job: sel } = Route.useSearch();
  const navigate = useNavigate({ from: '/' });
  const qc = useQueryClient();
  const job = sel ?? status.jobs[0]?.id ?? null;
  const { data: log } = useQuery({ ...q.jobLog(job ?? 0), enabled: job != null });
  const d = status.disk;
  const total = Object.values(d).reduce((a, b) => a + b, 0);
  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="grid cols-3">
        <div className="card">
          <h3>Modelli locali</h3>
          <div className="row small">
            <span className={`dot ${status.lmstudio.up ? 'on' : 'off'}`} /> LM Studio {status.lmstudio.up ? 'acceso' : 'spento'}
          </div>
          {status.lmstudio.models.length ? (
            status.lmstudio.models.map((m) => (
              <div key={m.id} className="small muted">
                {m.id} {m.context ? `· contesto ${m.context}` : ''}
              </div>
            ))
          ) : (
            <div className="small muted">nessun modello caricato (si caricano da soli quando servono)</div>
          )}
          <div className="row small" style={{ marginTop: 8 }}>
            <span className={`dot ${status.clef.up ? 'on' : ''}`} /> Clef {status.clef.up ? 'acceso' : 'spento (si accende quando serve)'}
          </div>
        </div>
        <div className="card">
          <h3>Claude</h3>
          <div className="row small">
            <span className={`dot ${status.claude.ok ? 'on' : 'off'}`} /> {status.claude.ok ? 'abbonamento claude.ai, nessuna API key' : `accesso: ${status.claude.method ?? 'non disponibile'}`}
          </div>
          <h3 style={{ marginTop: 12 }}>Chi fa cosa</h3>
          {Object.entries(status.routing).map(([t, r]) => (
            <div key={t} className="small">
              <span className="muted">{TASK_NAMES[t] ?? t}:</span> {r.provider} {r.model ?? ''} {r.effort ? `(${r.effort})` : ''}
            </div>
          ))}
        </div>
        <div className="card">
          <h3>Spazio</h3>
          {Object.entries(d)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => (
              <div key={k} className="row small" style={{ justifyContent: 'space-between' }}>
                <span className="muted">{k}</span>
                <span>{gb(v)}</span>
              </div>
            ))}
          <div className="row small" style={{ justifyContent: 'space-between', marginTop: 6 }}>
            <b>progetto</b>
            <b>{gb(total)}</b>
          </div>
          <div className="small muted">liberi sul disco: {gb(status.free)}</div>
        </div>
      </div>
      <div className="split">
        <div className="card">
          <h3>Lavori</h3>
          <div className="list">
            {status.jobs.length === 0 && <div className="muted small">Nessun lavoro ancora.</div>}
            {status.jobs.map((j) => (
              <div key={j.id} className={`item ${j.id === job ? 'sel' : ''}`} onClick={() => navigate({ search: { job: j.id }, replace: true })}>
                <div className="row">
                  <b className="small">{j.title}</b>
                  <span className="spacer" />
                  <span className={`chip ${j.status === 'finito' ? 'ok' : j.status === 'fallito' ? 'warn' : j.status === 'in corso' ? 'amber' : ''}`}>{j.status}</span>
                </div>
                <div className="small muted">
                  #{j.id} · {when(j.created_at)}
                  {j.finished_at && j.started_at ? ` · ${mins((Date.parse(j.finished_at) - Date.parse(j.started_at)) / 1000)}` : ''}
                </div>
                {j.status === 'in corso' || j.status === 'in coda' ? (
                  <button
                    className="btn danger small"
                    onClick={async (e) => {
                      e.stopPropagation();
                      await cancelJob({ data: j.id });
                      await qc.invalidateQueries({ queryKey: ['status'] });
                    }}
                  >
                    Ferma
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <h3>Log {job != null ? `#${job}` : ''}</h3>
          <pre className="log">{log || 'Nessun output.'}</pre>
        </div>
      </div>
    </div>
  );
}
