const express = require('express');
const { query, withTransaction } = require('../../db/pool');
const { optionalAuth } = require('../../middleware/auth');
const { eventBus, TOPICOS } = require('../../events/eventBus');

const router = express.Router();

// Definición oficial de Tools MCP (Model Context Protocol - Diagramas 4, 5, 6, 11, 16, 23, 28)
const MCP_TOOLS = [
  {
    name: 'consultar_aforo',
    description: 'Consulta horarios de tatami y cupos reales disponibles (máximo 18 por turno) por sede y disciplina.',
    inputSchema: {
      type: 'object',
      properties: {
        sede: { type: 'string', description: 'Surco, La Molina o San Borja' },
        disciplina: { type: 'string', description: 'BJJ, Muay Thai, Boxeo, Capoeira o Acondicionamiento' },
      },
    },
  },
  {
    name: 'consultar_stock_gear',
    description: 'Consulta disponibilidad de tallas e indumentaria AFF Gear (Kimonos, Guantes, Abadás) en las 3 sedes.',
    inputSchema: {
      type: 'object',
      properties: {
        disciplina: { type: 'string' },
        talla: { type: 'string' },
      },
    },
  },
  {
    name: 'validar_identidad',
    description: 'Verifica si un DNI pertenece a un alumno registrado y el estado de su matrícula.',
    inputSchema: {
      type: 'object',
      properties: {
        dni: { type: 'string' },
      },
      required: ['dni'],
    },
  },
  {
    name: 'reservar_cupo',
    description: 'Realiza una pre-reserva o reserva atómica en un turno de tatami disponible (máx 18).',
    inputSchema: {
      type: 'object',
      properties: {
        horario_id: { type: 'number' },
        usuario_id: { type: 'number' },
      },
      required: ['horario_id'],
    },
  },
];

async function executeMcpTool(toolName, args = {}, authUser = null) {
  if (toolName === 'consultar_aforo') {
    const params = [];
    const where = [];
    if (args.sede) {
      params.push(args.sede);
      where.push(`LOWER(s.nombre) LIKE LOWER('%' || $${params.length} || '%')`);
    }
    if (args.disciplina) {
      params.push(args.disciplina);
      where.push(`LOWER(h.disciplina) LIKE LOWER('%' || $${params.length} || '%')`);
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const r = await query(
      `SELECT h.id, h.titulo, h.disciplina, h.dias_bloque, h.hora_inicio, h.hora_fin, h.espacio, h.aforo_maximo,
              s.nombre AS sede_nombre,
              COALESCE(rc.ocupados, 0)::int AS ocupados,
              GREATEST(0, h.aforo_maximo - COALESCE(rc.ocupados, 0))::int AS disponibles
       FROM horarios_tatami h
       JOIN sedes s ON s.id = h.sede_id
       LEFT JOIN (
         SELECT horario_id, COUNT(*)::int AS ocupados
         FROM reservas_cupo
         WHERE fecha_clase = CURRENT_DATE AND estado IN ('confirmada', 'asistio')
         GROUP BY horario_id
       ) rc ON rc.horario_id = h.id
       ${whereSql}
       ORDER BY h.sede_id ASC, h.hora_inicio ASC`,
      params
    );
    return { tool: 'consultar_aforo', total: r.rows.length, horarios: r.rows };
  }

  if (toolName === 'consultar_stock_gear') {
    const params = [];
    const where = ['pg.es_parte_combo = true'];
    if (args.disciplina) {
      params.push(args.disciplina);
      where.push(`LOWER(pg.disciplina) LIKE LOWER('%' || $${params.length} || '%')`);
    }
    if (args.talla) {
      params.push(args.talla);
      where.push(`LOWER(pg.talla) = LOWER($${params.length})`);
    }
    const r = await query(
      `SELECT pg.sku, pg.nombre, pg.disciplina, pg.talla, pg.precio_venta,
              s.nombre AS sede_nombre, ss.cantidad_disponible
       FROM stock_sede ss
       JOIN productos_gear pg ON pg.id = ss.producto_id
       JOIN sedes s ON s.id = ss.sede_id
       WHERE ${where.join(' AND ')}
       ORDER BY ss.cantidad_disponible DESC`,
      params
    );
    return { tool: 'consultar_stock_gear', items: r.rows };
  }

  if (toolName === 'validar_identidad') {
    if (!args.dni) return { tool: 'validar_identidad', encontrado: false, mensaje: 'DNI no proporcionado.' };
    const r = await query(
      `SELECT u.id, u.nombre, u.apellido_paterno, u.disciplina, s.nombre AS sede
       FROM usuarios u
       LEFT JOIN sedes s ON s.id = u.sede_id
       WHERE u.dni = $1`,
      [String(args.dni).trim()]
    );
    if (!r.rows.length) return { tool: 'validar_identidad', encontrado: false };
    const mat = await query(
      'SELECT estado AS estado_matricula, fecha_fin FROM matriculas WHERE usuario_id = $1 ORDER BY fecha_fin DESC LIMIT 1',
      [r.rows[0].id]
    );
    return {
      tool: 'validar_identidad',
      encontrado: true,
      alumno: { ...r.rows[0], ...(mat.rows[0] || {}) },
    };
  }

  if (toolName === 'reservar_cupo') {
    const uid = args.usuario_id || authUser?.id;
    const hid = Number(args.horario_id);
    if (!hid) return { tool: 'reservar_cupo', ok: false, error: 'horario_id requerido.' };

    const hRes = await query(
      `SELECT h.*, s.nombre AS sede_nombre FROM horarios_tatami h JOIN sedes s ON s.id = h.sede_id WHERE h.id = $1`,
      [hid]
    );
    if (!hRes.rows.length) return { tool: 'reservar_cupo', ok: false, error: 'Horario no encontrado.' };
    const h = hRes.rows[0];

    if (!uid) {
      return {
        tool: 'reservar_cupo',
        ok: true,
        pre_reserva: true,
        horario: h,
        checkout_deeplink: `/pages/portal/renovar.html?horario_id=${h.id}&disciplina=${encodeURIComponent(h.disciplina)}`,
        mensaje: 'Pre-reserva preparada. Inicia sesión o completa tu pago para confirmar el cupo.',
      };
    }

    // Si hay usuario autenticado con membresía activa, reservar en BD atómicamente
    try {
      const reserva = await withTransaction(async (client) => {
        const lockH = await client.query('SELECT * FROM horarios_tatami WHERE id = $1 FOR UPDATE', [hid]);
        const mat = await client.query(
          "SELECT id FROM matriculas WHERE usuario_id = $1 AND estado = 'activa' AND fecha_fin >= CURRENT_DATE LIMIT 1",
          [uid]
        );
        if (!mat.rows.length) {
          return { requiere_pago: true };
        }
        const cnt = await client.query(
          "SELECT COUNT(*)::int AS ocupados FROM reservas_cupo WHERE horario_id = $1 AND fecha_clase = CURRENT_DATE AND estado IN ('confirmada','asistio')",
          [hid]
        );
        if (cnt.rows[0].ocupados >= lockH.rows[0].aforo_maximo) {
          return { lleno: true };
        }
        const dup = await client.query(
          "SELECT id FROM reservas_cupo WHERE horario_id = $1 AND usuario_id = $2 AND fecha_clase = CURRENT_DATE AND estado IN ('confirmada','asistio')",
          [hid, uid]
        );
        if (dup.rows.length) return { ya_reservado: true, reserva_id: dup.rows[0].id };
        const ins = await client.query(
          "INSERT INTO reservas_cupo (horario_id, usuario_id, fecha_clase, estado) VALUES ($1,$2,CURRENT_DATE,'confirmada') RETURNING *",
          [hid, uid]
        );
        return { confirmada: true, reserva: ins.rows[0] };
      });
      return { tool: 'reservar_cupo', ok: true, ...reserva, horario: h };
    } catch (err) {
      return { tool: 'reservar_cupo', ok: false, error: err.message };
    }
  }

  return { error: `Tool MCP desconocida: ${toolName}` };
}

// GET /api/mcp/tools — Lista herramientas expuestas por el MCP Server
router.get('/mcp/tools', (_req, res) => {
  res.json({ protocol: 'MCP-1.0', tools: MCP_TOOLS });
});

// POST /api/mcp — Endpoint JSON-RPC MCP
router.post('/mcp', optionalAuth, async (req, res) => {
  try {
    const { method, params = {}, id = 1 } = req.body || {};
    if (method === 'tools/list') {
      return res.json({ jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
    }
    if (method === 'tools/call') {
      const result = await executeMcpTool(params.name, params.arguments || {}, req.user);
      return res.json({ jsonrpc: '2.0', id, result });
    }
    return res.status(400).json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Método MCP no soportado' } });
  } catch (err) {
    return res.status(500).json({ error: 'Error en MCP Server.' });
  }
});

// POST /api/ia/chat — Agente Inteligente IA (RAG + MCP Tools en vivo + Guardrails)
router.post('/ia/chat', optionalAuth, async (req, res) => {
  try {
    const { message = '', session_key = 'anon-default' } = req.body || {};
    const txt = String(message).trim();
    if (!txt) return res.status(400).json({ error: 'Escribe una consulta.' });

    const lower = txt.toLowerCase();

    // 1. Recuperación semántica / RAG desde base_conocimiento_rag
    const ragAll = await query('SELECT * FROM base_conocimiento_rag');
    const ragHits = ragAll.rows.filter((doc) => {
      const keys = `${doc.titulo} ${doc.palabras_clave}`.toLowerCase().split(/\s+/);
      return keys.some((k) => k.length > 3 && lower.includes(k));
    });

    // 2. Detectar intención e invocar herramientas MCP en tiempo real
    const mcpUsed = [];
    let horariosMcp = [];
    let stockMcp = [];
    let recomendacionCombo = null;
    let identidadMcp = null;

    // Filtro de sede y disciplina detectado
    const sedeDetectada = lower.includes('surco')
      ? 'Surco'
      : lower.includes('molina')
      ? 'La Molina'
      : lower.includes('borja')
      ? 'San Borja'
      : null;

    const discDetectada = lower.includes('bjj') || lower.includes('jiu')
      ? 'Brazilian Jiu-Jitsu'
      : lower.includes('muay')
      ? 'Muay Thai'
      : lower.includes('box')
      ? 'Boxeo'
      : lower.includes('capoeira')
      ? 'Capoeira'
      : lower.includes('acond') || lower.includes('funcional')
      ? 'Acondicionamiento'
      : null;

    if (
      lower.includes('horario') ||
      lower.includes('cupo') ||
      lower.includes('aforo') ||
      lower.includes('vacante') ||
      lower.includes('clase') ||
      lower.includes('reservar') ||
      sedeDetectada ||
      discDetectada
    ) {
      const resAforo = await executeMcpTool('consultar_aforo', {
        sede: sedeDetectada,
        disciplina: discDetectada,
      });
      mcpUsed.push('consultar_aforo');
      horariosMcp = resAforo.horarios || [];
    }

    if (
      lower.includes('kimono') ||
      lower.includes('guante') ||
      lower.includes('abada') ||
      lower.includes('abadá') ||
      lower.includes('talla') ||
      lower.includes('stock') ||
      lower.includes('combo') ||
      lower.includes('indumentaria')
    ) {
      const resStock = await executeMcpTool('consultar_stock_gear', { disciplina: discDetectada });
      mcpUsed.push('consultar_stock_gear');
      stockMcp = resStock.items || [];
      recomendacionCombo = {
        titulo: 'Combo AFF Oficial (S/ 630.00)',
        incluye: discDetectada
          ? `3 meses de ${discDetectada} + Indumentaria reglamentaria oficial AFF Gear`
          : '3 meses multisede + Kimono BJJ / Guantes+Vendas / Abadá según tu disciplina',
        deeplink: '/pages/portal/renovar.html?plan=COMBO_AFF',
      };
    }

    const dniMatch = txt.match(/\b\d{8}\b/);
    if (dniMatch) {
      identidadMcp = await executeMcpTool('validar_identidad', { dni: dniMatch[0] });
      mcpUsed.push('validar_identidad');
    }

    // 3. Construir respuesta precisa (sin alucinaciones de tarifas ni aforos)
    const parts = [];

    if (identidadMcp?.encontrado) {
      const al = identidadMcp.alumno;
      parts.push(
        `✅ Identidad verificada para **${al.nombre} ${al.apellido_paterno || ''}** (${al.sede} · ${al.disciplina}). Estado de matrícula: **${al.estado_matricula || 'Sin matrícula'}**.`
      );
    }

    if (lower.includes('precio') || lower.includes('plan') || lower.includes('cuesta') || lower.includes('tarifa') || lower.includes('mensual') || lower.includes('combo')) {
      parts.push(
        `📋 **Planes Oficiales Forca & Fitness:**\n• Plan Mensual: **S/ 150.00**\n• Plan Bimensual: **S/ 280.00**\n• Plan Trimestral Multisede: **S/ 400.00**\n• Plan Semestral Pro: **S/ 720.00**\n• **Combo AFF (3 meses + Kit Indumentaria AFF Gear): S/ 630.00**`
      );
    }

    if (horariosMcp.length > 0) {
      const top = horariosMcp.slice(0, 4);
      const listado = top
        .map(
          (h) =>
            `• **${h.titulo}** (${h.sede_nombre}) — ${h.dias_bloque} ${h.hora_inicio}-${h.hora_fin} | **${h.disponibles}/${h.aforo_maximo} cupos libres**`
        )
        .join('\n');
      parts.push(`🥋 **Disponibilidad en vivo (Tool MCP \`consultar_aforo\`, máx. 18 por tatami):**\n${listado}`);
    }

    if (stockMcp.length > 0) {
      const topStock = stockMcp.slice(0, 4);
      const listadoStock = topStock
        .map((s) => `• ${s.nombre} Talla **${s.talla}** (${s.sede_nombre}): **${s.cantidad_disponible} unid.**`)
        .join('\n');
      parts.push(`🎒 **Stock AFF Gear en vivo (Tool MCP \`consultar_stock_gear\`):**\n${listadoStock}`);
    }

    if (lower.includes('sede') || lower.includes('donde') || lower.includes('dónde') || lower.includes('direccion') || lower.includes('dirección')) {
      parts.push(
        `📍 **Nuestras 3 Sedes en Lima:**\n• **Surco:** Av. Caminos del Inca 1420\n• **La Molina:** Av. Javier Prado Este 5890\n• **San Borja:** Av. Aviación 2945`
      );
    }

    if (lower.includes('pago') || lower.includes('yape') || lower.includes('plin') || lower.includes('factura') || lower.includes('boleta') || lower.includes('congel')) {
      parts.push(
        `💳 Aceptamos **Yape / Plin QR** (conciliación automática al instante), **Tarjeta**, **Transferencia** y **Efectivo en recepción**, emitiendo **Boleta o Factura Electrónica SUNAT UBL 2.1**. También puedes solicitar **congelamiento** por salud o viaje desde tu Portal.`
      );
    }

    if (parts.length === 0) {
      if (ragHits.length > 0) {
        parts.push(ragHits.map((r) => `**${r.titulo}:** ${r.contenido}`).join('\n\n'));
      } else {
        parts.push(
          `¡Hola! Soy el **Asistente IA 24/7 de Forca & Fitness** 🤖🥋.\nPuedo ayudarte en vivo con:\n• **Horarios y cupos en tiempo real** (máx. 18 alumnos por tatami en Surco, La Molina y San Borja)\n• **Planes** desde **S/ 150/mes** o **Combo AFF (S/ 630)** con Kimono/Guantes/Abadá\n• **Stock de tallas AFF Gear** y **Pre-reserva guiada**\n\nPrueba preguntando: *"¿Qué horarios de BJJ hay en Surco?"* o *"¿Tienen stock de Kimono talla A2 y cuánto cuesta el Combo AFF?"*`
        );
      }
    }

    const reply = parts.join('\n\n');

    // Guardar sesión conversacional
    try {
      await query(
        `INSERT INTO sesiones_chat_ia (session_key, usuario_id, mensajes, mcp_tools_usadas, updated_at)
         VALUES ($1,$2,$3::jsonb,$4::jsonb,NOW())
         ON CONFLICT (session_key) DO UPDATE SET
           mensajes = sesiones_chat_ia.mensajes || $3::jsonb,
           mcp_tools_usadas = $4::jsonb,
           updated_at = NOW()`,
        [
          session_key,
          req.user?.id || null,
          JSON.stringify([{ role: 'user', text: txt }, { role: 'assistant', text: reply }]),
          JSON.stringify(mcpUsed),
        ]
      );
    } catch (_) {}

    return res.json({
      reply,
      mcp_tools_used: mcpUsed,
      horarios_mcp: horariosMcp.slice(0, 4),
      stock_mcp: stockMcp.slice(0, 4),
      recomendacion_combo: recomendacionCombo,
    });
  } catch (err) {
    console.error('[IA Chat Error]', err);
    return res.status(500).json({ error: 'Error procesando consulta del Asistente IA.' });
  }
});

// POST /api/ia/leads — Captura automática de prospecto 24/7 desde Web Chat Widget
router.post('/ia/leads', async (req, res) => {
  try {
    const {
      nombre,
      whatsapp,
      email = '',
      sede_interes = 'Sede Surco',
      disciplina_interes = 'Brazilian Jiu-Jitsu',
      plan_interes = 'Combo AFF (S/630)',
    } = req.body || {};

    if (!nombre || !whatsapp) {
      return res.status(400).json({ error: 'Ingresa tu nombre y WhatsApp para contactarte.' });
    }

    const ins = await query(
      `INSERT INTO crm_leads (nombre, whatsapp, email, sede_interes, disciplina_interes, plan_interes, canal, estado)
       VALUES ($1,$2,$3,$4,$5,$6,'Agente IA 24/7','nuevo') RETURNING *`,
      [nombre.trim(), whatsapp.trim(), email.trim(), sede_interes, disciplina_interes, plan_interes]
    );

    await eventBus.publish(
      TOPICOS.CRM_LEADS_CAPTURADOS,
      { lead_id: ins.rows[0].id, nombre, sede_interes, disciplina_interes },
      'CMM3-AgenteIA'
    );

    return res.status(201).json({
      lead: ins.rows[0],
      message: '¡Datos registrados! Un coordinador te contactará y también puedes matricularte online al instante.',
    });
  } catch (err) {
    return res.status(500).json({ error: 'Error registrando prospecto.' });
  }
});

module.exports = router;
