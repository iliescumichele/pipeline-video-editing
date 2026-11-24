import { createFileRoute, redirect } from '@tanstack/react-router';

// Gameplay è dentro Video: ogni gameplay è un video, con Video lungo e Short.
export const Route = createFileRoute('/gameplay/')({
  beforeLoad: () => {
    throw redirect({ to: '/video' });
  },
});
