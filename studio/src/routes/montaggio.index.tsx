import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { q } from '../lib/queries';
import { when } from '../lib/util';

export const Route = createFileRoute('/montaggio/')({
  loader: ({ context }) => context.queryClient.ensureQueryData(q.longScripts()),
  component: LongScripts,
});

function LongScripts() {
  const { data } = useSuspenseQuery(q.longScripts());
  return (
    <div className="card">
      <h2>Video lunghi</h2>
      {data.length === 0 && <div className="empty">Nessun video lungo: scrivilo dalla scheda Notizie.</div>}
      {data.map((s) => (
        <div key={s.id} className="row small" style={{ marginTop: 6 }}>
          <Link to="/montaggio/$id" params={{ id: String(s.id) }}>
            #{s.id} · {s.title}
          </Link>
          <span className="muted">{when(s.created_at)}</span>
          <span className={`chip ${s.status === 'approvato' ? 'ok' : ''}`}>{s.status}</span>
        </div>
      ))}
    </div>
  );
}
