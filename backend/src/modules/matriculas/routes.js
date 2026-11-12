const express = require('express');
const { query, withTransaction } = require('../../db/pool');
const { requireAuth, requireRole, normalizeRole } = require('../../middleware/auth');
const { eventBus, TOPICOS } = require('../../events/eventBus');

const router = express.Router();

// GET /api/planes — Planes oficiales (Mensual 150, Bimensual 280, Trimestral 400, Semestral 720, Combo AFF 630)
router.get('/planes', async (_req, res) => {
  try {
    const r = await query('SELECT * FROM planes ORDER BY precio ASC');
    return res.json(r.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Error consultando planes.' });
  }
});

// GET /api/matriculas — Matrículas del alumno o globales para staff
router.get('/matriculas', requireAuth, async (req, res) => {
  try {
    const isAlumno = normalizeRole(req.user.rol) === 'Alumno';
    const params = [];
    let where = '';
    if (isAlumno) {
      params.push(req.user.id);
      where = 'WHERE m.usuario_id = $1';
    } else if (req.query.usuario_id) {
      params.push(Number(req.query.usuario_id));
      where = 'WHERE m.usuario_id = $1';
    }

    const r = await query(
      `SELECT m.*,
              p.codigo AS plan_codigo,
              p.nombre AS plan_nombre,
              p.duracion_meses,
              s.nombre AS sede_nombre,
              u.nombre || ' ' || u.apellido_paterno AS alumno_nombre,
              u.dni AS alumno_dni,
              u.email AS alumno_email,
              u.qr_token
       FROM matriculas m
       LEFT JOIN planes p ON p.id = m.plan_id
       LEFT JOIN sedes s ON s.id = m.sede_id
       LEFT JOIN usuarios u ON u.id = m.usuario_id
       ${where}
       ORDER BY m.id DESC`,
      params
    );
    return res.json(r.rows);
  } catch (err) {
    console.error('[Matriculas GET Error]', err);
    return res.status(500).json({ error: 'Error consultando matrículas.' });
  }
});

// GET /api/horarios — Grilla de horarios con ocupación en vivo sobre aforo máximo 18
router.get('/horarios', async (req, res) => {
  try {
    const fecha = req.query.fecha || new Date().toISOString().slice(0, 10);
    const params = [fecha];
    const filters = [];

    if (req.query.sede_id) {
      params.push(Number(req.query.sede_id));
      filters.push(`h.sede_id = $${params.length}`);
    }
    if (req.query.disciplina) {
      params.push(req.query.disciplina);
      filters.push(`LOWER(h.disciplina) LIKE LOWER('%' || $${params.length} || '%')`);
    }
    if (req.query.dias_bloque) {
      params.push(req.query.dias_bloque);
      filters.push(`LOWER(h.dias_bloque) LIKE LOWER('%' || $${params.length} || '%')`);
    }
    if (req.query.instructor_id) {
      params.push(Number(req.query.instructor_id));
      filters.push(`h.instructor_id = $${params.length}`);
    }

    const whereClause = filters.length ? 'WHERE ' + filters.join(' AND ') : '';

    const sql = `
      SELECT
        h.*,
        s.nombre AS sede_nombre,
        s.codigo AS sede_codigo,
        TRIM(COALESCE(u.nombre,'') || ' ' || COALESCE(u.apellido_paterno,'')) AS profesor_nombre,
        COALESCE(rc.ocupados, 0)::int AS cupos_ocupados,
        GREATEST(0, h.aforo_maximo - COALESCE(rc.ocupados, 0))::int AS cupos_disponibles,
        COALESCE(rc.espera, 0)::int AS lista_espera_count
      FROM horarios_tatami h
      JOIN sedes s ON s.id = h.sede_id
      LEFT JOIN usuarios u ON u.id = h.instructor_id
      LEFT JOIN (
        SELECT horario_id,
               SUM(CASE WHEN estado IN ('confirmada', 'asistio') THEN 1 ELSE 0 END) AS ocupados,
               SUM(CASE WHEN estado = 'lista_espera' THEN 1 ELSE 0 END) AS espera
        FROM reservas_cupo
        WHERE fecha_clase = $1::date
        GROUP BY horario_id
      ) rc ON rc.horario_id = h.id
      ${whereClause}
      ORDER BY h.sede_id ASC, h.hora_inicio ASC
    `;

    const r = await query(sql, params);
    return res.json(r.rows);
  } catch (err) {
    console.error('[Horarios GET Error]', err);
    return res.status(500).json({ error: 'Error consultando horarios de tatami.' });
  }
});

// GET /api/reservas/mias — Reservas del alumno autenticado
router.get('/reservas/mias', requireAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT r.*, h.titulo, h.disciplina, h.hora_inicio, h.hora_fin, h.espacio, h.aforo_maximo,
              s.nombre AS sede_nombre,
              TRIM(COALESCE(p.nombre,'') || ' ' || COALESCE(p.apellido_paterno,'')) AS profesor_nombre
       FROM reservas_cupo r
       JOIN horarios_tatami h ON h.id = r.horario_id
       JOIN sedes s ON s.id = h.sede_id
       LEFT JOIN usuarios p ON p.id = h.instructor_id
       WHERE r.usuario_id = $1
       ORDER BY r.fecha_clase DESC, r.id DESC`,
      [req.user.id]
    );
    return res.json(r.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Error consultando reservas.' });
  }
});

// POST /api/reservas — Reserva atómica de cupo (Bloqueo optimista + row lock máx 18 por tatami)
router.post('/reservas', requireAuth, async (req, res) => {
  try {
    const {
      horario_id,
      usuario_id,
      fecha_clase = new Date().toISOString().slice(0, 10),
      aceptar_lista_espera = false,
    } = req.body || {};

    if (!horario_id) {
      return res.status(400).json({ error: 'Debes seleccionar un horario de tatami.' });
    }

    const targetUserId =
      ['Director', 'Recepcionista', 'Profesor'].includes(req.user.rol) && usuario_id
        ? Number(usuario_id)
        : req.user.id;

    const outcome = await withTransaction(async (client) => {
      // 1. Bloquear fila del horario (control atómico de concurrencia)
      const hRes = await client.query(
        'SELECT * FROM horarios_tatami WHERE id = $1 FOR UPDATE',
        [Number(horario_id)]
      );
      if (!hRes.rows.length) {
        const e = new Error('Horario de tatami no encontrado.');
        e.status = 404;
        throw e;
      }
      const horario = hRes.rows[0];

      // 2. Validar membresía vigente del alumno
      const userRes = await client.query('SELECT acceso_habilitado, nombre FROM usuarios WHERE id = $1', [targetUserId]);
      if (!userRes.rows.length || !userRes.rows[0].acceso_habilitado) {
        const e = new Error('Tu acceso está inhabilitado. Comunícate con Recepción.');
        e.status = 403;
        throw e;
      }

      const matRes = await client.query(
        `SELECT * FROM matriculas
         WHERE usuario_id = $1 AND estado = 'activa' AND fecha_fin >= CURRENT_DATE
         ORDER BY fecha_fin DESC LIMIT 1`,
        [targetUserId]
      );
      if (!matRes.rows.length) {
        const e = new Error('Membresía vencida o inactiva. Renueva tu matrícula para reservar un cupo.');
        e.status = 403;
        e.code = 'MEMBRESIA_VENCIDA';
        throw e;
      }

      // 3. Evitar reserva duplicada
      const dupRes = await client.query(
        `SELECT id, estado FROM reservas_cupo
         WHERE horario_id = $1 AND usuario_id = $2 AND fecha_clase = $3::date
           AND estado IN ('confirmada', 'lista_espera', 'asistio')`,
        [horario.id, targetUserId, fecha_clase]
      );
      if (dupRes.rows.length) {
        const e = new Error('Ya cuentas con una reserva activa en este turno.');
        e.status = 409;
        throw e;
      }

      // 4. Verificar cruce horario en el mismo día
      const overlapRes = await client.query(
        `SELECT r.id, h.titulo, h.hora_inicio, h.hora_fin
         FROM reservas_cupo r
         JOIN horarios_tatami h ON h.id = r.horario_id
         WHERE r.usuario_id = $1 AND r.fecha_clase = $2::date
           AND r.estado IN ('confirmada', 'asistio')
           AND NOT (h.hora_fin <= $3 OR h.hora_inicio >= $4)`,
        [targetUserId, fecha_clase, horario.hora_inicio, horario.hora_fin]
      );
      if (overlapRes.rows.length) {
        const e = new Error(`Tienes cruce horario con ${overlapRes.rows[0].titulo} (${overlapRes.rows[0].hora_inicio}-${overlapRes.rows[0].hora_fin}).`);
        e.status = 409;
        throw e;
      }

      // 5. Contar cupos ocupados vs aforo_maximo (18)
      const countRes = await client.query(
        `SELECT COUNT(*)::int AS ocupados
         FROM reservas_cupo
         WHERE horario_id = $1 AND fecha_clase = $2::date AND estado IN ('confirmada', 'asistio')`,
        [horario.id, fecha_clase]
      );
      const ocupados = countRes.rows[0].ocupados;
      let estadoFinal = 'confirmada';

      if (ocupados >= horario.aforo_maximo) {
        if (!aceptar_lista_espera) {
          const e = new Error(`Aforo completo (${ocupados}/${horario.aforo_maximo} cupos). Puedes inscribirte en lista de espera.`);
          e.status = 409;
          e.code = 'AFORO_LLENO';
          e.horario = horario;
          throw e;
        }
        estadoFinal = 'lista_espera';
      }

      const ins = await client.query(
        `INSERT INTO reservas_cupo (horario_id, usuario_id, fecha_clase, estado)
         VALUES ($1, $2, $3::date, $4) RETURNING *`,
        [horario.id, targetUserId, fecha_clase, estadoFinal]
      );

      await client.query(
        'UPDATE horarios_tatami SET version = version + 1 WHERE id = $1',
        [horario.id]
      );

      return {
        reserva: ins.rows[0],
        horario,
        ocupados_nuevos: estadoFinal === 'confirmada' ? ocupados + 1 : ocupados,
      };
    });

    if (outcome.ocupados_nuevos >= outcome.horario.aforo_maximo) {
      await eventBus.publish(
        TOPICOS.AFORO_ALERTA,
        {
          horario_id: outcome.horario.id,
          titulo: outcome.horario.titulo,
          sede_id: outcome.horario.sede_id,
          ocupados: outcome.ocupados_nuevos,
          aforo_maximo: outcome.horario.aforo_maximo,
        },
        'APP2-Matriculas'
      );
    }

    return res.status(201).json({
      reserva: outcome.reserva,
      ocupados: outcome.ocupados_nuevos,
      aforo_maximo: outcome.horario.aforo_maximo,
      message:
        outcome.reserva.estado === 'lista_espera'
          ? 'Te uniste a la lista de espera. Se te asignará automáticamente si se libera un cupo.'
          : `Cupo reservado con éxito (${outcome.ocupados_nuevos}/${outcome.horario.aforo_maximo}).`,
    });
  } catch (err) {
    if (err.code === 'MEMBRESIA_VENCIDA') {
      await eventBus.publish(
        TOPICOS.MEMBRESIAS_VENCIDAS,
        { usuario_id: req.user.id, motivo: err.message },
        'APP2-Matriculas'
      );
    }
    if (err.code === 'AFORO_LLENO' && err.horario) {
      await eventBus.publish(
        TOPICOS.AFORO_ALERTA,
        { horario_id: err.horario.id, motivo: 'Intento de sobrecupo bloqueado atómicamente (18/18)' },
        'APP2-Matriculas'
      );
    }
    if (err.status) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    console.error('[Reservas POST Error]', err);
    return res.status(500).json({ error: 'Error al procesar reserva atómica.' });
  }
});

// POST /api/reservas/:id/cancelar — Cancela reserva y promueve al siguiente en lista de espera
router.post('/reservas/:id/cancelar', requireAuth, async (req, res) => {
  try {
    const reservaId = Number(req.params.id);
    const result = await withTransaction(async (client) => {
      const rRes = await client.query('SELECT * FROM reservas_cupo WHERE id = $1 FOR UPDATE', [reservaId]);
      if (!rRes.rows.length) {
        const e = new Error('Reserva no encontrada.');
        e.status = 404;
        throw e;
      }
      const r = rRes.rows[0];
      if (r.usuario_id !== req.user.id && !['Director', 'Profesor', 'Recepcionista'].includes(req.user.rol)) {
        const e = new Error('No autorizado para cancelar esta reserva.');
        e.status = 403;
        throw e;
      }

      await client.query("UPDATE reservas_cupo SET estado = 'cancelada' WHERE id = $1", [reservaId]);

      let promovido = null;
      if (r.estado === 'confirmada') {
        const nextWait = await client.query(
          `SELECT * FROM reservas_cupo
           WHERE horario_id = $1 AND fecha_clase = $2::date AND estado = 'lista_espera'
           ORDER BY created_at ASC, id ASC LIMIT 1 FOR UPDATE`,
          [r.horario_id, r.fecha_clase]
        );
        if (nextWait.rows.length) {
          const upd = await client.query(
            "UPDATE reservas_cupo SET estado = 'confirmada' WHERE id = $1 RETURNING *",
            [nextWait.rows[0].id]
          );
          promovido = upd.rows[0];
        }
      }
      return { cancelada: r, promovido };
    });

    return res.json({
      message: 'Reserva cancelada y cupo liberado.',
      promovido: result.promovido,
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    return res.status(500).json({ error: 'Error al cancelar reserva.' });
  }
});

// POST /api/asistencias/qr — Validación de pase QR en tatami (WebApp Staff PWA)
router.post('/asistencias/qr', requireAuth, requireRole(['Profesor', 'Director', 'Recepcionista']), async (req, res) => {
  try {
    const {
      qr_token,
      dni,
      usuario_id,
      horario_id,
      sede_id,
      metodo = 'QR',
      sincronizado_offline = false,
      fecha_hora,
    } = req.body || {};

    let alumnoRes;
    if (qr_token) {
      alumnoRes = await query('SELECT * FROM usuarios WHERE qr_token = $1', [qr_token.trim()]);
    } else if (dni) {
      alumnoRes = await query('SELECT * FROM usuarios WHERE dni = $1', [String(dni).trim()]);
    } else if (usuario_id) {
      alumnoRes = await query('SELECT * FROM usuarios WHERE id = $1', [Number(usuario_id)]);
    } else {
      return res.status(400).json({ error: 'Escanea un código QR o ingresa DNI / ID de alumno.' });
    }

    if (!alumnoRes.rows.length) {
      return res.status(404).json({ error: 'Código QR o alumno no reconocido.' });
    }
    const alumno = alumnoRes.rows[0];

    // Verificar estado de acceso y membresía
    const matRes = await query(
      `SELECT * FROM matriculas
       WHERE usuario_id = $1 AND estado = 'activa' AND fecha_fin >= CURRENT_DATE
       ORDER BY fecha_fin DESC LIMIT 1`,
      [alumno.id]
    );

    let estadoValidacion = 'autorizado';
    let mensaje = `Ingreso autorizado para ${alumno.nombre} ${alumno.apellido_paterno || ''}`.trim();

    if (!alumno.acceso_habilitado) {
      estadoValidacion = 'denegado_bloqueado';
      mensaje = 'Acceso bloqueado administrativamente.';
    } else if (!matRes.rows.length) {
      estadoValidacion = 'denegado_vencida';
      mensaje = 'Membresía vencida o congelada. Renovar en Portal o Recepción.';
    } else if (horario_id) {
      const hRes = await query('SELECT aforo_maximo FROM horarios_tatami WHERE id = $1', [Number(horario_id)]);
      const maxAforo = hRes.rows[0]?.aforo_maximo || 18;
      const asisCount = await query(
        `SELECT COUNT(*)::int AS cnt FROM asistencias_qr
         WHERE horario_id = $1 AND CAST(fecha_hora AS DATE) = CURRENT_DATE AND estado_validacion = 'autorizado'`,
        [Number(horario_id)]
      );
      if (asisCount.rows[0].cnt >= maxAforo) {
        estadoValidacion = 'denegado_aforo';
        mensaje = `Aforo máximo alcanzado en tatami (${maxAforo}/${maxAforo}).`;
      }
    }

    const ins = await query(
      `INSERT INTO asistencias_qr (usuario_id, horario_id, sede_id, instructor_id, metodo, estado_validacion, sincronizado_offline, fecha_hora)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::timestamp, NOW())) RETURNING *`,
      [
        alumno.id,
        horario_id ? Number(horario_id) : null,
        sede_id ? Number(sede_id) : alumno.sede_id,
        req.user.id,
        metodo,
        estadoValidacion,
        Boolean(sincronizado_offline),
        fecha_hora || null,
      ]
    );

    if (estadoValidacion === 'autorizado' && horario_id) {
      await query(
        `UPDATE reservas_cupo SET estado = 'asistio'
         WHERE usuario_id = $1 AND horario_id = $2 AND fecha_clase = CURRENT_DATE AND estado = 'confirmada'`,
        [alumno.id, Number(horario_id)]
      );
    }

    await eventBus.publish(
      TOPICOS.ASISTENCIAS_REGISTRADAS,
      {
        asistencia_id: ins.rows[0].id,
        usuario_id: alumno.id,
        horario_id: horario_id || null,
        sede_id: sede_id || alumno.sede_id,
        estado_validacion: estadoValidacion,
      },
      'APP2-Matriculas'
    );

    const statusHttp = estadoValidacion === 'autorizado' ? 201 : 403;
    return res.status(statusHttp).json({
      asistencia: ins.rows[0],
      autorizado: estadoValidacion === 'autorizado',
      estado_validacion: estadoValidacion,
      alumno: {
        id: alumno.id,
        nombre: `${alumno.nombre} ${alumno.apellido_paterno || ''}`.trim(),
        dni: alumno.dni,
        disciplina: alumno.disciplina,
        grado_actual: alumno.grado_actual,
      },
      message: mensaje,
    });
  } catch (err) {
    console.error('[Asistencia QR Error]', err);
    return res.status(500).json({ error: 'Error validando ingreso QR.' });
  }
});

// POST /api/asistencias/sync-offline — Sincronización por lotes desde cola IndexedDB PWA
router.post('/asistencias/sync-offline', requireAuth, requireRole(['Profesor', 'Director']), async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const results = [];
    for (const item of items) {
      const aRes = await query('SELECT id, sede_id FROM usuarios WHERE qr_token = $1 OR id = $2', [
        item.qr_token || '',
        Number(item.usuario_id || 0),
      ]);
      if (aRes.rows.length) {
        const u = aRes.rows[0];
        await query(
          `INSERT INTO asistencias_qr (usuario_id, horario_id, sede_id, instructor_id, metodo, estado_validacion, sincronizado_offline, fecha_hora)
           VALUES ($1,$2,$3,$4,'OfflineSync','autorizado',true,COALESCE($5::timestamp, NOW()))`,
          [u.id, item.horario_id || null, item.sede_id || u.sede_id, req.user.id, item.fecha_hora || null]
        );
        results.push({ ok: true, usuario_id: u.id });
      }
    }
    return res.json({ sincronizados: results.length, results });
  } catch (err) {
    return res.status(500).json({ error: 'Error sincronizando cola offline.' });
  }
});

// GET /api/asistencias — Listado de asistencias QR
router.get('/asistencias', requireAuth, async (req, res) => {
  try {
    const params = [];
    const where = [];
    if (normalizeRole(req.user.rol) === 'Alumno') {
      params.push(req.user.id);
      where.push(`a.usuario_id = $${params.length}`);
    } else if (req.query.horario_id) {
      params.push(Number(req.query.horario_id));
      where.push(`a.horario_id = $${params.length}`);
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const r = await query(
      `SELECT a.*,
              TRIM(COALESCE(u.nombre,'') || ' ' || COALESCE(u.apellido_paterno,'')) AS alumno_nombre,
              u.dni, u.disciplina,
              h.titulo AS horario_titulo,
              s.nombre AS sede_nombre
       FROM asistencias_qr a
       JOIN usuarios u ON u.id = a.usuario_id
       LEFT JOIN horarios_tatami h ON h.id = a.horario_id
       LEFT JOIN sedes s ON s.id = a.sede_id
       ${whereSql}
       ORDER BY a.fecha_hora DESC
       LIMIT 100`,
      params
    );
    return res.json(r.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Error consultando asistencias.' });
  }
});

// GET / POST / PUT Congelamientos formales de membresía
router.get('/congelamientos', requireAuth, async (req, res) => {
  try {
    const isAlumno = normalizeRole(req.user.rol) === 'Alumno';
    const r = await query(
      `SELECT c.*, u.nombre || ' ' || COALESCE(u.apellido_paterno,'') AS alumno_nombre, m.disciplina
       FROM congelamientos c
       JOIN usuarios u ON u.id = c.usuario_id
       JOIN matriculas m ON m.id = c.matricula_id
       ${isAlumno ? 'WHERE c.usuario_id = $1' : ''}
       ORDER BY c.id DESC`,
      isAlumno ? [req.user.id] : []
    );
    return res.json(r.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Error consultando congelamientos.' });
  }
});

router.post('/congelamientos', requireAuth, async (req, res) => {
  try {
    const { matricula_id, motivo = 'Salud', detalle = '', dias_solicitados = 15, fecha_inicio } = req.body || {};
    const matRes = await query(
      matricula_id
        ? 'SELECT * FROM matriculas WHERE id = $1'
        : "SELECT * FROM matriculas WHERE usuario_id = $1 AND estado = 'activa' ORDER BY fecha_fin DESC LIMIT 1",
      [matricula_id ? Number(matricula_id) : req.user.id]
    );
    if (!matRes.rows.length) {
      return res.status(404).json({ error: 'No se encontró una matrícula activa para congelar.' });
    }
    const m = matRes.rows[0];
    const dias = Math.max(5, Math.min(60, Number(dias_solicitados) || 15));
    const inicio = fecha_inicio ? new Date(fecha_inicio) : new Date();
    const fin = new Date(inicio);
    fin.setDate(fin.getDate() + dias);

    const ins = await query(
      `INSERT INTO congelamientos (matricula_id, usuario_id, motivo, detalle, dias_solicitados, fecha_inicio, fecha_fin, estado)
       VALUES ($1,$2,$3,$4,$5,$6::date,$7::date,'pendiente') RETURNING *`,
      [m.id, m.usuario_id, motivo, detalle, dias, inicio.toISOString().slice(0, 10), fin.toISOString().slice(0, 10)]
    );
    return res.status(201).json(ins.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Error creando solicitud de congelamiento.' });
  }
});

router.put('/congelamientos/:id', requireAuth, requireRole(['Director', 'Recepcionista']), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { estado = 'aprobado' } = req.body || {};
    const updated = await withTransaction(async (client) => {
      const cRes = await client.query('SELECT * FROM congelamientos WHERE id = $1 FOR UPDATE', [id]);
      if (!cRes.rows.length) return null;
      const c = cRes.rows[0];
      const upd = await client.query('UPDATE congelamientos SET estado = $1 WHERE id = $2 RETURNING *', [estado, id]);
      if (estado === 'aprobado' && c.estado !== 'aprobado') {
        const matRes = await client.query('SELECT fecha_fin FROM matriculas WHERE id = $1', [c.matricula_id]);
        if (matRes.rows.length) {
          const base = new Date(matRes.rows[0].fecha_fin);
          base.setDate(base.getDate() + Number(c.dias_solicitados || 0));
          await client.query('UPDATE matriculas SET fecha_fin = $1::date WHERE id = $2', [
            base.toISOString().slice(0, 10),
            c.matricula_id,
          ]);
        }
      }
      return upd.rows[0];
    });
    if (!updated) return res.status(404).json({ error: 'Solicitud no encontrada.' });
    return res.json(updated);
  } catch (err) {
    return res.status(500).json({ error: 'Error procesando congelamiento.' });
  }
});

module.exports = router;
