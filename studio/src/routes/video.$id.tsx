import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link, Outlet } from '@tanstack/react-router';
import { q } from '../lib/queries';
import { useToast } from '../lib/toast';
import { hms } from '../lib/util';
import { revealProject } from '../server/api.functions';

// Un video, con tutto quello che ne esce: per un gameplay il video lungo (tagli, video finale) e poi gli short,
// per gli altri video solo gli short. Tutti i file stanno in out/<id>/.
export const Route = createFileRoute('/video/$id')({
  loader: ({ context, params }) => context.queryClient.ensureQueryData(q.project(params.id)),
  component: VideoLayout,
});

function VideoLayout() {
  const { id } = Route.useParams();
  const { data: p } = useSuspenseQuery(q.project(id));
  const show = useToast();
  const g = p.gameplay;
  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="row">
        <Link to="/video" className="small">
          ← Video
        </Link>
        <h2 style={{ margin: 0, minWidth: 0, overflowWrap: 'anywhere' }}>{p.title}</h2>
        <span className="small muted">
          {p.title !== p.name.replace(/\.[^.]+$/, '') && `${p.name} · `}
          {p.folder ?? (p.kind === 'gameplay' ? 'registrazione non più sul Mac' : 'video non più sul Mac')}
          {p.duration > 0 && ` · ${hms(p.duration)}`}
          {g?.final != null && ` → ${hms(g.final)}`}
        </span>
        <span className="spacer" />
        <button className="btn" onClick={() => revealProject({ data: { id, sub: 'cartella' } }).catch((e: Error) => show(e.message))} title={`out/${id}`}>
          Apri la cartella
        </button>
      </div>
      <nav className="tabs" style={{ margin: 0 }}>
        {p.kind === 'gameplay' && (
          <Link to="/video/$id" params={{ id }} activeOptions={{ exact: true }} activeProps={{ 'aria-current': 'page' }}>
            1 · Video lungo{g?.exported ? ' ✓' : ''}
          </Link>
        )}
        <Link to="/video/$id/short" params={{ id }} activeProps={{ 'aria-current': 'page' }}>
          {p.kind === 'gameplay' ? '2 · ' : ''}Short{p.shorts.total ? ` (${p.shorts.approvato}/${p.shorts.total} approvati)` : ''}
        </Link>
      </nav>
      <Outlet />
    </div>
  );
}
