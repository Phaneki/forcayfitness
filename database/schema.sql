-- Esquema PostgreSQL completo — Plataforma Forca & Fitness
-- Abarca los 7 dominios del Modelo C4:
-- APP1 Identidad/LPDP | APP2 Matrículas/Aforos (Core) | APP3 Inventario AFF Gear
-- APP4 Seguridad DVR  | CMM1 Tesorería/SUNAT         | CMM2 Analítica/CRM
-- CMM3 Agente IA/MCP  | INT2 Bus de Eventos de Dominio

CREATE TABLE IF NOT EXISTS sedes (
  id SERIAL PRIMARY KEY,
  codigo VARCHAR(30) UNIQUE NOT NULL,
  nombre VARCHAR(120) NOT NULL,
  direccion VARCHAR(220) NOT NULL,
  area_tatami_m2 NUMERIC(8,2) NOT NULL DEFAULT 180.00,
  telefono VARCHAR(30),
  activa BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS usuarios (
  id SERIAL PRIMARY KEY,
  nombre VARCHAR(120) NOT NULL,
  apellido_paterno VARCHAR(80) DEFAULT '',
  apellido_materno VARCHAR(80) DEFAULT '',
  dni VARCHAR(20) UNIQUE,
  email VARCHAR(150) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  rol VARCHAR(40) NOT NULL DEFAULT 'Alumno',
  sede_id INT REFERENCES sedes(id),
  disciplina VARCHAR(80) DEFAULT 'Brazilian Jiu-Jitsu',
  telefono VARCHAR(30) DEFAULT '',
  direccion VARCHAR(220) DEFAULT '',
  fecha_nacimiento DATE,
  genero VARCHAR(30) DEFAULT '',
  es_menor BOOLEAN NOT NULL DEFAULT FALSE,
  grado_actual VARCHAR(100) DEFAULT 'Cinturón Blanco',
  acceso_habilitado BOOLEAN NOT NULL DEFAULT TRUE,
  mfa_habilitado BOOLEAN NOT NULL DEFAULT FALSE,
  mfa_pin VARCHAR(20),
  qr_token VARCHAR(120) UNIQUE,
  ficha_medica JSONB NOT NULL DEFAULT '{}'::jsonb,
  tarifa_hora NUMERIC(10,2) NOT NULL DEFAULT 65.00,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS consentimientos_lpdp (
  id SERIAL PRIMARY KEY,
  usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  apoderado_nombre VARCHAR(150) NOT NULL,
  apoderado_dni VARCHAR(20) NOT NULL,
  parentesco VARCHAR(50) NOT NULL DEFAULT 'Padre/Madre',
  telefono_apoderado VARCHAR(30),
  acepta_tratamiento_datos BOOLEAN NOT NULL DEFAULT TRUE,
  firma_hash_sha256 VARCHAR(64) NOT NULL,
  ip_registro VARCHAR(60),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS grados_marciales (
  id SERIAL PRIMARY KEY,
  usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  disciplina VARCHAR(80) NOT NULL,
  grado VARCHAR(100) NOT NULL,
  instructor_id INT REFERENCES usuarios(id),
  observaciones TEXT DEFAULT '',
  fecha_otorgamiento DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS planes (
  id SERIAL PRIMARY KEY,
  codigo VARCHAR(40) UNIQUE NOT NULL,
  nombre VARCHAR(120) NOT NULL,
  duracion_meses INT NOT NULL,
  precio NUMERIC(10,2) NOT NULL,
  incluye_combo_gear BOOLEAN NOT NULL DEFAULT FALSE,
  descripcion TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS matriculas (
  id SERIAL PRIMARY KEY,
  usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  plan_id INT REFERENCES planes(id),
  sede_id INT REFERENCES sedes(id),
  disciplina VARCHAR(80) NOT NULL,
  fecha_inicio DATE NOT NULL,
  fecha_fin DATE NOT NULL,
  estado VARCHAR(30) NOT NULL DEFAULT 'activa',
  es_combo_aff BOOLEAN NOT NULL DEFAULT FALSE,
  talla_combo VARCHAR(20),
  combo_despachado BOOLEAN NOT NULL DEFAULT FALSE,
  precio_congelado NUMERIC(10,2),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS horarios_tatami (
  id SERIAL PRIMARY KEY,
  sede_id INT NOT NULL REFERENCES sedes(id),
  disciplina VARCHAR(80) NOT NULL,
  titulo VARCHAR(150) NOT NULL,
  descripcion TEXT NOT NULL DEFAULT '',
  dias_bloque VARCHAR(50) NOT NULL,
  hora_inicio VARCHAR(15) NOT NULL,
  hora_fin VARCHAR(15) NOT NULL,
  espacio VARCHAR(100) NOT NULL,
  instructor_id INT REFERENCES usuarios(id),
  aforo_maximo INT NOT NULL DEFAULT 18 CHECK (aforo_maximo > 0 AND aforo_maximo <= 18),
  version INT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS reservas_cupo (
  id SERIAL PRIMARY KEY,
  horario_id INT NOT NULL REFERENCES horarios_tatami(id) ON DELETE CASCADE,
  usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  fecha_clase DATE NOT NULL DEFAULT CURRENT_DATE,
  estado VARCHAR(30) NOT NULL DEFAULT 'confirmada',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS asistencias_qr (
  id SERIAL PRIMARY KEY,
  usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  horario_id INT REFERENCES horarios_tatami(id),
  sede_id INT REFERENCES sedes(id),
  instructor_id INT REFERENCES usuarios(id),
  metodo VARCHAR(30) NOT NULL DEFAULT 'QR',
  estado_validacion VARCHAR(40) NOT NULL DEFAULT 'autorizado',
  sincronizado_offline BOOLEAN NOT NULL DEFAULT FALSE,
  fecha_hora TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS congelamientos (
  id SERIAL PRIMARY KEY,
  matricula_id INT NOT NULL REFERENCES matriculas(id) ON DELETE CASCADE,
  usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  motivo VARCHAR(50) NOT NULL,
  detalle TEXT DEFAULT '',
  dias_solicitados INT NOT NULL,
  fecha_inicio DATE NOT NULL,
  fecha_fin DATE NOT NULL,
  estado VARCHAR(20) NOT NULL DEFAULT 'pendiente',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS productos_gear (
  id SERIAL PRIMARY KEY,
  sku VARCHAR(50) UNIQUE NOT NULL,
  nombre VARCHAR(150) NOT NULL,
  categoria VARCHAR(60) NOT NULL,
  disciplina VARCHAR(80) NOT NULL,
  talla VARCHAR(20) NOT NULL,
  precio_venta NUMERIC(10,2) NOT NULL,
  es_parte_combo BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS stock_sede (
  id SERIAL PRIMARY KEY,
  producto_id INT NOT NULL REFERENCES productos_gear(id) ON DELETE CASCADE,
  sede_id INT NOT NULL REFERENCES sedes(id) ON DELETE CASCADE,
  cantidad_disponible INT NOT NULL DEFAULT 0,
  cantidad_reservada INT NOT NULL DEFAULT 0,
  punto_reorden INT NOT NULL DEFAULT 5,
  UNIQUE (producto_id, sede_id)
);

CREATE TABLE IF NOT EXISTS kardex_movimientos (
  id SERIAL PRIMARY KEY,
  producto_id INT NOT NULL REFERENCES productos_gear(id) ON DELETE CASCADE,
  sede_id INT NOT NULL REFERENCES sedes(id) ON DELETE CASCADE,
  tipo VARCHAR(40) NOT NULL,
  cantidad INT NOT NULL,
  referencia VARCHAR(180) DEFAULT '',
  usuario_responsable_id INT REFERENCES usuarios(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ordenes_reposicion (
  id SERIAL PRIMARY KEY,
  producto_id INT NOT NULL REFERENCES productos_gear(id) ON DELETE CASCADE,
  sede_id INT NOT NULL REFERENCES sedes(id) ON DELETE CASCADE,
  taller_proveedor VARCHAR(150) NOT NULL,
  cantidad_solicitada INT NOT NULL,
  estado VARCHAR(30) NOT NULL DEFAULT 'pendiente',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pagos (
  id SERIAL PRIMARY KEY,
  usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  matricula_id INT REFERENCES matriculas(id),
  sede_id INT REFERENCES sedes(id),
  concepto VARCHAR(180) NOT NULL,
  monto NUMERIC(10,2) NOT NULL,
  medio_pago VARCHAR(40) NOT NULL,
  tipo_comprobante VARCHAR(20) NOT NULL DEFAULT 'Boleta',
  ruc_cliente VARCHAR(20),
  razon_social_cliente VARCHAR(180),
  estado VARCHAR(30) NOT NULL DEFAULT 'pendiente',
  conciliacion_automatica BOOLEAN NOT NULL DEFAULT FALSE,
  webhook_referencia VARCHAR(120),
  idempotency_key VARCHAR(120) UNIQUE,
  items_pos JSONB NOT NULL DEFAULT '[]'::jsonb,
  fecha_pago TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS comprobantes_ubl (
  id SERIAL PRIMARY KEY,
  pago_id INT NOT NULL REFERENCES pagos(id) ON DELETE CASCADE,
  tipo VARCHAR(10) NOT NULL DEFAULT '03',
  serie_numero VARCHAR(40) UNIQUE NOT NULL,
  subtotal NUMERIC(10,2) NOT NULL,
  igv NUMERIC(10,2) NOT NULL,
  total NUMERIC(10,2) NOT NULL,
  estado_sunat VARCHAR(30) NOT NULL DEFAULT 'ACEPTADO_CDR',
  cdr_codigo VARCHAR(10) NOT NULL DEFAULT '0',
  cdr_mensaje VARCHAR(200) NOT NULL DEFAULT 'La Factura/Boleta ha sido aceptada por SUNAT/OSE',
  hash_sunat VARCHAR(64) NOT NULL,
  xml_ubl TEXT NOT NULL,
  enviado_email BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS arqueos_caja (
  id SERIAL PRIMARY KEY,
  sede_id INT NOT NULL REFERENCES sedes(id),
  cajero_id INT REFERENCES usuarios(id),
  fecha_turno DATE NOT NULL DEFAULT CURRENT_DATE,
  monto_apertura NUMERIC(10,2) NOT NULL DEFAULT 200.00,
  total_efectivo NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_yape_plin NUMERIC(10,2) NOT NULL DEFAULT 0,
  total_tarjeta NUMERIC(10,2) NOT NULL DEFAULT 0,
  diferencia NUMERIC(10,2) NOT NULL DEFAULT 0,
  estado VARCHAR(20) NOT NULL DEFAULT 'cerrada',
  observaciones TEXT DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS liquidaciones_docentes (
  id SERIAL PRIMARY KEY,
  instructor_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  periodo VARCHAR(20) NOT NULL,
  clases_dictadas INT NOT NULL DEFAULT 0,
  horas_totales NUMERIC(8,2) NOT NULL DEFAULT 0,
  tarifa_hora NUMERIC(10,2) NOT NULL DEFAULT 65.00,
  monto_total NUMERIC(10,2) NOT NULL DEFAULT 0,
  estado VARCHAR(20) NOT NULL DEFAULT 'calculada',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS equipos_dvr (
  id SERIAL PRIMARY KEY,
  sede_id INT NOT NULL REFERENCES sedes(id),
  nombre VARCHAR(120) NOT NULL,
  ip_local VARCHAR(50) NOT NULL,
  canales INT NOT NULL DEFAULT 8,
  estado_conexion VARCHAR(20) NOT NULL DEFAULT 'ONLINE',
  ntp_drift_ms INT NOT NULL DEFAULT 12,
  ultima_sync_ntp TIMESTAMP NOT NULL DEFAULT NOW(),
  almacenamiento_pct INT NOT NULL DEFAULT 62
);

CREATE TABLE IF NOT EXISTS incidentes_seguridad (
  id SERIAL PRIMARY KEY,
  sede_id INT NOT NULL REFERENCES sedes(id),
  dvr_id INT REFERENCES equipos_dvr(id),
  tipo VARCHAR(80) NOT NULL,
  descripcion TEXT NOT NULL,
  timestamp_evento TIMESTAMP NOT NULL DEFAULT NOW(),
  clip_referencia VARCHAR(180) NOT NULL,
  hash_evidencia_sha256 VARCHAR(64) NOT NULL,
  reportado_por_id INT REFERENCES usuarios(id),
  estado VARCHAR(20) NOT NULL DEFAULT 'abierto',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS logs_auditoria_video (
  id SERIAL PRIMARY KEY,
  dvr_id INT REFERENCES equipos_dvr(id),
  usuario_id INT REFERENCES usuarios(id),
  accion VARCHAR(60) NOT NULL,
  motivo TEXT NOT NULL,
  hash_registro VARCHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS crm_leads (
  id SERIAL PRIMARY KEY,
  nombre VARCHAR(120) NOT NULL,
  whatsapp VARCHAR(40) NOT NULL,
  email VARCHAR(150) DEFAULT '',
  sede_interes VARCHAR(80) NOT NULL,
  disciplina_interes VARCHAR(80) NOT NULL,
  plan_interes VARCHAR(80) DEFAULT 'Por definir',
  canal VARCHAR(50) NOT NULL DEFAULT 'Agente IA 24/7',
  estado VARCHAR(30) NOT NULL DEFAULT 'nuevo',
  notas TEXT DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS campanas_crm (
  id SERIAL PRIMARY KEY,
  titulo VARCHAR(150) NOT NULL,
  segmento VARCHAR(80) NOT NULL,
  canal VARCHAR(50) NOT NULL DEFAULT 'WhatsApp + Email',
  destinatarios_count INT NOT NULL DEFAULT 0,
  estado VARCHAR(30) NOT NULL DEFAULT 'enviada',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS base_conocimiento_rag (
  id SERIAL PRIMARY KEY,
  categoria VARCHAR(60) NOT NULL,
  titulo VARCHAR(150) NOT NULL,
  contenido TEXT NOT NULL,
  palabras_clave TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sesiones_chat_ia (
  id SERIAL PRIMARY KEY,
  session_key VARCHAR(120) UNIQUE NOT NULL,
  usuario_id INT REFERENCES usuarios(id),
  mensajes JSONB NOT NULL DEFAULT '[]'::jsonb,
  mcp_tools_usadas JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS eventos_dominio (
  id SERIAL PRIMARY KEY,
  topico VARCHAR(100) NOT NULL,
  payload JSONB NOT NULL,
  origen VARCHAR(60) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

