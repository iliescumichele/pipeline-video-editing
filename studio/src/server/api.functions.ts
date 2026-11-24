// Le funzioni server della dashboard: chiamate RPC dal browser, eseguite solo sul server.
import { createServerFn } from '@tanstack/react-start';
import type { RoutingFile } from '../../../src/lib/routing';
import type { Asset } from '../../../src/news/assets';
import * as p from './pipeline.server';

// ───────── stato e lavori ─────────

export const getStatus = createServerFn().handler(() => p.status());

export const getJobLog = createServerFn()
  .validator((id: number) => id)
  .handler(({ data }) => p.jobLog(data));

export const startJob = createServerFn({ method: 'POST' })
  .validator((r: p.JobRequest) => r)
  .handler(({ data }) => p.startJob(data));

export const estimateJob = createServerFn({ method: 'POST' })
  .validator((r: p.JobRequest) => r)
  .handler(({ data }) => p.estimateJob(data));

export const cancelJob = createServerFn({ method: 'POST' })
  .validator((id: number) => id)
  .handler(({ data }) => p.cancel(data));

// ───────── video e short ─────────

export const addVideo = createServerFn({ method: 'POST' })
  .validator((path: string) => path)
  .handler(({ data }) => p.addVideo(data));

export const getRun = createServerFn()
  .validator((id: string) => id)
  .handler(({ data }) => p.run(data));

export const saveShortReview = createServerFn({ method: 'POST' })
  .validator((d: { run: string; short: string; patch: Parameters<typeof p.saveReview>[2] }) => d)
  .handler(({ data }) => p.saveReview(data.run, data.short, data.patch));

// ───────── notizie e script ─────────

export const getStories = createServerFn()
  .validator((min: number) => min)
  .handler(({ data }) => p.stories(data));

export const getStory = createServerFn()
  .validator((id: number) => id)
  .handler(({ data }) => p.story(data));

export const setStoryStatus = createServerFn({ method: 'POST' })
  .validator((d: { id: number; status: string }) => d)
  .handler(({ data }) => p.setStoryStatus(data.id, data.status));

export const saveScript = createServerFn({ method: 'POST' })
  .validator((d: { id: number; edited?: unknown; status?: string }) => d)
  .handler(({ data }) => p.saveScript(data.id, data.edited, data.status));

// ───────── modelli e banco di prova ─────────

export const getRouting = createServerFn().handler(() => p.readRouting());

export const saveRouting = createServerFn({ method: 'POST' })
  .validator((r: RoutingFile) => r)
  .handler(({ data }) => p.saveRouting(data));

export const getBench = createServerFn()
  .validator((id: string | undefined) => id)
  .handler(({ data }) => ({
    runs: p.benchRuns().map((b) => ({ id: b.id, candidates: b.candidates.length, runs: b.runs.length })),
    summary: p.benchSummary(data),
  }));

export const getBenchPair = createServerFn()
  .validator((d: { id?: string; task?: string }) => d)
  .handler(({ data }) => p.votePair(data.id, data.task));

export const voteBench = createServerFn({ method: 'POST' })
  .validator((d: { token: string; winner: 'a' | 'b' | 'pari' }) => d)
  .handler(({ data }) => p.benchVote(data.token, data.winner) ?? { error: 'coppia scaduta' });

// ───────── libreria media e montaggio ─────────

export const getMedia = createServerFn().handler(() => p.mediaLibrary());

export const getLongScripts = createServerFn().handler(() => p.longScripts());

export const getManifest = createServerFn()
  .validator((id: number) => id)
  .handler(({ data }) => p.manifest(data));

export const setBeatAssets = createServerFn({ method: 'POST' })
  .validator((d: { script: number; chapter: number; index: number; assets: Asset[] }) => d)
  .handler(({ data }) => p.setBeatAssets(data.script, data.chapter, data.index, data.assets));

export const getTimeline = createServerFn()
  .validator((id: number) => id)
  .handler(({ data }) => p.timeline(data));

// ───────── gameplay lungo ─────────

export const getGameplay = createServerFn()
  .validator((id: string) => id)
  .handler(({ data }) => p.gameplay(data));

export const saveGameplayCuts = createServerFn({ method: 'POST' })
  .validator((d: { id: string; cuts: Parameters<typeof p.saveGameplayCuts>[1] }) => d)
  .handler(({ data }) => p.saveGameplayCuts(data.id, data.cuts));

export const saveGameplayMeta = createServerFn({ method: 'POST' })
  .validator((d: { id: string; patch: p.GameplayMeta }) => d)
  .handler(({ data }) => p.saveGameplayMeta(data.id, data.patch));

export const chooseSecondFolder = createServerFn({ method: 'POST' }).handler(() => p.chooseSecondFolder());

export const clearSecondFolder = createServerFn({ method: 'POST' }).handler(() => p.clearSecondFolder());

export const generateGameplayYoutube = createServerFn({ method: 'POST' })
  .validator((id: string) => id)
  .handler(({ data }) => p.gameplayYoutube(data));

export const addReference = createServerFn({ method: 'POST' })
  .validator((d: { name: string; base64: string }) => d)
  .handler(({ data }) => p.addReference(data.name, data.base64));

export const removeReference = createServerFn({ method: 'POST' })
  .validator((path: string) => path)
  .handler(({ data }) => p.removeReference(data));

export const revealInFinder = createServerFn({ method: 'POST' })
  .validator((target: string) => target)
  .handler(({ data }) => p.revealInFinder(data));

// ───────── file ─────────

export const getFiles = createServerFn().handler(() => p.files());

// ───────── video: gameplay e short insieme ─────────

export const getProjects = createServerFn().handler(() => p.projects());

export const getProject = createServerFn()
  .validator((id: string) => id)
  .handler(({ data }) => p.project(data));

export const revealProject = createServerFn({ method: 'POST' })
  .validator((d: { id: string; sub: 'cartella' | 'da-pubblicare' }) => d)
  .handler(({ data }) => p.revealProject(data.id, data.sub));

// ───────── qualità dei video ─────────

export const getExportSettings = createServerFn().handler(() => p.exportSettings());

export const saveExportSettings = createServerFn({ method: 'POST' })
  .validator((s: Parameters<typeof p.saveExportSettings>[0]) => s)
  .handler(({ data }) => p.saveExportSettings(data));
