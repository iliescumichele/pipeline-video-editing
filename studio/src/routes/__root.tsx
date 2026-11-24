import type { QueryClient } from '@tanstack/react-query';
import { useQuery } from '@tanstack/react-query';
import { createRootRouteWithContext, HeadContent, Link, Outlet, Scripts } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { q } from '../lib/queries';
import { JobGuardProvider } from '../lib/jobs';
import { ToastProvider } from '../lib/toast';
import css from '../styles.css?url';

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1' }, { title: 'Lucio Studio' }],
    links: [{ rel: 'stylesheet', href: css }],
  }),
  component: RootComponent,
  notFoundComponent: () => (
    <div className="empty">
      Pagina non trovata. <Link to="/">Torna allo stato</Link>
    </div>
  ),
});

const TABS = [
  { to: '/', label: 'Stato' },
  { to: '/video', label: 'Video' },
  { to: '/notizie', label: 'Notizie' },
  { to: '/montaggio', label: 'Montaggio' },
  { to: '/libreria', label: 'Libreria' },
  { to: '/modelli', label: 'Modelli' },
  { to: '/file', label: 'File' },
] as const;

function RootComponent() {
  return (
    <RootDocument>
      <ToastProvider>
        <JobGuardProvider>
          <Header />
          <main>
            <Outlet />
          </main>
        </JobGuardProvider>
      </ToastProvider>
    </RootDocument>
  );
}

function Header() {
  const { data: status } = useQuery(q.status());
  const running = status?.jobs.find((j) => j.status === 'in corso');
  return (
    <header>
      <h1>
        Lucio <span>Studio</span>
      </h1>
      <nav>
        {TABS.map((t) => (
          <Link key={t.to} to={t.to} activeOptions={{ exact: t.to === '/', includeSearch: false }} activeProps={{ 'aria-current': 'page' }}>
            {t.label}
          </Link>
        ))}
      </nav>
      <div className="pill">
        <span className={`dot ${status?.lmstudio.up ? 'on' : 'off'}`} /> LM Studio
        <span className={`dot ${status?.clef.up ? 'on' : ''}`} /> Clef
        <span className={`dot ${status?.claude.ok ? 'on' : 'off'}`} /> Claude
        {running && <span className="chip amber">in corso: {running.title}</span>}
      </div>
    </header>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="it">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
