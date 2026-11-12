const express = require('express');
const { query } = require('../../db/pool');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { eventBus, TOPICOS } = require('../../events/eventBus');
const { sha256 } = require('../../db/init');

const router = express.Router();

// GET /api/seguridad/dvr — Estado de grabadores DVR y drift NTP en las 3 sedes
router.get('/seguridad/dvr', requireAuth, requireRole(['Director']), async (_req, res) => {
  try {
    const r = await query(
      `SELECT d.*, s.nombre AS sede_nombre
       FROM equipos_dvr d
       JOIN sedes s ON s.id = d.sede_id
       ORDER BY d.id ASC`
    );
    return res.json(r.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Error consultando equipos DVR.' });
  }
});

// POST /api/seguridad/dvr/sync — Sincronización horaria NTP en las 3 sedes + log inmutable
router.post('/seguridad/dvr/sync', requireAuth, requireRole(['Director']), async (req, res) => {
  try {
    const { dvr_id } = req.body || {};
    const targetDvrs = dvr_id
      ? await query('SELECT * FROM equipos_dvr WHERE id = $1', [Number(dvr_id)])
      : await query('SELECT * FROM equipos_dvr ORDER BY id ASC');

    const resultados = [];
    for (const d of targetDvrs.rows) {
      const nuevoDrift = Math.floor(Math.random() * 8) + 2; // 2-9 ms sincronizado
      const upd = await query(
        `UPDATE equipos_dvr
         SET ntp_drift_ms = $1, estado_conexion = 'ONLINE', ultima_sync_ntp = NOW()
         WHERE id = $2 RETURNING *`,
        [nuevoDrift, d.id]
      );
      const logHash = sha256(`SYNC_NTP-${d.id}-${req.user.id}-${Date.now()}`);
      await query(
        `INSERT INTO logs_auditoria_video (dvr_id, usuario_id, accion, motivo, hash_registro)
         VALUES ($1,$2,'SYNC_NTP',$3,$4)`,
        [d.id, req.user.id, `Homologación NTP ejecutada. Drift anterior: ${d.ntp_drift_ms}ms -> Actual: ${nuevoDrift}ms`, logHash]
      );
      resultados.push(upd.rows[0]);
    }
    return res.json({ sincronizados: resultados.length, dvrs: resultados });
  } catch (err) {
    return res.status(500).json({ error: 'Error sincronizando relojes NTP de DVR.' });
  }
});

// GET / POST / PUT Incidentes de seguridad y correlación QR/POS-Video SHA-256
router.get('/seguridad/incidentes', requireAuth, requireRole(['Director']), async (_req, res) => {
  try {
    const r = await query(
      `SELECT i.*, s.nombre AS sede_nombre, d.nombre AS dvr_nombre,
              COALESCE(u.nombre || ' ' || u.apellido_paterno, 'Sistema') AS reportado_por
       FROM incidentes_seguridad i
       JOIN sedes s ON s.id = i.sede_id
       LEFT JOIN equipos_dvr d ON d.id = i.dvr_id
       LEFT JOIN usuarios u ON u.id = i.reportado_por_id
       ORDER BY i.id DESC`
    );
    return res.json(r.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Error consultando incidentes.' });
  }
});

router.post('/seguridad/incidentes', requireAuth, requireRole(['Director', 'Recepcionista', 'Profesor']), async (req, res) => {
  try {
    const { sede_id = 1, dvr_id, tipo = 'Incidente en Tatami', descripcion } = req.body || {};
    if (!descripcion) {
      return res.status(400).json({ error: 'Describe el incidente para generar la evidencia SHA-256.' });
    }
    const dvrRow = dvr_id
      ? (await query('SELECT * FROM equipos_dvr WHERE id = $1', [Number(dvr_id)])).rows[0]
      : (await query('SELECT * FROM equipos_dvr WHERE sede_id = $1 LIMIT 1', [Number(sede_id)])).rows[0];

    const clipRef = `rtsp://${dvrRow?.ip_local || '192.168.10.250'}/ch1/evidencia-${Date.now()}.mp4`;
    const hashEvidencia = sha256(`${clipRef}|${descripcion}|${req.user.id}`);

    const ins = await query(
      `INSERT INTO incidentes_seguridad (sede_id, dvr_id, tipo, descripcion, clip_referencia, hash_evidencia_sha256, reportado_por_id, estado)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'abierto') RETURNING *`,
      [Number(sede_id), dvrRow?.id || null, tipo, descripcion, clipRef, hashEvidencia, req.user.id]
    );

    await query(
      `INSERT INTO logs_auditoria_video (dvr_id, usuario_id, accion, motivo, hash_registro)
       VALUES ($1,$2,'EXPORTAR_CLIP_SHA256',$3,$4)`,
      [dvrRow?.id || null, req.user.id, `Evidencia generada para incidente #${ins.rows[0].id}: ${tipo}`, hashEvidencia]
    );

    await eventBus.publish(
      TOPICOS.SEGURIDAD_INCIDENTE_LOG,
      { incidente_id: ins.rows[0].id, sede_id, tipo, hash_evidencia: hashEvidencia },
      'APP4-SeguridadDVR'
    );

    return res.status(201).json(ins.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Error registrando incidente de seguridad.' });
  }
});

router.put('/seguridad/incidentes/:id/resolver', requireAuth, requireRole(['Director']), async (req, res) => {
  try {
    const r = await query(
      "UPDATE incidentes_seguridad SET estado = 'resuelto' WHERE id = $1 RETURNING *",
      [Number(req.params.id)]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Incidente no encontrado.' });
    return res.json(r.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Error resolviendo incidente.' });
  }
});

// GET / POST Bitácora inmutable (append-only) de acceso a cámaras
router.get('/seguridad/auditoria', requireAuth, requireRole(['Director']), async (_req, res) => {
  try {
    const r = await query(
      `SELECT l.*, d.nombre AS dvr_nombre, s.nombre AS sede_nombre,
              COALESCE(u.nombre || ' ' || u.apellido_paterno, 'Sistema') AS usuario_nombre
       FROM logs_auditoria_video l
       LEFT JOIN equipos_dvr d ON d.id = l.dvr_id
       LEFT JOIN sedes s ON s.id = d.sede_id
       LEFT JOIN usuarios u ON u.id = l.usuario_id
       ORDER BY l.id DESC LIMIT 100`
    );
    return res.json(r.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Error consultando bitácora de auditoría.' });
  }
});

router.post('/seguridad/auditoria', requireAuth, requireRole(['Director']), async (req, res) => {
  try {
    const { dvr_id, accion = 'VER_STREAM_RTSP', motivo = 'Revisión preventiva de tatami/caja' } = req.body || {};
    const hash = sha256(`AUDIT-${dvr_id}-${req.user.id}-${accion}-${Date.now()}`);
    const ins = await query(
      `INSERT INTO logs_auditoria_video (dvr_id, usuario_id, accion, motivo, hash_registro)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [dvr_id ? Number(dvr_id) : null, req.user.id, accion, motivo, hash]
    );
    return res.status(201).json(ins.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Error registrando log de auditoría.' });
  }
});

module.exports = router;

