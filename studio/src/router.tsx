import { QueryClient } from '@tanstack/react-query';
import { createRouter } from '@tanstack/react-router';
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query';
import { routeTree } from './routeTree.gen';

export function getRouter() {
  // Un QueryClient per richiesta: sul server non si mescolano i dati tra una pagina e l'altra.
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 1000 } } });
  const router = createRouter({ routeTree, context: { queryClient }, defaultPreloadStaleTime: 0, scrollRestoration: true });
  setupRouterSsrQueryIntegration({ router, queryClient });
  return router;
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
