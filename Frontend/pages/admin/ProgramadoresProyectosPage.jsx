// pages/admin/ProgramadoresProyectosPage.jsx
//
// Proyectos de la sección Programadores: cada proyecto es una tarjeta con su
// estado, el encargado, los integrantes y (para los que participan) el
// último mensaje del chat y cuántos nuevos hay. Tocando la tarjeta se abre
// la ficha con el chat (ProgramadoresProyectoPage.jsx).
// Backend: routes/admin/programadoresProyectos.js.
//
// Se refresca sola: con cada aviso del canal en tiempo real (proyecto creado
// o editado, mensaje nuevo en uno de mis proyectos) y cada 60s por las dudas.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { fetchProyectosProgramadores, getAdminToken } from '../../src/api';
import { getCurrentAdminUsername } from '../../src/utils/adminScopes';
import { useChatProgramadores } from '../../src/components/chatProgramadores/chatContexto';
import { rutaProyecto, previewDe } from '../../src/components/chatProgramadores/chatComun';
import UserAvatar from '../../src/components/UserAvatar';
import ProyectoFormModal from '../../src/components/programadoresProyectos/ProyectoFormModal';
import {
  EstadoPill, AvataresIntegrantes, IconoMensaje, IconoCandado, IconoCarpeta, IconoBuscar,
} from '../../src/components/programadoresProyectos/ProyectoPartes';
import { ESTADOS, ORDEN_ESTADOS, estadoDe, nombreDe, cuandoCorto } from '../../src/components/programadoresProyectos/proyectosComun';

const REFRESCO_MS = 60000;

function TarjetaProyecto({ p, yo }) {
  const e = estadoDe(p.estado);
  const um = p.ultimo_mensaje;
  const otros = p.integrantes.filter((u) => u.username !== p.encargado.username);
  const soyEncargado = p.encargado.username === yo;
  return (
    <Link
      to={rutaProyecto(p.id)}
      className={`proy-card${p.no_leidos ? ' proy-card--nuevos' : ''}`}
      style={{ '--proy-color': p.archivado ? '#94a3b8' : e.color }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <EstadoPill estado={p.estado} archivado={p.archivado} />
        {p.no_leidos > 0 && (
          <span className="proy-nuevos">
            {p.no_leidos > 99 ? '99+' : p.no_leidos} {p.no_leidos === 1 ? 'nuevo' : 'nuevos'}
          </span>
        )}
      </div>

      <div>
        <div className="proy-card__titulo">{p.nombre}</div>
        {p.descripcion && <p className="proy-desc" style={{ marginTop: 4 }}>{p.descripcion}</p>}
      </div>

      <div className="proy-card__equipo">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <UserAvatar username={p.encargado.username} name={p.encargado.name} size={34} />
          <div style={{ minWidth: 0, lineHeight: 1.25 }}>
            <div style={{ fontWeight: 800, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {nombreDe(p.encargado)}
            </div>
            <div className="proy-label" style={{ textTransform: 'none', letterSpacing: 0 }}>
              Encargado{soyEncargado ? ' · vos' : ''}
            </div>
          </div>
        </div>
        {otros.length > 0 ? (
          <div style={{ display: 'grid', justifyItems: 'end', gap: 3 }}>
            <AvataresIntegrantes integrantes={otros} size={24} />
            <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 700 }}>
              +{otros.length} {otros.length === 1 ? 'integrante' : 'integrantes'}
            </span>
          </div>
        ) : (
          <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 700 }}>Solo el encargado</span>
        )}
      </div>

      <div className="proy-card__pie">
        {!p.es_integrante ? (
          <>
            <IconoCandado size={14} />
            <span>El chat es solo de los integrantes</span>
          </>
        ) : um ? (
          <>
            <IconoMensaje size={14} />
            <span
              style={{
                flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                color: p.no_leidos ? 'var(--text)' : undefined, fontWeight: p.no_leidos ? 700 : 400,
              }}
            >
              <b>{um.autor_username === yo ? 'Vos' : um.autor_username}:</b> {previewDe({ texto: um.texto, n_adjuntos: um.n_adjuntos })}
            </span>
            <span style={{ flex: '0 0 auto', fontSize: 11.5 }}>{cuandoCorto(um.created_at)}</span>
          </>
        ) : (
          <>
            <IconoMensaje size={14} />
            <span>Sin mensajes todavía</span>
          </>
        )}
      </div>
    </Link>
  );
}

export default function ProgramadoresProyectosPage() {
  const nav = useNavigate();
  useEffect(() => { if (!getAdminToken()) nav('/admin/login', { replace: true }); }, [nav]);

  const yo = useMemo(() => getCurrentAdminUsername() || '', []);
  const { suscribir } = useChatProgramadores();

  const [proyectos, setProyectos] = useState([]);
  const [usuarios, setUsuarios] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const [sinAcceso, setSinAcceso] = useState(false);
  const [verArchivados, setVerArchivados] = useState(false);
  const [filtroEstado, setFiltroEstado] = useState('todos');
  const [soloMios, setSoloMios] = useState(false);
  const [busqueda, setBusqueda] = useState('');
  const [creando, setCreando] = useState(false);
  const pedidoRef = useRef(0);

  const cargar = useCallback(async () => {
    const n = ++pedidoRef.current; // si cambian los filtros en el medio, gana el último pedido
    try {
      const { data } = await fetchProyectosProgramadores(verArchivados ? { archivados: 1 } : undefined);
      if (n !== pedidoRef.current) return;
      setProyectos(data?.proyectos || []);
      setUsuarios(data?.usuarios || []);
      setError('');
    } catch (err) {
      if (n !== pedidoRef.current) return;
      if (err?.response?.status === 403) setSinAcceso(true);
      else setError(err?.response?.data?.error || 'No se pudieron cargar los proyectos');
    } finally {
      if (n === pedidoRef.current) setCargando(false);
    }
  }, [verArchivados]);

  useEffect(() => {
    setCargando(true);
    cargar();
    const t = setInterval(() => { if (!document.hidden) cargar(); }, REFRESCO_MS);
    return () => clearInterval(t);
  }, [cargar]);

  // Avisos en tiempo real: se agrupan para no recargar 5 veces seguidas.
  useEffect(() => {
    let timer = null;
    const unsub = suscribir((ev) => {
      const relevante = ev.tipo === 'proyectos'
        || (ev.tipo === 'proyecto' && (ev.evento?.tipo === 'mensaje' || (ev.evento?.tipo === 'lectura' && ev.evento.username === yo)));
      if (!relevante) return;
      clearTimeout(timer);
      timer = setTimeout(cargar, 400);
    });
    return () => { clearTimeout(timer); unsub(); };
  }, [suscribir, cargar, yo]);

  const visibles = useMemo(() => {
    const q = busqueda.trim().toLowerCase();
    return proyectos.filter((p) => {
      if (filtroEstado !== 'todos' && p.estado !== filtroEstado) return false;
      if (soloMios && !p.es_integrante) return false;
      if (!q) return true;
      return [p.nombre, p.descripcion, nombreDe(p.encargado), p.encargado.username, ...p.integrantes.map(nombreDe)]
        .some((t) => String(t || '').toLowerCase().includes(q));
    });
  }, [proyectos, filtroEstado, soloMios, busqueda]);

  const conteoPorEstado = useMemo(() => {
    const out = {};
    for (const p of proyectos) out[p.estado] = (out[p.estado] || 0) + 1;
    return out;
  }, [proyectos]);

  const misProyectos = useMemo(() => proyectos.filter((p) => p.es_integrante).length, [proyectos]);

  const encabezado = (
    <div className="proy-head">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', minWidth: 0 }}>
        <Link className="btn" to="/index">← Inicio</Link>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: 0 }}>{verArchivados ? 'Proyectos archivados' : 'Proyectos'}</h2>
          {!sinAcceso && !cargando && (
            <div className="proy-sub">
              {proyectos.length} {proyectos.length === 1 ? 'proyecto' : 'proyectos'}
              {!verArchivados && ` · participás en ${misProyectos}`}
            </div>
          )}
        </div>
      </div>
      {!sinAcceso && (
        <button type="button" className="btn btn--brand" onClick={() => setCreando(true)} disabled={cargando && !proyectos.length && !usuarios.length}>
          + Nuevo proyecto
        </button>
      )}
    </div>
  );

  if (sinAcceso) {
    return (
      <div>
        {encabezado}
        <div className="card" style={{ padding: 20, marginTop: 14 }}>
          No tenés acceso a Proyectos: es solo para usuarios con el permiso <b>programadores:admin</b>.
        </div>
      </div>
    );
  }

  return (
    <div>
      {encabezado}

      <div className="proy-toolbar">
        <label className="proy-buscar">
          <IconoBuscar size={15} />
          <input
            type="search"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
            placeholder="Buscar proyecto, encargado o integrante"
            aria-label="Buscar proyectos"
          />
        </label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <button type="button" className={`proy-chip${filtroEstado === 'todos' ? ' proy-chip--activo' : ''}`} onClick={() => setFiltroEstado('todos')}>
            Todos <span className="proy-chip__n">{proyectos.length}</span>
          </button>
          {ORDEN_ESTADOS.map((k) => (
            <button
              key={k}
              type="button"
              className={`proy-chip${filtroEstado === k ? ' proy-chip--activo' : ''}`}
              onClick={() => setFiltroEstado(k)}
            >
              {ESTADOS[k].label} <span className="proy-chip__n">{conteoPorEstado[k] || 0}</span>
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto', flexWrap: 'wrap' }}>
          <button
            type="button"
            className={`proy-chip${soloMios ? ' proy-chip--activo' : ''}`}
            aria-pressed={soloMios}
            onClick={() => setSoloMios((v) => !v)}
          >
            Solo donde participo
          </button>
          <button type="button" className="proy-chip" onClick={() => { setVerArchivados((v) => !v); setFiltroEstado('todos'); }}>
            {verArchivados ? 'Ver activos' : 'Ver archivados'}
          </button>
        </div>
      </div>

      {error && <div style={{ color: 'crimson', fontWeight: 700, marginBottom: 12 }}>{error}</div>}

      {cargando && !proyectos.length ? (
        <div style={{ color: 'var(--muted)', padding: 20 }}>Cargando proyectos…</div>
      ) : !proyectos.length ? (
        <div className="proy-vacio">
          <span style={{ color: 'var(--brand)' }}><IconoCarpeta size={36} /></span>
          {verArchivados ? (
            <div style={{ color: 'var(--muted)' }}>No hay proyectos archivados.</div>
          ) : (
            <>
              <div style={{ fontWeight: 900, fontSize: 16 }}>Todavía no hay proyectos</div>
              <div style={{ color: 'var(--muted)', fontSize: 13, maxWidth: 420 }}>
                Creá el primero: elegí el encargado, sumá a los que van a trabajar en él y ya tienen su chat.
              </div>
              <button type="button" className="btn btn--brand" onClick={() => setCreando(true)}>+ Nuevo proyecto</button>
            </>
          )}
        </div>
      ) : !visibles.length ? (
        <div style={{ color: 'var(--muted)', padding: 20, textAlign: 'center' }}>Ningún proyecto coincide con los filtros.</div>
      ) : (
        <div className="proy-grid">
          {visibles.map((p) => <TarjetaProyecto key={p.id} p={p} yo={yo} />)}
        </div>
      )}

      {creando && (
        <ProyectoFormModal
          usuarios={usuarios}
          onClose={() => setCreando(false)}
          onGuardado={(p) => { setCreando(false); nav(rutaProyecto(p.id)); }}
        />
      )}
    </div>
  );
}
