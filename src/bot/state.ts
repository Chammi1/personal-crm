import * as settings from '../db/repo/settings.js';

/**
 * Состояние диалога хранится в таблице settings, а не в памяти процесса:
 * перезапуск контейнера посреди ввода заметки больше не теряет контекст.
 * Пользователь один, поэтому пары ключей достаточно.
 */
export type Pending =
  | { type: 'note'; personId: number }
  | { type: 'task'; personId: number }
  | { type: 'event'; personId: number }
  | { type: 'contact_note'; personId: number };

const PENDING_KEY = 'bot_pending';
const CURRENT_KEY = 'bot_current';

export function setPending(p: Pending): void {
  settings.set(PENDING_KEY, JSON.stringify(p));
}

export function takePending(): Pending | null {
  const raw = settings.get(PENDING_KEY, '');
  if (!raw) return null;
  settings.set(PENDING_KEY, '');
  try {
    return JSON.parse(raw) as Pending;
  } catch {
    return null;
  }
}

/** Подглядеть ожидание, не съедая его — для тестов и диагностики. */
export function getPending(): Pending | null {
  const raw = settings.get(PENDING_KEY, '');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Pending;
  } catch {
    return null;
  }
}

export function clearPending(): void {
  settings.set(PENDING_KEY, '');
}

export function setCurrent(id: number): void {
  settings.set(CURRENT_KEY, String(id));
}

export function getCurrent(): number | null {
  const n = Number(settings.get(CURRENT_KEY, ''));
  return Number.isInteger(n) && n > 0 ? n : null;
}
