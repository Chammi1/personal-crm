import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { config } from '../config.js';
import { isOwner, verifyInitData } from './auth.js';
import { api } from './api.js';
import { sync } from './sync.js';

const require = createRequire(import.meta.url);
const app = new Hono();

/**
 * Доступ к API только владельцу по подписанной initData.
 * ALLOW_INSECURE=1 отключает проверку — режим только для локальной отладки
 * в обычном браузере, на боевом сервере включать нельзя.
 */
app.use('/api/*', async (c, next) => {
  if (config.allowInsecure) return next();

  const initData = c.req.header('X-Telegram-Init-Data') ?? '';
  const { ok, userId } = verifyInitData(initData);
  if (!ok || !isOwner(userId)) return c.json({ error: 'forbidden' }, 403);
  return next();
});

app.route('/api', api);

// Приём данных из СОТА CRM. Своя защита по SYNC_TOKEN — сюда стучится сервер,
// а не браузер, и подписанного initData у него нет.
app.route('/sync', sync);

// Vue отдаём со своего же сервера, а не с CDN: меньше зависимостей от сети.
app.get('/vendor/vue.js', (c) => {
  const path = require.resolve('vue/dist/vue.esm-browser.prod.js');
  return c.body(readFileSync(path), 200, { 'Content-Type': 'application/javascript; charset=utf-8' });
});

app.use('/*', serveStatic({ root: './public' }));

export function startServer(): void {
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`[web] мини-апп на порту ${info.port}${config.allowInsecure ? ' (проверка initData ОТКЛЮЧЕНА)' : ''}`);
  });
}
