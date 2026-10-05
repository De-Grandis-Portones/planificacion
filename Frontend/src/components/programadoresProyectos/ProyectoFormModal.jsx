// src/components/programadoresProyectos/ProyectoFormModal.jsx — alta y
// edición de un proyecto: nombre, descripción, estado, encargado e
// integrantes. El encargado siempre queda como integrante (el backend
// también lo asegura). Se puede elegir a quien tenga acceso a la sección
// Programadores; en una edición, además, a quien ya estaba en el proyecto.
import { useMemo, useState } from 'react';
import { crearProyectoProgramadores, actualizarProyectoProgramadores } from '../../api';
import { getCurrentAdminUsername } from '../../utils/adminScopes';
import UserAvatar from '../UserAvatar';
import { ESTADOS, ORDEN_ESTADOS, nombreDe } from './proyectosComun';

export default function ProyectoFormModal({ proyecto, usuarios, onClose, onGuardado }) {
  const yo = useMemo(() => getCurrentAdminUsername() || '', []);
  const esEdicion = !!proyecto;

  // Elegibles: los del permiso + los que ya están en el proyecto.
  const opciones = useMemo(() => {
    const porUsername = new Map();
    for (const u of usuarios || []) porUsername.set(u.username, { username: u.username, name: u.name || null });
    for (const u of proyecto?.integrantes || []) if (!porUsername.has(u.username)) porUsername.set(u.username, u);
    return [...porUsername.values()].sort((a, b) => nombreDe(a).localeCompare(nombreDe(b), 'es', { sensitivity: 'base' }));
  }, [usuarios, proyecto]);

  const [form, setForm] = useState(() => {
    if (proyecto) {
      return {
        nombre: proyecto.nombre || '',
        descripcion: proyecto.descripcion || '',
        estado: proyecto.estado || 'en_curso',
        encargado: proyecto.encargado?.username || '',
        integrantes: (proyecto.integrantes || []).map((u) => u.username),
      };
    }
    const soyElegible = (usuarios || []).some((u) => u.username === yo);
    return {
      nombre: '',
      descripcion: '',
      estado: 'en_curso',
      encargado: soyElegible ? yo : '',
      integrantes: soyElegible ? [yo] : [],
    };
  });
  const [guardando, setGuardando] = useState(false);
  const [err, setErr] = useState('');

  const set = (campo, valor) => setForm((f) => ({ ...f, [campo]: valor }));

  function elegirEncargado(username) {
    setForm((f) => ({
      ...f,
      encargado: username,
      integrantes: username && !f.integrantes.includes(username) ? [...f.integrantes, username] : f.integrantes,
    }));
  }

  function alternarIntegrante(username) {
    if (username === form.encargado) return; // el encargado no se puede sacar
    setForm((f) => ({
      ...f,
      integrantes: f.integrantes.includes(username) ? f.integrantes.filter((u) => u !== username) : [...f.integrantes, username],
    }));
  }

  async function guardar() {
    if (!form.nombre.trim()) { setErr('Falta el nombre del proyecto.'); return; }
    if (!form.encargado) { setErr('Elegí quién es el encargado.'); return; }
    setGuardando(true);
    setErr('');
    const payload = {
      nombre: form.nombre.trim(),
      descripcion: form.descripcion.trim(),
      estado: form.estado,
      encargado: form.encargado,
      integrantes: form.integrantes,
    };
    try {
      const { data } = esEdicion
        ? await actualizarProyectoProgramadores(proyecto.id, payload)
        : await crearProyectoProgramadores(payload);
      onGuardado(data.proyecto);
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
      setGuardando(false);
    }
  }

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ width: 'min(560px, 100%)', maxHeight: '92vh', overflowY: 'auto', background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)', boxShadow: '0 12px 32px rgba(0,0,0,0.18)', padding: 16 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontWeight: 900 }}>{esEdicion ? 'Editar proyecto' : 'Nuevo proyecto'}</div>
          <button type="button" className="btn" style={{ marginLeft: 'auto' }} onClick={onClose}>Cerrar</button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ fontSize: 12, fontWeight: 700 }}>
            Nombre
            <input
              className="pp-input" style={{ width: '100%', marginTop: 4 }} maxLength={120} autoFocus
              value={form.nombre} onChange={(e) => set('nombre', e.target.value)} placeholder="Ej: Migración del tablero a la nueva API"
            />
          </label>

          <label style={{ fontSize: 12, fontWeight: 700 }}>
            Descripción (opcional)
            <textarea
              className="pp-input" style={{ width: '100%', marginTop: 4, minHeight: 80, resize: 'vertical' }} maxLength={4000}
              value={form.descripcion} onChange={(e) => set('descripcion', e.target.value)}
              placeholder="De qué se trata, objetivo, links útiles…"
            />
          </label>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <label style={{ fontSize: 12, fontWeight: 700, flex: '1 1 220px' }}>
              Encargado
              <select className="pp-input" style={{ width: '100%', marginTop: 4 }} value={form.encargado} onChange={(e) => elegirEncargado(e.target.value)}>
                <option value="">Elegí quién…</option>
                {opciones.map((u) => (
                  <option key={u.username} value={u.username}>
                    {nombreDe(u)}{u.name && u.name !== u.username ? ` (@${u.username})` : ''}{u.username === yo ? ' - vos' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ fontSize: 12, fontWeight: 700, flex: '1 1 160px' }}>
              Estado
              <select className="pp-input" style={{ width: '100%', marginTop: 4 }} value={form.estado} onChange={(e) => set('estado', e.target.value)}>
                {ORDEN_ESTADOS.map((k) => <option key={k} value={k}>{ESTADOS[k].label}</option>)}
              </select>
            </label>
          </div>

          <div>
            <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
              Integrantes <span style={{ fontWeight: 600, color: 'var(--muted)' }}>· los que pueden ver y usar el chat del proyecto</span>
            </div>
            {!opciones.length ? (
              <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>No hay usuarios con acceso a Programadores.</div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {opciones.map((u) => {
                  const esEncargado = u.username === form.encargado;
                  const elegido = esEncargado || form.integrantes.includes(u.username);
                  return (
                    <button
                      key={u.username}
                      type="button"
                      className={`proy-chip${elegido ? ' proy-chip--elegido' : ''}`}
                      onClick={() => alternarIntegrante(u.username)}
                      aria-pressed={elegido}
                      title={esEncargado ? 'El encargado siempre es integrante' : elegido ? 'Quitar del proyecto' : 'Sumar al proyecto'}
                      style={{ padding: '4px 10px 4px 4px', cursor: esEncargado ? 'default' : 'pointer' }}
                    >
                      <UserAvatar username={u.username} name={u.name} size={22} />
                      {nombreDe(u)}
                      {esEncargado ? <span style={{ fontSize: 10.5, fontWeight: 800, color: '#fff', background: 'var(--brand)', borderRadius: 999, padding: '1px 7px' }}>Encargado</span> : elegido ? <span style={{ color: 'var(--brand)' }}>✓</span> : null}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {err ? <div style={{ color: 'crimson', fontWeight: 700, fontSize: 12 }}>{err}</div> : null}

          <button type="button" className="btn btn--brand" disabled={guardando} onClick={guardar}>
            {guardando ? 'Guardando…' : esEdicion ? 'Guardar cambios' : 'Crear proyecto'}
          </button>
        </div>
      </div>
    </div>
  );
}
