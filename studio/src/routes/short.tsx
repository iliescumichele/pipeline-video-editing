import { createFileRoute, redirect } from '@tanstack/react-router';

// Gli short stanno nella pagina del loro video: /video/<id>/short.
export const Route = createFileRoute('/short')({
  validateSearch: (s: Record<string, unknown>): { run?: string } => (typeof s.run === 'string' ? { run: s.run } : {}),
  beforeLoad: ({ search }) => {
    throw search.run ? redirect({ to: '/video/$id/short', params: { id: search.run } }) : redirect({ to: '/video' });
  },
});
