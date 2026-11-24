import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { q } from '../lib/queries';
import { gb, when } from '../lib/util';

export const Route = createFileRoute('/file')({
  loader: ({ context }) => context.queryClient.ensureQueryData(q.files()),
  component: Files,
});

function Files() {
  const { data: files } = useSuspenseQuery(q.files());
  const { data: status } = useQuery(q.status());
  return (
    <div className="grid cols-2">
      <div className="card">
        <h2>File prodotti e modificati</h2>
        <table>
          <thead>
            <tr>
              <th>File</th>
              <th>Tipo</th>
              <th className="num">Dimensione</th>
              <th>Modificato</th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.path}>
                <td className="small" style={{ wordBreak: 'break-all' }}>
                  {f.path.startsWith('out/') ? (
                    <a href={`/media/out/${f.path.slice(4)}`} target="_blank" rel="noreferrer">
                      {f.path}
                    </a>
                  ) : (
                    f.path
                  )}
                </td>
                <td>
                  <span className="chip">{f.kind}</span>
                </td>
                <td className="num small">{gb(f.size)}</td>
                <td className="small muted">{when(f.mtime)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h2>Pulizia</h2>
        <p className="small muted">
          I file in <code>work/</code> sono intermedi e si rigenerano. Da terminale: <code>bun run clean --work</code> li cancella insieme a modelli, Python e node_modules (che{' '}
          <code>bun run setup</code> reinstalla). <code>out/</code> e <code>data/</code> non vengono mai toccati.
        </p>
        {status &&
          Object.entries(status.disk).map(([k, v]) => (
            <div key={k} className="row small" style={{ justifyContent: 'space-between' }}>
              <span>{k}</span>
              <span>{gb(v)}</span>
            </div>
          ))}
      </div>
    </div>
  );
}
