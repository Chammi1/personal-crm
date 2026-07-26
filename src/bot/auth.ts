import type { Context, NextFunction } from 'grammy';
import { config } from '../config.js';

/** Единственный пользователь — владелец. Всё остальное молча игнорируется. */
export async function onlyOwner(ctx: Context, next: NextFunction): Promise<void> {
  if (ctx.from?.id !== config.ownerId) {
    console.warn(`[auth] отклонён доступ: id=${ctx.from?.id} username=${ctx.from?.username}`);
    return;
  }
  await next();
}
