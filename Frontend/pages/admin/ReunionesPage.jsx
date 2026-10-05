// pages/admin/ReunionesPage.jsx
//
// "Reuniones y Tareas": agenda compartida entre admins para cargar fecha y
// hora de reuniones propias (calendario mensual). Sin invitados/RSVP - no se
// pidió, es un espacio compartido donde cualquier admin ve/crea/edita/borra
// cualquier reunión, mismo criterio "sin scope propio" que /admin/tickets.
// El link "Ver tareas" no es una pantalla nueva - lleva a la columna
// "Tareas" del tablero de Tickets que ya existe (/admin/tickets-tablero).
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getAdminToken, fetchReuniones, createReunion, updateReunion, deleteReunion } from '../../src/api';
import { pad2, todayISO10 } from '../../src/utils/isoWeek';

const DIAS_SEMANA = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const MESES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

function toISO(year, month, day) {
  return `${year}-${pad2(month + 1)}-${pad2(day)}`;
}

// Grilla del mes: siempre semanas completas (lunes a domingo) incluyendo los
// días del mes anterior/siguiente que completan la primera/última fila, para
// que el calendario no "salte" de tamaño mes a mes.
function construirGrilla(year, month) {
  const primerDia = new Date(year, month, 1);
  const ultimoDia = new Date(year, month + 1, 0);
  // getDay(): 0=domingo..6=sábado -> lo pasamos a 0=lunes..6=domingo.
  const offsetInicio = (primerDia.getDay() + 6) % 7;
  const totalDias = ultimoDia.getDate();

  const celdas = [];
  for (let i = 0; i < offsetInicio; i++) {
    const d = new Date(year, month, 1 - (offsetInicio - i));
    celdas.push({ fecha: toISO(d.getFullYear(), d.getMonth(), d.getDate()), enMes: false, dia: d.getDate() });
  }
  for (let dia = 1; dia <= totalDias; dia++) {
    celdas.push({ fecha: toISO(year, month, dia), enMes: true, dia });
  }
  while (celdas.length % 7 !== 0) {
    const ultima = celdas[celdas.length - 1];
    const [y, m, d] = ultima.fecha.split('-').map(Number);
    const sig = new Date(y, m - 1, d + 1);
    celdas.push({ fecha: toISO(sig.getFullYear(), sig.getMonth(), sig.getDate()), enMes: false, dia: sig.getDate() });
  }

  const semanas = [];
  for (let i = 0; i < celdas.length; i += 7) semanas.push(celdas.slice(i, i + 7));
  return semanas;
}

const emptyForm = { titulo: '', fecha: '', horaInicio: '', horaFin: '', enlace: '', descripcion: '' };

function ReunionFormModal({ inicial, onClose, onGuardada, onBorrada }) {
  const [form, setForm] = useState(inicial);
  const [guardando, setGuardando] = useState(false);
  const [borrando, setBorrando] = useState(false);
  const [err, setErr] = useState('');

  const esEdicion = !!inicial.id;

  const guardar = async () => {
    if (!form.titulo.trim()) { setErr('Falta el título.'); return; }
    if (!form.fecha) { setErr('Falta la fecha.'); return; }
    if (!form.horaInicio) { setErr('Falta la hora de inicio.'); return; }
    setGuardando(true);
    setErr('');
    const payload = {
      titulo: form.titulo.trim(),
      fecha: form.fecha,
      horaInicio: form.horaInicio,
      horaFin: form.horaFin || null,
      enlace: form.enlace.trim() || null,
      descripcion: form.descripcion.trim() || null,
    };
    try {
      const { data } = esEdicion ? await updateReunion(form.id, payload) : await createReunion(payload);
      onGuardada(data.reunion);
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    } finally {
      setGuardando(false);
    }
  };

  const borrar = async () => {
    if (!window.confirm('¿Borrar esta reunión? No se puede deshacer.')) return;
    setBorrando(true);
    setErr('');
    try {
      await deleteReunion(form.id);
      onBorrada(form.id);
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
      setBorrando(false);
    }
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{ width: 'min(480px, 100%)', maxHeight: '92vh', overflowY: 'auto', background: 'var(--surface)', borderRadius: 14, border: '1px solid var(--border)', boxShadow: '0 12px 32px rgba(0,0,0,0.18)', padding: 16 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: esEdicion && inicial.creadoPor ? 2 : 12 }}>
          <div style={{ fontWeight: 900 }}>{esEdicion ? 'Editar reunión' : 'Nueva reunión'}</div>
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={onClose}>Cerrar</button>
        </div>
        {esEdicion && inicial.creadoPor ? (
          <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 10 }}>Creada por: {inicial.creadoPor}</div>
        ) : null}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ fontSize: 12, fontWeight: 700 }}>
            Título
            <input className="pp-input" style={{ width: '100%', marginTop: 4 }} value={form.titulo} onChange={(e) => setForm((f) => ({ ...f, titulo: e.target.value }))} placeholder="Ej: Reunión semanal de admins" />
          </label>

          <div style={{ display: 'flex', gap: 10 }}>
            <label style={{ fontSize: 12, fontWeight: 700, flex: 1 }}>
              Fecha
              <input type="date" className="pp-input" style={{ width: '100%', marginTop: 4 }} value={form.fecha} onChange={(e) => setForm((f) => ({ ...f, fecha: e.target.value }))} />
            </label>
            <label style={{ fontSize: 12, fontWeight: 700 }}>
              Desde
              <input type="time" className="pp-input" style={{ marginTop: 4 }} value={form.horaInicio} onChange={(e) => setForm((f) => ({ ...f, horaInicio: e.target.value }))} />
            </label>
            <label style={{ fontSize: 12, fontWeight: 700 }}>
              Hasta
              <input type="time" className="pp-input" style={{ marginTop: 4 }} value={form.horaFin} onChange={(e) => setForm((f) => ({ ...f, horaFin: e.target.value }))} />
            </label>
          </div>

          <label style={{ fontSize: 12, fontWeight: 700 }}>
            Enlace (Meet, Zoom, etc. - opcional)
            <input className="pp-input" style={{ width: '100%', marginTop: 4 }} value={form.enlace} onChange={(e) => setForm((f) => ({ ...f, enlace: e.target.value }))} placeholder="https://…" />
          </label>

          <label style={{ fontSize: 12, fontWeight: 700 }}>
            Motivo (opcional)
            <textarea
              className="pp-input" style={{ width: '100%', marginTop: 4, minHeight: 70, resize: 'vertical' }}
              placeholder="Ej: revisar avance de la semana, coordinar con distribuidores, etc."
              value={form.descripcion} onChange={(e) => setForm((f) => ({ ...f, descripcion: e.target.value }))}
            />
          </label>

          {err ? <div style={{ color: 'crimson', fontWeight: 700, fontSize: 12 }}>{err}</div> : null}

          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button className="btn btn--brand" disabled={guardando || borrando} onClick={guardar} style={{ flex: 1 }}>
              {guardando ? 'Guardando…' : 'Guardar'}
            </button>
            {esEdicion ? (
              <button className="btn" disabled={guardando || borrando} onClick={borrar} style={{ color: 'crimson' }}>
                {borrando ? 'Borrando…' : 'Borrar'}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ReunionesPage() {
  const nav = useNavigate();
  useEffect(() => { if (!getAdminToken()) nav('/admin/login', { replace: true }); }, [nav]);

  const hoy = useMemo(() => todayISO10(), []);
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [month, setMonth] = useState(() => new Date().getMonth()); // 0-11

  const [reuniones, setReuniones] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [modal, setModal] = useState(null); // null | { id?, titulo, fecha, ... }
  const [hoverFecha, setHoverFecha] = useState(null);

  const semanas = useMemo(() => construirGrilla(year, month), [year, month]);
  const desde = semanas[0][0].fecha;
  const hasta = semanas[semanas.length - 1][6].fecha;

  const reload = async () => {
    setLoading(true);
    setErr('');
    try {
      const { data } = await fetchReuniones({ desde, hasta });
      setReuniones(Array.isArray(data?.reuniones) ? data.reuniones : []);
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { reload(); }, [desde, hasta]); // eslint-disable-line react-hooks/exhaustive-deps

  const reunionesPorFecha = useMemo(() => {
    const map = new Map();
    for (const r of reuniones) {
      if (!map.has(r.fecha)) map.set(r.fecha, []);
      map.get(r.fecha).push(r);
    }
    return map;
  }, [reuniones]);

  const irMesAnterior = () => {
    const d = new Date(year, month - 1, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
  };
  const irMesSiguiente = () => {
    const d = new Date(year, month + 1, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
  };
  const irHoy = () => {
    const d = new Date();
    setYear(d.getFullYear());
    setMonth(d.getMonth());
  };

  // El botón "+ Nueva reunión" del header (no un día puntual) precarga la
  // fecha según el mes que se está mirando: si es el mes actual, hoy; si es
  // otro mes (navegaste con ‹ ›), el día 1 de ESE mes - así no crea una
  // reunión "de hoy" mientras estás planificando un mes distinto.
  const fechaPorDefecto = useMemo(() => {
    const ahora = new Date();
    if (year === ahora.getFullYear() && month === ahora.getMonth()) return hoy;
    return toISO(year, month, 1);
  }, [year, month, hoy]);

  const abrirNueva = (fecha) => setModal({ ...emptyForm, fecha: fecha || fechaPorDefecto });
  const abrirEdicion = (r) => setModal({
    id: r.id, titulo: r.titulo, fecha: r.fecha, horaInicio: r.hora_inicio,
    horaFin: r.hora_fin || '', enlace: r.enlace || '', descripcion: r.descripcion || '',
    creadoPor: r.creado_por || null,
  });

  const alGuardar = () => { setModal(null); reload(); };
  const alBorrar = () => { setModal(null); reload(); };

  return (
    <div className="container" style={{ maxWidth: 1100 }}>
      <div className="header-row" style={{ alignItems: 'center' }}>
        <h2 className="h1">Reuniones y Tareas</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link className="btn" to="/admin/tickets-tablero">📋 Ver tareas</Link>
          <Link className="btn" to="/admin">← Admin</Link>
          <Link className="btn" to="/index">Inicio</Link>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, marginBottom: 10 }}>
        <button className="btn" onClick={irMesAnterior}>‹</button>
        <div style={{ fontWeight: 900, fontSize: 16, minWidth: 180, textAlign: 'center' }}>{MESES[month]} {year}</div>
        <button className="btn" onClick={irMesSiguiente}>›</button>
        <button className="btn" onClick={irHoy}>Hoy</button>
        <button className="btn btn--brand" style={{ marginLeft: 'auto' }} onClick={() => abrirNueva(fechaPorDefecto)}>+ Nueva reunión</button>
      </div>

      {err ? <div style={{ color: 'crimson', fontWeight: 700, fontSize: 13, marginBottom: 10 }}>{err}</div> : null}

      <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden', opacity: loading ? 0.6 : 1 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', background: 'var(--surface-muted, #f9fafb)' }}>
          {DIAS_SEMANA.map((d) => (
            <div key={d} style={{ padding: '8px 6px', fontSize: 12, fontWeight: 800, textAlign: 'center', borderBottom: '1px solid var(--border)' }}>{d}</div>
          ))}
        </div>
        {semanas.map((semana, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)' }}>
            {semana.map((celda) => {
              const reunionesDia = reunionesPorFecha.get(celda.fecha) || [];
              const esHoy = celda.fecha === hoy;
              return (
                <div
                  key={celda.fecha}
                  onClick={() => abrirNueva(celda.fecha)}
                  onMouseEnter={() => setHoverFecha(celda.fecha)}
                  onMouseLeave={() => setHoverFecha((f) => (f === celda.fecha ? null : f))}
                  style={{
                    minHeight: 92, borderRight: '1px solid var(--border)', borderBottom: '1px solid var(--border)',
                    padding: 6, cursor: 'pointer', opacity: celda.enMes ? 1 : 0.4,
                    background: esHoy
                      ? (hoverFecha === celda.fecha ? 'rgba(37,99,235,0.12)' : 'rgba(37,99,235,0.06)')
                      : (hoverFecha === celda.fecha ? 'rgba(0,0,0,0.04)' : 'transparent'),
                    transition: 'background .1s ease',
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: esHoy ? 900 : 700, color: esHoy ? '#2563eb' : 'inherit' }}>{celda.dia}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 4 }}>
                    {reunionesDia.map((r) => (
                      <div
                        key={r.id}
                        onClick={(e) => { e.stopPropagation(); abrirEdicion(r); }}
                        title={r.descripcion ? `${r.titulo} — ${r.descripcion}` : r.titulo}
                        style={{
                          fontSize: 11, fontWeight: 700, background: '#eef2ff', color: '#3730a3',
                          borderRadius: 6, padding: '2px 5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}
                      >
                        {r.hora_inicio}{r.hora_fin ? `–${r.hora_fin}` : ''} · {r.titulo}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div style={{ marginTop: 12, fontSize: 12, opacity: 0.7 }}>
        Cualquier admin puede crear, editar o borrar una reunión - es un espacio compartido, sin invitados individuales.
        Tocá un día para agregar una reunión, o una reunión existente para editarla.
      </div>

      {modal ? (
        <ReunionFormModal inicial={modal} onClose={() => setModal(null)} onGuardada={alGuardar} onBorrada={alBorrar} />
      ) : null}
    </div>
  );
}
