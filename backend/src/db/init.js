const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getPool } = require('./pool');

function sha256(str) {
  return crypto.createHash('sha256').update(String(str)).digest('hex');
}

function buildXmlUbl(serieNumero, tipo, clienteNombre, rucOCi, concepto, subtotal, igv, total) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>2.0</cbc:CustomizationID>
  <cbc:ID>${serieNumero}</cbc:ID>
  <cbc:IssueDate>${new Date().toISOString().slice(0, 10)}</cbc:IssueDate>
  <cbc:InvoiceTypeCode>${tipo}</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>PEN</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty><cac:Party><cac:PartyLegalEntity><cbc:RegistrationName>FORCA &amp; FITNESS S.A.C.</cbc:RegistrationName><cbc:CompanyID>20612345678</cbc:CompanyID></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party><cac:PartyLegalEntity><cbc:RegistrationName>${clienteNombre}</cbc:RegistrationName><cbc:CompanyID>${rucOCi || '00000000'}</cbc:CompanyID></cac:PartyLegalEntity></cac:Party></cac:AccountingCustomerParty>
  <cac:TaxTotal><cbc:TaxAmount currencyID="PEN">${Number(igv).toFixed(2)}</cbc:TaxAmount></cac:TaxTotal>
  <cac:LegalMonetaryTotal><cbc:PayableAmount currencyID="PEN">${Number(total).toFixed(2)}</cbc:PayableAmount></cac:LegalMonetaryTotal>
  <cac:InvoiceLine><cbc:ID>1</cbc:ID><cbc:LineExtensionAmount currencyID="PEN">${Number(subtotal).toFixed(2)}</cbc:LineExtensionAmount><cac:Item><cbc:Description>${concepto}</cbc:Description></cac:Item></cac:InvoiceLine>
</Invoice>`;
}

async function initDatabase(customPool) {
  const pool = customPool || getPool();
  const schemaPath = path.resolve(__dirname, '../../../database/schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');

  // Limpiar comentarios y ejecutar creación de tablas idempotente
  const cleanedSql = schemaSql
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');

  const statements = cleanedSql
    .split(/;\s*(?:\r?\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const stmt of statements) {
    await pool.query(stmt);
  }

  // Verificar si ya existen sedes sembradas
  const existing = await pool.query('SELECT COUNT(*)::int AS cnt FROM sedes');
  if (existing.rows[0].cnt > 0) {
    return { seeded: false, message: 'Base de datos ya inicializada.' };
  }

  // 1. Sedes (Surco, La Molina, San Borja)
  const sedesRes = await pool.query(`
    INSERT INTO sedes (codigo, nombre, direccion, area_tatami_m2, telefono) VALUES
    ('SURCO', 'Sede Surco', 'Av. Caminos del Inca 1420, Santiago de Surco', 240.00, '+51 991 234 501'),
    ('LA_MOLINA', 'Sede La Molina', 'Av. Javier Prado Este 5890, La Molina', 210.00, '+51 991 234 502'),
    ('SAN_BORJA', 'Sede San Borja', 'Av. Aviación 2945, San Borja', 195.00, '+51 991 234 503')
    RETURNING id, codigo
  `);
  const sedeMap = {};
  for (const r of sedesRes.rows) sedeMap[r.codigo] = r.id;

  // 2. Usuarios (5 roles exactos del diagrama)
  const pwdHash = bcrypt.hashSync('Forca2026!', 10);
  const usersData = [
    // Directores
    ['Faridh', 'Cruz', 'Mendoza', '44112233', 'director@forcafitness.pe', 'Director', sedeMap.SURCO, 'Brazilian Jiu-Jitsu', '991234560', 'Av. Surco 450', '1988-05-14', 'Masculino', false, 'Cinturón Negro 2° Dan', true, true, '123456', 'QR-DIR-001', 90],
    ['Paul', 'Rafael', 'Quispe', '44112234', 'paul.rafael@forcafitness.pe', 'Director', sedeMap.LA_MOLINA, 'Muay Thai', '991234561', 'Av. La Molina 780', '1987-09-21', 'Masculino', false, 'Kru Nivel 4', true, true, '123456', 'QR-DIR-002', 90],
    ['Cristian', 'Benites', 'Vega', '44112235', 'cristian.benites@forcafitness.pe', 'Director', sedeMap.SAN_BORJA, 'Boxeo', '991234562', 'Av. San Borja Sur 310', '1989-11-02', 'Masculino', false, 'Head Coach', true, true, '123456', 'QR-DIR-003', 90],
    // Tesorero
    ['Valeria', 'Salazar', 'Ríos', '45223344', 'tesorero@forcafitness.pe', 'Tesorero', sedeMap.SURCO, 'Administración', '991234563', 'Calle Las Flores 210, Surco', '1992-03-10', 'Femenino', false, 'Staff Finanzas', true, false, null, 'QR-TES-001', 70],
    // Recepcionistas (POS Sedes)
    ['Camila', 'Paredes', 'Soto', '71223344', 'recepcion@forcafitness.pe', 'Recepcionista', sedeMap.SURCO, 'Recepción POS', '991234564', 'Jr. Monte Rosa 180, Surco', '1998-07-19', 'Femenino', false, 'Staff Recepción', true, false, null, 'QR-REC-001', 45],
    ['Andrea', 'Lozano', 'Díaz', '71223345', 'recepcion.molina@forcafitness.pe', 'Recepcionista', sedeMap.LA_MOLINA, 'Recepción POS', '991234565', 'Av. La Universidad 420, La Molina', '1999-02-12', 'Femenino', false, 'Staff Recepción', true, false, null, 'QR-REC-002', 45],
    // Profesores / Instructores
    ['Renzo', 'Gracie', 'Almeida', '40998811', 'profesor@forcafitness.pe', 'Profesor', sedeMap.SURCO, 'Brazilian Jiu-Jitsu', '991234566', 'Av. Benavides 3100, Surco', '1986-04-08', 'Masculino', false, 'Cinturón Negro 3° Dan', true, false, null, 'QR-PROF-001', 85],
    ['Carlos', 'Vega', 'Toro', '41998822', 'carlos.vega@forcafitness.pe', 'Profesor', sedeMap.LA_MOLINA, 'Muay Thai', '991234567', 'Av. Fontana 220, La Molina', '1990-08-17', 'Masculino', false, 'Kru Muay Thai', true, false, null, 'QR-PROF-002', 75],
    ['Héctor', 'Ramírez', 'Paz', '42998833', 'hector.ramirez@forcafitness.pe', 'Profesor', sedeMap.SAN_BORJA, 'Boxeo', '991234568', 'Av. San Luis 1840, San Borja', '1989-12-03', 'Masculino', false, 'Entrenador FPB', true, false, null, 'QR-PROF-003', 70],
    ['Thiago', 'Silva', 'Mendes', '43998844', 'thiago.silva@forcafitness.pe', 'Profesor', sedeMap.SURCO, 'Capoeira', '991234569', 'Av. Higuereta 510, Surco', '1991-06-25', 'Masculino', false, 'Contra-Mestre Cordel Blanco/Verde', true, false, null, 'QR-PROF-004', 70],
    ['Valeria', 'Rossi', 'Campos', '44998855', 'valeria.rossi@forcafitness.pe', 'Profesor', sedeMap.SAN_BORJA, 'Acondicionamiento', '991234570', 'Av. Primavera 990, San Borja', '1993-01-30', 'Femenino', false, 'Coach Funcional NSCA', true, false, null, 'QR-PROF-005', 65],
    // Alumnos (Activos, Próximo a vencer, Vencido, Menor LPDP)
    ['Mateo', 'Fernández', 'Rojas', '72345678', 'alumno@forcafitness.pe', 'Alumno', sedeMap.SURCO, 'Brazilian Jiu-Jitsu', '987654321', 'Av. Velasco Astete 1120, Surco', '1999-04-15', 'Masculino', false, 'Cinturón Azul · 2 grados', true, false, null, 'QR-ALU-0001', 0],
    ['Lucía', 'Mendoza', 'Cárdenas', '73456789', 'lucia.mendoza@forcafitness.pe', 'Alumno', sedeMap.LA_MOLINA, 'Muay Thai', '987654322', 'Calle Las Caobas 340, La Molina', '2001-09-10', 'Femenino', false, 'Prajied Azul', true, false, null, 'QR-ALU-0002', 0],
    ['Diego', 'Torres', 'Vargas', '74567890', 'diego.torres@forcafitness.pe', 'Alumno', sedeMap.SAN_BORJA, 'Boxeo', '987654323', 'Av. Las Artes Norte 512, San Borja', '1997-11-22', 'Masculino', false, 'Nivel Intermedio', true, false, null, 'QR-ALU-0003', 0],
    ['Sofía', 'Castro', 'León', '78901234', 'sofia.castro@forcafitness.pe', 'Alumno', sedeMap.SURCO, 'Capoeira', '987654324', 'Calle Los Sauces 215, Surco', '2012-06-18', 'Femenino', true, 'Cordel Amarillo (Kids)', true, false, null, 'QR-ALU-0004', 0],
    ['Sebastián', 'Gómez', 'Prado', '75678901', 'sebastian.gomez@forcafitness.pe', 'Alumno', sedeMap.LA_MOLINA, 'Acondicionamiento', '987654325', 'Av. Raúl Ferrero 890, La Molina', '1995-02-05', 'Masculino', false, 'Atleta Avanzado', true, false, null, 'QR-ALU-0005', 0],
  ];

  const userIds = {};
  for (const u of usersData) {
    const res = await pool.query(
      `INSERT INTO usuarios (
        nombre, apellido_paterno, apellido_materno, dni, email, password_hash,
        rol, sede_id, disciplina, telefono, direccion, fecha_nacimiento, genero,
        es_menor, grado_actual, acceso_habilitado, mfa_habilitado, mfa_pin, qr_token, tarifa_hora, ficha_medica
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb)
      RETURNING id, email`,
      [
        u[0], u[1], u[2], u[3], u[4], pwdHash,
        u[5], u[6], u[7], u[8], u[9], u[10], u[11],
        u[12], u[13], u[14], u[15], u[16], u[17], u[18],
        JSON.stringify({ sangre: 'O+', alergia: 'Ninguna conocida', emergencia: 'Contacto familiar +51 999 888 777', actualizado: new Date().toISOString() }),
      ]
    );
    userIds[res.rows[0].email] = res.rows[0].id;
  }

  // 3. Consentimiento LPDP para menor (Sofía Castro)
  const sofiaId = userIds['sofia.castro@forcafitness.pe'];
  await pool.query(
    `INSERT INTO consentimientos_lpdp (usuario_id, apoderado_nombre, apoderado_dni, parentesco, telefono_apoderado, acepta_tratamiento_datos, firma_hash_sha256, ip_registro)
     VALUES ($1, $2, $3, $4, $5, true, $6, '127.0.0.1')`,
    [sofiaId, 'Patricia León de Castro', '40123456', 'Madre / Tutora Legal', '999888111', sha256(`LPDP-${sofiaId}-40123456`)]
  );

  // 4. Historial de grados marciales
  await pool.query(
    `INSERT INTO grados_marciales (usuario_id, disciplina, grado, instructor_id, observaciones, fecha_otorgamiento) VALUES
    ($1, 'Brazilian Jiu-Jitsu', 'Cinturón Blanco · 4 grados', $2, 'Evaluación técnica de fundamentos aprobada', CURRENT_DATE - INTERVAL '180 days'),
    ($1, 'Brazilian Jiu-Jitsu', 'Cinturón Azul · 2 grados', $2, 'Ceremonia oficial Sede Surco', CURRENT_DATE - INTERVAL '30 days'),
    ($3, 'Capoeira', 'Cordel Amarillo (Kids)', $4, 'Batizado anual Forca & Fitness', CURRENT_DATE - INTERVAL '60 days')`,
    [
      userIds['alumno@forcafitness.pe'],
      userIds['profesor@forcafitness.pe'],
      sofiaId,
      userIds['thiago.silva@forcafitness.pe'],
    ]
  );

  // 5. Planes oficiales del diagrama (Mensual 150, Bimensual 280, Trimestral 400, Semestral 720, Combo AFF 630)
  const planesRes = await pool.query(`
    INSERT INTO planes (codigo, nombre, duracion_meses, precio, incluye_combo_gear, descripcion) VALUES
    ('MENSUAL', 'Plan Mensual Regular', 1, 150.00, false, 'Acceso a 1 disciplina y reserva de turnos en tatami por 30 días.'),
    ('BIMENSUAL', 'Plan Bimensual', 2, 280.00, false, '2 meses continuos con tarifa congelada (ahorras S/ 20).'),
    ('TRIMESTRAL', 'Plan Trimestral', 3, 400.00, false, '3 meses multisede (Surco, La Molina y San Borja). Ahorras S/ 50.'),
    ('SEMESTRAL', 'Plan Semestral Pro', 6, 720.00, false, '6 meses de entrenamiento ilimitado en horarios reservados (20% OFF).'),
    ('COMBO_AFF', 'Combo AFF (Plan + Indumentaria)', 3, 630.00, true, 'Plan Trimestral + Kit oficial AFF Gear (Kimono BJJ / Guantes+Vendas / Abadá según disciplina).')
    RETURNING id, codigo
  `);
  const planMap = {};
  for (const p of planesRes.rows) planMap[p.codigo] = p.id;

  // 6. Matrículas activas, próximas a vencer, vencidas y Combo AFF
  const mat1 = await pool.query(
    `INSERT INTO matriculas (usuario_id, plan_id, sede_id, disciplina, fecha_inicio, fecha_fin, estado, es_combo_aff, talla_combo, combo_despachado, precio_congelado)
     VALUES
     ($1, $2, $3, 'Brazilian Jiu-Jitsu', CURRENT_DATE - INTERVAL '10 days', CURRENT_DATE + INTERVAL '20 days', 'activa', true, 'A2', false, 630.00),
     ($4, $5, $6, 'Muay Thai', CURRENT_DATE - INTERVAL '26 days', CURRENT_DATE + INTERVAL '4 days', 'activa', false, null, false, 150.00),
     ($7, $5, $8, 'Boxeo', CURRENT_DATE - INTERVAL '45 days', CURRENT_DATE - INTERVAL '15 days', 'vencida', false, null, false, 150.00),
     ($9, $10, $3, 'Capoeira', CURRENT_DATE - INTERVAL '5 days', CURRENT_DATE + INTERVAL '85 days', 'activa', false, null, false, 400.00),
     ($11, $5, $6, 'Acondicionamiento', CURRENT_DATE - INTERVAL '28 days', CURRENT_DATE + INTERVAL '2 days', 'activa', false, null, false, 150.00)
     RETURNING id, usuario_id`,
    [
      userIds['alumno@forcafitness.pe'], planMap.COMBO_AFF, sedeMap.SURCO,
      userIds['lucia.mendoza@forcafitness.pe'], planMap.MENSUAL, sedeMap.LA_MOLINA,
      userIds['diego.torres@forcafitness.pe'], sedeMap.SAN_BORJA,
      sofiaId, planMap.TRIMESTRAL,
      userIds['sebastian.gomez@forcafitness.pe'],
    ]
  );

  // 7. Horarios de Tatami (aforo máximo = 18 estricto por diagrama!)
  const horariosRes = await pool.query(
    `INSERT INTO horarios_tatami (sede_id, disciplina, titulo, descripcion, dias_bloque, hora_inicio, hora_fin, espacio, instructor_id, aforo_maximo) VALUES
    ($1, 'Brazilian Jiu-Jitsu', 'BJJ Adultos · Gi & No-Gi', 'Técnicas de sumisión, control y combate cuerpo a cuerpo por cinturones.', 'Lunes a Viernes', '19:00', '20:30', 'Tatami Principal Surco', $4, 18),
    ($1, 'Brazilian Jiu-Jitsu', 'BJJ Fundamentos & Iniciación', 'Principios básicos de postura, escapes, transiciones y derribos seguros.', 'Lunes a Viernes', '07:00', '08:30', 'Tatami Principal Surco', $4, 18),
    ($2, 'Muay Thai', 'Muay Thai · Las 8 Extremidades', 'Golpeo de puños, patadas, rodillas, codos y dominio de clinch tailandés.', 'Lunes a Viernes', '18:00', '19:30', 'Ring Central La Molina', $5, 18),
    ($3, 'Boxeo', 'Boxeo Clásico & Sparring Técnico', 'Juego de pies, esquivas, combinaciones de poder y resistencia aeróbica.', 'Lunes a Viernes', '08:00', '09:30', 'Ring Boxeo #1 San Borja', $6, 18),
    ($1, 'Capoeira', 'Capoeira Regional · Roda & Acrobacia', 'Movilidad articular, ginga, acrobacias marciales e instrumentos tradicionales.', 'Sábados', '10:30', '12:00', 'Tatami 2 Surco', $7, 18),
    ($3, 'Acondicionamiento', 'Acondicionamiento Físico Funcional', 'Circuitos de potencia explosiva, fuerza funcional y resistencia.', 'Lunes a Viernes', '06:30', '07:45', 'Zona Funcional San Borja', $8, 18),
    ($2, 'Brazilian Jiu-Jitsu', 'BJJ No-Gi · Submission Wrestling', 'Sesión intensiva de derribos y sumisiones sin kimono.', 'Sábados', '10:00', '11:30', 'Tatami La Molina', $4, 18),
    ($2, 'Muay Thai', 'Muay Thai · Sparring & Paos', 'Trabajo técnico de paos tailandeses y asaltos controlados.', 'Sábados', '11:30', '13:00', 'Ring La Molina', $5, 18)
    RETURNING id, titulo`,
    [
      sedeMap.SURCO, sedeMap.LA_MOLINA, sedeMap.SAN_BORJA,
      userIds['profesor@forcafitness.pe'],
      userIds['carlos.vega@forcafitness.pe'],
      userIds['hector.ramirez@forcafitness.pe'],
      userIds['thiago.silva@forcafitness.pe'],
      userIds['valeria.rossi@forcafitness.pe'],
    ]
  );

  // Reservas iniciales para mostrar ocupación real sobre 18
  const h1 = horariosRes.rows[0].id;
  const h3 = horariosRes.rows[2].id;
  await pool.query(
    `INSERT INTO reservas_cupo (horario_id, usuario_id, fecha_clase, estado) VALUES
    ($1, $2, CURRENT_DATE, 'confirmada'),
    ($1, $3, CURRENT_DATE, 'confirmada'),
    ($4, $5, CURRENT_DATE, 'confirmada')`,
    [
      h1, userIds['alumno@forcafitness.pe'], sofiaId,
      h3, userIds['lucia.mendoza@forcafitness.pe'],
    ]
  );

  // Asistencias QR iniciales
  await pool.query(
    `INSERT INTO asistencias_qr (usuario_id, horario_id, sede_id, instructor_id, metodo, estado_validacion) VALUES
    ($1, $2, $3, $4, 'QR', 'autorizado'),
    ($5, $6, $7, $8, 'QR', 'autorizado')`,
    [
      userIds['alumno@forcafitness.pe'], h1, sedeMap.SURCO, userIds['profesor@forcafitness.pe'],
      userIds['lucia.mendoza@forcafitness.pe'], h3, sedeMap.LA_MOLINA, userIds['carlos.vega@forcafitness.pe'],
    ]
  );

  // 8. Productos AFF Gear & Stock por Sede
  const gearRes = await pool.query(`
    INSERT INTO productos_gear (sku, nombre, categoria, disciplina, talla, precio_venta, es_parte_combo) VALUES
    ('AFF-KIM-A1', 'Kimono BJJ Oficial AFF Pearl Weave', 'Kimono BJJ', 'Brazilian Jiu-Jitsu', 'A1', 280.00, true),
    ('AFF-KIM-A2', 'Kimono BJJ Oficial AFF Pearl Weave', 'Kimono BJJ', 'Brazilian Jiu-Jitsu', 'A2', 280.00, true),
    ('AFF-KIM-A3', 'Kimono BJJ Oficial AFF Pearl Weave', 'Kimono BJJ', 'Brazilian Jiu-Jitsu', 'A3', 280.00, true),
    ('AFF-GUA-12', 'Guantes de Boxeo/Muay Thai Pro Cuero', 'Guantes', 'Boxeo', '12oz', 190.00, true),
    ('AFF-GUA-14', 'Guantes de Boxeo/Muay Thai Pro Cuero', 'Guantes', 'Muay Thai', '14oz', 195.00, true),
    ('AFF-ABA-M', 'Abadá Oficial Capoeira Forca & Fitness', 'Abadá Capoeira', 'Capoeira', 'M', 140.00, true),
    ('AFF-VEN-UN', 'Par de Vendas Elásticas 4.5m AFF', 'Accesorios', 'Boxeo', 'Única', 35.00, true),
    ('AFF-ISO-01', 'Bebida Isotónica Electrolitos 600ml', 'Bebidas/Supl.', 'General', 'Única', 8.00, false),
    ('AFF-PRO-01', 'Batido Proteína Whey Post-Entreno', 'Bebidas/Supl.', 'General', 'Única', 15.00, false)
    RETURNING id, sku
  `);
  const gearMap = {};
  for (const g of gearRes.rows) gearMap[g.sku] = g.id;

  // Sembrar stock en las 3 sedes (incluyendo stock bajo para probar alertas de reorden!)
  const stockEntries = [
    [gearMap['AFF-KIM-A1'], sedeMap.SURCO, 4, 0, 5], // bajo punto reorden!
    [gearMap['AFF-KIM-A2'], sedeMap.SURCO, 12, 1, 5],
    [gearMap['AFF-KIM-A3'], sedeMap.SURCO, 8, 0, 5],
    [gearMap['AFF-GUA-12'], sedeMap.SURCO, 9, 0, 5],
    [gearMap['AFF-GUA-14'], sedeMap.LA_MOLINA, 3, 0, 5], // bajo punto reorden!
    [gearMap['AFF-ABA-M'], sedeMap.SURCO, 7, 0, 4],
    [gearMap['AFF-VEN-UN'], sedeMap.SAN_BORJA, 18, 0, 6],
    [gearMap['AFF-ISO-01'], sedeMap.SURCO, 45, 0, 10],
    [gearMap['AFF-PRO-01'], sedeMap.SURCO, 24, 0, 8],
    [gearMap['AFF-KIM-A2'], sedeMap.LA_MOLINA, 6, 0, 5],
    [gearMap['AFF-GUA-12'], sedeMap.SAN_BORJA, 10, 0, 5],
    [gearMap['AFF-ISO-01'], sedeMap.LA_MOLINA, 30, 0, 10],
    [gearMap['AFF-ISO-01'], sedeMap.SAN_BORJA, 28, 0, 10],
  ];
  for (const s of stockEntries) {
    await pool.query(
      `INSERT INTO stock_sede (producto_id, sede_id, cantidad_disponible, cantidad_reservada, punto_reorden) VALUES ($1,$2,$3,$4,$5)`,
      s
    );
  }

  await pool.query(
    `INSERT INTO ordenes_reposicion (producto_id, sede_id, taller_proveedor, cantidad_solicitada, estado) VALUES
    ($1, $2, 'Taller Textil Lima Combat S.A.C.', 15, 'en_produccion'),
    ($3, $4, 'Guantes & Cuero Perú E.I.R.L.', 10, 'pendiente')`,
    [gearMap['AFF-KIM-A1'], sedeMap.SURCO, gearMap['AFF-GUA-14'], sedeMap.LA_MOLINA]
  );

  // 9. Pagos, Webhooks conciliados y Comprobantes UBL 2.1 SUNAT
  const pago1 = await pool.query(
    `INSERT INTO pagos (usuario_id, matricula_id, sede_id, concepto, monto, medio_pago, tipo_comprobante, estado, conciliacion_automatica, webhook_referencia, idempotency_key, fecha_pago)
     VALUES ($1, $2, $3, 'Combo AFF (Trimestral + Kimono A2)', 630.00, 'yape', 'Boleta', 'aprobado', true, 'WHK-YAPE-998123', 'seed-pago-1', NOW() - INTERVAL '10 days')
     RETURNING id`,
    [userIds['alumno@forcafitness.pe'], mat1.rows[0].id, sedeMap.SURCO]
  );
  const sub1 = +(630 / 1.18).toFixed(2);
  const igv1 = +(630 - sub1).toFixed(2);
  await pool.query(
    `INSERT INTO comprobantes_ubl (pago_id, tipo, serie_numero, subtotal, igv, total, estado_sunat, hash_sunat, xml_ubl)
     VALUES ($1, '03', 'B001-0000001', $2, $3, 630.00, 'ACEPTADO_CDR', $4, $5)`,
    [pago1.rows[0].id, sub1, igv1, sha256('B001-0000001'), buildXmlUbl('B001-0000001', '03', 'Mateo Fernández Rojas', '72345678', 'Combo AFF (Trimestral + Kimono A2)', sub1, igv1, 630.00)]
  );

  // Pago pendiente (efectivo / transferencia) para flujo de Tesorería
  await pool.query(
    `INSERT INTO pagos (usuario_id, matricula_id, sede_id, concepto, monto, medio_pago, tipo_comprobante, estado, conciliacion_automatica, idempotency_key, fecha_pago)
     VALUES
     ($1, $2, $3, 'Renovación Plan Mensual Muay Thai', 150.00, 'efectivo', 'Boleta', 'pendiente', false, 'seed-pago-2', NOW() - INTERVAL '2 hours'),
     ($4, $5, $6, 'Plan Mensual Boxeo', 150.00, 'transferencia', 'Boleta', 'pendiente', false, 'seed-pago-3', NOW() - INTERVAL '1 hour')`,
    [
      userIds['lucia.mendoza@forcafitness.pe'], mat1.rows[1].id, sedeMap.LA_MOLINA,
      userIds['diego.torres@forcafitness.pe'], mat1.rows[2].id, sedeMap.SAN_BORJA,
    ]
  );

  // 10. Equipos DVR en las 3 sedes + Incidentes + Bitácora Inmutable
  const dvrsRes = await pool.query(
    `INSERT INTO equipos_dvr (sede_id, nombre, ip_local, canales, estado_conexion, ntp_drift_ms, almacenamiento_pct) VALUES
    ($1, 'DVR Hikvision Tatami Surco', '192.168.10.250', 12, 'ONLINE', 8, 64),
    ($2, 'DVR Dahua Ring La Molina', '192.168.20.250', 8, 'ONLINE', 1420, 71),
    ($3, 'DVR Hikvision Caja/Tatami San Borja', '192.168.30.250', 8, 'ONLINE', 14, 53)
    RETURNING id, sede_id, nombre`,
    [sedeMap.SURCO, sedeMap.LA_MOLINA, sedeMap.SAN_BORJA]
  );
  const dvrSurco = dvrsRes.rows[0].id;
  const dvrMolina = dvrsRes.rows[1].id;
  const dirId = userIds['director@forcafitness.pe'];

  await pool.query(
    `INSERT INTO incidentes_seguridad (sede_id, dvr_id, tipo, descripcion, clip_referencia, hash_evidencia_sha256, reportado_por_id, estado) VALUES
    ($1, $2, 'Desfase Horario', 'Desfase NTP detectado de 1,420 ms en DVR La Molina respecto al reloj de torniquete QR.', 'rtsp://192.168.20.250/ch2/clip-1845.mp4', $3, $4, 'abierto')`,
    [sedeMap.LA_MOLINA, dvrMolina, sha256('rtsp-clip-molina-1845'), dirId]
  );

  await pool.query(
    `INSERT INTO logs_auditoria_video (dvr_id, usuario_id, accion, motivo, hash_registro) VALUES
    ($1, $2, 'SYNC_NTP', 'Sincronización automática programada cada 5 min — Drift 8ms', $3),
    ($4, $2, 'CRUCE_QR_CAJA', 'Verificación de apertura de caja POS y check-in horario 18:00', $5)`,
    [dvrSurco, dirId, sha256('log-sync-1'), dvrMolina, sha256('log-cruce-2')]
  );

  // 11. Liquidación docente inicial
  const periodoActual = new Date().toISOString().slice(0, 7);
  await pool.query(
    `INSERT INTO liquidaciones_docentes (instructor_id, periodo, clases_dictadas, horas_totales, tarifa_hora, monto_total, estado) VALUES
    ($1, $2, 24, 36.00, 85.00, 3060.00, 'calculada'),
    ($3, $2, 20, 30.00, 75.00, 2250.00, 'calculada'),
    ($4, $2, 18, 27.00, 70.00, 1890.00, 'pagada')`,
    [
      userIds['profesor@forcafitness.pe'], periodoActual,
      userIds['carlos.vega@forcafitness.pe'],
      userIds['hector.ramirez@forcafitness.pe'],
    ]
  );

  // 12. CRM Leads & Campañas
  await pool.query(`
    INSERT INTO crm_leads (nombre, whatsapp, email, sede_interes, disciplina_interes, plan_interes, canal, estado, notas) VALUES
    ('Rodrigo Alpaca', '998112233', 'rodrigo.a@gmail.com', 'Sede Surco', 'Brazilian Jiu-Jitsu', 'Combo AFF (S/630)', 'Agente IA 24/7', 'nuevo', 'Consultó tallas Kimono A2 a las 23:15 hrs'),
    ('Mariana Paredes', '997445566', 'mariana.p@hotmail.com', 'Sede La Molina', 'Muay Thai', 'Plan Trimestral (S/400)', 'Agente IA 24/7', 'contactado', 'Interesada en turno noche 18:00')
  `);

  await pool.query(`
    INSERT INTO campanas_crm (titulo, segmento, canal, destinatarios_count, estado) VALUES
    ('Renovación Anticipada 10% OFF', 'Proximos a vencer', 'WhatsApp + Email', 2, 'enviada')
  `);

  // 13. Base de conocimiento RAG para el Agente IA (CMM3)
  await pool.query(`
    INSERT INTO base_conocimiento_rag (categoria, titulo, contenido, palabras_clave) VALUES
    ('Planes y Precios', 'Tarifas Oficiales Forca & Fitness', 'Ofrecemos Plan Mensual a S/ 150.00, Plan Bimensual a S/ 280.00, Plan Trimestral a S/ 400.00, Plan Semestral Pro a S/ 720.00 y el Combo AFF a S/ 630.00 (incluye 3 meses + indumentaria oficial: Kimono BJJ o Guantes+Vendas o Abadá Capoeira).', 'precio plan mensual bimensual trimestral semestral combo aff tarifa costo'),
    ('Sedes y Horarios', 'Nuestras 3 Sedes en Lima', 'Contamos con 3 sedes: Sede Surco (Av. Caminos del Inca 1420), Sede La Molina (Av. Javier Prado Este 5890) y Sede San Borja (Av. Aviación 2945). Los turnos tienen un aforo máximo estricto de 18 alumnos por tatami para garantizar seguridad y enseñanza personalizada.', 'sede surco molina san borja direccion ubicacion aforo tatami cupo 18'),
    ('Disciplinas', 'Disciplinas Marciales y Fitness', 'Dictamos Brazilian Jiu-Jitsu (Gi y No-Gi), Muay Thai, Boxeo Clásico, Capoeira Regional (incluye programa Kids con consentimiento LPDP) y Acondicionamiento Físico Funcional.', 'disciplina bjj jiu jitsu muay thai boxeo capoeira acondicionamiento kids'),
    ('Reglamento y Congelamiento', 'Política de Congelamiento y Pagos', 'Puedes solicitar congelamiento formal de tu membresía por viaje o motivo médico desde el Portal de Alumnos. Aceptamos Yape/Plin QR con conciliación automática, tarjetas Culqi/Mercado Pago, transferencia y efectivo en recepción con boleta o factura electrónica SUNAT UBL 2.1.', 'congelar congelamiento viaje salud pago yape plin tarjeta boleta factura sunat')
  `);

  return { seeded: true, message: 'Esquema y datos iniciales sembrados correctamente.' };
}

module.exports = { initDatabase, sha256, buildXmlUbl };
