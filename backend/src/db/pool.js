const { Pool } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env') });

let poolInstance = null;

/**
 * Construye las opciones SSL apropiadas para Render PostgreSQL o Postgres local.
 * - Si DATABASE_SSL='false', desactiva SSL.
 * - Si DATABASE_SSL='true' o la URL apunta a *.render.com o incluye sslmode=require, usa SSL con rejectUnauthorized: false.
 */
function resolveSslOption(connectionString, forceSsl) {
  if (typeof forceSsl === 'boolean') {
    return forceSsl ? { rejectUnauthorized: false } : false;
  }
  const envSsl = (process.env.DATABASE_SSL || '').toLowerCase();
  if (envSsl === 'false' || envSsl === '0') return false;
  if (envSsl === 'true' || envSsl === '1') return { rejectUnauthorized: false };
  if (!connectionString) return false;
  if (
    connectionString.includes('.render.com') ||
    connectionString.includes('sslmode=require') ||
    connectionString.includes('ssl=true')
  ) {
    return { rejectUnauthorized: false };
  }
  return false;
}

function createPool(forceSsl) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'Falta la variable de entorno DATABASE_URL. Configúrala con la URL de PostgreSQL de Render o tu instancia local.'
    );
  }
  return new Pool({
    connectionString,
    ssl: resolveSslOption(connectionString, forceSsl),
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
}

function setPool(customPool) {
  poolInstance = customPool;
}

function getPool() {
  if (!poolInstance) {
    poolInstance = createPool();
  }
  return poolInstance;
}

/**
 * Verifica conectividad contra PostgreSQL y reintenta automáticamente
 * cambiando SSL on/off si Render Internal/External URL difiere.
 */
async function ensurePoolConnected() {
  let pool = getPool();
  try {
    await pool.query('SELECT 1');
    return pool;
  } catch (err) {
    const msg = (err && err.message) || '';
    const needsNoSsl = msg.includes('does not support SSL connections');
    const needsSsl =
      msg.includes('SSL/TLS required') ||
      msg.includes('no pg_hba.conf entry') ||
      msg.includes('SSL connection is required');

    if (needsNoSsl || needsSsl) {
      try {
        await pool.end();
      } catch (_) {}
      poolInstance = createPool(needsSsl);
      await poolInstance.query('SELECT 1');
      return poolInstance;
    }
    throw err;
  }
}

async function query(text, params) {
  return getPool().query(text, params);
}

async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  getPool,
  setPool,
  ensurePoolConnected,
  query,
  withTransaction,
};

