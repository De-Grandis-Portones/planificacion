// pages/admin/ProgramadoresProyectoPage.jsx
//
// Ficha de un proyecto de Programadores: quién es el encargado, quiénes
// trabajan en él, la descripción y su chat (el mismo ChatSala del Chat de
// Programadores, contra /admin/programadores/proyectos/:id/...). El chat es
// solo de los integrantes; los demás ven la ficha y un aviso. El encargado
// o quien lo creó pueden editarlo o archivarlo (archivado = chat solo
// lectura, se puede desarchivar).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  fetchProyectoProgramadores, archivarProyectoProgramadores, apiChatProyecto, getAdminToken,
} from '../../src/api';
import { getCurrentAdminUsername } from '../../src/utils/adminScopes';
import ChatSala from '../../src/components/chatProgramadores/ChatSala';
import { useChatProgramadores } from '../../src/components/chatProgramadores/chatContexto';
import { RUTA_PROYECTOS } from '../../src/components/chatProgramadores/chatComun';
import ProyectoFormModal from '../../src/components/programadoresProyectos/ProyectoFormModal';
import { EstadoPill, Persona, IconoCandado } from '../../src/components/programadoresProyectos/ProyectoPartes';
import { nombreDe, fechaLarga, inicialesProyecto } from '../../src/components/programadoresProyectos/proyectosComun';

export default function ProgramadoresProyectoPage() {
  const nav = useNavigate();
  useEffect(() => { if (!getAdminToken()) nav('/admin/login', { replace: true }); }, [nav]);

  const { id } = useParams();
  const idNum = Number(id);
  const yo = useMemo(() => getCurrentAdminUsername() || '', []);
  const { suscribir, conectado } = useChatProgramadores();

  const [proyecto, setProyecto] = useState(null);
  const [usuarios, setUsuarios] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const [editando, setEditando] = useState(false);
  const [archivando, setArchivando] = useState(false);

  const cargar = useCallback(async () => {
    try {
      const { data } = await fetchProyectoProgramadores(id);
      setProyecto(data?.proyecto || null);
      setUsuarios(data?.usuarios || []);
      setError('');
    } catch (err) {
      const status = err?.response?.status;
      if (status === 404) setError('Este proyecto no existe.');
      else if (status === 403) setError('No tenés acceso a Proyectos: es solo para usuarios con el permiso programadores:admin.');
      else setError(err?.response?.data?.error || 'No se pudo cargar el proyecto');
    } finally {
      setCargando(false);
    }
  }, [id]);

  useEffect(() => {
    setCargando(true);
    setProyecto(null);
    cargar();
  }, [cargar]);

  // Si alguien lo edita (nombre, integrantes, estado...), la ficha se
  // actualiza sola; si me sacaron, el chat desaparece.
  useEffect(() => suscribir((ev) => {
    if (ev.tipo === 'proyectos' && ev.proyecto_id === idNum) cargar();
  }), [suscribir, cargar, idNum]);

  const apiChat = useMemo(() => apiChatProyecto(id), [id]);
  const suscribirChat = useCallback((fn) => suscribir((ev) => {
    if (ev.tipo === 'conectado') fn(ev);
    else if (ev.tipo === 'proyecto' && ev.proyecto_id === idNum && ev.evento) fn(ev.evento);
  }), [suscribir, idNum]);

  async function alternarArchivo() {
    if (!proyecto) return;
    const archivar = !proyecto.archivado;
    if (archivar && !window.confirm('¿Archivar este proyecto? Deja de aparecer entre los activos y su chat queda solo para leer. Se puede desarchivar cuando quieras.')) return;
    setArchivando(true);
    try {
      const { data } = await archivarProyectoProgramadores(proyecto.id, archivar);
      setProyecto(data.proyecto);
    } catch (err) {
      window.alert(err?.response?.data?.error || 'No se pudo cambiar el archivo del proyecto');
    } finally {
      setArchivando(false);
    }
  }

  const volver = <Link className="btn" to={RUTA_PROYECTOS}>← Proyectos</Link>;

  if (cargando && !proyecto) {
    return (
      <div>
        <div className="proy-head">{volver}</div>
        <div style={{ color: 'var(--muted)', padding: 20 }}>Cargando proyecto…</div>
      </div>
    );
  }

  if (!proyecto) {
    return (
      <div>
        <div className="proy-head">{volver}</div>
        <div className="card" style={{ padding: 20, marginTop: 14 }}>{error || 'No se pudo cargar el proyecto'}</div>
      </div>
    );
  }

  const p = proyecto;
  const otros = p.integrantes.filter((u) => u.username !== p.encargado.username);

  return (
    <div>
      <div className="proy-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', minWidth: 0 }}>
          {volver}
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <h2 style={{ margin: 0, wordBreak: 'break-word' }}>{p.nombre}</h2>
              <EstadoPill estado={p.estado} archivado={p.archivado} />
            </div>
            <div className="proy-sub">
              Encargado: {nombreDe(p.encargado)}{p.encargado.username === yo ? ' (vos)' : ''} · {p.integrantes.length} {p.integrantes.length === 1 ? 'integrante' : 'integrantes'}
            </div>
          </div>
        </div>
        {p.puede_editar && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {!p.archivado && <button type="button" className="btn btn--brand" onClick={() => setEditando(true)}>Editar</button>}
            <button type="button" className="btn" onClick={alternarArchivo} disabled={archivando}>
              {archivando ? 'Guardando…' : p.archivado ? 'Desarchivar' : 'Archivar'}
            </button>
          </div>
        )}
      </div>

      <div className="proy-layout">
        <aside className="proy-info">
          <section className="proy-info__bloque">
            <div className="proy-label">Encargado</div>
            <div className="proy-encargado">
              <Persona persona={p.encargado} yo={yo} size={40} />
            </div>
          </section>

          <section className="proy-info__bloque">
            <div className="proy-label">Integrantes · {otros.length}</div>
            {otros.length ? (
              <div style={{ display: 'grid', gap: 10 }}>
                {otros.map((u) => <Persona key={u.username} persona={u} yo={yo} size={30} />)}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>Por ahora trabaja solo el encargado.</div>
            )}
          </section>

          {p.descripcion && (
            <section className="proy-info__bloque">
              <div className="proy-label">Descripción</div>
              <div style={{ fontSize: 13.5, lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{p.descripcion}</div>
            </section>
          )}

          <div className="proy-info__meta">
            <div>Creado {p.creado_por ? `por ${nombreDe(p.creado_por)} ` : ''}el {fechaLarga(p.created_at)}</div>
            {p.archivado && <div>Archivado el {fechaLarga(p.archivado_at)}</div>}
            {!p.puede_editar && <div>Lo pueden editar el encargado o quien lo creó.</div>}
          </div>
        </aside>

        <div className="proy-chat">
          {p.es_integrante ? (
            <ChatSala
              key={p.id}
              api={apiChat}
              suscribir={suscribirChat}
              conectado={conectado}
              titulo={p.nombre}
              icono={<span style={{ fontSize: 15, fontWeight: 800, letterSpacing: 0.5 }}>{inicialesProyecto(p.nombre)}</span>}
              textoSinAcceso="El chat es solo para los integrantes del proyecto."
              soloLectura={p.archivado ? 'Proyecto archivado: el chat queda solo para leer.' : null}
              alto="calc(100vh - 170px)"
            />
          ) : (
            <div className="proy-vacio" style={{ marginTop: 12 }}>
              <span style={{ color: 'var(--muted)' }}><IconoCandado size={32} /></span>
              <div style={{ fontWeight: 900 }}>El chat es solo para los integrantes</div>
              <div style={{ color: 'var(--muted)', fontSize: 13 }}>
                Si tenés que trabajar en este proyecto, pedile a {nombreDe(p.encargado)} que te sume.
              </div>
            </div>
          )}
        </div>
      </div>

      {editando && (
        <ProyectoFormModal
          proyecto={p}
          usuarios={usuarios}
          onClose={() => setEditando(false)}
          onGuardado={(nuevo) => { setEditando(false); setProyecto(nuevo); }}
        />
      )}
    </div>
  );
}
