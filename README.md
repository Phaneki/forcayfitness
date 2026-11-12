# Forca & Fitness — Plataforma Centralizada (C4 + Render PostgreSQL)

Sistema integral de gestión para **Forca & Fitness S.A.C.** (3 sedes en Lima: **Sede Surco**, **Sede La Molina** y **Sede San Borja**), implementado en **Node.js + Express + PostgreSQL (Render)** respetando los diagramas C4 (Contexto, Contenedores, Componentes y Vistas UI `APU1..APU5`, `APP1..APP4`, `CMM1..CMM3`, Event Bus y Servidor MCP).

---

## Arquitectura Implementada

### 5 Aplicaciones Frontend (`frontend/`)
- **`APU1` Portal Web Autoservicio (`/pages/portal/`)**:
  - `mis-matriculas.html`: Resumen de membresía, reservas próximas, carnet QR digital y solicitud formal de congelamiento.
  - `disciplinas.html`: Horarios en vivo de las 3 sedes con control estricto máximo **18 cupos/tatami**, reserva atómica y unión a lista de espera.
  - `renovar.html`: Planes oficiales (`Mensual S/150`, `Bimensual S/280`, `Trimestral S/400`, `Semestral S/720`, `Combo AFF S/630` con selección de talla).
  - `pagos.html` y `comprobante.html`: Checkout con Yape/Plin QR, Tarjeta Culqi/Mercado Pago, Transferencia y Efectivo; emisión **SUNAT UBL 2.1** (Boleta `B001` / Factura `F001`), descarga de XML y QR fiscal.
  - `perfil.html` y `editar-perfil.html`: Customer 360, Carnet QR, historial de grados marciales, Ficha Médica Deportiva y consentimiento **LPDP (Ley N° 29733)** para menores.
- **`APU2` WebApp Staff PWA (`/pages/staff/` + `manifest.json` + `sw.js`)**:
  - `index.html`: Escáner QR en tatami, monitoreo en vivo de aforo (`X/18`), soporte cámara WebRTC y cola offline local con sincronización por lotes.
  - `asistencia.html`: Lista de asistencia de clase, alertas de mora/membresía vencida y check-in manual.
  - `grados.html`: Evaluación técnica y registro de ascensos de grados/cinturones marciales.
  - `honorarios.html`: Turnos asignados por sede y liquidación de honorarios docentes.
- **`APU3` Terminal POS Recepción (`/pages/pos/`)**:
  - `index.html`: Caja rápida multi-sede con atajos de teclado (`F1` Efectivo, `F2` Yape/Plin, `F3` Tarjeta, `F4` Nuevo Alumno LPDP), catálogo de planes + vitrina AFF Gear y vista previa de ticket térmico 80mm.
  - `despacho-combo.html`: Entrega presencial de kits **Combo AFF** con descuento automático en Kárdex.
  - `stock-sedes.html`: Consulta en tiempo real de stock por talla y sede con alertas de reorden.
  - `arqueo-caja.html`: Cuadre y cierre de caja diario comparando efectivo, Yape/Plin y lotes POS contra el sistema.
- **`APU4` Backoffice Administrativo & BI (`/pages/admin/`)**:
  - `index.html`: Dashboard ejecutivo (Ingresos, Ticket Promedio, LTV, Churn %, Ocupación de Tatamis %, Rentabilidad/m² por sede y Event Bus).
  - `alumnos.html`: Directorio Customer 360, alta presencial con validación LPDP y aprobación/rechazo de congelamientos.
  - `tesoreria.html`: Conciliación de pagos pendientes, comprobantes SUNAT UBL 2.1 + descarga XML, y pago de planilla docente.
  - `inventario.html`: Control Kárdex AFF Gear y órdenes de reposición a talleres textiles.
  - `control_acceso.html`: Control de acceso físico y torniquetes QR (habilitar/bloquear) + bitácora de ingresos.
  - `seguridad-dvr.html`: Estado de DVR de las 3 sedes, sincronización NTP en 1 clic, incidentes con evidencia **SHA-256** y bitácora inmutable append-only.
  - `crm-retencion.html`: Cohorte en riesgo de abandono (Churn), leads captados 24/7 por el Agente IA/MCP y campañas omnicanal.
- **`APU5` Web Chat Asistente IA 24/7 (`/pages/widget-ia.js`)**:
  - Widget flotante presente en toda la aplicación conectado a RAG + MCP (`/api/ia/chat`, `/api/ia/leads`, `/api/mcp`).

### 7 Módulos Backend (`backend/src/modules/`) + API Gateway + PostgreSQL
1. `identidad` (`APP1`): Auth JWT SSO, 5 roles, Customer 360, grados marciales, LPDP menores Ley N° 29733.
2. `matriculas` (`APP2`): Reserva atómica con `FOR UPDATE` (máx. 18 cupos/tatami), promoción automática de lista de espera, asistencia QR + sync offline y congelamientos.
3. `inventario` (`APP3`): Stock por sede/talla, despacho Combo AFF, Kárdex y órdenes a taller.
4. `seguridad` (`APP4`): DVR multi-sede, NTP sync, incidentes SHA-256 y bitácora append-only.
5. `tesoreria` (`CMM1`): Webhook/conciliación automática Yape/Plin y tarjetas, UBL 2.1 XML+CDR, arqueos de caja y planilla docente.
6. `analitica` (`CMM2`): KPIs BI, rentabilidad por m², riesgo Churn, CRM leads y campañas.
7. `agente` (`CMM3` + `MCP Server`): Motor RAG + herramientas MCP JSON-RPC (`consultar_aforo`, `consultar_stock_gear`, `validar_identidad`, `reservar_cupo`).

---

## Credenciales Demo (Semilla Idempotente)

Todas las cuentas de prueba utilizan la contraseña **`Forca2025!`**:

| Rol | Correo | Detalles |
|---|---|---|
| **Director** | `director@forcafitness.pe` | 2FA PIN opcional: `123456` |
| **Tesorero** | `tesorero@forcafitness.pe` | Conciliación SUNAT y Planilla |
| **Profesor** | `profesor@forcafitness.pe` | Staff PWA Tatami (`Sede Surco`) |
| **Recepcionista** | `recepcion@forcafitness.pe` | Terminal POS y Despacho Combo |
| **Alumno (Activo)** | `alumno@forcafitness.pe` | QR: `QR-ALU-0001` |
| **Alumno (Vencido)** | `diego.torres@forcafitness.pe` | Ideal para probar bloqueo y renovación |
| **Alumno (Menor LPDP)** | `sofia.castro@forcafitness.pe` | Con consentimiento firmado |

---

## Ejecución Local

1. Instalar dependencias:
   ```bash
   npm install
   ```
2. Copiar `.env.example` a `.env` y configurar `DATABASE_URL` con tu PostgreSQL local o External Database URL de Render:
   ```bash
   cp .env.example .env
   ```
3. Inicializar esquema y datos semilla (opcional, también se ejecuta automáticamente al iniciar el servidor):
   ```bash
   npm run db:init
   ```
4. Iniciar servidor:
   ```bash
   npm start
   ```
5. Ejecutar suite de pruebas automatizadas:
   ```bash
   npm test
   ```

---

## Despliegue en Render + PostgreSQL de Render

El proyecto está listo para desplegarse como **monolito modular unificado** (API Gateway + Frontend estático en un mismo Web Service conectado a Render PostgreSQL).

### Opción A: Despliegue Automático con Blueprint (`render.yaml`) — Recomendado
1. Sube este repositorio a GitHub.
2. En el panel de **Render** (<https://dashboard.render.com>), haz clic en **New + → Blueprint**.
3. Conecta tu repositorio de GitHub (`forcayfitness`).
4. Render leerá automáticamente [`render.yaml`](render.yaml) y provisionará:
   - Base de datos PostgreSQL **`forca-fitness-db`** (`databaseName: forca_fitness`, `user: forca_user`, `plan: free`).
   - Web Service Node.js **`forca-fitness-app`** (`buildCommand: npm install`, `startCommand: npm start`, `healthCheckPath: /api/health`).
   - Variables de entorno automáticas: `NODE_ENV=production`, `JWT_SECRET` autogenerado y `DATABASE_URL` enlazada desde `forca-fitness-db`.
5. Espera a que finalice el deploy: al arrancar `backend/src/server.js`, se crea el esquema (`database/schema.sql`) y la semilla inicial si la base está vacía.

### Opción B: Configuración Manual en Render
1. **Crear Base de Datos PostgreSQL**:
   - **New + → PostgreSQL** (`Name: forca-fitness-db`, `Database: forca_fitness`, región recomendada igual a tu Web Service).
   - Copia el valor **Internal Database URL** (si ambos servicios están en la misma cuenta/región de Render) o **External Database URL**.
2. **Crear Web Service**:
   - **New + → Web Service** apuntando al repositorio.
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Health Check Path**: `/api/health`
3. **Variables de Entorno en Render (Environment)**:
   - `NODE_ENV` = `production`
   - `DATABASE_URL` = *(pegar la Internal/External Database URL de Render PostgreSQL)*
   - `JWT_SECRET` = *(cadena aleatoria segura de 32+ caracteres)*
   - *(Opcional)* `DATABASE_SSL` = `true` (el archivo `backend/src/db/pool.js` detecta SSL automáticamente para `*.render.com` y cuenta con reintento automático si la conexión interna no requiere SSL).
   - *(Opcional)* `OPENAI_API_KEY` o `GEMINI_API_KEY` si deseas enriquecer el Agente IA fuera del motor local RAG + MCP.
4. Una vez desplegado, entra a tu URL de Render (por ejemplo `https://forca-fitness-app.onrender.com`) y verifica `/api/health`.
