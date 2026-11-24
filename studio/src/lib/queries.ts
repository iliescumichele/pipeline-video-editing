// Letture della dashboard come query di TanStack Query, con l'intervallo di aggiornamento di ciascuna.
import { queryOptions } from '@tanstack/react-query';
import * as api from '../server/api.functions';

export const q = {
  status: () => queryOptions({ queryKey: ['status'], queryFn: () => api.getStatus(), refetchInterval: 5000 }),
  jobLog: (id: number) => queryOptions({ queryKey: ['job-log', id], queryFn: () => api.getJobLog({ data: id }), refetchInterval: 2000 }),
  run: (id: string) => queryOptions({ queryKey: ['run', id], queryFn: () => api.getRun({ data: id }) }),
  stories: (min: number) => queryOptions({ queryKey: ['stories', min], queryFn: () => api.getStories({ data: min }), refetchInterval: 15000 }),
  story: (id: number) => queryOptions({ queryKey: ['story', id], queryFn: () => api.getStory({ data: id }), refetchInterval: 10000 }),
  routing: () => queryOptions({ queryKey: ['routing'], queryFn: () => api.getRouting() }),
  bench: (id?: string) => queryOptions({ queryKey: ['bench', id ?? null], queryFn: () => api.getBench({ data: id }), refetchInterval: 20000 }),
  media: () => queryOptions({ queryKey: ['media'], queryFn: () => api.getMedia(), refetchInterval: 15000 }),
  longScripts: () => queryOptions({ queryKey: ['long-scripts'], queryFn: () => api.getLongScripts() }),
  manifest: (id: number) => queryOptions({ queryKey: ['manifest', id], queryFn: () => api.getManifest({ data: id }), refetchInterval: 10000 }),
  timeline: (id: number) => queryOptions({ queryKey: ['timeline', id], queryFn: () => api.getTimeline({ data: id }) }),
  gameplay: (id: string) => queryOptions({ queryKey: ['gameplay', id], queryFn: () => api.getGameplay({ data: id }), refetchInterval: 5000 }),
  projects: () => queryOptions({ queryKey: ['projects'], queryFn: () => api.getProjects(), refetchInterval: 8000 }),
  project: (id: string) => queryOptions({ queryKey: ['project', id], queryFn: () => api.getProject({ data: id }), refetchInterval: 5000 }),
  exportSettings: () => queryOptions({ queryKey: ['export-settings'], queryFn: () => api.getExportSettings() }),
  files: () => queryOptions({ queryKey: ['files'], queryFn: () => api.getFiles(), refetchInterval: 15000 }),
};
