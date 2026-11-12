const express = require('express');
const cors = require('cors');
const path = require('path');
const { query } = require('./db/pool');

const identidadRoutes = require('./modules/identidad/routes');
const matriculasRoutes = require('./modules/matriculas/routes');
const inventarioRoutes = require('./modules/inventario/routes');
const seguridadRoutes = require('./modules/seguridad/routes');
const tesoreriaRoutes = require('./modules/tesoreria/routes');
const analiticaRoutes = require('./modules/analitica/routes');
const agenteRoutes = require('./modules/agente/routes');

function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '2mb' }));

  // Healthcheck oficial para Render (healthCheckPath: /api/health)
  app.get('/api/health', async (_req, res) => {
    try {
      await query('SELECT 1');
      return res.json({
        status: 'ok',
        service: 'Forca & Fitness API Gateway',
        database: 'connected',
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      return res.status(503).json({
        status: 'degraded',
        database: 'disconnected',
        error: err.message,
      });
    }
  });

  // Montaje de módulos de dominio bajo /api y /api/v1 (API Gateway)
  const apiRouters = [
    identidadRoutes,
    matriculasRoutes,
    inventarioRoutes,
    seguridadRoutes,
    tesoreriaRoutes,
    analiticaRoutes,
    agenteRoutes,
  ];
  for (const r of apiRouters) {
    app.use('/api', r);
    app.use('/api/v1', r);
  }

  // Servir Frontend estático (Portales APU1..APU5)
  const frontendDir = path.resolve(__dirname, '../../frontend');
  app.use(express.static(frontendDir));

  app.get('/', (_req, res) => {
    res.sendFile(path.join(frontendDir, 'index.html'));
  });

  // Manejo de errores JSON en /api/*
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Endpoint no encontrado en API Gateway.' });
  });

  return app;
}

module.exports = { createApp };

