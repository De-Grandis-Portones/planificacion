const express = require('express');
const router = express.Router();

const { adminAuth } = require('../../middleware/adminAuth');
const notasNodoDb = require('../../notasNodoDb');
const testUsersNodoDb = require('../../testUsersNodoDb');

// GET /admin/notas-nodo/:nodoId
router.get('/notas-nodo/:nodoId', adminAuth, async (req, res) => {
  try {
    const nota = await notasNodoDb.getNota(req.params.nodoId);
    return res.json(nota);
  } catch (err) {
    console.error('admin get notas-nodo error:', err);
    return res.status(500).json({ error: 'Error leyendo la nota', detail: err.message });
  }
});

// PUT /admin/notas-nodo/:nodoId  body: { nota, admin_user, admin_password, link, env_vars, info_programacion }
router.put('/notas-nodo/:nodoId', adminAuth, async (req, res) => {
  try {
    const { nota, admin_user, admin_password, link, env_vars, info_programacion } = req.body || {};
    const saved = await notasNodoDb.setNota(
      req.params.nodoId,
      { nota, adminUser: admin_user, adminPassword: admin_password, link, envVars: env_vars, infoProgramacion: info_programacion },
      req.admin?.username
    );
    return res.json(saved);
  } catch (err) {
    console.error('admin put notas-nodo error:', err);
    return res.status(500).json({ error: 'Error guardando la nota', detail: err.message });
  }
});

// GET /admin/notas-nodo/:nodoId/entradas — lista de "¿qué se está trabajando
// acá?" por admin (una fila por autor, ver notasNodoDb.js).
router.get('/notas-nodo/:nodoId/entradas', adminAuth, async (req, res) => {
  try {
    const entradas = await notasNodoDb.listNotaEntradas(req.params.nodoId);
    return res.json({ entradas });
  } catch (err) {
    console.error('admin get notas-nodo entradas error:', err);
    return res.status(500).json({ error: 'Error leyendo las entradas', detail: err.message });
  }
});

// PUT /admin/notas-nodo/:nodoId/entradas  body: { texto }
// El autor SIEMPRE es el admin logueado (req.admin.username) — nunca viene
// del body, así nadie puede escribir o borrar la entrada de otro.
router.put('/notas-nodo/:nodoId/entradas', adminAuth, async (req, res) => {
  try {
    const autor = req.admin?.username;
    if (!autor) return res.status(401).json({ error: 'No autorizado' });
    const texto = String(req.body?.texto || '');
    const entrada = await notasNodoDb.upsertNotaEntrada(req.params.nodoId, autor, texto);
    return res.json({ ok: true, entrada });
  } catch (err) {
    console.error('admin put notas-nodo entrada error:', err);
    return res.status(500).json({ error: 'Error guardando la entrada', detail: err.message });
  }
});

// DELETE /admin/notas-nodo/:nodoId/entradas — borra SOLO la entrada propia.
router.delete('/notas-nodo/:nodoId/entradas', adminAuth, async (req, res) => {
  try {
    const autor = req.admin?.username;
    if (!autor) return res.status(401).json({ error: 'No autorizado' });
    await notasNodoDb.deleteNotaEntrada(req.params.nodoId, autor);
    return res.json({ ok: true });
  } catch (err) {
    console.error('admin delete notas-nodo entrada error:', err);
    return res.status(500).json({ error: 'Error borrando la entrada', detail: err.message });
  }
});

// GET /admin/notas-nodo/:nodoId/usuarios-prueba
router.get('/notas-nodo/:nodoId/usuarios-prueba', adminAuth, async (req, res) => {
  try {
    const usuarios = await testUsersNodoDb.listTestUsers(req.params.nodoId);
    return res.json({ usuarios });
  } catch (err) {
    console.error('admin get usuarios-prueba error:', err);
    return res.status(500).json({ error: 'Error leyendo los usuarios de prueba', detail: err.message });
  }
});

// POST /admin/notas-nodo/:nodoId/usuarios-prueba  body: { etiqueta, usuario, password }
router.post('/notas-nodo/:nodoId/usuarios-prueba', adminAuth, async (req, res) => {
  try {
    const { etiqueta, usuario, password } = req.body || {};
    if (!String(usuario || '').trim() || !String(password || '').trim()) {
      return res.status(400).json({ error: 'Usuario y contraseña son obligatorios' });
    }
    const creado = await testUsersNodoDb.addTestUser(
      req.params.nodoId,
      { etiqueta, usuario, password },
      req.admin?.username
    );
    return res.json(creado);
  } catch (err) {
    console.error('admin post usuarios-prueba error:', err);
    return res.status(500).json({ error: 'Error guardando el usuario de prueba', detail: err.message });
  }
});

// DELETE /admin/notas-nodo/:nodoId/usuarios-prueba/:id
router.delete('/notas-nodo/:nodoId/usuarios-prueba/:id', adminAuth, async (req, res) => {
  try {
    await testUsersNodoDb.deleteTestUser(req.params.nodoId, req.params.id);
    return res.json({ ok: true });
  } catch (err) {
    console.error('admin delete usuarios-prueba error:', err);
    return res.status(500).json({ error: 'Error borrando el usuario de prueba', detail: err.message });
  }
});

module.exports = router;
