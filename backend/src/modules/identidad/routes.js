const express = require('express');
const bcrypt = require('bcryptjs');
const { query, withTransaction } = require('../../db/pool');
const { signToken, requireAuth, requireRole, normalizeRole } = require('../../middleware/auth');
const { eventBus, TOPICOS } = require('../../events/eventBus');
const { sha256 } = require('../../db/init');

const router = express.Router();

function calcularEdad(fechaNac) {
  if (!fechaNac) return 18;
  const hoy = new Date();
  const nac = new Date(fechaNac);
  let edad = hoy.getFullYear() - nac.getFullYear();
  const m = hoy.getMonth() - nac.getMonth();
  if (m < 0 || (m === 0 && hoy.getDate() < nac.getDate())) edad--;
  return edad;
}

// POST /api/auth/login
router.post('/auth/login', async (req, res) => {
  try {
    const { email, password, mfa_code } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Ingresa tu correo y contraseña.' });
    }

    const result = await query(
      `SELECT u.*, s.nombre AS sede_nombre, s.codigo AS sede_codigo
       FROM usuarios u
       LEFT JOIN sedes s ON s.id = u.sede_id
       WHERE LOWER(u.email) = LOWER($1)
       LIMIT 1`,
      [email.trim()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Credenciales incorrectas.' });
    }

    const u = result.rows[0];
    const valid = await bcrypt.compare(password, u.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Credenciales incorrectas.' });
    }

    // Verificación MFA opcional / explícita para Directores
    if (u.mfa_habilitado && req.body.require_mfa && u.mfa_pin && mfa_code !== u.mfa_pin) {
      return res.status(200).json({
        mfa_required: true,
        message: 'Se requiere código 2FA de Director (demo: 123456).',
      });
    }
    if (mfa_code && u.mfa_pin && mfa_code !== u.mfa_pin) {
      return res.status(401).json({ error: 'Código 2FA / PIN incorrecto.' });
    }

    const rolCanonic = normalizeRole(u.rol);
    const usuarioPayload = {
      id: u.id,
      id_alumno: u.id,
      nombre: [u.nombre, u.apellido_paterno, u.apellido_materno].filter(Boolean).join(' '),
      nombres: u.nombre,
      apellido_paterno: u.apellido_paterno,
      apellido_materno: u.apellido_materno,
      email: u.email,
      dni: u.dni,
      rol: rolCanonic,
      sede_id: u.sede_id,
      sede: u.sede_nombre || 'Sede Surco',
      disciplina: u.disciplina,
      telefono: u.telefono,
      direccion: u.direccion,
      fecha_nacimiento: u.fecha_nacimiento,
      genero: u.genero,
      es_menor: u.es_menor,
      grado_actual: u.grado_actual,
      acceso_habilitado: u.acceso_habilitado,
      qr_token: u.qr_token,
      ficha_medica: u.ficha_medica || {},
    };

    const token = signToken(usuarioPayload);
    return res.json({ token, usuario: usuarioPayload });
  } catch (err) {
    console.error('[Auth Login Error]', err);
    return res.status(500).json({ error: 'Error interno al iniciar sesión.' });
  }
});

// POST /api/auth/registro — Registro de nuevo alumno (web o presencial) con validación LPDP menor
router.post('/auth/registro', async (req, res) => {
  try {
    const {
      nombre,
      apellido_paterno = '',
      apellido_materno = '',
      dni,
      email,
      password,
      telefono = '',
      direccion = '',
      fecha_nacimiento,
      genero = '',
      sede_id = 1,
      disciplina = 'Brazilian Jiu-Jitsu',
      apoderado_nombre,
      apoderado_dni,
      parentesco = 'Padre/Madre',
      telefono_apoderado = '',
      acepta_lpdp = true,
    } = req.body || {};

    if (!nombre || !email || !password || !dni) {
      return res.status(400).json({ error: 'Nombre, DNI, correo y contraseña son obligatorio.' });
    }

    const edad = fecha_nacimiento ? calcularEdad(fecha_nacimiento) : 18;
    const esMenor = edad < 18;

    if (esMenor && (!apoderado_nombre || !apoderado_dni || !acepta_lpdp)) {
      return res.status(400).json({
        error: 'Alumno menor de edad: se requiere nombre, DNI del apoderado y firma de consentimiento LPDP (Ley N° 29733).',
      });
    }

    const existe = await query(
      'SELECT id FROM usuarios WHERE LOWER(email) = LOWER($1) OR dni = $2',
      [email.trim(), String(dni).trim()]
    );
    if (existe.rows.length > 0) {
      return res.status(409).json({ error: 'Ya existe una cuenta con ese correo o DNI.' });
    }

    const pwdHash = await bcrypt.hash(password, 10);
    const qrToken = 'QR-ALU-' + Date.now().toString(36).toUpperCase();

    const nuevo = await withTransaction(async (client) => {
      const ins = await client.query(
        `INSERT INTO usuarios (
          nombre, apellido_paterno, apellido_materno, dni, email, password_hash,
          rol, sede_id, disciplina, telefono, direccion, fecha_nacimiento, genero,
          es_menor, grado_actual, acceso_habilitado, qr_token
        ) VALUES ($1,$2,$3,$4,$5,$6,'Alumno',$7,$8,$9,$10,$11,$12,$13,'Principiante',true,$14)
        RETURNING *`,
        [
          nombre.trim(),
          apellido_paterno.trim(),
          apellido_materno.trim(),
          String(dni).trim(),
          email.trim().toLowerCase(),
          pwdHash,
          Number(sede_id) || 1,
          disciplina,
          telefono,
          direccion,
          fecha_nacimiento || null,
          genero,
          esMenor,
          qrToken,
        ]
      );
      const u = ins.rows[0];

      if (esMenor || (apoderado_nombre && apoderado_dni)) {
        const firmaHash = sha256(`LPDP-${u.id}-${apoderado_dni}-${Date.now()}`);
        await client.query(
          `INSERT INTO consentimientos_lpdp (
            usuario_id, apoderado_nombre, apoderado_dni, parentesco,
            telefono_apoderado, acepta_tratamiento_datos, firma_hash_sha256, ip_registro
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            u.id,
            apoderado_nombre,
            apoderado_dni,
            parentesco,
            telefono_apoderado || telefono,
            Boolean(acepta_lpdp),
            firmaHash,
            req.ip || '0.0.0.0',
          ]
        );
      }
      return u;
    });

    await eventBus.publish(
      TOPICOS.USUARIOS_REGISTRADOS,
      {
        usuario_id: nuevo.id,
        email: nuevo.email,
        es_menor: esMenor,
        sede_id: nuevo.sede_id,
        disciplina: nuevo.disciplina,
      },
      'APP1-Identidad'
    );

    const sedeRes = await query('SELECT nombre FROM sedes WHERE id = $1', [nuevo.sede_id]);
    const usuarioPayload = {
      id: nuevo.id,
      id_alumno: nuevo.id,
      nombre: [nuevo.nombre, nuevo.apellido_paterno, nuevo.apellido_materno].filter(Boolean).join(' '),
      email: nuevo.email,
      dni: nuevo.dni,
      rol: 'Alumno',
      sede_id: nuevo.sede_id,
      sede: sedeRes.rows[0]?.nombre || 'Sede Surco',
      disciplina: nuevo.disciplina,
      es_menor: nuevo.es_menor,
      grado_actual: nuevo.grado_actual,
      qr_token: nuevo.qr_token,
    };

    const token = signToken(usuarioPayload);
    return res.status(201).json({ token, usuario: usuarioPayload });
  } catch (err) {
    console.error('[Auth Registro Error]', err);
    return res.status(500).json({ error: 'Error al registrar alumno.' });
  }
});

// GET /api/alumnos — Lista de alumnos (Ficha 360 + última matrícula)
router.get('/alumnos', requireAuth, async (req, res) => {
  try {
    const isAlumno = normalizeRole(req.user.rol) === 'Alumno';
    const sedeFilter = req.query.sede_id ? Number(req.query.sede_id) : null;

    const params = [];
    const whereParts = [`LOWER(u.rol) = 'alumno'`];
    if (isAlumno) {
      params.push(req.user.id);
      whereParts.push(`u.id = $${params.length}`);
    } else if (sedeFilter) {
      params.push(sedeFilter);
      whereParts.push(`u.sede_id = $${params.length}`);
    }

    const sql = `
      SELECT
        u.id,
        u.id AS id_alumno,
        u.nombre,
        u.apellido_paterno,
        u.apellido_materno,
        u.dni,
        u.email,
        u.telefono,
        u.direccion,
        u.fecha_nacimiento,
        u.genero,
        u.es_menor,
        u.grado_actual,
        u.acceso_habilitado,
        u.qr_token,
        u.ficha_medica,
        u.sede_id,
        COALESCE(s.nombre, 'Sede Surco') AS sede,
        u.disciplina,
        u.created_at,
        u.created_at AS fecha_inscripcion
      FROM usuarios u
      LEFT JOIN sedes s ON s.id = u.sede_id
      WHERE ${whereParts.join(' AND ')}
      ORDER BY u.id ASC
    `;

    const result = await query(sql, params);
    const matRes = await query(
      `SELECT m.*, p.nombre AS plan_nombre
       FROM matriculas m
       LEFT JOIN planes p ON p.id = m.plan_id
       ORDER BY m.fecha_fin DESC, m.id DESC`
    );
    const lpdpRes = await query('SELECT * FROM consentimientos_lpdp ORDER BY id DESC');

    const matByUser = {};
    for (const m of matRes.rows) {
      if (!matByUser[m.usuario_id]) matByUser[m.usuario_id] = m;
    }
    const lpdpByUser = {};
    for (const c of lpdpRes.rows) {
      if (!lpdpByUser[c.usuario_id]) lpdpByUser[c.usuario_id] = c;
    }

    const enriched = result.rows.map((u) => {
      const m = matByUser[u.id] || {};
      const c = lpdpByUser[u.id] || {};
      return {
        ...u,
        matricula_id: m.id || null,
        fecha_inicio_membresia: m.fecha_inicio || null,
        fecha_fin_membresia: m.fecha_fin || null,
        estado_membresia: m.estado || null,
        es_combo_aff: m.es_combo_aff || false,
        talla_combo: m.talla_combo || null,
        combo_despachado: m.combo_despachado || false,
        plan_nombre: m.plan_nombre || null,
        apoderado_nombre: c.apoderado_nombre || null,
        apoderado_dni: c.apoderado_dni || null,
        lpdp_hash: c.firma_hash_sha256 || null,
      };
    });

    return res.json(enriched);
  } catch (err) {
    console.error('[Alumnos GET Error]', err);
    return res.status(500).json({ error: 'Error consultando alumnos.' });
  }
});

// GET /api/usuarios/me — Perfil completo 360 del usuario autenticado
router.get('/usuarios/me', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT u.id, u.nombre, u.apellido_paterno, u.apellido_materno, u.dni, u.email, u.rol,
              u.sede_id, s.nombre AS sede, u.disciplina, u.telefono, u.direccion, u.fecha_nacimiento,
              u.genero, u.es_menor, u.grado_actual, u.acceso_habilitado, u.qr_token, u.ficha_medica
       FROM usuarios u
       LEFT JOIN sedes s ON s.id = u.sede_id
       WHERE u.id = $1`,
      [req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Usuario no encontrado.' });
    const u = result.rows[0];
    const grados = await query(
      `SELECT g.*, p.nombre AS instructor_nombre
       FROM grados_marciales g
       LEFT JOIN usuarios p ON p.id = g.instructor_id
       WHERE g.usuario_id = $1
       ORDER BY g.fecha_otorgamiento DESC`,
      [u.id]
    );
    const lpdp = await query(
      'SELECT apoderado_nombre, apoderado_dni, parentesco, firma_hash_sha256, created_at FROM consentimientos_lpdp WHERE usuario_id = $1 ORDER BY id DESC LIMIT 1',
      [u.id]
    );
    return res.json({
      ...u,
      nombre_completo: [u.nombre, u.apellido_paterno, u.apellido_materno].filter(Boolean).join(' '),
      grados: grados.rows,
      consentimiento_lpdp: lpdp.rows[0] || null,
    });
  } catch (err) {
    console.error('[Perfil Me Error]', err);
    return res.status(500).json({ error: 'Error al cargar perfil.' });
  }
});

// PUT /api/usuarios/:id — Actualizar perfil 360, ficha médica y contraseña
router.put('/usuarios/:id', requireAuth, async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    if (req.user.id !== targetId && !['Director', 'Recepcionista'].includes(req.user.rol)) {
      return res.status(403).json({ error: 'No autorizado para editar este perfil.' });
    }

    const currentRes = await query('SELECT * FROM usuarios WHERE id = $1', [targetId]);
    if (!currentRes.rows.length) return res.status(404).json({ error: 'Usuario no encontrado.' });
    const current = currentRes.rows[0];

    const {
      nombre,
      apellido_paterno,
      apellido_materno,
      dni,
      telefono,
      celular,
      direccion,
      fecha_nacimiento,
      genero,
      ficha_medica,
      password,
      password_actual,
    } = req.body || {};

    let newPwdHash = current.password_hash;
    if (password) {
      if (password.length < 8) {
        return res.status(400).json({ error: 'La nueva contraseña debe tener mínimo 8 caracteres.' });
      }
      if (req.user.id === targetId && password_actual) {
        const ok = await bcrypt.compare(password_actual, current.password_hash);
        if (!ok) return res.status(400).json({ error: 'La contraseña actual es incorrecta.' });
      }
      newPwdHash = await bcrypt.hash(password, 10);
    }

    let nombreFinal = current.nombre;
    let apePatFinal = apellido_paterno !== undefined ? apellido_paterno : current.apellido_paterno;
    let apeMatFinal = apellido_materno !== undefined ? apellido_materno : current.apellido_materno;
    if (nombre && apellido_paterno === undefined) {
      const parts = nombre.trim().split(/\s+/);
      nombreFinal = parts[0] || current.nombre;
      if (parts.length > 1) apePatFinal = parts[1];
      if (parts.length > 2) apeMatFinal = parts.slice(2).join(' ');
    } else if (nombre) {
      nombreFinal = nombre.trim();
    }

    const updated = await query(
      `UPDATE usuarios SET
        nombre = $1,
        apellido_paterno = $2,
        apellido_materno = $3,
        dni = COALESCE($4, dni),
        telefono = COALESCE($5, telefono),
        direccion = COALESCE($6, direccion),
        fecha_nacimiento = COALESCE($7, fecha_nacimiento),
        genero = COALESCE($8, genero),
        ficha_medica = COALESCE($9::jsonb, ficha_medica),
        password_hash = $10
      WHERE id = $11
      RETURNING id, nombre, apellido_paterno, apellido_materno, dni, email, rol, telefono, direccion, fecha_nacimiento, genero, ficha_medica`,
      [
        nombreFinal,
        apePatFinal,
        apeMatFinal,
        dni || null,
        celular !== undefined ? celular : telefono !== undefined ? telefono : null,
        direccion !== undefined ? direccion : null,
        fecha_nacimiento || null,
        genero || null,
        ficha_medica ? JSON.stringify(ficha_medica) : null,
        newPwdHash,
        targetId,
      ]
    );

    return res.json({ usuario: updated.rows[0], message: 'Perfil actualizado correctamente.' });
  } catch (err) {
    console.error('[Usuarios PUT Error]', err);
    return res.status(500).json({ error: 'Error actualizando perfil.' });
  }
});

// PUT /api/alumnos/:id/acceso — Habilitar o bloquear acceso físico (Torniquetes / QR)
router.put('/alumnos/:id/acceso', requireAuth, requireRole(['Director', 'Recepcionista']), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { acceso_habilitado } = req.body || {};
    const updated = await query(
      'UPDATE usuarios SET acceso_habilitado = $1 WHERE id = $2 RETURNING id, nombre, acceso_habilitado',
      [Boolean(acceso_habilitado), id]
    );
    if (!updated.rows.length) return res.status(404).json({ error: 'Alumno no encontrado.' });
    return res.json(updated.rows[0]);
  } catch (err) {
    return res.status(500).json({ error: 'Error actualizando acceso.' });
  }
});

// POST /api/lpdp/consentimiento — Validación DNI apoderado (RENIEC sim) y firma digital Ley 29733
router.post('/lpdp/consentimiento', requireAuth, async (req, res) => {
  try {
    const { usuario_id, apoderado_nombre, apoderado_dni, parentesco = 'Padre/Madre', telefono_apoderado = '' } = req.body || {};
    const targetId = Number(usuario_id || req.user.id);
    if (!apoderado_nombre || !apoderado_dni || !/^\d{8}$/.test(String(apoderado_dni).trim())) {
      return res.status(400).json({ error: 'Ingresa nombre completo y DNI válido de 8 dígitos del apoderado.' });
    }
    const firmaHash = sha256(`LPDP-${targetId}-${apoderado_dni}-${Date.now()}`);
    const ins = await query(
      `INSERT INTO consentimientos_lpdp (usuario_id, apoderado_nombre, apoderado_dni, parentesco, telefono_apoderado, acepta_tratamiento_datos, firma_hash_sha256, ip_registro)
       VALUES ($1,$2,$3,$4,$5,true,$6,$7) RETURNING *`,
      [targetId, apoderado_nombre.trim(), String(apoderado_dni).trim(), parentesco, telefono_apoderado, firmaHash, req.ip || '0.0.0.0']
    );
    await query('UPDATE usuarios SET es_menor = true WHERE id = $1', [targetId]);
    return res.status(201).json({ consentimiento: ins.rows[0], reniec_verificado: true });
  } catch (err) {
    return res.status(500).json({ error: 'Error guardando consentimiento LPDP.' });
  }
});

// GET /api/grados/:usuarioId y POST /api/grados — Progresión de grado marcial
router.get('/grados/:usuarioId', requireAuth, async (req, res) => {
  try {
    const rows = await query(
      `SELECT g.*, p.nombre || ' ' || p.apellido_paterno AS instructor_nombre
       FROM grados_marciales g
       LEFT JOIN usuarios p ON p.id = g.instructor_id
       WHERE g.usuario_id = $1
       ORDER BY g.fecha_otorgamiento DESC, g.id DESC`,
      [Number(req.params.usuarioId)]
    );
    return res.json(rows.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Error consultando grados marciales.' });
  }
});

router.post('/grados', requireAuth, requireRole(['Profesor', 'Director']), async (req, res) => {
  try {
    const { usuario_id, disciplina, grado, observaciones = '' } = req.body || {};
    if (!usuario_id || !disciplina || !grado) {
      return res.status(400).json({ error: 'Alumno, disciplina y nuevo grado son requeridos.' });
    }
    const ins = await withTransaction(async (client) => {
      const r = await client.query(
        `INSERT INTO grados_marciales (usuario_id, disciplina, grado, instructor_id, observaciones)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [Number(usuario_id), disciplina, grado, req.user.id, observaciones]
      );
      await client.query('UPDATE usuarios SET grado_actual = $1 WHERE id = $2', [grado, Number(usuario_id)]);
      return r.rows[0];
    });
    return res.status(201).json(ins);
  } catch (err) {
    return res.status(500).json({ error: 'Error registrando ascenso de grado.' });
  }
});

// GET /api/sedes — Sedes oficiales (Surco, La Molina, San Borja)
router.get('/sedes', async (_req, res) => {
  try {
    const r = await query('SELECT * FROM sedes WHERE activa = true ORDER BY id ASC');
    return res.json(r.rows);
  } catch (err) {
    return res.status(500).json({ error: 'Error cargando sedes.' });
  }
});

module.exports = router;
