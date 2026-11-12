const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { ensurePoolConnected } = require('./db/pool');
const { initDatabase } = require('./db/init');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';

async function start() {
  try {
    console.log('[Forca & Fitness] Conectando a PostgreSQL...');
    const pool = await ensurePoolConnected();
    console.log('[Forca & Fitness] Verificando esquema y datos iniciales...');
    const dbRes = await initDatabase(pool);
    console.log('[Forca & Fitness]', dbRes.message);

    const app = createApp();
    app.listen(PORT, HOST, () => {
      console.log(`[Forca & Fitness] Servidor listo en http://${HOST}:${PORT}`);
    });
  } catch (err) {
    console.error('[Forca & Fitness] Error fatal al iniciar:', err);
    process.exit(1);
  }
}

start();

