import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/gameplay/$id')({
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/video/$id', params });
  },
});
