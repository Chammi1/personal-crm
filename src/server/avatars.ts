import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../config.js';

/**
 * Аватары лежат рядом с базой, в примонтированном томе — переживают пересборку.
 * Клиент присылает картинку уже уменьшенной до 320px в base64,
 * поэтому серверу не нужен ни sharp, ни другие нативные зависимости.
 */
export const AVATAR_DIR = join(dirname(config.dbPath), 'avatars');
const MAX_BYTES = 400_000;

mkdirSync(AVATAR_DIR, { recursive: true });

export function save(kind: 'p' | 'pet', id: number, dataUrl: string): string | null {
  const match = dataUrl.match(/^data:image\/(jpeg|png|webp);base64,(.+)$/);
  if (!match) return null;

  const buffer = Buffer.from(match[2]!, 'base64');
  if (buffer.byteLength > MAX_BYTES) return null;

  const file = `${kind}${id}.jpg`;
  writeFileSync(join(AVATAR_DIR, file), buffer);
  return file;
}

export function remove(file: string): void {
  const path = join(AVATAR_DIR, file.replace(/[^\w.-]/g, ''));
  if (existsSync(path)) unlinkSync(path);
}
