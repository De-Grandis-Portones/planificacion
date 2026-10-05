// routes/admin/reuniones.js — agenda de reuniones entre admins, sin scope
// propio (cualquier admin logueado ve/crea/edita/borra), mismo criterio que
// /admin/tickets.
const express = require('express');
const { adminAuth } = require('../../middleware/adminAuth');
const reunionesDb = require('../../lib/reunionesDb');

const router = express.Router();

function parseHora(raw) {
  const s = String(raw || '').trim();
  return /^\d{1,2}:\d{2}$/.test(s) ? s : null;
}

function parseFecha(raw) {
  const s = String(raw || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// GET /admin/reuniones?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
router.get('/reuniones', adminAuth, async (req, res) => {
  try {
    const desde = req.query.desde ? String(req.query.desde) : undefined;
    const hasta = req.query.hasta ? String(req.query.hasta) : undefined;
    const reuniones = await reunionesDb.listReuniones({ desde, hasta });
    return res.json({ ok: true, reuniones });
  } catch (err) {
    console.error('reuniones list error:', err);
    return res.status(500).json({ error: 'Error listando reuniones', detail: err.message });
  }
});

// POST /admin/reuniones — crear
router.post('/reuniones', adminAuth, async (req, res) => {
  try {
    const titulo = String(req.body?.titulo || '').trim();
    const fecha = parseFecha(req.body?.fecha);
    const horaInicio = parseHora(req.body?.horaInicio);
    if (!titulo) return res.status(400).json({ error: 'Falta el título' });
    if (!fecha) return res.status(400).json({ error: 'Fecha inválida' });
    if (!horaInicio) return res.status(400).json({ error: 'Falta la hora de inicio' });
    const horaFinRaw = req.body?.horaFin ? parseHora(req.body.horaFin) : null;
    if (req.body?.horaFin && !horaFinRaw) return res.status(400).json({ error: 'Hora de fin inválida' });

    const reunion = await reunionesDb.createReunion({
      titulo,
      descripcion: req.body?.descripcion ? String(req.body.descripcion).trim().slice(0, 2000) : null,
      fecha,
      horaInicio,
      horaFin: horaFinRaw,
      enlace: req.body?.enlace ? String(req.body.enlace).trim().slice(0, 500) : null,
      creadoPor: req.admin?.username || null,
    });
    return res.json({ ok: true, reunion });
  } catch (err) {
    console.error('reuniones create error:', err);
    return res.status(500).json({ error: 'Error creando la reunión', detail: err.message });
  }
});

// PUT /admin/reuniones/:id — editar
router.put('/reuniones/:id', adminAuth, async (req, res) => {
  try {
    const titulo = String(req.body?.titulo || '').trim();
    const fecha = parseFecha(req.body?.fecha);
    const horaInicio = parseHora(req.body?.horaInicio);
    if (!titulo) return res.status(400).json({ error: 'Falta el título' });
    if (!fecha) return res.status(400).json({ error: 'Fecha inválida' });
    if (!horaInicio) return res.status(400).json({ error: 'Falta la hora de inicio' });
    const horaFinRaw = req.body?.horaFin ? parseHora(req.body.horaFin) : null;
    if (req.body?.horaFin && !horaFinRaw) return res.status(400).json({ error: 'Hora de fin inválida' });

    const reunion = await reunionesDb.updateReunion(req.params.id, {
      titulo,
      descripcion: req.body?.descripcion ? String(req.body.descripcion).trim().slice(0, 2000) : null,
      fecha,
      horaInicio,
      horaFin: horaFinRaw,
      enlace: req.body?.enlace ? String(req.body.enlace).trim().slice(0, 500) : null,
    });
    if (!reunion) return res.status(404).json({ error: 'Reunión no encontrada' });
    return res.json({ ok: true, reunion });
  } catch (err) {
    console.error('reuniones update error:', err);
    return res.status(500).json({ error: 'Error actualizando la reunión', detail: err.message });
  }
});

// DELETE /admin/reuniones/:id
router.delete('/reuniones/:id', adminAuth, async (req, res) => {
  try {
    const borrada = await reunionesDb.deleteReunion(req.params.id);
    if (!borrada) return res.status(404).json({ error: 'Reunión no encontrada' });
    return res.json({ ok: true });
  } catch (err) {
    console.error('reuniones delete error:', err);
    return res.status(500).json({ error: 'Error borrando la reunión', detail: err.message });
  }
});

module.exports = router;
