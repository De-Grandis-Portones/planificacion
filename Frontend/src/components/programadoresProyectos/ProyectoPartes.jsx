// src/components/programadoresProyectos/ProyectoPartes.jsx — piezas chicas
// que se repiten en las tarjetas y en la ficha de un proyecto. Los íconos
// son SVG en línea con currentColor (sin librería y sin emoji, igual que el
// ícono de columna vacía del tablero de Tickets).
import UserAvatar from '../UserAvatar';
import { estadoDe, nombreDe } from './proyectosComun';

const pill = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 999,
  fontSize: 12, fontWeight: 800, whiteSpace: 'nowrap', flex: '0 0 auto',
};

export function EstadoPill({ estado, archivado = false }) {
  const e = archivado ? { label: 'Archivado', color: '#64748b', fondo: '#e2e8f0' } : estadoDe(estado);
  return (
    <span style={{ ...pill, color: e.color, background: e.fondo }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: e.color }} />
      {e.label}
    </span>
  );
}

// Avatar + nombre real (+ @usuario abajo si el nombre es distinto del login).
export function Persona({ persona, size = 26, yo, extra }) {
  if (!persona?.username) return null;
  const nombre = nombreDe(persona);
  const esYo = yo && persona.username === yo;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
      <UserAvatar username={persona.username} name={persona.name} size={size} />
      <div style={{ minWidth: 0, lineHeight: 1.25 }}>
        <div style={{ fontWeight: 800, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {nombre}
          {esYo && <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 700, color: 'var(--brand)' }}>(vos)</span>}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {extra || (persona.name && persona.name !== persona.username ? `@${persona.username}` : null)}
        </div>
      </div>
    </div>
  );
}

// Fila de avatares superpuestos, con "+N" si son muchos.
export function AvataresIntegrantes({ integrantes, max = 5, size = 26 }) {
  const visibles = integrantes.slice(0, max);
  const resto = integrantes.length - visibles.length;
  return (
    <div style={{ display: 'flex', alignItems: 'center' }} title={integrantes.map(nombreDe).join(', ')}>
      {visibles.map((p, i) => (
        <span key={p.username} style={{ marginLeft: i ? -7 : 0, borderRadius: '50%', boxShadow: '0 0 0 2px var(--surface)', display: 'inline-flex' }}>
          <UserAvatar username={p.username} name={p.name} size={size} />
        </span>
      ))}
      {resto > 0 && (
        <span
          style={{
            marginLeft: -7, width: size, height: size, borderRadius: '50%', background: '#e2e8f0', color: '#334155',
            fontSize: 11, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 0 0 2px var(--surface)',
          }}
        >
          +{resto}
        </span>
      )}
    </div>
  );
}

function Icono({ size = 16, children, ...rest }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: '0 0 auto' }} {...rest}
    >
      {children}
    </svg>
  );
}

export function IconoMensaje(props) {
  return <Icono {...props}><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" /></Icono>;
}

export function IconoCandado(props) {
  return <Icono {...props}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></Icono>;
}

export function IconoCarpeta(props) {
  return <Icono {...props}><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></Icono>;
}

export function IconoBuscar(props) {
  return <Icono {...props}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Icono>;
}
