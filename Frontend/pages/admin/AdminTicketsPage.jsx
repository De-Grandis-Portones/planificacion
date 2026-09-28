// pages/admin/AdminTicketsPage.jsx — ver todos los tickets y abrir el
// detalle (responder / cambiar estado, ver AdminTicketDetailModal.jsx). Sin
// scope propio: cualquier admin logueado entra, igual que
// /admin/indice-programacion. Las respuestas que se mandan acá se ven
// reflejadas en "Mis tickets" del widget de quien creó el ticket
// (Frontend/src/components/TicketWidget.jsx). También existe una vista
// tipo tablero de los mismos datos, ver AdminTicketsBoardPage.jsx.
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { clearAdminToken, fetchAdminTickets } from '../../src/api';
import AdminTicketDetailModal, { ESTADO_LABEL, ESTADO_COLOR, APP_LABEL } from '../../src/components/AdminTicketDetailModal';
import UserAvatar from '../../src/components/UserAvatar';

const ESTADOS = [
  { key: '', label: 'Todos' },
  { key: 'pending', label: 'Pendientes' },
  { key: 'in_progress', label: 'En curso' },
  { key: 'closed', label: 'Cerrados' },
];

export default function AdminTicketsPage() {
  const nav = useNavigate();
  // Arranca en "Pendientes": es lo que hay que atender al entrar.
  const [estadoFiltro, setEstadoFiltro] = useState('pending');
  const [tickets, setTickets] = useState([]);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState('');
  const [seleccionadoId, setSeleccionadoId] = useState(null);

  const logout = () => {
    clearAdminToken();
    nav('/admin/login');
  };

  async function cargar() {
    setCargando(true);
    setError('');
    try {
      const { data } = await fetchAdminTickets(estadoFiltro ? { estado: estadoFiltro } : {});
      setTickets(data?.tickets || []);
    } catch (err) {
      setError(err?.response?.data?.error || 'Error cargando los tickets');
    } finally {
      setCargando(false);
    }
  }

  useEffect(() => {
    cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estadoFiltro]);

  const pendientesCount = useMemo(
    () => tickets.filter((t) => t.estado === 'pending').length,
    [tickets]
  );

  return (
    <div className="container" style={{ maxWidth: '100%' }}>
      <div className="header-row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn" to="/admin">← Admin</Link>
          <Link className="btn" to="/index">Inicio</Link>
          <Link className="btn" to="/admin/tickets-tablero">Ver como tareas</Link>
        </div>
        <h2 style={{ margin: 0 }}>Tickets</h2>
        <button className="btn" type="button" onClick={logout}>Cerrar Sesión</button>
      </div>

      <div style={{ display: 'flex', gap: 8, margin: '14px 0', flexWrap: 'wrap', alignItems: 'center' }}>
        {ESTADOS.map((e) => (
          <button
            key={e.key}
            type="button"
            className={estadoFiltro === e.key ? 'btn btn--brand' : 'btn'}
            onClick={() => setEstadoFiltro(e.key)}
          >
            {e.label}
            {e.key === 'pending' && pendientesCount > 0 && (!estadoFiltro || estadoFiltro === 'pending') ? ` (${pendientesCount})` : ''}
          </button>
        ))}
        <button className="btn" type="button" onClick={cargar} disabled={cargando} style={{ marginLeft: 'auto' }}>
          {cargando ? 'Actualizando...' : 'Actualizar'}
        </button>
      </div>

      {error && <div style={{ color: '#b3261e', marginBottom: 10 }}>{error}</div>}

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '2px solid var(--border)' }}>
              <th style={{ padding: 8 }}>App</th>
              <th style={{ padding: 8 }}>Categoría</th>
              <th style={{ padding: 8 }}>Mensaje</th>
              <th style={{ padding: 8 }}>Creado por</th>
              <th style={{ padding: 8 }}>Fecha</th>
              <th style={{ padding: 8 }}>Estado</th>
            </tr>
          </thead>
          <tbody>
            {tickets.map((t) => (
              <tr
                key={t.id}
                onClick={() => setSeleccionadoId(t.id)}
                style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer' }}
              >
                <td style={{ padding: 8 }}>{APP_LABEL[t.app_origen] || t.app_origen || '—'}</td>
                <td style={{ padding: 8, fontWeight: 600 }}>{t.categoria}</td>
                <td style={{ padding: 8, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t.mensaje}
                </td>
                <td style={{ padding: 8 }}>{t.creado_por_username || '—'}</td>
                <td style={{ padding: 8 }}>{new Date(t.created_at).toLocaleString()}</td>
                <td style={{ padding: 8 }}>
                  <span style={{ fontWeight: 700, color: ESTADO_COLOR[t.estado] || 'var(--ink)' }}>
                    {ESTADO_LABEL[t.estado] || t.estado}
                  </span>
                  {t.en_progreso_por && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 2 }}>
                      <UserAvatar username={t.en_progreso_por} size={14} />
                      <span style={{ fontSize: 11, color: 'var(--ink-weak)' }}>{t.en_progreso_por}</span>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {!cargando && tickets.length === 0 && (
              <tr>
                <td colSpan={6} style={{ padding: 16, textAlign: 'center', color: 'var(--ink-weak)' }}>
                  No hay tickets{estadoFiltro ? ' con ese estado' : ''}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <AdminTicketDetailModal
        ticketId={seleccionadoId}
        onClose={() => setSeleccionadoId(null)}
        onTicketChanged={(patch) => {
          setTickets((prev) => {
            if (estadoFiltro && patch.estado && estadoFiltro !== patch.estado) {
              return prev.filter((t) => t.id !== patch.id);
            }
            return prev.map((t) => (t.id === patch.id ? { ...t, ...patch } : t));
          });
        }}
        onTicketDeleted={(id) => setTickets((prev) => prev.filter((t) => t.id !== id))}
      />
    </div>
  );
}
