import { migrate } from './db/index.js';
import { bot, setCommandMenu } from './bot/index.js';
import { scheduleDigest } from './jobs/digest.js';
import { startServer } from './server/index.js';

async function main(): Promise<void> {
  migrate();
  await setCommandMenu();
  scheduleDigest();
  startServer();

  const stop = (): void => { void bot.stop(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  console.log('[bot] запущен');
  await bot.start();
}

main().catch((e) => {
  console.error('Не удалось запуститься:', e);
  process.exit(1);
});
