// routes/admin/portonesInstalados.js
//
// Padrón de portones instalados en clientes finales (dirección + Google Maps,
// NV y tipo de portón). Solo lectura: ver lib/portonesInstaladosDb.js.
const express = require('express');
const { adminAuth } = require('../../middleware/adminAuth');
const { listPortonesInstalados } = require('../../lib/portonesInstaladosDb');

const router = express.Router();

// Quienes ya ven estos mismos datos (cliente, dirección, características) en
// Preproducción, más Servicio Técnico y Programadores. Mismo listado que
// muestra el acceso en el Índice (pages/IndexPage.jsx) - mantenerlos iguales.
const PORTONES_INSTALADOS_SCOPES = [
  'preproduccion:full',
  'preproduccion:admin',
  'preproduccion:comercial_view',
  'qc:admin',
  'workflow:admin',
  'servicio_tecnico:admin',
  'programadores:admin',
];

function normalizeScopes(scopesRaw) {
  if (Array.isArray(scopesRaw)) return scopesRaw.map((s) => String(s || '').trim()).filter(Boolean);
  if (typeof scopesRaw === 'string') return scopesRaw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  return [];
}

function requirePortonesInstaladosAccess(req, res, next) {
  const scopes = normalizeScopes(req?.admin?.scopes ?? req?.admin?.scope ?? req?.admin?.permissions ?? []);
  if (!PORTONES_INSTALADOS_SCOPES.some((s) => scopes.includes(s))) {
    return res.status(403).json({ error: 'No tenés permiso para ver los portones instalados' });
  }
  return next();
}

// Con path (no router.use global), mismo motivo que insumos.js/users.js: no
// pisar otros routers admin montados en la misma base /admin.
router.get('/portones-instalados', adminAuth, requirePortonesInstaladosAccess, async (_req, res) => {
  try {
    const portones = await listPortonesInstalados();
    res.json({ ok: true, portones, generado_at: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: 'Error leyendo portones instalados', detail: err.message });
  }
});

module.exports = router;
