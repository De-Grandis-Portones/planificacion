// src/components/AdminTicketDetailModal.jsx — detalle de un ticket (mensaje,
// adjuntos, hilo de respuestas, form de responder, botones de estado) para
// cualquier admin logueado. Extraído de AdminTicketsPage.jsx para poder
// reusarlo también en AdminTicketsBoardPage.jsx (tablero tipo Trello) sin
// duplicar la lógica de responder/cambiar estado.
import { useEffect, useState } from 'react';
import {
  fetchAdminTicketDetail,
  addAdminTicketMessage,
  updateTicketStatus,
  assignTicketToMe,
  unassignTicket,
  declinarTicket,
  retirarDeclinacionTicket,
  deleteAdminTicket,
} from '../api';
import BaseModal from './modals/BaseModal';
import UserAvatar from './UserAvatar';
import { nombreConUsuario } from '../utils/nombreUsuario';
import { getCurrentAdminUsername } from '../utils/adminScopes';
import {
  formatTicketAttachmentMeta,
  isImageTicketAttachment,
  openTicketAttachment,
  downloadTicketAttachment,
} from '../utils/ticketAttachment';

// No hay estado "cancelled": cuando un usuario anula su propio ticket se
// borra directamente (ver TicketWidget.jsx / DELETE .../tickets/mine/:id) -
// no queda como fila ni como estado para el admin.
export const ESTADO_LABEL = { pending: 'Pendiente', in_progress: 'En curso', closed: 'Cerrado' };
export const ESTADO_COLOR = {
  pending: 'var(--state-pending, #b45309)',
  in_progress: 'var(--state-process, #92720c)',
  closed: 'var(--state-done, #15803d)',
};

// Este panel (y el tablero) son el lugar central para los tickets de TODAS
// las apps del ecosistema — todas escriben en las mismas tablas
// `tickets`/`ticket_mensajes`.
export const APP_LABEL = {
  planificacion: 'Planificación',
  integrador: 'Integrador',
  presupuestador: 'Presupuestador',
  remitos: 'Remitos',
  'informe-ventas': 'Informe de Ventas',
  distribuidor: 'Distribuidor',
  // No es una app real - tarjetas creadas a mano desde el tablero
  // (/admin/tickets-tablero), no mandadas por ninguna app.
  tarea: 'Tareas',
};

// Lo que cambia en un ticket cuando alguien se asigna, cambia el estado o
// avisa que no lo hace: es lo que el modal le pasa a la lista/tablero.
function camposDeAsignacion(t, anterior) {
  return {
    estado: t?.estado ?? anterior?.estado,
    en_progreso_por: t ? t.en_progreso_por ?? null : anterior?.en_progreso_por ?? null,
    en_progreso_por_nombre: t ? t.en_progreso_por_nombre ?? null : anterior?.en_progreso_por_nombre ?? null,
    no_la_hacen: t?.no_la_hacen ?? anterior?.no_la_hacen ?? [],
  };
}

// `ticketId` en null cierra el modal. `onTicketChanged(patch)` se llama con
// `{ id, estado?, updated_at? }` cada vez que algo cambió acá adentro, para
// que quien nos usa (la lista o el tablero) pueda parchear su propio estado
// local sin tener que volver a pedir todo de nuevo. `onTicketDeleted(id)` se
// llama cuando se borra el ticket (solo posible si ya está "closed") - a
// diferencia de un cambio, acá hay que sacarlo de la lista, no parchearlo.
export default function AdminTicketDetailModal({ ticketId, onClose, onTicketChanged, onTicketDeleted }) {
  const [ticket, setTicket] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [respuesta, setRespuesta] = useState('');
  const [enviandoRespuesta, setEnviandoRespuesta] = useState(false);
  const [cambiandoEstado, setCambiandoEstado] = useState(false);
  const [asignando, setAsignando] = useState(false);
  const [declinarAbierto, setDeclinarAbierto] = useState(false);
  const [motivoDeclinar, setMotivoDeclinar] = useState('');
  const [declinando, setDeclinando] = useState(false);
  const [errorDeclinar, setErrorDeclinar] = useState('');
  const [confirmandoBorrar, setConfirmandoBorrar] = useState(false);
  const [borrando, setBorrando] = useState(false);
  const miUsername = getCurrentAdminUsername();

  useEffect(() => {
    if (!ticketId) {
      setTicket(null);
      return;
    }
    setRespuesta('');
    setConfirmandoBorrar(false);
    setDeclinarAbierto(false);
    setMotivoDeclinar('');
    setErrorDeclinar('');
    cargar(ticketId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketId]);

  async function cargar(id) {
    setCargando(true);
    try {
      const { data } = await fetchAdminTicketDetail(id);
      setTicket(data?.ticket || null);
    } catch (err) {
      console.error('Error abriendo ticket:', err);
    } finally {
      setCargando(false);
    }
  }

  async function enviarRespuesta(e) {
    e.preventDefault();
    if (!ticket || !respuesta.trim()) return;
    setEnviandoRespuesta(true);
    try {
      await addAdminTicketMessage(ticket.id, { mensaje: respuesta.trim() });
      setRespuesta('');
      const { data } = await fetchAdminTicketDetail(ticket.id);
      const actualizado = data?.ticket || null;
      setTicket(actualizado);
      if (actualizado) onTicketChanged?.({ id: actualizado.id, updated_at: actualizado.updated_at, estado: actualizado.estado });
    } catch (err) {
      console.error('Error enviando respuesta:', err);
    } finally {
      setEnviandoRespuesta(false);
    }
  }

  async function cambiarEstado(nuevoEstado) {
    if (!ticket) return;
    setCambiandoEstado(true);
    try {
      const { data } = await updateTicketStatus(ticket.id, nuevoEstado);
      // El backend ya decide qué hacer con en_progreso_por según el estado
      // (lo pisa con quien lo puso "En curso", lo limpia si vuelve a
      // "Pendiente", lo deja igual si se cierra) - simplemente reflejamos lo
      // que devolvió, no lo calculamos acá.
      const cambios = camposDeAsignacion(data?.ticket, { ...ticket, estado: nuevoEstado });
      setTicket((prev) => (prev ? { ...prev, ...cambios } : prev));
      onTicketChanged?.({ id: ticket.id, ...cambios });
    } catch (err) {
      console.error('Error cambiando estado:', err);
    } finally {
      setCambiandoEstado(false);
    }
  }

  // "Asignarme"/"Tomar" o "Quitarme" - un click directo, en cualquier
  // estado (a diferencia de cambiarEstado, esto no necesita pasar por "En
  // curso").
  async function cambiarAsignado(accion) {
    if (!ticket) return;
    setAsignando(true);
    try {
      const { data } = accion === 'liberar' ? await unassignTicket(ticket.id) : await assignTicketToMe(ticket.id);
      // Asignarse retira el "No la voy a hacer" propio (lo hace el backend).
      const cambios = camposDeAsignacion(data?.ticket, ticket);
      setTicket((prev) => (prev ? { ...prev, ...cambios } : prev));
      onTicketChanged?.({ id: ticket.id, ...cambios });
    } catch (err) {
      console.error('Error asignando el ticket:', err);
    } finally {
      setAsignando(false);
    }
  }

  // "No la voy a hacer" (con motivo opcional) / "Deshacer". Si era
  // yo el asignado, el backend además me quita (y si estaba "En curso" por
  // mí, vuelve a "Pendiente").
  async function cambiarDeclinacion(accion) {
    if (!ticket) return;
    setDeclinando(true);
    setErrorDeclinar('');
    try {
      const { data } = accion === 'retirar'
        ? await retirarDeclinacionTicket(ticket.id)
        : await declinarTicket(ticket.id, motivoDeclinar.trim());
      const cambios = camposDeAsignacion(data?.ticket, ticket);
      setTicket((prev) => (prev ? { ...prev, ...cambios } : prev));
      onTicketChanged?.({ id: ticket.id, ...cambios });
      setDeclinarAbierto(false);
      setMotivoDeclinar('');
    } catch (err) {
      setErrorDeclinar(err?.response?.data?.error || 'No se pudo guardar el aviso');
    } finally {
      setDeclinando(false);
    }
  }

  async function borrarTicket() {
    if (!ticket) return;
    setBorrando(true);
    try {
      await deleteAdminTicket(ticket.id);
      const idBorrado = ticket.id;
      onTicketDeleted?.(idBorrado);
      onClose?.();
    } catch (err) {
      console.error('Error borrando ticket:', err);
    } finally {
      setBorrando(false);
      setConfirmandoBorrar(false);
    }
  }

  const noLaHacen = ticket?.no_la_hacen || [];
  const yaDecline = noLaHacen.some((d) => d.username === miUsername);

  return (
    <BaseModal
      open={!!ticketId}
      onClose={onClose}
      wide
      title={ticket?.titulo || ticket?.categoria}
      subtitle={
        ticket
          ? `${ticket.titulo ? `${ticket.categoria} · ` : ''}${APP_LABEL[ticket.app_origen] || ticket.app_origen || ''} · Creado por ${nombreConUsuario(ticket.creado_por_nombre, ticket.creado_por_username) || '—'} · ${new Date(ticket.created_at).toLocaleString()}`
          : ''
      }
    >
      {cargando && !ticket && <div style={{ fontSize: 13, color: 'var(--ink-weak)' }}>Cargando...</div>}
      {ticket && (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            {['pending', 'in_progress', 'closed'].map((e) => (
              <button
                key={e}
                type="button"
                className={ticket.estado === e ? 'btn btn--brand' : 'btn'}
                disabled={cambiandoEstado}
                onClick={() => cambiarEstado(e)}
              >
                {ESTADO_LABEL[e]}
              </button>
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 13, flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--ink-weak)' }}>Trabajando en esto:</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <UserAvatar username={ticket.en_progreso_por} name={ticket.en_progreso_por_nombre} size={20} />
              <strong>{ticket.en_progreso_por_nombre || ticket.en_progreso_por || 'Nadie todavía'}</strong>
            </span>
            {ticket.en_progreso_por && ticket.en_progreso_por === miUsername ? (
              <button type="button" className="btn" disabled={asignando} onClick={() => cambiarAsignado('liberar')}>
                {asignando ? '...' : 'Quitarme'}
              </button>
            ) : (
              <button type="button" className="btn" disabled={asignando} onClick={() => cambiarAsignado('asignar')}>
                {asignando ? '...' : (ticket.en_progreso_por ? 'Tomar' : 'Asignarme')}
              </button>
            )}
            {yaDecline ? (
              <button
                type="button"
                className="btn"
                disabled={declinando}
                onClick={() => cambiarDeclinacion('retirar')}
                title="Sacar tu «No la voy a hacer» de este ticket"
              >
                {declinando ? '...' : 'Deshacer «No la voy a hacer»'}
              </button>
            ) : ticket.estado !== 'closed' && !declinarAbierto && (
              <button
                type="button"
                className="btn pp-btn--danger"
                onClick={() => setDeclinarAbierto(true)}
                title="Dejar a la vista que no te vas a encargar de esto (no le avisa a nadie)"
              >
                No la voy a hacer
              </button>
            )}
          </div>

          {declinarAbierto && (
            <div
              style={{
                display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12, padding: 10,
                border: '1px solid #f3c1bc', borderRadius: 8, background: '#fdf3f2',
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 700 }}>
                No la voy a hacer
                <span style={{ fontWeight: 400, color: 'var(--ink-weak)' }}>
                  {' · '}queda a la vista en el ticket, no le llega aviso a nadie
                  {ticket.en_progreso_por === miUsername ? ' · te vas a quitar de este ticket' : ''}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <input
                  autoFocus
                  value={motivoDeclinar}
                  maxLength={300}
                  onChange={(e) => setMotivoDeclinar(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') cambiarDeclinacion('declinar');
                    if (e.key === 'Escape') setDeclinarAbierto(false);
                  }}
                  placeholder="¿Por qué? (opcional) Ej: no es de mi área, no llego esta semana…"
                  style={{ flex: '1 1 240px', padding: 8, borderRadius: 8, border: '1px solid var(--border)' }}
                />
                <button type="button" className="btn btn--brand" disabled={declinando} onClick={() => cambiarDeclinacion('declinar')}>
                  {declinando ? 'Guardando...' : 'Confirmar'}
                </button>
                <button type="button" className="btn" disabled={declinando} onClick={() => setDeclinarAbierto(false)}>
                  Cancelar
                </button>
              </div>
              {errorDeclinar && <div style={{ fontSize: 12, color: '#b3261e' }}>{errorDeclinar}</div>}
            </div>
          )}

          {noLaHacen.length > 0 && (
            <div style={{ marginBottom: 12, padding: '8px 10px', borderRadius: 8, background: '#fdf3f2', border: '1px solid #f3c1bc' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#b3261e', marginBottom: 4 }}>
                No la {noLaHacen.length === 1 ? 'va' : 'van'} a hacer
              </div>
              {noLaHacen.map((d) => (
                <div key={d.username} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, flexWrap: 'wrap', padding: '2px 0' }}>
                  <UserAvatar username={d.username} name={d.nombre} size={18} />
                  <strong>{d.username === miUsername ? 'Vos' : (d.nombre || d.username)}</strong>
                  {d.motivo && <span style={{ color: 'var(--ink-weak)' }}>— “{d.motivo}”</span>}
                  <span style={{ fontSize: 11, color: 'var(--ink-weak)' }}>· {new Date(d.created_at).toLocaleDateString()}</span>
                </div>
              ))}
              {errorDeclinar && !declinarAbierto && <div style={{ fontSize: 12, color: '#b3261e' }}>{errorDeclinar}</div>}
            </div>
          )}

          <div style={{ fontSize: 14, whiteSpace: 'pre-wrap', marginBottom: 12 }}>{ticket.mensaje}</div>

          {(ticket.adjuntos || []).length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
              {ticket.adjuntos.map((a, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => openTicketAttachment(a)}
                  onDoubleClick={() => downloadTicketAttachment(a)}
                  title={`${formatTicketAttachmentMeta(a)} (clic para ver, doble clic para descargar)`}
                  style={{
                    border: '1px solid var(--border)', borderRadius: 8, padding: 6,
                    background: 'transparent', cursor: 'pointer', fontSize: 12, textAlign: 'left',
                  }}
                >
                  {isImageTicketAttachment(a) ? (
                    <img src={a.data_url} alt={a.name} style={{ width: 90, height: 90, objectFit: 'cover', borderRadius: 6, display: 'block' }} />
                  ) : (
                    <span>📎 {formatTicketAttachmentMeta(a)}</span>
                  )}
                </button>
              ))}
            </div>
          )}

          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
            {(ticket.mensajes || []).map((m) => (
              <div key={m.id} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, color: 'var(--ink-weak)' }}>
                  {nombreConUsuario(m.autor_nombre, m.autor_username) || (m.es_admin ? 'Soporte' : 'Usuario')} · {new Date(m.created_at).toLocaleString()}
                </div>
                <div style={{ fontSize: 14, whiteSpace: 'pre-wrap' }}>{m.mensaje}</div>
              </div>
            ))}
            {(!ticket.mensajes || ticket.mensajes.length === 0) && (
              <div style={{ fontSize: 13, color: 'var(--ink-weak)' }}>Todavía no hay respuestas.</div>
            )}
          </div>

          <form onSubmit={enviarRespuesta} style={{ marginTop: 10 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={respuesta}
                onChange={(e) => setRespuesta(e.target.value)}
                placeholder="Responder..."
                style={{ flex: 1, padding: 8, borderRadius: 8, border: '1px solid var(--border)' }}
              />
              <button type="submit" className="btn btn--brand" disabled={enviandoRespuesta}>
                {enviandoRespuesta ? 'Enviando...' : 'Enviar'}
              </button>
            </div>
          </form>

          {/* Se puede borrar sea cual sea el estado - el backend
              (deleteTicketAdmin en ticketsDb.js) no restringe por estado, a
              pedido explícito del usuario. */}
          {!confirmandoBorrar ? (
            <button
              type="button"
              onClick={() => setConfirmandoBorrar(true)}
              style={{
                marginTop: 12, background: 'none', border: 'none', padding: 0,
                color: '#b3261e', fontSize: 12, cursor: 'pointer', textDecoration: 'underline',
              }}
            >
              Borrar ticket
            </button>
          ) : (
            <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, color: 'var(--ink-weak)' }}>¿Seguro que querés borrarlo? No se puede deshacer.</span>
              <button
                type="button"
                onClick={borrarTicket}
                disabled={borrando}
                style={{
                  padding: '4px 10px', fontSize: 12, borderRadius: 8, border: 'none',
                  background: '#b3261e', color: '#fff', fontWeight: 700, cursor: 'pointer',
                }}
              >
                {borrando ? 'Borrando...' : 'Sí, borrar'}
              </button>
              <button
                type="button"
                onClick={() => setConfirmandoBorrar(false)}
                disabled={borrando}
                style={{
                  padding: '4px 10px', fontSize: 12, borderRadius: 8,
                  border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer',
                }}
              >
                No
              </button>
            </div>
          )}
        </div>
      )}
    </BaseModal>
  );
}
