// Lucio Studio: la dashboard della pipeline (TanStack Start). Gira con Bun (`bun --bun vite`), così
// le funzioni server usano bun:sqlite e i moduli della pipeline in ../src così come sono.
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: '127.0.0.1', port: Number(process.env.LUCIO_DASHBOARD_PORT ?? 4747), strictPort: true },
  ssr: { external: ['bun:sqlite'] },
  plugins: [tanstackStart(), viteReact()],
});
