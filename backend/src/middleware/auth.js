const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'forca_fitness_dev_jwt_secret_2026';

const ROLE_ALIASES = {
  admin: 'Director',
  director: 'Director',
  tesorero: 'Tesorero',
  tesoreria: 'Tesorero',
  'tesorería': 'Tesorero',
  profesor: 'Profesor',
  instructor: 'Profesor',
  recepcion: 'Recepcionista',
  'recepción': 'Recepcionista',
  recepcionista: 'Recepcionista',
  alumno: 'Alumno',
};

function normalizeRole(role) {
  const key = String(role || '').trim().toLowerCase();
  return ROLE_ALIASES[key] || role || 'Alumno';
}

function signToken(usuario) {
  const rolCanonic = normalizeRole(usuario.rol);
  return jwt.sign(
    {
      id: usuario.id,
      email: usuario.email,
      nombre: usuario.nombre,
      rol: rolCanonic,
      sede_id: usuario.sede_id || null,
    },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
}

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  if (!token) {
    return res.status(401).json({ error: 'Token de sesión requerido.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    decoded.rol = normalizeRole(decoded.rol);
    req.user = decoded;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Sesión expirada o token inválido.' });
  }
}

function optionalAuth(req, _res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      decoded.rol = normalizeRole(decoded.rol);
      req.user = decoded;
    } catch (_) {}
  }
  next();
}

function requireRole(allowedRoles = []) {
  const normalizedAllowed = allowedRoles.map(normalizeRole);
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'No autenticado.' });
    }
    if (normalizedAllowed.length === 0) return next();
    const userRole = normalizeRole(req.user.rol);
    if (!normalizedAllowed.includes(userRole)) {
      return res.status(403).json({
        error: `Acceso denegado para rol ${userRole}. Se requiere: ${normalizedAllowed.join(', ')}`,
      });
    }
    return next();
  };
}

module.exports = {
  JWT_SECRET,
  normalizeRole,
  signToken,
  requireAuth,
  optionalAuth,
  requireRole,
};

