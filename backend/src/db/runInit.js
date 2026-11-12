const { ensurePoolConnected } = require('./pool');
const { initDatabase } = require('./init');

(async () => {
  try {
    const pool = await ensurePoolConnected();
    const res = await initDatabase(pool);
    console.log('[DB Init]', res.message);
    process.exit(0);
  } catch (err) {
    console.error('[DB Init Error]', err);
    process.exit(1);
  }
})();

