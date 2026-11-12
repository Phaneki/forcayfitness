const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { newDb } = require('pg-mem');

const { setPool } = require('../src/db/pool');
const { initDatabase } = require('../src/db/init');
const { createApp } = require('../src/app');

let app;
let testPool;

function createPgMemPool() {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  db.public.registerFunction({
    name: 'date',
    args: ['timestamp'],
    returns: 'date',
    implementation: (ts) => new Date(ts).toISOString().slice(0, 10),
  });
  db.public.registerFunction({
    name: 'trim',
    args: ['text'],
    returns: 'text',
    implementation: (s) => String(s || '').trim(),
  });
  const pgMem = db.adapters.createPg();
  return new pgMem.Pool();
}

/**
 * Despacha peticiones HTTP in-memory directo a Express sin abrir sockets TCP.
 */
function req(urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const method = (opts.method || 'GET').toUpperCase();
    const rawBody = opts.body ? JSON.stringify(opts.body) : '';
    const headers = {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(rawBody)),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.headers || {}),
    };
    const normHeaders = {};
    for (const [k, v] of Object.entries(headers)) normHeaders[k.toLowerCase()] = v;

    const fakeReq = new PassThrough();
    fakeReq.url = urlPath;
    fakeReq.originalUrl = urlPath;
    fakeReq.method = method;
    fakeReq.headers = normHeaders;
    fakeReq.socket = Object.assign(new EventEmitter(), { remoteAddress: '127.0.0.1', writable: true });
    fakeReq.connection = fakeReq.socket;
    fakeReq.ip = '127.0.0.1';

    const resHeaders = {};
    const chunks = [];
    const fakeRes = new EventEmitter();
    fakeRes.writable = true;
    fakeRes.writableEnded = false;
    fakeRes.finished = false;
    fakeRes.socket = Object.assign(new EventEmitter(), { writable: true });
    fakeRes.statusCode = 200;
    fakeRes.locals = {};
    fakeRes.headersSent = false;
    fakeRes.setHeader = (k, v) => { resHeaders[k.toLowerCase()] = v; };
    fakeRes.getHeader = (k) => resHeaders[k.toLowerCase()];
    fakeRes.getHeaders = () => ({ ...resHeaders });
    fakeRes.removeHeader = (k) => { delete resHeaders[k.toLowerCase()]; };
    fakeRes.hasHeader = (k) => k.toLowerCase() in resHeaders;
    fakeRes.status = (code) => { fakeRes.statusCode = code; return fakeRes; };
    fakeRes.writeHead = (code, reasonOrHeaders, maybeHeaders) => {
      fakeRes.statusCode = code;
      const h = typeof reasonOrHeaders === 'object' ? reasonOrHeaders : maybeHeaders;
      if (h) for (const [k, v] of Object.entries(h)) resHeaders[k.toLowerCase()] = v;
      fakeRes.headersSent = true;
      return fakeRes;
    };
    fakeRes.write = (chunk) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    };
    fakeRes.destroy = () => {};
    fakeRes.end = (chunk) => {
      if (chunk) fakeRes.write(chunk);
      fakeRes.headersSent = true;
      fakeRes.writableEnded = true;
      fakeRes.finished = true;
      const raw = Buffer.concat(chunks).toString('utf8');
      let data = raw;
      try { data = JSON.parse(raw); } catch (_) {}
      fakeRes.emit('finish');
      resolve({ status: fakeRes.statusCode, headers: resHeaders, data, raw });
    };

    app.handle(fakeReq, fakeRes, (err) => {
      if (err) reject(err);
      else resolve({ status: 404, data: { error: 'Not found' }, raw: '' });
    });

    if (rawBody) fakeReq.push(Buffer.from(rawBody));
    fakeReq.push(null);
  });
}

test.before(async () => {
  testPool = createPgMemPool();
  setPool(testPool);
  await initDatabase(testPool);
  app = createApp();
});

test('1. Healthcheck retorna ok y base conectada', async () => {
  const r = await req('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.status, 'ok');
  assert.equal(r.data.database, 'connected');
});

test('2. Login 5 roles y Registro menor con cumplimiento LPDP (Ley 29733)', async () => {
  const dir = await req('/api/auth/login', {
    method: 'POST',
    body: { email: 'director@forcafitness.pe', password: 'Forca2025!' },
  });
  assert.equal(dir.status, 200);
  assert.equal(dir.data.usuario.rol, 'Director');
  assert.ok(dir.data.token);

  for (const [email, expectedRol] of [
    ['tesorero@forcafitness.pe', 'Tesorero'],
    ['profesor@forcafitness.pe', 'Profesor'],
    ['recepcion@forcafitness.pe', 'Recepcionista'],
    ['alumno@forcafitness.pe', 'Alumno'],
  ]) {
    const r = await req('/api/auth/login', {
      method: 'POST',
      body: { email, password: 'Forca2025!' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.usuario.rol, expectedRol);
  }

  // Registro menor sin apoderado -> debe rechazarse 400
  const failMenor = await req('/api/auth/registro', {
    method: 'POST',
    body: {
      nombre: 'Lucas',
      apellido_paterno: 'Diaz',
      dni: '88112233',
      email: 'lucas.menor@test.pe',
      password: 'Password123',
      fecha_nacimiento: '2014-05-10',
    },
  });
  assert.equal(failMenor.status, 400);

  // Registro menor con apoderado LPDP -> 201
  const okMenor = await req('/api/auth/registro', {
    method: 'POST',
    body: {
      nombre: 'Lucas',
      apellido_paterno: 'Diaz',
      dni: '88112233',
      email: 'lucas.menor@test.pe',
      password: 'Password123',
      fecha_nacimiento: '2014-05-10',
      apoderado_nombre: 'Ana Diaz',
      apoderado_dni: '40556677',
      acepta_lpdp: true,
    },
  });
  assert.equal(okMenor.status, 201);
  assert.equal(okMenor.data.usuario.es_menor, true);
});

test('3. Control atómico de aforo (máx 18 por tatami) y lista de espera', async () => {
  const alu = await req('/api/auth/login', {
    method: 'POST',
    body: { email: 'alumno@forcafitness.pe', password: 'Forca2025!' },
  });
  const token = alu.data.token;

  const horarios = await req('/api/horarios');
  assert.equal(horarios.status, 200);
  assert.ok(horarios.data.length >= 6);
  for (const h of horarios.data) {
    assert.ok(h.aforo_maximo <= 18, `Aforo maximo debe ser <= 18, fue ${h.aforo_maximo}`);
  }

  const h2 = horarios.data[1];
  const resCupo = await req('/api/reservas', {
    method: 'POST',
    token,
    body: { horario_id: h2.id },
  });
  assert.equal(resCupo.status, 201);
  assert.equal(resCupo.data.reserva.estado, 'confirmada');

  const cancelRes = await req(`/api/reservas/${resCupo.data.reserva.id}/cancelar`, {
    method: 'POST',
    token,
  });
  assert.equal(cancelRes.status, 200);
});

test('4. Pago Yape QR auto-conciliado + Comprobante SUNAT UBL 2.1 + Despacho Combo AFF', async () => {
  const alu = await req('/api/auth/login', {
    method: 'POST',
    body: { email: 'diego.torres@forcafitness.pe', password: 'Forca2025!' },
  });
  const tokenAlu = alu.data.token;

  // Diego tiene membresía vencida -> no puede reservar todavía
  const hor = await req('/api/horarios');
  const blockedRes = await req('/api/reservas', {
    method: 'POST',
    token: tokenAlu,
    body: { horario_id: hor.data[0].id },
  });
  assert.equal(blockedRes.status, 403);

  // Diego paga Combo AFF por Yape QR -> concilia automático + emite Boleta UBL 2.1 + activa matrícula
  const pagoRes = await req('/api/pagos', {
    method: 'POST',
    token: tokenAlu,
    body: {
      monto: 630,
      concepto: 'Combo AFF Boxeo (Plan + Guantes)',
      medio_pago: 'yape',
      tipo_comprobante: 'Boleta',
      plan_codigo: 'COMBO_AFF',
      disciplina: 'Boxeo',
      es_combo_aff: true,
      talla_combo: '12oz',
      sede_id: 3,
      idempotency_key: 'test-idem-combo-1',
    },
  });
  assert.equal(pagoRes.status, 201);
  assert.equal(pagoRes.data.estado, 'aprobado');
  assert.equal(pagoRes.data.conciliacion_automatica, true);
  assert.ok(pagoRes.data.comprobante.serie_numero.startsWith('B001-'));
  assert.equal(pagoRes.data.comprobante.estado_sunat, 'ACEPTADO_CDR');

  // Recepcionista despacha el Combo AFF de Diego -> descuenta inventario y crea Kárdex
  const rec = await req('/api/auth/login', {
    method: 'POST',
    body: { email: 'recepcion@forcafitness.pe', password: 'Forca2025!' },
  });
  const desp = await req('/api/inventario/despachar-combo', {
    method: 'POST',
    token: rec.data.token,
    body: { matricula_id: pagoRes.data.matricula_id, sede_id: 3, talla: '12oz' },
  });
  assert.equal(desp.status, 200);
});

test('5. Staff Profesor: Validación QR en tatami + Ascenso de Grado', async () => {
  const prof = await req('/api/auth/login', {
    method: 'POST',
    body: { email: 'profesor@forcafitness.pe', password: 'Forca2025!' },
  });
  const tokenProf = prof.data.token;

  const checkin = await req('/api/asistencias/qr', {
    method: 'POST',
    token: tokenProf,
    body: { qr_token: 'QR-ALU-0001', horario_id: 1, sede_id: 1 },
  });
  assert.equal(checkin.status, 201);
  assert.equal(checkin.data.autorizado, true);

  const grado = await req('/api/grados', {
    method: 'POST',
    token: tokenProf,
    body: { usuario_id: 12, disciplina: 'Brazilian Jiu-Jitsu', grado: 'Cinturón Azul · 3 grados' },
  });
  assert.equal(grado.status, 201);
});

test('6. Seguridad DVR NTP Sync + Analítica BI KPIs + Agente IA MCP', async () => {
  const dir = await req('/api/auth/login', {
    method: 'POST',
    body: { email: 'director@forcafitness.pe', password: 'Forca2025!' },
  });
  const tokenDir = dir.data.token;

  const syncRes = await req('/api/seguridad/dvr/sync', {
    method: 'POST',
    token: tokenDir,
    body: {},
  });
  assert.equal(syncRes.status, 200);
  assert.equal(syncRes.data.sincronizados, 3);
  for (const d of syncRes.data.dvrs) {
    assert.ok(d.ntp_drift_ms <= 15);
  }

  const kpis = await req('/api/analitica/kpis', { token: tokenDir });
  assert.equal(kpis.status, 200);
  assert.ok(kpis.data.resumen.ingresos_totales > 0);
  assert.equal(kpis.data.por_sede.length, 3);

  const chat = await req('/api/ia/chat', {
    method: 'POST',
    body: { message: '¿Qué horarios de BJJ hay en Surco y cuánto cuesta el Combo AFF?' },
  });
  assert.equal(chat.status, 200);
  assert.ok(chat.data.mcp_tools_used.includes('consultar_aforo'));
  assert.ok(chat.data.mcp_tools_used.includes('consultar_stock_gear'));
  assert.ok(chat.data.horarios_mcp.length > 0);

  const mcpList = await req('/api/mcp', {
    method: 'POST',
    body: { method: 'tools/list', id: 1 },
  });
  assert.equal(mcpList.status, 200);
  assert.equal(mcpList.data.result.tools.length, 4);
});

test('7. Aforo estricto 18/18 tatami, bloqueo 19no, lista de espera y promoción automática', async () => {
  const horRes = await req('/api/horarios');
  // Usar horario con id=4 (Capoeira o libre sin reservas previas del test 3)
  const targetHorario = horRes.data.find((h) => Number(h.cupos_ocupados) === 0) || horRes.data[3];
  const fechaHoy = new Date().toISOString().slice(0, 10);

  // Crear 19 alumnos con matrícula activa para saturar exactamente el tatami de 18
  const tokens = [];
  for (let i = 1; i <= 19; i++) {
    const email = `tatami.alu${i}@test.pe`;
    const reg = await req('/api/auth/registro', {
      method: 'POST',
      body: {
        nombre: `Atleta${i}`,
        apellido_paterno: 'Tatami',
        dni: String(91000000 + i),
        email,
        password: 'Password123',
        sede_id: targetHorario.sede_id,
      },
    });
    assert.equal(reg.status, 201);
    await testPool.query(
      `INSERT INTO matriculas (usuario_id, sede_id, disciplina, fecha_inicio, fecha_fin, estado, precio_congelado)
       VALUES ($1, $2, $3, CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days', 'activa', 150)`,
      [reg.data.usuario.id, targetHorario.sede_id, targetHorario.disciplina]
    );
    tokens.push(reg.data.token);
  }

  // Reservar los 18 cupos permitidos
  const reservasConfirmadas = [];
  for (let i = 0; i < 18; i++) {
    const r = await req('/api/reservas', {
      method: 'POST',
      token: tokens[i],
      body: { horario_id: targetHorario.id, fecha_clase: fechaHoy },
    });
    assert.equal(r.status, 201, `Reserva #${i + 1} debía confirmarse`);
    assert.equal(r.data.reserva.estado, 'confirmada');
    reservasConfirmadas.push({ id: r.data.reserva.id, token: tokens[i] });
  }

  // El alumno 19 sin lista_espera recibe 409 AFORO_LLENO
  const r19Fail = await req('/api/reservas', {
    method: 'POST',
    token: tokens[18],
    body: { horario_id: targetHorario.id, fecha_clase: fechaHoy },
  });
  assert.equal(r19Fail.status, 409);
  assert.equal(r19Fail.data.code, 'AFORO_LLENO');

  // El alumno 19 se inscribe en lista_espera
  const r19Wait = await req('/api/reservas', {
    method: 'POST',
    token: tokens[18],
    body: { horario_id: targetHorario.id, fecha_clase: fechaHoy, aceptar_lista_espera: true },
  });
  assert.equal(r19Wait.status, 201);
  assert.equal(r19Wait.data.reserva.estado, 'lista_espera');

  // Al cancelar el alumno 1, el alumno 19 es promovido automáticamente a 'confirmada'
  const cancel1 = await req(`/api/reservas/${reservasConfirmadas[0].id}/cancelar`, {
    method: 'POST',
    token: reservasConfirmadas[0].token,
  });
  assert.equal(cancel1.status, 200);
  assert.ok(cancel1.data.promovido, 'Debe promover automáticamente al siguiente en lista de espera');

  const check19 = await req('/api/reservas/mias', { token: tokens[18] });
  assert.equal(check19.status, 200);
  assert.equal(check19.data[0].estado, 'confirmada');
});

test('8. Tesorería confirma pago pendiente + UBL XML + DVR SHA-256 + Campaña CRM', async () => {
  const alu = await req('/api/auth/login', {
    method: 'POST',
    body: { email: 'alumno@forcafitness.pe', password: 'Forca2025!' },
  });
  const pendingPay = await req('/api/pagos', {
    method: 'POST',
    token: alu.data.token,
    body: {
      monto: 280,
      concepto: 'Plan Bimensual Transferencia BCP',
      medio_pago: 'transferencia',
      tipo_comprobante: 'Factura',
      ruc_cliente: '20555666777',
      razon_social_cliente: 'Inversiones Dojo S.A.C.',
      sede_id: 1,
    },
  });
  assert.equal(pendingPay.status, 201);
  assert.equal(pendingPay.data.estado, 'pendiente');

  const tes = await req('/api/auth/login', {
    method: 'POST',
    body: { email: 'tesorero@forcafitness.pe', password: 'Forca2025!' },
  });
  const conf = await req(`/api/pagos/${pendingPay.data.id}/confirmar`, {
    method: 'PUT',
    token: tes.data.token,
  });
  assert.equal(conf.status, 200);
  assert.equal(conf.data.pago.estado, 'aprobado');
  assert.ok(conf.data.emitted.comprobante.serie_numero.startsWith('F001-'));

  const xmlRes = await req(`/api/comprobantes/${conf.data.emitted.comprobante.id}/xml`, {
    token: tes.data.token,
  });
  assert.equal(xmlRes.status, 200);
  assert.ok(xmlRes.raw.includes('<Invoice') || xmlRes.raw.includes('UBLVersionID'));

  const dir = await req('/api/auth/login', {
    method: 'POST',
    body: { email: 'director@forcafitness.pe', password: 'Forca2025!' },
  });
  const inc = await req('/api/seguridad/incidentes', {
    method: 'POST',
    token: dir.data.token,
    body: { sede_id: 1, tipo: 'Auditoria Caja POS', descripcion: 'Verificación de arqueo nocturno' },
  });
  assert.equal(inc.status, 201);
  assert.equal(inc.data.hash_evidencia_sha256.length, 64);

  const resInc = await req(`/api/seguridad/incidentes/${inc.data.id}/resolver`, {
    method: 'PUT',
    token: dir.data.token,
  });
  assert.equal(resInc.status, 200);
  assert.equal(resInc.data.estado, 'resuelto');

  const camp = await req('/api/crm/campanas', {
    method: 'POST',
    token: dir.data.token,
    body: { titulo: 'Reactivación Q4', segmento: 'Vencidos 30 dias', canal: 'WhatsApp + Email', destinatarios_count: 5 },
  });
  assert.equal(camp.status, 201);
  assert.equal(camp.data.estado, 'enviada');
});

test('9. Todas las pantallas frontend APU1..APU5 y assets PWA se sirven con HTTP 200', async () => {
  const staticPaths = [
    '/',
    '/manifest.json',
    '/sw.js',
    '/pages/auth.js',
    '/pages/widget-ia.js',
    '/pages/auth/login.html',
    '/pages/portal/mis-matriculas.html',
    '/pages/portal/disciplinas.html',
    '/pages/portal/renovar.html',
    '/pages/portal/pagos.html',
    '/pages/portal/comprobante.html',
    '/pages/portal/perfil.html',
    '/pages/portal/editar-perfil.html',
    '/pages/staff/index.html',
    '/pages/staff/asistencia.html',
    '/pages/staff/grados.html',
    '/pages/staff/honorarios.html',
    '/pages/pos/index.html',
    '/pages/pos/despacho-combo.html',
    '/pages/pos/stock-sedes.html',
    '/pages/pos/arqueo-caja.html',
    '/pages/admin/index.html',
    '/pages/admin/alumnos.html',
    '/pages/admin/tesoreria.html',
    '/pages/admin/inventario.html',
    '/pages/admin/control_acceso.html',
    '/pages/admin/seguridad-dvr.html',
    '/pages/admin/crm-retencion.html',
  ];

  for (const p of staticPaths) {
    const r = await req(p);
    assert.equal(r.status, 200, `Ruta estática ${p} debe retornar HTTP 200`);
    assert.ok(r.raw.length > 50, `Ruta estática ${p} no debe estar vacía`);
  }
});

test('10. Mercado Pago Checkout Pro + Validación Webhook x-signature HMAC-SHA256 + Idempotencia', async () => {
  const crypto = require('crypto');
  const origFetch = global.fetch;
  const prevEnv = {
    MP_ACCESS_TOKEN: process.env.MP_ACCESS_TOKEN,
    MP_WEBHOOK_SECRET: process.env.MP_WEBHOOK_SECRET,
    APP_BASE_URL: process.env.APP_BASE_URL,
  };

  process.env.MP_ACCESS_TOKEN = 'TEST-mock-mp-token';
  process.env.MP_WEBHOOK_SECRET = 'secreto_mp_test_2026';
  process.env.APP_BASE_URL = 'https://forca-test.onrender.com';

  let createdPagoId = null;

  global.fetch = async (url, init) => {
    const u = String(url);
    if (u === 'https://api.mercadopago.com/checkout/preferences') {
      const body = JSON.parse(init.body);
      createdPagoId = body.external_reference;
      return {
        ok: true,
        status: 201,
        json: async () => ({
          id: 'pref-mp-123',
          sandbox_init_point: 'https://sandbox.mercadopago.com.pe/checkout/v1/redirect?pref_id=pref-mp-123',
          init_point: 'https://www.mercadopago.com.pe/checkout/v1/redirect?pref_id=pref-mp-123',
        }),
      };
    }
    if (u.startsWith('https://api.mercadopago.com/v1/payments/')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 987654321,
          status: 'approved',
          external_reference: String(createdPagoId),
        }),
      };
    }
    throw new Error(`Fetch inesperado en test MP: ${u}`);
  };

  try {
    const alu = await req('/api/auth/login', {
      method: 'POST',
      body: { email: 'alumno@forcafitness.pe', password: 'Forca2025!' },
    });
    assert.equal(alu.status, 200);

    // 1. Crear pago -> debe retornar checkout_url y quedar pendiente hasta recibir webhook
    const payRes = await req('/api/pagos', {
      method: 'POST',
      token: alu.data.token,
      body: {
        monto: 400,
        concepto: 'Plan Trimestral Multisede MP',
        medio_pago: 'tarjeta',
        tipo_comprobante: 'Boleta',
        plan_codigo: 'TRIMESTRAL',
        disciplina: 'Brazilian Jiu-Jitsu',
        sede_id: 1,
      },
    });
    assert.equal(payRes.status, 201);
    assert.equal(payRes.data.estado, 'pendiente');
    assert.ok(payRes.data.checkout_url.includes('sandbox.mercadopago.com.pe'));

    // 2. Webhook con firma inválida -> 401
    const badWhk = await req('/api/pagos/webhook?data.id=987654321&type=payment', {
      method: 'POST',
      headers: {
        'x-request-id': 'req-mp-1',
        'x-signature': 'ts=1700000000,v1=0000000000000000000000000000000000000000000000000000000000000000',
      },
      body: { type: 'payment', data: { id: '987654321' } },
    });
    assert.equal(badWhk.status, 401);

    // 3. Webhook con firma HMAC-SHA256 válida -> aprueba pago y emite UBL 2.1
    const ts = '1762920000';
    const reqId = 'req-mp-2';
    const dataId = '987654321';
    const manifest = `id:${dataId};request-id:${reqId};ts:${ts};`;
    const v1 = crypto.createHmac('sha256', process.env.MP_WEBHOOK_SECRET).update(manifest).digest('hex');

    const okWhk = await req(`/api/pagos/webhook?data.id=${dataId}&type=payment`, {
      method: 'POST',
      headers: {
        'x-request-id': reqId,
        'x-signature': `ts=${ts},v1=${v1}`,
      },
      body: { type: 'payment', data: { id: dataId } },
    });
    assert.equal(okWhk.status, 200);
    assert.equal(okWhk.data.ok, true);
    assert.equal(okWhk.data.idempotent, false);
    assert.equal(okWhk.data.pago.estado, 'aprobado');
    assert.ok(okWhk.data.comprobante.serie_numero.startsWith('B001-'));

    // 4. Reintento idempotente del mismo webhook -> 200 con idempotent: true
    const dupWhk = await req(`/api/pagos/webhook?data.id=${dataId}&type=payment`, {
      method: 'POST',
      headers: {
        'x-request-id': reqId,
        'x-signature': `ts=${ts},v1=${v1}`,
      },
      body: { type: 'payment', data: { id: dataId } },
    });
    assert.equal(dupWhk.status, 200);
    assert.equal(dupWhk.data.idempotent, true);
  } finally {
    global.fetch = origFetch;
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
