/**
 * Состояние в памяти. Пользователь ровно один, процесс один,
 * поэтому хранилище сложнее Map тут было бы преждевременным.
 */
type Pending =
  | { type: 'note'; personId: number }
  | { type: 'task'; personId: number }
  | { type: 'event'; personId: number };

let pending: Pending | null = null;
let current: number | null = null;

export const setPending = (p: Pending): void => { pending = p; };
export const takePending = (): Pending | null => { const p = pending; pending = null; return p; };
export const clearPending = (): void => { pending = null; };

export const setCurrent = (id: number): void => { current = id; };
export const getCurrent = (): number | null => current;
