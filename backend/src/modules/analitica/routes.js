const express = require('express');
const { query } = require('../../db/pool');
const { requireAuth, requireRole } = require('../../middleware/auth');

const router = express.Router();

// GET /api/analitica/kpis — Cuadro de Mando Integral (BI) para el Directorio
router.get('/analitica/kpis', requireAuth, requireRole(['Director', 'Tesorero']), async (req, res) => {
  try {
    const sedeFilter = req.query.sede_id ? Number(req.query.sede_id) : null;

    const sedesRes = await query('SELECT * FROM sedes WHERE activa = true ORDER BY id ASC');
    const alumnosRaw = await query(
      `SELECT u.id, u.nombre, u.apellido_paterno, u.email, u.telefono, u.sede_id, u.disciplina
       FROM usuarios u
       WHERE LOWER(u.rol) = 'alumno' ${sedeFilter ? 'AND u.sede_id = $1' : ''}`,
      sedeFilter ? [sedeFilter] : []
    );
    const matAll = await query('SELECT * FROM matriculas ORDER BY fecha_fin DESC, id DESC');
    const latestMat = {};
    for (const m of matAll.rows) {
      if (!latestMat[m.usuario_id]) latestMat[m.usuario_id] = m;
    }
    const alumnosRes = {
      rows: alumnosRaw.rows.map((u) => {
        const m = latestMat[u.id] || {};
        return {
          ...u,
          fecha_fin: m.fecha_fin || null,
          estado_mat: m.estado || null,
          precio_congelado: m.precio_congelado || null,
        };
      }),
    };

    const pagosRes = await query(
      `SELECT p.*, s.nombre AS sede_nombre
       FROM pagos p
       LEFT JOIN sedes s ON s.id = p.sede_id
       WHERE p.estado = 'aprobado' ${sedeFilter ? 'AND p.sede_id = $1' : ''}`,
      sedeFilter ? [sedeFilter] : []
    );

    const horariosRes = await query(
      `SELECT h.*, s.nombre AS sede_nombre,
              COALESCE(rc.ocupados, 0)::int AS ocupados
       FROM horarios_tatami h
       JOIN sedes s ON s.id = h.sede_id
       LEFT JOIN (
         SELECT horario_id, COUNT(*)::int AS ocupados
         FROM reservas_cupo
         WHERE fecha_clase = CURRENT_DATE AND estado IN ('confirmada', 'asistio')
         GROUP BY horario_id
       ) rc ON rc.horario_id = h.id
       ${sedeFilter ? 'WHERE h.sede_id = $1' : ''}`,
      sedeFilter ? [sedeFilter] : []
    );

    const hoy = new Date();
    let activos = 0;
    let proxVencer = 0;
    let vencidos = 0;
    const enRiesgoChurn = [];

    for (const a of alumnosRes.rows) {
      if (!a.fecha_fin) {
        vencidos++;
        enRiesgoChurn.push({ ...a, riesgo: 'Alto (Sin matrícula)', dias_restantes: -99 });
        continue;
      }
      const diff = Math.ceil((new Date(a.fecha_fin) - hoy) / (1000 * 60 * 60 * 24));
      if (diff < 0) {
        vencidos++;
        enRiesgoChurn.push({ ...a, riesgo: 'Alto (Vencida)', dias_restantes: diff });
      } else if (diff <= 7) {
        proxVencer++;
        enRiesgoChurn.push({ ...a, riesgo: 'Medio (Vence pronto)', dias_restantes: diff });
      } else {
        activos++;
      }
    }

    const totalAlumnos = alumnosRes.rows.length || 1;
    const ingresosTotales = pagosRes.rows.reduce((acc, p) => acc + Number(p.monto || 0), 0);
    const ticketPromedio = pagosRes.rows.length ? +(ingresosTotales / pagosRes.rows.length).toFixed(2) : 0;
    const churnRate = +((vencidos / totalAlumnos) * 100).toFixed(1);
    const ltvEstimado = +(ticketPromedio * 5.2).toFixed(2); // promedio 5.2 ciclos de retención

    // Ocupación tatamis
    const totalCapacidad = horariosRes.rows.reduce((acc, h) => acc + Number(h.aforo_maximo || 18), 0) || 1;
    const totalOcupados = horariosRes.rows.reduce((acc, h) => acc + Number(h.ocupados || 0), 0);
    const ocupacionPromedioPct = +((totalOcupados / totalCapacidad) * 100).toFixed(1);

    // Ingresos y rentabilidad por m2 por sede
    const porSede = sedesRes.rows
      .filter((s) => !sedeFilter || s.id === sedeFilter)
      .map((s) => {
        const ing = pagosRes.rows
          .filter((p) => p.sede_id === s.id)
          .reduce((acc, p) => acc + Number(p.monto || 0), 0);
        const area = Number(s.area_tatami_m2 || 180);
        const alumnosSede = alumnosRes.rows.filter((a) => a.sede_id === s.id).length;
        return {
          sede_id: s.id,
          sede: s.nombre,
          area_m2: area,
          alumnos: alumnosSede,
          ingresos: +ing.toFixed(2),
          rentabilidad_m2: +(ing / area).toFixed(2),
        };
      });

    // Distribución por disciplina
    const discMap = {};
    for (const a of alumnosRes.rows) {
      const d = a.disciplina || 'General';
      discMap[d] = (discMap[d] || 0) + 1;
    }
    const porDisciplina = Object.entries(discMap).map(([disciplina, cantidad]) => ({ disciplina, cantidad }));

    const eventosRes = await query('SELECT * FROM eventos_dominio ORDER BY id DESC LIMIT 12');

    return res.json({
      resumen: {
        ingresos_totales: +ingresosTotales.toFixed(2),
        ticket_promedio: ticketPromedio,
        ltv_estimado: ltvEstimado,
        churn_rate_pct: churnRate,
        ocupacion_tatami_pct: ocupacionPromedioPct,
        total_alumnos: alumnosRes.rows.length,
        activos,
        prox_vencer: proxVencer,
        vencidos,
      },
      por_sede: porSede,
      por_disciplina: porDisciplina,
      horarios_ocupacion: horariosRes.rows,
      en_riesgo_churn: enRiesgoChurn,
      eventos_recientes: eventosRes.rows,
    });
  } catch (err) {
    console.error('[Analitica KPIs Error]', err);
    return res.status(500).json({ error: 'Error calculando métricas BI.' });
  }
});

// GET / POST / PUT Leads CRM
router.get('/crm/leads', requireAuth, requireRole(['Director', 'Recepcionista', 'Tesorero']), async (_req, res) => {
  try {
    const r = await query('SELECT * FROM crm_leads ORDER BY id DESC');
    return res.json(r.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Error consultando leads CRM.' });
  }
});

router.put('/crm/leads/:id', requireAuth, requireRole(['Director', 'Recepcionista']), async (req, res) => {
  try {
    const { estado = 'contactado', notas } = req.body || {};
    const r = await query(
      'UPDATE crm_leads SET estado = $1, notas = COALESCE($2, notas) WHERE id = $3 RETURNING *',
      [estado, notas || null, Number(req.params.id)]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Lead no encontrado.' });
    return res.json(r.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Error actualizando lead.' });
  }
});

// GET / POST Campañas de Retención CRM
router.get('/crm/campanas', requireAuth, requireRole(['Director', 'Tesorero']), async (_req, res) => {
  try {
    const r = await query('SELECT * FROM campanas_crm ORDER BY id DESC');
    return res.json(r.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Error consultando campañas CRM.' });
  }
});

router.post('/crm/campanas', requireAuth, requireRole(['Director']), async (req, res) => {
  try {
    const { titulo, segmento = 'Proximos a vencer', canal = 'WhatsApp + Email', destinatarios_count = 1 } = req.body || {};
    if (!titulo) return res.status(400).json({ error: 'Título de campaña requerido.' });
    const r = await query(
      `INSERT INTO campanas_crm (titulo, segmento, canal, destinatarios_count, estado)
       VALUES ($1,$2,$3,$4,'enviada') RETURNING *`,
      [titulo, segmento, canal, Number(destinatarios_count)]
    );
    return res.status(201).json(r.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Error lanzando campaña CRM.' });
  }
});

module.exports = router;
