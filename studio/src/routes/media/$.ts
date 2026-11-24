import { createFileRoute } from '@tanstack/react-router';
import { serveMedia } from '../../server/media.server';

export const Route = createFileRoute('/media/$')({
  server: {
    handlers: {
      GET: ({ request }) => serveMedia(request),
    },
  },
});
