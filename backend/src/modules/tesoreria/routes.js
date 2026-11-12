const express = require('express');
const { query, withTransaction } = require('../../db/pool');
const { requireAuth, requireRole, normalizeRole } = require('../../middleware/auth');
const { eventBus, TOPICOS } = require('../../events/eventBus');
const { sha256, buildXmlUbl } = require('../../db/init');

const router = express.Router();

async function emitirComprobanteYActivarMatricula(client, pagoRow, extra = {}) {
  // 1. Generar comprobante UBL 2.1 oficial (Boleta 03 / Factura 01)
  const esFactura = String(pagoRow.tipo_comprobante || '').toLowerCase() === 'factura';
  const tipoCod = esFactura ? '01' : '03';
  const prefijo = esFactura ? 'F001' : 'B001';
  const serieNumero = `${prefijo}-${String(pagoRow.id).padStart(7, '0')}`;

  const total = Number(pagoRow.monto);
  const subtotal = +(total / 1.18).toFixed(2);
  const igv = +(total - subtotal).toFixed(2);

  const userRes = await client.query('SELECT nombre, apellido_paterno, dni, email FROM usuarios WHERE id = $1', [
    pagoRow.usuario_id,
  ]);
  const usr = userRes.rows[0] || { nombre: 'Cliente', apellido_paterno: '', dni: '00000000' };
  const clienteNombre = pagoRow.razon_social_cliente || `${usr.nombre} ${usr.apellido_paterno || ''}`.trim();
  const rucODni = pagoRow.ruc_cliente || usr.dni || '00000000';
  const hashSunat = sha256(`${serieNumero}|${total}|${rucODni}|${pagoRow.id}`);
  const xmlUbl = buildXmlUbl(serieNumero, tipoCod, clienteNombre, rucODni, pagoRow.concepto, subtotal, igv, total);

  const existingComp = await client.query('SELECT * FROM comprobantes_ubl WHERE pago_id = $1', [pagoRow.id]);
  let comp = existingComp.rows[0];
  if (!comp) {
    const cIns = await client.query(
      `INSERT INTO comprobantes_ubl (pago_id, tipo, serie_numero, subtotal, igv, total, estado_sunat, hash_sunat, xml_ubl)
       VALUES ($1,$2,$3,$4,$5,$6,'ACEPTADO_CDR',$7,$8) RETURNING *`,
      [pagoRow.id, tipoCod, serieNumero, subtotal, igv, total, hashSunat, xmlUbl]
    );
    comp = cIns.rows[0];
  }

  // 2. Activar o extender matrícula si corresponde
  let matriculaId = pagoRow.matricula_id;
  if (extra.plan_codigo) {
    const pRes = await client.query('SELECT * FROM planes WHERE codigo = $1', [extra.plan_codigo]);
    const plan = pRes.rows[0];
    const meses = plan ? Number(plan.duracion_meses) : Number(extra.duracion_meses || 1);
    const esCombo = Boolean(extra.es_combo_aff || plan?.incluye_combo_gear);
    const disciplina = extra.disciplina || 'Brazilian Jiu-Jitsu';
    const sedeId = Number(pagoRow.sede_id || extra.sede_id || 1);

    const activeMat = await client.query(
      `SELECT * FROM matriculas WHERE usuario_id = $1 AND estado = 'activa' AND fecha_fin >= CURRENT_DATE
       ORDER BY fecha_fin DESC LIMIT 1`,
      [pagoRow.usuario_id]
    );

    const baseDate = activeMat.rows.length ? new Date(activeMat.rows[0].fecha_fin) : new Date();
    const finDate = new Date(baseDate);
    finDate.setMonth(finDate.getMonth() + meses);
    const inicioStr = new Date().toISOString().slice(0, 10);
    const finStr = finDate.toISOString().slice(0, 10);

    if (activeMat.rows.length && !esCombo) {
      await client.query('UPDATE matriculas SET fecha_fin = $1::date WHERE id = $2', [finStr, activeMat.rows[0].id]);
      matriculaId = activeMat.rows[0].id;
    } else {
      const mIns = await client.query(
        `INSERT INTO matriculas (usuario_id, plan_id, sede_id, disciplina, fecha_inicio, fecha_fin, estado, es_combo_aff, talla_combo, combo_despachado, precio_congelado)
         VALUES ($1,$2,$3,$4,$5::date,$6::date,'activa',$7,$8,false,$9) RETURNING *`,
        [
          pagoRow.usuario_id,
          plan?.id || null,
          sedeId,
          disciplina,
          inicioStr,
          finStr,
          esCombo,
          extra.talla_combo || null,
          total,
        ]
      );
      matriculaId = mIns.rows[0].id;
    }
    await client.query('UPDATE pagos SET matricula_id = $1 WHERE id = $2', [matriculaId, pagoRow.id]);
  } else if (matriculaId) {
    // Extender 1 mes si era renovación de matrícula existente
    const mRes = await client.query('SELECT * FROM matriculas WHERE id = $1', [matriculaId]);
    if (mRes.rows.length) {
      const m = mRes.rows[0];
      const base = new Date(m.fecha_fin) > new Date() ? new Date(m.fecha_fin) : new Date();
      base.setMonth(base.getMonth() + 1);
      await client.query("UPDATE matriculas SET estado = 'activa', fecha_fin = $1::date WHERE id = $2", [
        base.toISOString().slice(0, 10),
        matriculaId,
      ]);
    }
  }

  // 3. Descontar items POS de vitrina (bebidas, suplementos, accesorios) si vienen en el pago
  const itemsPos = Array.isArray(extra.items_pos) ? extra.items_pos : [];
  for (const item of itemsPos) {
    if (item.producto_id && item.cantidad > 0) {
      const targetSede = Number(pagoRow.sede_id || 1);
      await client.query(
        `UPDATE stock_sede SET cantidad_disponible = GREATEST(0, cantidad_disponible - $1)
         WHERE producto_id = $2 AND sede_id = $3`,
        [Number(item.cantidad), Number(item.producto_id), targetSede]
      );
      await client.query(
        `INSERT INTO kardex_movimientos (producto_id, sede_id, tipo, cantidad, referencia, usuario_responsable_id)
         VALUES ($1,$2,'VENTA_POS',$3,$4,$5)`,
        [Number(item.producto_id), targetSede, -Number(item.cantidad), `Venta POS Pago #${pagoRow.id}`, pagoRow.usuario_id]
      );
    }
  }

  return { comprobante: comp, matricula_id: matriculaId };
}

// GET /api/pagos — Historial de pagos (Alumno ve solo los suyos; Staff ve todos)
router.get('/pagos', requireAuth, async (req, res) => {
  try {
    const isAlumno = normalizeRole(req.user.rol) === 'Alumno';
    const r = await query(
      `SELECT p.*,
              u.id AS id_alumno,
              TRIM(COALESCE(u.nombre,'') || ' ' || COALESCE(u.apellido_paterno,'')) AS alumno,
              TRIM(COALESCE(u.nombre,'') || ' ' || COALESCE(u.apellido_paterno,'')) AS nombre_alumno,
              u.dni,
              s.nombre AS sede_nombre,
              c.serie_numero,
              c.estado_sunat,
              c.hash_sunat
       FROM pagos p
       JOIN usuarios u ON u.id = p.usuario_id
       LEFT JOIN sedes s ON s.id = p.sede_id
       LEFT JOIN comprobantes_ubl c ON c.pago_id = p.id
       ${isAlumno ? 'WHERE p.usuario_id = $1' : ''}
       ORDER BY p.fecha_pago DESC, p.id DESC`,
      isAlumno ? [req.user.id] : []
    );
    return res.json(r.rows);
  } catch (err) {
    console.error('[Pagos GET Error]', err);
    return res.status(500).json({ error: 'Error consultando pagos.' });
  }
});

// GET /api/pagos/pendientes — Pagos pendientes de aprobación en Tesorería
router.get('/pagos/pendientes', requireAuth, requireRole(['Director', 'Tesorero', 'Recepcionista']), async (_req, res) => {
  try {
    const r = await query(
      `SELECT p.*,
              u.id AS id_alumno,
              TRIM(COALESCE(u.nombre,'') || ' ' || COALESCE(u.apellido_paterno,'')) AS alumno,
              TRIM(COALESCE(u.nombre,'') || ' ' || COALESCE(u.apellido_paterno,'')) AS nombre_alumno,
              u.dni,
              s.nombre AS sede_nombre
       FROM pagos p
       JOIN usuarios u ON u.id = p.usuario_id
       LEFT JOIN sedes s ON s.id = p.sede_id
       WHERE p.estado = 'pendiente'
       ORDER BY p.fecha_pago DESC, p.id DESC`
    );
    return res.json(r.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Error consultando pagos pendientes.' });
  }
});

// POST /api/pagos — Checkout Portal Web o Terminal POS (Idempotente + Conciliación + SUNAT UBL 2.1)
router.post('/pagos', requireAuth, async (req, res) => {
  try {
    const {
      alumno_id,
      usuario_id,
      matricula_id,
      sede_id = 1,
      monto,
      concepto = 'Matrícula Regular',
      medio_pago = 'yape',
      tipo_comprobante = 'Boleta',
      ruc_cliente = null,
      razon_social_cliente = null,
      plan_codigo,
      duracion_meses,
      disciplina,
      es_combo_aff = false,
      talla_combo = null,
      items_pos = [],
      aprobado_en_pos = false,
      idempotency_key,
    } = req.body || {};

    const targetUserId =
      ['Director', 'Tesorero', 'Recepcionista'].includes(req.user.rol) && (alumno_id || usuario_id)
        ? Number(alumno_id || usuario_id)
        : req.user.id;

    const idemKey = req.headers['idempotency-key'] || idempotency_key || null;
    if (idemKey) {
      const dup = await query('SELECT * FROM pagos WHERE idempotency_key = $1', [String(idemKey)]);
      if (dup.rows.length) {
        const comp = await query('SELECT * FROM comprobantes_ubl WHERE pago_id = $1', [dup.rows[0].id]);
        return res.status(200).json({ ...dup.rows[0], comprobante: comp.rows[0] || null, idempotent_hit: true });
      }
    }

    const metodoNorm = String(medio_pago).toLowerCase();
    const esDigitalAuto = ['yape', 'plin', 'tarjeta', 'mercado_pago', 'culqi'].includes(metodoNorm);
    const estadoInicial = esDigitalAuto || aprobado_en_pos ? 'aprobado' : 'pendiente';
    const webhookRef = esDigitalAuto ? `WHK-${metodoNorm.toUpperCase()}-${Date.now().toString().slice(-6)}` : null;

    const result = await withTransaction(async (client) => {
      const ins = await client.query(
        `INSERT INTO pagos (
          usuario_id, matricula_id, sede_id, concepto, monto, medio_pago,
          tipo_comprobante, ruc_cliente, razon_social_cliente, estado,
          conciliacion_automatica, webhook_referencia, idempotency_key, items_pos
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
        RETURNING *`,
        [
          targetUserId,
          matricula_id ? Number(matricula_id) : null,
          Number(sede_id) || 1,
          concepto,
          Number(monto || 150),
          metodoNorm,
          tipo_comprobante,
          ruc_cliente,
          razon_social_cliente,
          estadoInicial,
          esDigitalAuto,
          webhookRef,
          idemKey,
          JSON.stringify(items_pos || []),
        ]
      );
      const pagoRow = ins.rows[0];
      let emitted = null;

      if (estadoInicial === 'aprobado') {
        emitted = await emitirComprobanteYActivarMatricula(client, pagoRow, {
          plan_codigo,
          duracion_meses,
          disciplina,
          es_combo_aff,
          talla_combo,
          sede_id,
          items_pos,
        });
      }

      return { pago: pagoRow, emitted };
    });

    if (estadoInicial === 'aprobado') {
      await eventBus.publish(
        TOPICOS.PAGOS_CONCILIADOS,
        {
          pago_id: result.pago.id,
          usuario_id: targetUserId,
          monto: result.pago.monto,
          medio_pago: metodoNorm,
          conciliacion_automatica: esDigitalAuto,
        },
        'CMM1-Tesoreria'
      );
      if (result.emitted?.comprobante) {
        await eventBus.publish(
          TOPICOS.COMPROBANTES_EMITIDOS,
          {
            serie_numero: result.emitted.comprobante.serie_numero,
            hash_sunat: result.emitted.comprobante.hash_sunat,
          },
          'CMM1-Tesoreria'
        );
      }
      if (plan_codigo || result.emitted?.matricula_id) {
        await eventBus.publish(
          TOPICOS.MATRICULAS_CONFIRMADAS,
          {
            matricula_id: result.emitted?.matricula_id,
            usuario_id: targetUserId,
            es_combo_aff: Boolean(es_combo_aff),
          },
          'APP2-Matriculas'
        );
      }
    }

    return res.status(201).json({
      ...result.pago,
      comprobante: result.emitted?.comprobante || null,
      matricula_id: result.emitted?.matricula_id || result.pago.matricula_id,
    });
  } catch (err) {
    console.error('[Pagos POST Error]', err);
    return res.status(500).json({ error: 'Error registrando pago.' });
  }
});

// POST /api/pagos/webhook — Webhook de Pasarela (Culqi / Mercado Pago / Yape QR)
router.post('/pagos/webhook', async (req, res) => {
  try {
    const { pago_id, referencia_externa, estado = 'approved' } = req.body || {};
    if (!pago_id) return res.status(400).json({ error: 'pago_id requerido en payload webhook.' });
    if (estado !== 'approved') return res.json({ ok: true, ignored: true });

    const out = await withTransaction(async (client) => {
      const pRes = await client.query('SELECT * FROM pagos WHERE id = $1 FOR UPDATE', [Number(pago_id)]);
      if (!pRes.rows.length) return null;
      const upd = await client.query(
        `UPDATE pagos SET estado = 'aprobado', conciliacion_automatica = true,
         webhook_referencia = COALESCE($1, webhook_referencia) WHERE id = $2 RETURNING *`,
        [referencia_externa || `WHK-${Date.now()}`, Number(pago_id)]
      );
      const emitted = await emitirComprobanteYActivarMatricula(client, upd.rows[0], {});
      return { pago: upd.rows[0], emitted };
    });

    if (!out) return res.status(404).json({ error: 'Pago no encontrado.' });
    await eventBus.publish(TOPICOS.PAGOS_CONCILIADOS, { pago_id, via: 'webhook' }, 'CMM1-Tesoreria');
    return res.json({ ok: true, pago: out.pago, comprobante: out.emitted.comprobante });
  } catch (err) {
    return res.status(500).json({ error: 'Error procesando webhook.' });
  }
});

// PUT /api/pagos/:id/confirmar — Confirmación manual por Tesorería (Efectivo/Transferencia)
router.put('/pagos/:id/confirmar', requireAuth, requireRole(['Director', 'Tesorero', 'Recepcionista']), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const out = await withTransaction(async (client) => {
      const pRes = await client.query('SELECT * FROM pagos WHERE id = $1 FOR UPDATE', [id]);
      if (!pRes.rows.length) return null;
      const upd = await client.query("UPDATE pagos SET estado = 'aprobado' WHERE id = $1 RETURNING *", [id]);
      const emitted = await emitirComprobanteYActivarMatricula(client, upd.rows[0], {});
      return { pago: upd.rows[0], emitted };
    });

    if (!out) return res.status(404).json({ error: 'Pago no encontrado.' });
    await eventBus.publish(TOPICOS.PAGOS_CONCILIADOS, { pago_id: id, manual: true }, 'CMM1-Tesoreria');
    return res.json({ message: 'Pago confirmado y comprobante UBL emitido.', ...out });
  } catch (err) {
    return res.status(500).json({ error: 'Error confirmando pago.' });
  }
});

// PUT /api/pagos/:id/rechazar
router.put('/pagos/:id/rechazar', requireAuth, requireRole(['Director', 'Tesorero', 'Recepcionista']), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const upd = await query("UPDATE pagos SET estado = 'rechazado' WHERE id = $1 RETURNING *", [id]);
    if (!upd.rows.length) return res.status(404).json({ error: 'Pago no encontrado.' });
    return res.json(upd.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Error rechazando pago.' });
  }
});

// GET /api/comprobantes y descarga XML UBL 2.1
router.get('/comprobantes', requireAuth, async (req, res) => {
  try {
    const isAlumno = normalizeRole(req.user.rol) === 'Alumno';
    const r = await query(
      `SELECT c.id, c.pago_id, c.tipo, c.serie_numero, c.subtotal, c.igv, c.total,
              c.estado_sunat, c.cdr_codigo, c.cdr_mensaje, c.hash_sunat, c.enviado_email, c.created_at,
              p.concepto, p.medio_pago, p.ruc_cliente, p.razon_social_cliente,
              TRIM(COALESCE(u.nombre,'') || ' ' || COALESCE(u.apellido_paterno,'')) AS cliente_nombre,
              u.dni AS cliente_dni, u.email AS cliente_email
       FROM comprobantes_ubl c
       JOIN pagos p ON p.id = c.pago_id
       JOIN usuarios u ON u.id = p.usuario_id
       ${isAlumno ? 'WHERE p.usuario_id = $1' : ''}
       ORDER BY c.id DESC`,
      isAlumno ? [req.user.id] : []
    );
    return res.json(r.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Error consultando comprobantes SUNAT.' });
  }
});

router.get('/comprobantes/:id/xml', requireAuth, async (req, res) => {
  try {
    const r = await query('SELECT serie_numero, xml_ubl FROM comprobantes_ubl WHERE id = $1', [Number(req.params.id)]);
    if (!r.rows.length) return res.status(404).json({ error: 'Comprobante no encontrado.' });
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${r.rows[0].serie_numero}.xml"`);
    return res.send(r.rows[0].xml_ubl);
  } catch (err) {
    return res.status(500).json({ error: 'Error descargando XML UBL.' });
  }
});

// GET / POST Arqueos de Caja (Terminal POS + Tesorería)
router.get('/tesoreria/arqueos', requireAuth, requireRole(['Director', 'Tesorero', 'Recepcionista']), async (_req, res) => {
  try {
    const r = await query(
      `SELECT a.*, s.nombre AS sede_nombre, COALESCE(u.nombre || ' ' || u.apellido_paterno,'Cajero') AS cajero_nombre
       FROM arqueos_caja a
       JOIN sedes s ON s.id = a.sede_id
       LEFT JOIN usuarios u ON u.id = a.cajero_id
       ORDER BY a.id DESC LIMIT 50`
    );
    return res.json(r.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Error consultando arqueos.' });
  }
});

router.post('/tesoreria/arqueos', requireAuth, requireRole(['Director', 'Tesorero', 'Recepcionista']), async (req, res) => {
  try {
    const {
      sede_id = 1,
      monto_apertura = 200,
      total_efectivo = 0,
      total_yape_plin = 0,
      total_tarjeta = 0,
      observaciones = '',
    } = req.body || {};

    // Calcular recaudado registrado del día en sistema para esa sede
    const sysRes = await query(
      `SELECT medio_pago, COALESCE(SUM(monto),0)::numeric AS sum_monto
       FROM pagos
       WHERE sede_id = $1 AND estado = 'aprobado' AND CAST(fecha_pago AS DATE) = CURRENT_DATE
       GROUP BY medio_pago`,
      [Number(sede_id)]
    );
    let esperado = Number(monto_apertura);
    for (const row of sysRes.rows) esperado += Number(row.sum_monto);
    const declarado = Number(monto_apertura) + Number(total_efectivo) + Number(total_yape_plin) + Number(total_tarjeta);
    const diferencia = +(declarado - esperado).toFixed(2);

    const ins = await query(
      `INSERT INTO arqueos_caja (sede_id, cajero_id, monto_apertura, total_efectivo, total_yape_plin, total_tarjeta, diferencia, estado, observaciones)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'cerrada',$8) RETURNING *`,
      [Number(sede_id), req.user.id, monto_apertura, total_efectivo, total_yape_plin, total_tarjeta, diferencia, observaciones]
    );
    return res.status(201).json(ins.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Error registrando arqueo de caja.' });
  }
});

// Planilla y Liquidación de Honorarios Docentes (18 profesores)
router.get('/tesoreria/planilla', requireAuth, requireRole(['Director', 'Tesorero']), async (_req, res) => {
  try {
    const r = await query(
      `SELECT l.*, TRIM(u.nombre || ' ' || COALESCE(u.apellido_paterno,'')) AS profesor_nombre,
              u.disciplina, s.nombre AS sede_nombre
       FROM liquidaciones_docentes l
       JOIN usuarios u ON u.id = l.instructor_id
       LEFT JOIN sedes s ON s.id = u.sede_id
       ORDER BY l.id DESC`
    );
    return res.json(r.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Error consultando planilla docente.' });
  }
});

router.post('/tesoreria/planilla/:id/pagar', requireAuth, requireRole(['Director', 'Tesorero']), async (req, res) => {
  try {
    const upd = await query(
      "UPDATE liquidaciones_docentes SET estado = 'pagada' WHERE id = $1 RETURNING *",
      [Number(req.params.id)]
    );
    if (!upd.rows.length) return res.status(404).json({ error: 'Liquidación no encontrada.' });
    return res.json(upd.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Error pagando liquidación.' });
  }
});

router.get('/staff/mis-honorarios', requireAuth, requireRole(['Profesor', 'Director']), async (req, res) => {
  try {
    const liq = await query(
      `SELECT * FROM liquidaciones_docentes WHERE instructor_id = $1 ORDER BY id DESC`,
      [req.user.id]
    );
    const turnos = await query(
      `SELECT h.*, s.nombre AS sede_nombre
       FROM horarios_tatami h
       JOIN sedes s ON s.id = h.sede_id
       WHERE h.instructor_id = $1
       ORDER BY h.hora_inicio ASC`,
      [req.user.id]
    );
    return res.json({ liquidaciones: liq.rows, turnos: turnos.rows });
  } catch (err) {
    return res.status(500).json({ error: 'Error consultando turnos y honorarios.' });
  }
});

module.exports = router;
