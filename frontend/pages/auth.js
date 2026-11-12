/**
 * auth.js — API Gateway Client, Control de 5 Roles C4, Navegación Dinámica y Utilidades QR
 * Forca & Fitness · Arquitectura C4 Completa
 */

function getApiBase() {
  if (window.FORCA_API_URL) return window.FORCA_API_URL.replace(/\/$/, '');
  if (location.protocol === 'file:') return 'http://localhost:3000';
  return '';
}

const API_BASE = getApiBase();

function apiHeaders(extra) {
  const token = localStorage.getItem('token') || '';
  return Object.assign(
    { 'Content-Type': 'application/json' },
    token ? { Authorization: 'Bearer ' + token } : {},
    extra || {}
  );
}

// ── ALIASES Y NORMALIZACIÓN DE LOS 5 ROLES DIRECTOS DEL DIAGRAMA ─────────────
const ROLE_ALIASES = {
  director: 'director',
  admin: 'director',
  tesorero: 'tesorero',
  tesoreria: 'tesorero',
  'tesorería': 'tesorero',
  profesor: 'profesor',
  instructor: 'profesor',
  recepcion: 'recepcionista',
  'recepción': 'recepcionista',
  recepcionista: 'recepcionista',
  alumno: 'alumno',
};

const NAV_CONFIG = {
  alumno: [
    { href: '../portal/mis-matriculas.html', label: '🏠 Inicio' },
    { href: '../portal/disciplinas.html', label: '🥋 Horarios y Cupos' },
    { href: '../portal/renovar.html', label: '🔄 Planes y Combo AFF' },
    { href: '../portal/pagos.html', label: '💳 Pagos' },
    { href: '../portal/perfil.html', label: '👤 Mi Perfil' },
  ],
  profesor: [
    { href: '../staff/index.html', label: '📱 Escáner QR & Aforo' },
    { href: '../staff/asistencia.html', label: '📋 Asistencia' },
    { href: '../staff/grados.html', label: '🥋 Grados Marciales' },
    { href: '../staff/honorarios.html', label: '💵 Mis Honorarios' },
    { href: '../portal/perfil.html', label: '👤 Mi Perfil' },
  ],
  recepcionista: [
    { href: '../pos/index.html', label: '🛒 Caja Rápida POS' },
    { href: '../pos/despacho-combo.html', label: '🎒 Despacho Combo AFF' },
    { href: '../pos/stock-sedes.html', label: '📦 Stock 3 Sedes' },
    { href: '../pos/arqueo-caja.html', label: '🧾 Arqueo Caja' },
    { href: '../portal/perfil.html', label: '👤 Mi Perfil' },
  ],
  tesorero: [
    { href: '../admin/index.html', label: '📊 Dashboard' },
    { href: '../admin/tesoreria.html', label: '💰 Tesorería & SUNAT' },
    { href: '../admin/alumnos.html', label: '👥 Alumnos' },
    { href: '../admin/inventario.html', label: '📦 Inventario AFF' },
    { href: '../portal/perfil.html', label: '👤 Mi Perfil' },
  ],
  director: [
    { href: '../admin/index.html', label: '📊 Dashboard BI' },
    { href: '../admin/alumnos.html', label: '👥 Alumnos' },
    { href: '../admin/tesoreria.html', label: '💰 Tesorería' },
    { href: '../admin/inventario.html', label: '📦 Inventario' },
    { href: '../admin/control_acceso.html', label: '🛡 Acceso' },
    { href: '../admin/seguridad-dvr.html', label: '📹 DVR' },
    { href: '../admin/crm-retencion.html', label: '🎯 CRM' },
    { href: '../portal/perfil.html', label: '👤 Perfil' },
  ],
  default: [{ href: '../portal/perfil.html', label: '👤 Mi Perfil' }],
};

function _normalizeRole(role) {
  const normalized = String(role || '').trim().toLowerCase();
  return ROLE_ALIASES[normalized] || normalized;
}

function _homeForRole(role) {
  const normalized = _normalizeRole(role);
  if (normalized === 'director' || normalized === 'tesorero') return '../admin/index.html';
  if (normalized === 'profesor') return '../staff/index.html';
  if (normalized === 'recepcionista') return '../pos/index.html';
  if (normalized === 'alumno') return '../portal/mis-matriculas.html';
  return '../auth/login.html';
}

function _getUsuario() {
  try {
    return JSON.parse(localStorage.getItem('usuario') || '{}');
  } catch (e) {
    return {};
  }
}

function _hasSession() {
  const token = localStorage.getItem('token');
  return Boolean(token && token.trim() && token !== 'undefined' && token !== 'null');
}

function requireRol(rolesPermitidos) {
  if (!_hasSession()) {
    location.href = '../auth/login.html';
    return null;
  }
  const usuario = _getUsuario();
  if (rolesPermitidos && rolesPermitidos.length > 0) {
    const rol = _normalizeRole(usuario.rol);
    const permitido = rolesPermitidos.some((r) => _normalizeRole(r) === rol);
    if (!permitido) {
      alert('No tienes permiso para acceder a esta sección.');
      location.href = _homeForRole(rol);
      return null;
    }
  }
  return usuario;
}

function initNav(activeOverride) {
  if (!document.getElementById('ff-nav-layout-style')) {
    var navCss = document.createElement('style');
    navCss.id = 'ff-nav-layout-style';
    navCss.textContent =
      'nav{gap:14px;}' +
      '.nav-logo,.nav-right{flex-shrink:0;}' +
      '.nav-links{flex:1;min-width:0;display:flex;align-items:center;gap:4px;overflow-x:auto;scrollbar-width:none;}' +
      '.nav-links::-webkit-scrollbar{display:none;}' +
      '.nav-links a{flex-shrink:0;white-space:nowrap;}' +
      '@media (max-width:1020px){nav{padding:10px 16px!important;height:auto!important;flex-wrap:wrap;}.nav-links{order:3;flex-basis:100%;width:100%;border-top:1px solid #f3f4f6;padding-top:6px;margin-top:6px;}}';
    document.head.appendChild(navCss);
  }

  const usuario = _getUsuario();
  const rolRaw = (usuario.rol || '').trim();
  const rolNorm = _normalizeRole(rolRaw);
  const links = NAV_CONFIG[rolNorm] || NAV_CONFIG.default;
  const paginaActual = location.pathname;

  const navLinksEl = document.getElementById('navLinks');
  if (navLinksEl) {
    navLinksEl.innerHTML = links
      .map(function (l) {
        var targetPath = new URL(l.href, location.href).pathname;
        var esActivo = activeOverride
          ? targetPath.endsWith('/' + activeOverride) || l.href.endsWith('/' + activeOverride)
          : paginaActual === targetPath;
        return '<a href="' + l.href + '" class="' + (esActivo ? 'active' : '') + '">' + l.label + '</a>';
      })
      .join('');
  }

  var avatarEl = document.getElementById('navAvatar');
  if (avatarEl) {
    avatarEl.style.cursor = 'pointer';
    avatarEl.title = 'Ver Mi Perfil';
    if (!avatarEl.getAttribute('onclick')) {
      avatarEl.onclick = function () {
        location.href = '../portal/perfil.html';
      };
    }
  }

  if (usuario.nombre) {
    var ini = usuario.nombre.substring(0, 2).toUpperCase();
    var nombreEl = document.getElementById('navNombre');
    var rolEl = document.getElementById('navRol');
    if (avatarEl) avatarEl.textContent = ini;
    if (nombreEl) nombreEl.textContent = usuario.nombre;
    if (rolEl) {
      rolEl.textContent =
        rolRaw + (usuario.sede ? ' · ' + usuario.sede : usuario.disciplina ? ' · ' + usuario.disciplina : '');
    }
  }

  // Cargar Widget IA 24/7 (APU5) si aún no está presente
  if (rolNorm === 'alumno' && !document.getElementById('forca-ia-widget-script') && !document.querySelector('script[src*="widget-ia.js"]')) {
    var sc = document.createElement('script');
    sc.id = 'forca-ia-widget-script';
    sc.src = '../widget-ia.js';
    document.body.appendChild(sc);
  }

  // Registrar Service Worker PWA
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  }
}

function cerrarSesion() {
  if (confirm('¿Seguro que deseas cerrar sesión?')) {
    localStorage.removeItem('token');
    localStorage.removeItem('usuario');
    location.href = '../auth/login.html';
  }
}

/**
 * Generador SVG determinístico de matriz QR (sin CDN externo)
 */
function renderQrSvg(text, size) {
  size = size || 140;
  var str = String(text || 'FORCA-QR');
  var n = 21;
  var cells = [];
  var hash = 2166136261;
  for (var i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  function isFinder(r, c) {
    return (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
  }
  function finderPixel(r, c) {
    var lr = r < 7 ? r : r - (n - 7);
    var lc = c < 7 ? c : c - (n - 7);
    if (lr === 0 || lr === 6 || lc === 0 || lc === 6) return true;
    if (lr >= 2 && lr <= 4 && lc >= 2 && lc <= 4) return true;
    return false;
  }
  var cellSize = size / n;
  var rects = '';
  for (var r = 0; r < n; r++) {
    for (var c = 0; c < n; c++) {
      var dark = false;
      if (isFinder(r, c)) {
        dark = finderPixel(r, c);
      } else if (r === 6 || c === 6) {
        dark = (r + c) % 2 === 0;
      } else {
        var seed = (hash ^ (r * 73856093) ^ (c * 19349663) ^ str.charCodeAt((r + c) % str.length)) >>> 0;
        dark = seed % 11 < 5;
      }
      if (dark) {
        rects +=
          '<rect x="' +
          (c * cellSize).toFixed(2) +
          '" y="' +
          (r * cellSize).toFixed(2) +
          '" width="' +
          (cellSize + 0.2).toFixed(2) +
          '" height="' +
          (cellSize + 0.2).toFixed(2) +
          '" fill="#0d2d5e"/>';
      }
    }
  }
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="' +
    size +
    '" height="' +
    size +
    '" viewBox="0 0 ' +
    size +
    ' ' +
    size +
    '" style="background:#fff;border-radius:8px;padding:6px;border:1px solid #e5e7eb;">' +
    rects +
    '</svg>'
  );
}

