import type { Person } from '../db/types.js';
import * as people from '../db/repo/people.js';

/**
 * Раскладка узлов на кругах.
 *
 * Угол выводится из id детерминированным хешем внутри сектора кластера,
 * а не из порядкового номера. Так позиция человека не съезжает,
 * когда рядом появляются новые люди: запоминаемость карты — половина её пользы.
 */

export const RING_RADIUS = [26, 55, 88, 122, 152];
const SECTOR_PAD = 5;

function hash(n: number, salt: number): number {
  let x = (n * 2654435761 + salt * 40503) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822507) >>> 0;
  x ^= x >>> 13;
  return x >>> 0;
}

export interface Cluster { tag: string; index: number }

/** Кластеры — самые частые теги. Остальные сваливаются в «прочее». */
export function clusters(all: Person[]): { list: string[]; of: (id: number) => number } {
  const counts = new Map<string, number>();
  const primary = new Map<number, string>();

  for (const p of all) {
    const tags = people.tagsOf(p.id);
    const first = tags[0];
    if (first) {
      primary.set(p.id, first);
      counts.set(first, (counts.get(first) ?? 0) + 1);
    }
  }

  // «Прочее» есть ВСЕГДА: иначе при шести и более популярных тегах люди
  // с редким тегом или без тегов рисовались бы в чужом секторе.
  const list = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tag]) => tag);
  list.push('прочее');

  const indexOf = new Map(list.map((t, i) => [t, i]));
  return {
    list,
    of: (id: number) => indexOf.get(primary.get(id) ?? '') ?? list.length - 1,
  };
}

export function place(person: Person, sector: number, sectorCount: number): { x: number; y: number; angle: number } {
  const span = 360 / sectorCount;
  const start = -90 + sector * span + SECTOR_PAD;
  const usable = span - SECTOR_PAD * 2;

  const angle = start + (hash(person.id, 1) % 10_000) / 10_000 * usable;
  const jitter = ((hash(person.id, 2) % 7) - 3) * (person.circle > 1 ? 3.2 : 1.2);
  const r = (RING_RADIUS[person.circle] ?? 152) + jitter;

  const rad = (angle * Math.PI) / 180;
  return { x: 180 + Math.cos(rad) * r, y: 180 + Math.sin(rad) * r, angle };
}
