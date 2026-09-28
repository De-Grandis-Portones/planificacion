// pages/admin/AdminTicketsBoardPage.jsx — misma data que AdminTicketsPage.jsx
// (vista de lista/tabla) pero como tablero tipo Trello. Todas las columnas
// fijas (una por cada app que puede mandar tickets, más "Tareas" y
// "Cerrados") se muestran siempre, aunque estén vacías - así se ve de
// entrada de dónde pueden llegar tickets, sin esperar a que llegue el
// primero. Un admin puede además crear "apartados" (columnas extra, ver "+
// Nuevo apartado") y tarjetas propias en cualquiera de ellas o en "Tareas"
// (ver "+ Crear tarea") - no hace falta que las mande otra app.
// Dos comportamientos de drag&drop distintos según el tipo de tarjeta:
// - Ticket REAL (mandado por otra app): solo se puede arrastrar a
//   "Cerrados" (lo cierra) o, si ya está cerrado, de vuelta a SU PROPIA
//   columna (lo reabre a "Pendiente"). No se puede "mover" a la columna de
//   otra app - el origen es un dato fijo del ticket.
// - Tarjeta "Tarea" (creada a mano en "Tareas" o en cualquier apartado, ver
//   "+ Crear tarea", app_origen='tarea' fijo siempre): se puede arrastrar a
//   CUALQUIER columna (fija, otro apartado, o Cerrados), en cualquier
//   estado - no tiene un "origen real" que proteger. Qué columna se ve hoy
//   queda en `board_column` (ver Backend/server/lib/ticketsDb.js
//   setBoardColumn), independiente de app_origen.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  clearAdminToken,
  createTicket,
  createTicketApartado,
  deleteTicketApartado,
  fetchAdminTickets,
  fetchTicketApartados,
  updateTicketBoardColumn,
  updateTicketStatus,
} from '../../src/api';
import AdminTicketDetailModal, { APP_LABEL, ESTADO_COLOR } from '../../src/components/AdminTicketDetailModal';
import UserAvatar from '../../src/components/UserAvatar';
import { nombreConUsuario } from '../../src/utils/nombreUsuario';

const CLOSED_COL = '__closed';
const TAREAS_COL = 'tarea';
const APP_ORDER = [TAREAS_COL, 'planificacion', 'integrador', 'presupuestador', 'remitos', 'informe-ventas', 'distribuidor'];
// Las columnas de app REAL (no "tarea") son las únicas que NO aceptan crear
// tarjetas a mano ni recibir una tarjeta "tarea" movida desde otro lado -
// "Tareas" y cualquier apartado custom sí.
const REAL_APP_COLUMNS = APP_ORDER.filter((a) => a !== TAREAS_COL);

// Dónde se pinta HOY una tarjeta no cerrada: una "tarea" usa board_column
// (con fallback a la columna "tarea" si todavía no se movió nunca, o si
// vivía en un apartado que borraron); un ticket real siempre usa su
// app_origen fijo.
function columnaActualDe(t) {
  return t.app_origen === TAREAS_COL ? (t.board_column || TAREAS_COL) : t.app_origen;
}

// "Tareas" y cualquier apartado custom aceptan tarjetas "tarea" y tienen
// "+ Crear tarea"; las columnas de app real y "Cerrados" no.
function esColumnaManual(colKey) {
  return colKey !== CLOSED_COL && !REAL_APP_COLUMNS.includes(colKey);
}

// Ícono simple (sin librería, sin emoji) para la columna vacía - un tray/
// bandeja vacía, dibujado en línea con currentColor para que respete el
// tema claro/oscuro sin configurar nada aparte.
function IconoBandejaVacia() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.45 }}>
      <path d="M3 7l2-4h14l2 4M3 7v11a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7M3 7h18M9 12h6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function primerasPalabras(texto, n = 10) {
  const palabras = String(texto || '').trim().split(/\s+/).filter(Boolean);
  if (palabras.length <= n) return palabras.join(' ');
  return `${palabras.slice(0, n).join(' ')}…`;
}

export default function AdminTicketsBoardPage() {
  const nav = useNavigate();
  const [tickets, setTickets] = useState([]);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState('');
  const [seleccionadoId, setSeleccionadoId] = useState(null);
  const [dragOverCol, setDragOverCol] = useState(null);
  // Estado (no un ref) a propósito: necesitamos que cambiar esto dispare un
  // re-render para que las columnas inválidas se atenúen visualmente
  // mientras se arrastra (un ref no re-renderiza).
  const [draggingTicket, setDraggingTicket] = useState(null);
  // Solo un form de "crear tarea" abierto a la vez, en la columna que
  // guarda este valor (null = ninguno abierto).
  const [nuevaTareaColAbierta, setNuevaTareaColAbierta] = useState(null);
  const [nuevaTareaTexto, setNuevaTareaTexto] = useState('');
  const [creandoTarea, setCreandoTarea] = useState(false);
  const [apartados, setApartados] = useState([]);
  const [nuevoApartadoAbierto, setNuevoApartadoAbierto] = useState(false);
  const [nuevoApartadoNombre, setNuevoApartadoNombre] = useState('');
  const [creandoApartado, setCreandoApartado] = useState(false);
  const [confirmandoBorrarApartado, setConfirmandoBorrarApartado] = useState(null);
  const [borrandoApartado, setBorrandoApartado] = useState(null);
  // Arrastrar con el mouse sobre el fondo del tablero para desplazarlo
  // horizontalmente (como Trello), en vez de depender solo de la barra de
  // scroll. `panRef` guarda la posición inicial (no dispara render en cada
  // mousemove, solo movemos el scroll del DOM directamente); `isPanning` sí
  // es estado porque necesita re-renderizar para el cursor "grabbing".
  const scrollRef = useRef(null);
  const panRef = useRef({ startX: 0, startScrollLeft: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [busqueda, setBusqueda] = useState('');

  const logout = () => {
    clearAdminToken();
    nav('/admin/login');
  };

  async function cargar() {
    setCargando(true);
    setError('');
    try {
      const { data } = await fetchAdminTickets({});
      setTickets(data?.tickets || []);
    } catch (err) {
      setError(err?.response?.data?.error || 'Error cargando los tickets');
    } finally {
      setCargando(false);
    }
  }

  async function cargarApartados() {
    try {
      const { data } = await fetchTicketApartados();
      setApartados(data?.apartados || []);
    } catch (err) {
      console.error('Error cargando los apartados:', err);
    }
  }

  useEffect(() => {
    cargar();
    cargarApartados();
  }, []);

  async function crearTarea(e) {
    e.preventDefault();
    const texto = nuevaTareaTexto.trim();
    const columna = nuevaTareaColAbierta;
    if (!texto || !columna) return;
    setCreandoTarea(true);
    try {
      const { data } = await createTicket({
        categoria: texto.length > 80 ? `${texto.slice(0, 80)}…` : texto,
        mensaje: texto,
        appOrigen: TAREAS_COL,
        boardColumn: columna,
      });
      if (data?.ticket) setTickets((prev) => [data.ticket, ...prev]);
      setNuevaTareaTexto('');
      setNuevaTareaColAbierta(null);
    } catch (err) {
      console.error('Error creando la tarea:', err);
      setError(err?.response?.data?.error || 'Error creando la tarea');
    } finally {
      setCreandoTarea(false);
    }
  }

  async function crearApartado(e) {
    e.preventDefault();
    const nombre = nuevoApartadoNombre.trim();
    if (!nombre) return;
    setCreandoApartado(true);
    try {
      const { data } = await createTicketApartado(nombre);
      if (data?.apartado) setApartados((prev) => [...prev, data.apartado]);
      setNuevoApartadoNombre('');
      setNuevoApartadoAbierto(false);
    } catch (err) {
      console.error('Error creando el apartado:', err);
      setError(err?.response?.data?.error || 'Error creando el apartado');
    } finally {
      setCreandoApartado(false);
    }
  }

  // Solo un apartado CUSTOM se puede borrar (nunca "Tareas" ni las columnas
  // de app real, que ni siquiera tienen fila en esta tabla). Al borrarlo,
  // sus tarjetas vuelven a "Tareas" en vez de desaparecer - ver
  // deleteApartado en el backend.
  async function borrarApartado(clave) {
    setBorrandoApartado(clave);
    try {
      await deleteTicketApartado(clave);
      setApartados((prev) => prev.filter((a) => a.clave !== clave));
      setTickets((prev) => prev.map((t) => (
        t.app_origen === TAREAS_COL && t.board_column === clave ? { ...t, board_column: TAREAS_COL } : t
      )));
      setConfirmandoBorrarApartado(null);
    } catch (err) {
      console.error('Error borrando el apartado:', err);
      setError(err?.response?.data?.error || 'Error borrando el apartado');
    } finally {
      setBorrandoApartado(null);
    }
  }

  // Etiqueta de un apartado custom por su clave (para el header de columna y
  // el badge de app dentro de "Cerrados").
  const apartadoLabelByClave = useMemo(
    () => Object.fromEntries(apartados.map((a) => [a.clave, a.nombre])),
    [apartados]
  );
  const apartadoClaves = useMemo(() => new Set(apartados.map((a) => a.clave)), [apartados]);

  // Todas las columnas fijas siempre presentes (aunque estén vacías), más
  // los apartados custom (en orden de creación), más cualquier app_origen
  // desconocido que aparezca en los datos (ej. una app nueva que todavía no
  // se agregó a APP_ORDER), al final y ordenada.
  const columnas = useMemo(() => {
    const clavesApartados = apartados.map((a) => a.clave);
    const desconocidas = [...new Set(tickets.map((t) => t.app_origen).filter(Boolean))]
      .filter((a) => !APP_ORDER.includes(a))
      .sort();
    return [...APP_ORDER, ...clavesApartados, ...desconocidas];
  }, [tickets, apartados]);

  // Buscador: filtra por categoría, mensaje, quién lo creó o quién lo está
  // trabajando - así se puede encontrar una tarjeta puntual sin tener que
  // desplazarse a mano por columnas con muchas tarjetas.
  const busquedaNormalizada = busqueda.trim().toLowerCase();
  function coincideBusqueda(t) {
    if (!busquedaNormalizada) return true;
    return (
      String(t.categoria || '').toLowerCase().includes(busquedaNormalizada) ||
      String(t.mensaje || '').toLowerCase().includes(busquedaNormalizada) ||
      String(t.creado_por_nombre || '').toLowerCase().includes(busquedaNormalizada) ||
      String(t.creado_por_username || '').toLowerCase().includes(busquedaNormalizada) ||
      String(t.en_progreso_por_nombre || '').toLowerCase().includes(busquedaNormalizada) ||
      String(t.en_progreso_por || '').toLowerCase().includes(busquedaNormalizada)
    );
  }

  const porColumna = useMemo(() => {
    const map = {};
    for (const app of columnas) map[app] = [];
    map[CLOSED_COL] = [];
    for (const t of tickets) {
      if (!coincideBusqueda(t)) continue;
      if (t.estado === 'closed') {
        map[CLOSED_COL].push(t);
      } else {
        const col = columnaActualDe(t);
        if (map[col]) map[col].push(t);
      }
    }
    for (const key of Object.keys(map)) {
      map[key].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }
    return map;
  }, [tickets, columnas, busquedaNormalizada]);

  const totalCoincidencias = useMemo(
    () => Object.values(porColumna).reduce((sum, arr) => sum + arr.length, 0),
    [porColumna]
  );

  function onDragStart(t) {
    setDraggingTicket({ id: t.id, appOrigen: t.app_origen, estado: t.estado, boardColumn: t.board_column || null });
  }

  function onDragEnd() {
    setDraggingTicket(null);
    setDragOverCol(null);
  }

  // Una tarjeta "tarea" se puede soltar en CUALQUIER columna, en cualquier
  // estado. Un ticket real sigue la regla vieja: a "Cerrados" se puede
  // soltar cualquiera que no esté ya cerrado; a la columna de una app solo
  // se puede soltar el ticket que YA estaba cerrado y es justamente de esa
  // app (reabrir) - no se puede "mover" un ticket real a la columna de otra
  // app, el origen es un dato fijo.
  function puedeSoltarEn(colKey) {
    if (!draggingTicket) return false;
    if (draggingTicket.appOrigen === TAREAS_COL) return true;
    if (colKey === CLOSED_COL) return draggingTicket.estado !== 'closed';
    return draggingTicket.estado === 'closed' && colKey === draggingTicket.appOrigen;
  }

  async function onDrop(colKey) {
    const d = draggingTicket;
    setDragOverCol(null);
    if (!d || !puedeSoltarEn(colKey)) return;
    const esTarea = d.appOrigen === TAREAS_COL;

    if (colKey === CLOSED_COL) {
      if (d.estado === 'closed') return;
      setTickets((prev) => prev.map((t) => (t.id === d.id ? { ...t, estado: 'closed' } : t)));
      try {
        await updateTicketStatus(d.id, 'closed');
      } catch (err) {
        console.error('Error moviendo ticket:', err);
        cargar();
      }
      return;
    }

    if (esTarea) {
      const columnaActual = d.estado === 'closed' ? null : (d.boardColumn || TAREAS_COL);
      if (columnaActual === colKey) return; // ya está ahí, no hay nada que mover
      const reabrir = d.estado === 'closed';
      setTickets((prev) => prev.map((t) => (
        t.id === d.id ? { ...t, board_column: colKey, estado: reabrir ? 'pending' : t.estado } : t
      )));
      try {
        if (reabrir) await updateTicketStatus(d.id, 'pending');
        await updateTicketBoardColumn(d.id, colKey);
      } catch (err) {
        console.error('Error moviendo la tarea:', err);
        cargar();
      }
      return;
    }

    // Ticket real reabriendo a su propia columna - la única opción
    // no-Cerrados permitida por puedeSoltarEn para este caso.
    setTickets((prev) => prev.map((t) => (t.id === d.id ? { ...t, estado: 'pending' } : t)));
    try {
      await updateTicketStatus(d.id, 'pending');
    } catch (err) {
      console.error('Error moviendo ticket:', err);
      cargar();
    }
  }

  // No arrancar el paneo si el click empezó en algo con su propia
  // interacción (tarjeta arrastrable, botón, link, o un campo de texto/
  // formulario) - solo el fondo vacío del tablero/columnas pasa a mover el
  // scroll.
  function onPanMouseDown(e) {
    if (e.button !== 0) return; // solo click izquierdo
    if (e.target.closest('[draggable="true"], button, a, input, textarea, form, select')) return;
    panRef.current = { startX: e.clientX, startScrollLeft: scrollRef.current.scrollLeft };
    setIsPanning(true);
  }

  function onPanMouseMove(e) {
    if (!isPanning || !scrollRef.current) return;
    scrollRef.current.scrollLeft = panRef.current.startScrollLeft - (e.clientX - panRef.current.startX);
  }

  function onPanMouseUp() {
    if (isPanning) setIsPanning(false);
  }

  const columnasConCerrados = [...columnas, CLOSED_COL];

  return (
    <div className="container" style={{ maxWidth: '100%' }}>
      <div className="header-row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn" to="/admin">← Admin</Link>
          <Link className="btn" to="/index">Inicio</Link>
          <Link className="btn" to="/admin/tickets">Ver como lista</Link>
        </div>
        <h2 style={{ margin: 0 }}>Tickets · Tablero</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" type="button" onClick={cargar} disabled={cargando}>
            {cargando ? 'Actualizando...' : 'Actualizar'}
          </button>
          <button className="btn" type="button" onClick={logout}>Cerrar Sesión</button>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, maxWidth: 340 }}>
        <input
          type="text"
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
          placeholder="Buscar en el tablero..."
          style={{ flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 13 }}
        />
        {busqueda && (
          <button type="button" className="btn" onClick={() => setBusqueda('')} title="Limpiar búsqueda">×</button>
        )}
        {busquedaNormalizada && (
          <span style={{ fontSize: 12, color: 'var(--ink-weak)', whiteSpace: 'nowrap' }}>
            {totalCoincidencias} resultado{totalCoincidencias === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {error && <div style={{ color: '#b3261e', margin: '10px 0' }}>{error}</div>}
      {cargando && tickets.length === 0 && (
        <div style={{ fontSize: 13, color: 'var(--ink-weak)', marginTop: 12 }}>Cargando...</div>
      )}

      <div
        ref={scrollRef}
        onMouseDown={onPanMouseDown}
        onMouseMove={onPanMouseMove}
        onMouseUp={onPanMouseUp}
        onMouseLeave={onPanMouseUp}
        style={{
          display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 12, marginTop: 14,
          cursor: isPanning ? 'grabbing' : 'grab',
          userSelect: isPanning ? 'none' : 'auto',
        }}
      >
        {columnasConCerrados.map((colKey) => {
          const items = porColumna[colKey] || [];
          const esCerrados = colKey === CLOSED_COL;
          const puedeRecibir = draggingTicket ? puedeSoltarEn(colKey) : true;
          return (
            <div
              key={colKey}
              onDragOver={(e) => {
                if (puedeSoltarEn(colKey)) {
                  e.preventDefault();
                  setDragOverCol(colKey);
                }
              }}
              onDragLeave={() => setDragOverCol((c) => (c === colKey ? null : c))}
              onDrop={(e) => {
                e.preventDefault();
                onDrop(colKey);
              }}
              style={{
                minWidth: 260, width: 260, flexShrink: 0,
                background: dragOverCol === colKey ? 'var(--brand-100)' : (esCerrados ? 'var(--surface-2, #f8fafc)' : 'var(--surface)'),
                border: `1px ${esCerrados ? 'dashed' : 'solid'} ${dragOverCol === colKey ? 'var(--brand-700)' : 'var(--border)'}`,
                borderRadius: 12, display: 'flex', flexDirection: 'column', maxHeight: '75vh',
                opacity: !puedeRecibir && draggingTicket ? 0.6 : 1,
                transition: 'opacity .1s, background .1s',
              }}
            >
              <div style={{
                padding: '10px 12px', borderBottom: `1px ${esCerrados ? 'dashed' : 'solid'} var(--border)`,
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                background: esCerrados ? 'var(--surface-2, #f1f5f9)' : 'transparent',
                borderRadius: '12px 12px 0 0',
              }}>
                <strong style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', color: esCerrados ? 'var(--ink-weak)' : 'inherit' }}>
                  {esCerrados ? 'Cerrados' : (apartadoLabelByClave[colKey] || APP_LABEL[colKey] || colKey)}
                </strong>
                {apartadoClaves.has(colKey) && confirmandoBorrarApartado === colKey ? (
                  <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                    <button
                      type="button"
                      onClick={() => borrarApartado(colKey)}
                      disabled={borrandoApartado === colKey}
                      style={{ fontSize: 11, color: '#b3261e', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textDecoration: 'underline' }}
                    >
                      {borrandoApartado === colKey ? 'Borrando...' : 'Sí, borrar'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmandoBorrarApartado(null)}
                      disabled={borrandoApartado === colKey}
                      style={{ fontSize: 11, color: 'var(--ink-weak)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                    >
                      No
                    </button>
                  </span>
                ) : (
                  <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                    <span style={{ fontSize: 11, color: 'var(--ink-weak)', fontWeight: 700 }}>{items.length}</span>
                    {apartadoClaves.has(colKey) && (
                      <button
                        type="button"
                        title="Borrar este apartado"
                        onClick={() => setConfirmandoBorrarApartado(colKey)}
                        style={{ fontSize: 14, lineHeight: 1, color: 'var(--ink-weak)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
                      >
                        ×
                      </button>
                    )}
                  </span>
                )}
              </div>

              <div style={{ padding: 8, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {items.length === 0 && (
                  busquedaNormalizada ? (
                    <div style={{ fontSize: 12, color: 'var(--ink-weak)', textAlign: 'center', padding: '14px 0' }}>
                      Sin resultados
                    </div>
                  ) : !esColumnaManual(colKey) && (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, color: 'var(--ink-weak)', padding: '20px 0' }}>
                      <IconoBandejaVacia />
                      <span style={{ fontSize: 12 }}>Sin tickets</span>
                    </div>
                  )
                )}
                {items.map((t) => (
                  <div
                    key={t.id}
                    draggable
                    onDragStart={() => onDragStart(t)}
                    onDragEnd={onDragEnd}
                    onClick={() => setSeleccionadoId(t.id)}
                    title={t.estado === 'in_progress' ? 'En curso · arrastrar para cambiar de columna · clic para ver todo' : 'Arrastrar para cambiar de columna · clic para ver todo'}
                    style={{
                      border: '1px solid var(--border)',
                      borderLeft: `4px solid ${ESTADO_COLOR[t.estado] || 'var(--border)'}`,
                      borderRadius: 8, padding: 8,
                      background: 'var(--surface)', cursor: 'grab',
                      boxShadow: '0 1px 2px rgba(15,23,42,.08)',
                    }}
                  >
                    {esCerrados && (
                      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--brand-700)', marginBottom: 3 }}>
                        {apartadoLabelByClave[t.board_column] || APP_LABEL[t.app_origen] || t.app_origen}
                      </div>
                    )}
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-weak)', marginBottom: 2 }}>
                      {t.categoria}
                    </div>
                    <div style={{ fontSize: 13, lineHeight: 1.3 }}>{primerasPalabras(t.mensaje)}</div>
                    <div style={{ fontSize: 10, color: 'var(--ink-weak)', marginTop: 5 }}>
                      {nombreConUsuario(t.creado_por_nombre, t.creado_por_username) || '—'} · {new Date(t.created_at).toLocaleDateString()}
                    </div>
                    {t.en_progreso_por && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 4 }}>
                        <UserAvatar username={t.en_progreso_por} name={t.en_progreso_por_nombre} size={16} />
                        <span style={{ fontSize: 10, color: t.estado === 'in_progress' ? ESTADO_COLOR.in_progress : 'var(--ink-weak)', fontWeight: 700 }}>
                          {t.estado === 'closed' ? 'Resuelto' : t.estado === 'in_progress' ? 'En curso' : 'Asignado'}
                        </span>
                      </div>
                    )}
                  </div>
                ))}

                {esColumnaManual(colKey) && (
                  nuevaTareaColAbierta === colKey ? (
                    <form onSubmit={crearTarea} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <textarea
                        autoFocus
                        value={nuevaTareaTexto}
                        onChange={(e) => setNuevaTareaTexto(e.target.value)}
                        placeholder="¿Qué hay que hacer?"
                        rows={3}
                        style={{ padding: 8, borderRadius: 8, border: '1px solid var(--border)', resize: 'vertical', fontSize: 13, fontFamily: 'inherit' }}
                      />
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button type="submit" className="btn btn--brand" disabled={creandoTarea || !nuevaTareaTexto.trim()}>
                          {creandoTarea ? 'Creando...' : 'Crear tarea'}
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => { setNuevaTareaColAbierta(null); setNuevaTareaTexto(''); }}
                        >
                          Cancelar
                        </button>
                      </div>
                    </form>
                  ) : (
                    <button
                      type="button"
                      onClick={() => { setNuevaTareaColAbierta(colKey); setNuevaTareaTexto(''); }}
                      style={{
                        border: '1px dashed var(--border)', borderRadius: 8, padding: 8,
                        background: 'transparent', cursor: 'pointer', fontSize: 13,
                        color: 'var(--ink-weak)', textAlign: 'left',
                      }}
                    >
                      + Crear tarea
                    </button>
                  )
                )}
              </div>
            </div>
          );
        })}

        <div style={{ minWidth: 220, width: 220, flexShrink: 0 }}>
          {nuevoApartadoAbierto ? (
            <form
              onSubmit={crearApartado}
              style={{
                display: 'flex', flexDirection: 'column', gap: 6,
                border: '1px solid var(--border)', borderRadius: 12, padding: 10,
                background: 'var(--surface)',
              }}
            >
              <input
                autoFocus
                value={nuevoApartadoNombre}
                onChange={(e) => setNuevoApartadoNombre(e.target.value)}
                placeholder="Nombre del apartado"
                style={{ padding: 8, borderRadius: 8, border: '1px solid var(--border)', fontSize: 13 }}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="submit" className="btn btn--brand" disabled={creandoApartado || !nuevoApartadoNombre.trim()}>
                  {creandoApartado ? 'Creando...' : 'Crear'}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => { setNuevoApartadoAbierto(false); setNuevoApartadoNombre(''); }}
                >
                  Cancelar
                </button>
              </div>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setNuevoApartadoAbierto(true)}
              style={{
                width: '100%', border: '1px dashed var(--border)', borderRadius: 12, padding: 12,
                background: 'transparent', cursor: 'pointer', fontSize: 13,
                color: 'var(--ink-weak)', textAlign: 'left',
              }}
            >
              + Nuevo apartado
            </button>
          )}
        </div>
      </div>

      <AdminTicketDetailModal
        ticketId={seleccionadoId}
        onClose={() => setSeleccionadoId(null)}
        onTicketChanged={(patch) => {
          setTickets((prev) => prev.map((t) => (t.id === patch.id ? { ...t, ...patch } : t)));
        }}
        onTicketDeleted={(id) => setTickets((prev) => prev.filter((t) => t.id !== id))}
      />
    </div>
  );
}
