const express = require('express');
const { query, withTransaction } = require('../../db/pool');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { eventBus, TOPICOS } = require('../../events/eventBus');

const router = express.Router();

// GET /api/inventario/stock — Catálogo y existencias por sede y talla
router.get('/inventario/stock', requireAuth, async (req, res) => {
  try {
    const sedeId = req.query.sede_id ? Number(req.query.sede_id) : null;
    const params = [];
    let where = '';
    if (sedeId) {
      params.push(sedeId);
      where = 'WHERE ss.sede_id = $1';
    }
    const r = await query(
      `SELECT ss.id AS stock_id, ss.producto_id, ss.sede_id, ss.cantidad_disponible,
              ss.cantidad_reservada, ss.punto_reorden,
              (ss.cantidad_disponible <= ss.punto_reorden) AS alerta_reorden,
              pg.sku, pg.nombre, pg.categoria, pg.disciplina, pg.talla, pg.precio_venta, pg.es_parte_combo,
              s.nombre AS sede_nombre, s.codigo AS sede_codigo
       FROM stock_sede ss
       JOIN productos_gear pg ON pg.id = ss.producto_id
       JOIN sedes s ON s.id = ss.sede_id
       ${where}
       ORDER BY (ss.cantidad_disponible <= ss.punto_reorden) DESC, pg.categoria ASC, pg.nombre ASC`,
      params
    );
    return res.json(r.rows);
  } catch (err) {
    console.error('[Stock GET Error]', err);
    return res.status(500).json({ error: 'Error consultando inventario AFF Gear.' });
  }
});

// GET /api/inventario/combos-pendientes — Kits Combo AFF pagados pendientes de entrega en recepción
router.get('/inventario/combos-pendientes', requireAuth, requireRole(['Recepcionista', 'Director', 'Tesorero']), async (_req, res) => {
  try {
    const r = await query(
      `SELECT m.id AS matricula_id, m.usuario_id, m.disciplina, m.talla_combo, m.combo_despachado,
              m.fecha_inicio, m.sede_id, s.nombre AS sede_nombre,
              TRIM(COALESCE(u.nombre,'') || ' ' || COALESCE(u.apellido_paterno,'')) AS alumno_nombre,
              u.dni, u.qr_token, u.email
       FROM matriculas m
       JOIN usuarios u ON u.id = m.usuario_id
       LEFT JOIN sedes s ON s.id = m.sede_id
       WHERE m.es_combo_aff = true AND m.estado = 'activa'
       ORDER BY m.combo_despachado ASC, m.id DESC`
    );
    return res.json(r.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Error consultando combos pendientes.' });
  }
});

// POST /api/inventario/despachar-combo — Despacho presencial de kit Combo AFF y descuento de Kárdex
router.post('/inventario/despachar-combo', requireAuth, requireRole(['Recepcionista', 'Director']), async (req, res) => {
  try {
    const { matricula_id, sede_id, talla } = req.body || {};
    if (!matricula_id) {
      return res.status(400).json({ error: 'Se requiere matricula_id.' });
    }

    const result = await withTransaction(async (client) => {
      const mRes = await client.query('SELECT * FROM matriculas WHERE id = $1 FOR UPDATE', [Number(matricula_id)]);
      if (!mRes.rows.length) {
        const e = new Error('Matrícula no encontrada.');
        e.status = 404;
        throw e;
      }
      const mat = mRes.rows[0];
      if (mat.combo_despachado) {
        const e = new Error('Este kit Combo AFF ya fue entregado al alumno.');
        e.status = 409;
        throw e;
      }

      const targetSede = Number(sede_id || mat.sede_id || 1);
      const targetTalla = talla || mat.talla_combo || 'A2';

      // Buscar producto compatible con disciplina/talla en la sede o cualquiera disponible
      const prodRes = await client.query(
        `SELECT ss.*, pg.nombre AS producto_nombre, pg.sku
         FROM stock_sede ss
         JOIN productos_gear pg ON pg.id = ss.producto_id
         WHERE pg.es_parte_combo = true
           AND ss.sede_id = $1
           AND ss.cantidad_disponible > 0
           AND (LOWER(pg.disciplina) = LOWER($2) OR LOWER(pg.talla) = LOWER($3))
         ORDER BY (LOWER(pg.disciplina) = LOWER($2) AND LOWER(pg.talla) = LOWER($3)) DESC, ss.cantidad_disponible DESC
         LIMIT 1 FOR UPDATE`,
        [targetSede, mat.disciplina, targetTalla]
      );

      let stockInfo = null;
      let alertaReorden = false;

      if (prodRes.rows.length) {
        stockInfo = prodRes.rows[0];
        const nuevoSaldo = stockInfo.cantidad_disponible - 1;
        await client.query(
          'UPDATE stock_sede SET cantidad_disponible = $1 WHERE id = $2',
          [nuevoSaldo, stockInfo.id]
        );
        await client.query(
          `INSERT INTO kardex_movimientos (producto_id, sede_id, tipo, cantidad, referencia, usuario_responsable_id)
           VALUES ($1,$2,'SALIDA_COMBO_AFF',-1,$3,$4)`,
          [stockInfo.producto_id, targetSede, `Despacho Combo Matrícula #${mat.id} (Talla ${targetTalla})`, req.user.id]
        );
        if (nuevoSaldo <= stockInfo.punto_reorden) {
          alertaReorden = true;
        }
      }

      await client.query(
        'UPDATE matriculas SET combo_despachado = true, talla_combo = $1 WHERE id = $2',
        [targetTalla, mat.id]
      );

      return { mat, stockInfo, alertaReorden, targetSede };
    });

    await eventBus.publish(
      TOPICOS.STOCK_COMBO_DESCONTAR,
      {
        matricula_id: result.mat.id,
        sede_id: result.targetSede,
        producto: result.stockInfo?.producto_nombre || `Kit ${result.mat.disciplina}`,
      },
      'APP3-Inventario'
    );

    if (result.alertaReorden && result.stockInfo) {
      await eventBus.publish(
        TOPICOS.STOCK_REORDEN_ALERTA,
        {
          producto_id: result.stockInfo.producto_id,
          sku: result.stockInfo.sku,
          sede_id: result.targetSede,
        },
        'APP3-Inventario'
      );
    }

    return res.json({
      message: 'Combo AFF entregado y descontado del Kárdex.',
      alerta_reorden: result.alertaReorden,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[Despacho Combo Error]', err);
    return res.status(500).json({ error: 'Error al despachar Combo AFF.' });
  }
});

// GET /api/inventario/kardex y POST /api/inventario/kardex
router.get('/inventario/kardex', requireAuth, async (_req, res) => {
  try {
    const r = await query(
      `SELECT k.*, pg.sku, pg.nombre AS producto_nombre, pg.talla, s.nombre AS sede_nombre,
              COALESCE(u.nombre,'Sistema') AS responsable_nombre
       FROM kardex_movimientos k
       JOIN productos_gear pg ON pg.id = k.producto_id
       JOIN sedes s ON s.id = k.sede_id
       LEFT JOIN usuarios u ON u.id = k.usuario_responsable_id
       ORDER BY k.id DESC LIMIT 100`
    );
    return res.json(r.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Error consultando kárdex.' });
  }
});

router.post('/inventario/kardex', requireAuth, requireRole(['Director', 'Recepcionista', 'Tesorero']), async (req, res) => {
  try {
    const { producto_id, sede_id, tipo = 'ENTRADA_TALLER', cantidad, referencia = '' } = req.body || {};
    const qty = Number(cantidad);
    if (!producto_id || !sede_id || !qty) {
      return res.status(400).json({ error: 'Producto, sede y cantidad distinta de 0 son requeridos.' });
    }

    const updated = await withTransaction(async (client) => {
      const ssRes = await client.query(
        'SELECT * FROM stock_sede WHERE producto_id = $1 AND sede_id = $2 FOR UPDATE',
        [Number(producto_id), Number(sede_id)]
      );
      let stockRow;
      if (ssRes.rows.length) {
        const nuevo = Math.max(0, ssRes.rows[0].cantidad_disponible + qty);
        const upd = await client.query(
          'UPDATE stock_sede SET cantidad_disponible = $1 WHERE id = $2 RETURNING *',
          [nuevo, ssRes.rows[0].id]
        );
        stockRow = upd.rows[0];
      } else {
        const ins = await client.query(
          'INSERT INTO stock_sede (producto_id, sede_id, cantidad_disponible, punto_reorden) VALUES ($1,$2,$3,5) RETURNING *',
          [Number(producto_id), Number(sede_id), Math.max(0, qty)]
        );
        stockRow = ins.rows[0];
      }

      await client.query(
        `INSERT INTO kardex_movimientos (producto_id, sede_id, tipo, cantidad, referencia, usuario_responsable_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [Number(producto_id), Number(sede_id), tipo, qty, referencia, req.user.id]
      );
      return stockRow;
    });

    if (updated.cantidad_disponible <= updated.punto_reorden) {
      await eventBus.publish(
        TOPICOS.STOCK_REORDEN_ALERTA,
        { producto_id, sede_id, saldo: updated.cantidad_disponible },
        'APP3-Inventario'
      );
    }

    return res.status(201).json(updated);
  } catch (err) {
    return res.status(500).json({ error: 'Error registrando movimiento de kárdex.' });
  }
});

// GET / POST / PUT Órdenes de reposición a talleres textiles
router.get('/inventario/ordenes', requireAuth, requireRole(['Director', 'Tesorero']), async (_req, res) => {
  try {
    const r = await query(
      `SELECT o.*, pg.sku, pg.nombre AS producto_nombre, pg.talla, s.nombre AS sede_nombre
       FROM ordenes_reposicion o
       JOIN productos_gear pg ON pg.id = o.producto_id
       JOIN sedes s ON s.id = o.sede_id
       ORDER BY o.id DESC`
    );
    return res.json(r.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Error consultando órdenes de reposición.' });
  }
});

router.post('/inventario/ordenes', requireAuth, requireRole(['Director', 'Tesorero']), async (req, res) => {
  try {
    const { producto_id, sede_id, taller_proveedor = 'Taller Textil Lima Combat S.A.C.', cantidad_solicitada = 15 } = req.body || {};
    if (!producto_id || !sede_id) {
      return res.status(400).json({ error: 'Producto y sede son requeridos.' });
    }
    const ins = await query(
      `INSERT INTO ordenes_reposicion (producto_id, sede_id, taller_proveedor, cantidad_solicitada, estado)
       VALUES ($1,$2,$3,$4,'pendiente') RETURNING *`,
      [Number(producto_id), Number(sede_id), taller_proveedor, Number(cantidad_solicitada)]
    );
    return res.status(201).json(ins.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Error creando orden de reposición.' });
  }
});

router.put('/inventario/ordenes/:id/recibir', requireAuth, requireRole(['Director', 'Tesorero', 'Recepcionista']), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const done = await withTransaction(async (client) => {
      const oRes = await client.query('SELECT * FROM ordenes_reposicion WHERE id = $1 FOR UPDATE', [id]);
      if (!oRes.rows.length) return null;
      const o = oRes.rows[0];
      if (o.estado === 'recibida') return o;

      await client.query("UPDATE ordenes_reposicion SET estado = 'recibida' WHERE id = $1", [id]);
      const ss = await client.query(
        'SELECT * FROM stock_sede WHERE producto_id = $1 AND sede_id = $2 FOR UPDATE',
        [o.producto_id, o.sede_id]
      );
      if (ss.rows.length) {
        await client.query(
          'UPDATE stock_sede SET cantidad_disponible = cantidad_disponible + $1 WHERE id = $2',
          [o.cantidad_solicitada, ss.rows[0].id]
        );
      } else {
        await client.query(
          'INSERT INTO stock_sede (producto_id, sede_id, cantidad_disponible, punto_reorden) VALUES ($1,$2,$3,5)',
          [o.producto_id, o.sede_id, o.cantidad_solicitada]
        );
      }
      await client.query(
        `INSERT INTO kardex_movimientos (producto_id, sede_id, tipo, cantidad, referencia, usuario_responsable_id)
         VALUES ($1,$2,'ENTRADA_TALLER',$3,$4,$5)`,
        [o.producto_id, o.sede_id, o.cantidad_solicitada, `Recepción Orden Taller #${o.id}`, req.user.id]
      );
      return { ...o, estado: 'recibida' };
    });
    if (!done) return res.status(404).json({ error: 'Orden no encontrada.' });
    return res.json(done);
  } catch (err) {
    return res.status(500).json({ error: 'Error recibiendo orden de reposición.' });
  }
});

module.exports = router;

