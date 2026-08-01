import { daysBetween, today } from './dates.js';
import * as people from '../db/repo/people.js';
import * as timeline from '../db/repo/timeline.js';

/**
 * Аналитика сети: здоровье кластеров, мосты между ними, коннекторы, дыры.
 * Без теории графов — честные агрегаты, на которые можно опереться действием.
 * Одна логика на бота (/network) и мини-апп (вкладка «Сеть»).
 */

export interface NetworkView {
  clusters: { tag: string; n: number; avgSilence: number | null }[];
  /** люди в двух и более кластерах — теряешь моста, теряешь кусок сети */
  bridges: { id: number; name: string; tags: string[] }[];
  /** кто скольких привёл (met_via) */
  connectors: { id: number; name: string; n: number }[];
  /** кластеры, где все молчат дольше 60 дней (или контакты не размечены) */
  holes: { tag: string; n: number; freshest: number | null }[];
}

export function analyze(now = today()): NetworkView {
  const active = people.active();
  const tagsMap = people.tagsOfAll();
  const lastMap = timeline.lastContactMap();

  const clusters = new Map<string, { n: number; silences: number[]; freshest: number | null }>();
  for (const p of active) {
    for (const t of tagsMap.get(p.id) ?? []) {
      const c = clusters.get(t) ?? { n: 0, silences: [], freshest: null };
      c.n++;
      const last = lastMap.get(p.id);
      if (last) {
        const silent = daysBetween(last, now);
        c.silences.push(silent);
        c.freshest = c.freshest === null ? silent : Math.min(c.freshest, silent);
      }
      clusters.set(t, c);
    }
  }

  const clusterList = [...clusters.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .map(([tag, c]) => ({
      tag, n: c.n,
      avgSilence: c.silences.length
        ? Math.round(c.silences.reduce((s, x) => s + x, 0) / c.silences.length)
        : null,
    }));

  const bridges = active
    .map((p) => ({ id: p.id, name: p.name, tags: tagsMap.get(p.id) ?? [] }))
    .filter((x) => x.tags.length >= 2)
    .sort((a, b) => b.tags.length - a.tags.length)
    .slice(0, 8);

  const connectors = people.connectorTop(8)
    .map((c) => ({ id: c.person.id, name: c.person.name, n: c.n }));

  const holes = [...clusters.entries()]
    .filter(([, c]) => c.n >= 2 && (c.freshest === null || c.freshest > 60))
    .sort((a, b) => (b[1].freshest ?? 9999) - (a[1].freshest ?? 9999))
    .slice(0, 6)
    .map(([tag, c]) => ({ tag, n: c.n, freshest: c.freshest }));

  return { clusters: clusterList, bridges, connectors, holes };
}
