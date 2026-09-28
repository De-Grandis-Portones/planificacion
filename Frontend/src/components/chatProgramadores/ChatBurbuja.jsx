// src/components/chatProgramadores/ChatBurbuja.jsx — burbuja de un mensaje del
// Chat de Programadores (texto con links/@menciones/```código```, adjuntos,
// cita del mensaje al que responde, reacciones, tildes y menú de acciones),
// más la burbuja provisoria de un mensaje que todavía se está enviando.
import { Fragment, useEffect, useRef, useState } from 'react';
import UserAvatar from '../UserAvatar';
import { colorForUsername } from '../../utils/userAvatar';
import {
  C, MEDIA_MAX, REACCIONES_RAPIDAS, MENCION_RE,
  extensionDe, formatBytes, formatHora, iconoArchivo, esImagen, previewDe,
} from './chatComun';

const URL_RE = /(https?:\/\/[^\s<]+)/g;

// @usuario resaltado si es integrante del grupo (el propio, además, con fondo).
function ConMenciones({ texto, miembrosSet, yo }) {
  const out = [];
  let ultimo = 0;
  for (const m of String(texto).matchAll(MENCION_RE)) {
    const nombre = m[2];
    const lower = nombre.toLowerCase();
    if (!miembrosSet.has(lower) && lower !== String(yo).toLowerCase()) continue;
    const inicio = m.index + m[1].length;
    if (inicio > ultimo) out.push(texto.slice(ultimo, inicio));
    const esYo = lower === String(yo).toLowerCase();
    out.push(
      <span
        key={inicio}
        style={{ color: C.link, fontWeight: 600, ...(esYo ? { background: '#fff3c4', borderRadius: 4, padding: '0 2px' } : {}) }}
      >
        @{nombre}
      </span>
    );
    ultimo = inicio + nombre.length + 1;
  }
  if (ultimo < texto.length) out.push(texto.slice(ultimo));
  return out.map((p, i) => (typeof p === 'string' ? <Fragment key={`t${i}`}>{p}</Fragment> : p));
}

function ConLinks({ texto, miembrosSet, yo }) {
  return String(texto).split(URL_RE).map((p, i) => (i % 2 === 1
    ? <a key={i} href={p} target="_blank" rel="noopener noreferrer" style={{ color: C.link }}>{p}</a>
    : <ConMenciones key={i} texto={p} miembrosSet={miembrosSet} yo={yo} />));
}

// ```bloques``` en monoespaciado, como en WhatsApp (útil para pegar código).
export function TextoMensaje({ texto, miembrosSet, yo }) {
  const partes = String(texto || '').split('```');
  return partes.map((p, i) => (i % 2 === 1 && i < partes.length - 1
    ? (
      <code
        key={i}
        style={{
          display: 'block', fontFamily: 'Consolas, "Courier New", monospace', fontSize: 12.5,
          background: 'rgba(0,0,0,.05)', borderRadius: 6, padding: '6px 8px', margin: '2px 0',
          whiteSpace: 'pre-wrap', overflowX: 'auto',
        }}
      >
        {p.replace(/^\n/, '')}
      </code>
    )
    : <ConLinks key={i} texto={i % 2 === 1 ? '```' + p : p} miembrosSet={miembrosSet} yo={yo} />));
}

// Cita del mensaje al que se responde (en la burbuja y arriba del composer).
export function CitaMensaje({ c, yo, onClick }) {
  const color = colorForUsername(c.autor_username);
  return (
    <div
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      title={onClick ? 'Ir al mensaje' : undefined}
      style={{
        background: 'rgba(0,0,0,.05)', borderLeft: `4px solid ${color}`, borderRadius: 6,
        padding: '4px 8px', cursor: onClick ? 'pointer' : 'default', minWidth: 0, whiteSpace: 'normal',
      }}
    >
      <div style={{ color, fontWeight: 700, fontSize: 12.5 }}>{c.autor_username === yo ? 'Vos' : c.autor_username}</div>
      <div
        style={{
          fontSize: 12.5, color: C.suave, overflow: 'hidden', wordBreak: 'break-word',
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
          fontStyle: c.eliminado ? 'italic' : 'normal',
        }}
      >
        {previewDe(c)}
      </div>
    </div>
  );
}

function Adjunto({ a, onMediaLoad }) {
  if (!a.url) {
    return <div style={{ fontSize: 12, color: C.suave, fontStyle: 'italic' }}>📎 {a.nombre} (no disponible)</div>;
  }
  const tipo = String(a.tipo || '');
  const ext = extensionDe(a.nombre);
  if (esImagen(tipo, a.nombre)) {
    return (
      <a href={a.url} target="_blank" rel="noopener noreferrer" title={a.nombre}>
        <img
          src={a.url}
          alt={a.nombre}
          onLoad={onMediaLoad}
          style={{ maxWidth: MEDIA_MAX, maxHeight: 320, minWidth: 48, minHeight: 48, objectFit: 'cover', borderRadius: 6, display: 'block' }}
        />
      </a>
    );
  }
  if (tipo.startsWith('video/') || ['mp4', 'webm', 'mov'].includes(ext)) {
    return <video src={a.url} controls onLoadedMetadata={onMediaLoad} style={{ maxWidth: MEDIA_MAX, borderRadius: 6, display: 'block' }} />;
  }
  if (tipo.startsWith('audio/')) {
    return <audio src={a.url} controls style={{ maxWidth: 260 }} />;
  }
  return <ChipArchivo nombre={a.nombre} tamano={a.tamano} href={a.url} />;
}

function ChipArchivo({ nombre, tamano, href }) {
  const ext = extensionDe(nombre);
  const contenido = (
    <>
      <span style={{ fontSize: 26, lineHeight: 1 }}>{iconoArchivo(nombre)}</span>
      <span style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nombre}</div>
        <div style={{ fontSize: 11, color: C.suave }}>{formatBytes(tamano)}{ext ? ` · ${ext.toUpperCase()}` : ''}</div>
      </span>
    </>
  );
  const estilo = {
    display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8,
    background: 'rgba(0,0,0,.05)', color: C.texto, textDecoration: 'none', minWidth: 200, maxWidth: 280,
  };
  return href
    ? <a href={href} target="_blank" rel="noopener noreferrer" title={`Abrir ${nombre}`} style={estilo}>{contenido}</a>
    : <div style={estilo}>{contenido}</div>;
}

// ✓ enviado · ✓✓ gris: lo vio alguien · ✓✓ azul: lo vieron todos los demás.
function Tildes({ m, lecturas, otrosMiembros }) {
  const vistos = lecturas
    .filter((l) => l.username !== m.autor_username && l.ultimo_leido_id >= m.id)
    .map((l) => l.username);
  const todos = otrosMiembros.length > 0 && otrosMiembros.every((u) => vistos.includes(u));
  const title = vistos.length ? `Visto por: ${vistos.join(', ')}` : 'Enviado';
  return (
    <span title={title} style={{ color: todos ? C.tildeAzul : C.tildeGris, fontWeight: 700, letterSpacing: -3, marginLeft: 3 }}>
      {vistos.length ? '✓✓' : '✓'}
    </span>
  );
}

function Reacciones({ reacciones, yo, propio, onToggle }) {
  if (!reacciones?.length) return null;
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: propio ? 'flex-end' : 'flex-start', marginTop: -6, padding: '0 8px', position: 'relative', zIndex: 1 }}>
      {reacciones.map((r) => {
        const mia = r.usernames.includes(yo);
        return (
          <button
            key={r.emoji}
            type="button"
            onClick={() => onToggle(r.emoji)}
            title={`${r.usernames.map((u) => (u === yo ? 'Vos' : u)).join(', ')}${mia ? ' · tocá para quitar la tuya' : ''}`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 3, padding: '1px 7px', borderRadius: 999,
              border: `1px solid ${mia ? '#86c7a6' : '#e0e3e6'}`, background: mia ? '#e7f7ee' : '#fff',
              boxShadow: '0 1px 1px rgba(11,20,26,.1)', cursor: 'pointer', fontSize: 13, lineHeight: 1.5,
            }}
          >
            <span>{r.emoji}</span>
            {r.usernames.length > 1 && <span style={{ fontSize: 11, color: C.suave }}>{r.usernames.length}</span>}
          </button>
        );
      })}
    </div>
  );
}

function MenuAcciones({ m, propio, yo, arriba, anclaRef, onCerrar, onResponder, onReaccionar, onCopiar, onEditar, onEliminar }) {
  const ref = useRef(null);
  useEffect(() => {
    // El botón ⌄ (anclaRef) queda afuera del menú pero no cuenta como
    // "afuera": si no, el mousedown cerraría y su click lo volvería a abrir.
    function fuera(e) {
      if (ref.current?.contains(e.target) || anclaRef?.current?.contains(e.target)) return;
      onCerrar();
    }
    function esc(e) {
      if (e.key === 'Escape') onCerrar();
    }
    document.addEventListener('mousedown', fuera);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', fuera);
      document.removeEventListener('keydown', esc);
    };
  }, [onCerrar, anclaRef]);
  const mia = m.reacciones?.find((r) => r.usernames.includes(yo))?.emoji;
  const item = {
    display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none',
    padding: '7px 14px', fontSize: 13.5, cursor: 'pointer', color: C.texto, whiteSpace: 'nowrap',
  };
  const hacer = (fn) => () => { onCerrar(); fn(m); };
  return (
    <div
      ref={ref}
      data-menu-chat=""
      style={{
        position: 'absolute', zIndex: 10, [propio ? 'right' : 'left']: 0, ...(arriba ? { bottom: '100%' } : { top: '100%' }),
        background: '#fff', borderRadius: 10, boxShadow: '0 4px 18px rgba(11,20,26,.22)', padding: '6px 0', minWidth: 190,
        whiteSpace: 'normal',
      }}
    >
      <div style={{ display: 'flex', gap: 2, padding: '2px 8px 6px', borderBottom: '1px solid #eef0f2' }}>
        {REACCIONES_RAPIDAS.map((e) => (
          <button
            key={e}
            type="button"
            onClick={() => { onCerrar(); onReaccionar(m, e); }}
            title={mia === e ? 'Quitar reacción' : `Reaccionar ${e}`}
            style={{
              fontSize: 20, background: mia === e ? '#e7f7ee' : 'none', border: 'none', cursor: 'pointer',
              borderRadius: 999, padding: '2px 4px', lineHeight: 1.2,
            }}
          >
            {e}
          </button>
        ))}
      </div>
      <button type="button" style={item} onClick={hacer(onResponder)}>↩️ Responder</button>
      {m.texto && <button type="button" style={item} onClick={hacer(onCopiar)}>📋 Copiar texto</button>}
      {propio && m.texto != null && <button type="button" style={item} onClick={hacer(onEditar)}>✏️ Editar</button>}
      {propio && <button type="button" style={{ ...item, color: '#b3261e' }} onClick={hacer(onEliminar)}>🗑️ Eliminar</button>}
    </div>
  );
}

export default function ChatBurbuja({
  m, propio, inicioDeTanda, lecturas, otrosMiembros, miembrosSet, yo, resaltado,
  menuAbierto, onMenu, onMediaLoad, onResponder, onReaccionar, onCopiar, onEditar, onEliminar, onIrACita,
}) {
  const [hover, setHover] = useState(false);
  const [arriba, setArriba] = useState(false);
  const wrapRef = useRef(null);
  const botonMenuRef = useRef(null);
  const soloMedia = !m.texto && m.adjuntos.length > 0 && !m.responde_a;

  function abrirMenu() {
    const r = wrapRef.current?.getBoundingClientRect();
    setArriba(!!r && r.bottom > window.innerHeight * 0.55);
    onMenu(m.id);
  }

  return (
    <div
      data-msg-id={m.id}
      style={{ display: 'flex', flexDirection: 'column', alignItems: propio ? 'flex-end' : 'flex-start', marginTop: inicioDeTanda ? 8 : 2 }}
    >
      <div style={{ display: 'flex', justifyContent: propio ? 'flex-end' : 'flex-start', gap: 6, width: '100%' }}>
        {!propio && (
          <div style={{ width: 28, flex: '0 0 auto' }}>
            {inicioDeTanda && <UserAvatar username={m.autor_username} size={28} />}
          </div>
        )}
        <div
          ref={wrapRef}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          onTouchStart={() => setHover(true)}
          style={{
            position: 'relative', maxWidth: 'min(75%, 560px)', background: propio ? C.propio : C.ajeno, color: C.texto,
            borderRadius: 8, borderTopRightRadius: propio && inicioDeTanda ? 0 : 8,
            borderTopLeftRadius: !propio && inicioDeTanda ? 0 : 8,
            padding: soloMedia ? 4 : '6px 9px 4px',
            boxShadow: resaltado ? '0 0 0 3px rgba(83,189,235,.8)' : '0 1px 0.5px rgba(11,20,26,.13)',
            transition: 'box-shadow .3s',
            fontSize: 14, lineHeight: 1.35, wordBreak: 'break-word', whiteSpace: 'pre-wrap',
            display: 'flex', flexDirection: 'column', gap: 4,
          }}
        >
          {!m.eliminado && (hover || menuAbierto) && (
            <button
              ref={botonMenuRef}
              type="button"
              onClick={() => (menuAbierto ? onMenu(null) : abrirMenu())}
              title="Más opciones"
              aria-label="Más opciones"
              style={{
                position: 'absolute', top: 2, right: 2, zIndex: 2, width: 24, height: 22, border: 'none', borderRadius: 6,
                background: propio ? 'rgba(217,253,211,.95)' : 'rgba(255,255,255,.95)', cursor: 'pointer', color: C.suave, fontSize: 13,
              }}
            >
              ⌄
            </button>
          )}
          {menuAbierto && (
            <MenuAcciones
              m={m} propio={propio} yo={yo} arriba={arriba} anclaRef={botonMenuRef} onCerrar={() => onMenu(null)}
              onResponder={onResponder} onReaccionar={onReaccionar} onCopiar={onCopiar} onEditar={onEditar} onEliminar={onEliminar}
            />
          )}
          {!propio && inicioDeTanda && (
            <div style={{ fontSize: 12.5, fontWeight: 700, color: colorForUsername(m.autor_username), padding: soloMedia ? '2px 5px 0' : 0, paddingRight: 22 }}>
              {m.autor_username}
            </div>
          )}
          {m.eliminado ? (
            <div style={{ color: C.suave, fontStyle: 'italic', paddingRight: 4 }}>
              🚫 {propio ? 'Eliminaste este mensaje' : 'Este mensaje fue eliminado'}
            </div>
          ) : (
            <>
              {m.responde_a && <CitaMensaje c={m.responde_a} yo={yo} onClick={() => onIrACita(m.responde_a.id)} />}
              {m.adjuntos.map((a, i) => <Adjunto key={i} a={a} onMediaLoad={onMediaLoad} />)}
              {m.texto && <div><TextoMensaje texto={m.texto} miembrosSet={miembrosSet} yo={yo} /></div>}
            </>
          )}
          <div style={{ alignSelf: 'flex-end', fontSize: 11, color: C.suave, marginTop: -2, padding: soloMedia ? '0 5px 2px' : 0 }}>
            {m.editado_at && <span style={{ marginRight: 4, fontStyle: 'italic' }}>editado</span>}
            {formatHora(m.created_at)}
            {propio && !m.eliminado && <Tildes m={m} lecturas={lecturas} otrosMiembros={otrosMiembros} />}
          </div>
        </div>
      </div>
      <div style={{ paddingLeft: propio ? 0 : 34 }}>
        <Reacciones reacciones={m.reacciones} yo={yo} propio={propio} onToggle={(emoji) => onReaccionar(m, emoji)} />
      </div>
    </div>
  );
}

// Burbuja de un mensaje propio que todavía no confirmó el servidor: se
// muestra al instante con 🕓 (y barra de progreso si lleva archivos); si
// falla, queda con ⚠ y la opción de reintentar o descartar.
export function BurbujaEnvio({ envio, miembrosSet, yo, onReintentar, onDescartar }) {
  const conArchivos = envio.archivos.length > 0;
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
      <div
        style={{
          maxWidth: 'min(75%, 560px)', background: C.propio, color: C.texto, borderRadius: 8,
          padding: '6px 9px 4px', boxShadow: '0 1px 0.5px rgba(11,20,26,.13)', opacity: envio.estado === 'error' ? 1 : 0.85,
          fontSize: 14, lineHeight: 1.35, wordBreak: 'break-word', whiteSpace: 'pre-wrap',
          display: 'flex', flexDirection: 'column', gap: 4,
        }}
      >
        {envio.respondeA && <CitaMensaje c={envio.respondeA} yo={yo} />}
        {envio.archivos.map((p, i) => (p.previewUrl
          ? <img key={i} src={p.previewUrl} alt={p.file.name} style={{ maxWidth: MEDIA_MAX, maxHeight: 320, minWidth: 48, minHeight: 48, objectFit: 'cover', borderRadius: 6, display: 'block' }} />
          : <ChipArchivo key={i} nombre={p.file.name} tamano={p.file.size} />))}
        {envio.texto && <div><TextoMensaje texto={envio.texto} miembrosSet={miembrosSet} yo={yo} /></div>}
        {conArchivos && envio.estado === 'enviando' && (
          <div title={envio.progreso >= 100 ? 'Procesando…' : `Subiendo ${envio.progreso}%`} style={{ height: 4, borderRadius: 2, background: 'rgba(0,0,0,.08)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${envio.progreso}%`, background: 'var(--brand, #008241)', transition: 'width .2s' }} />
          </div>
        )}
        {envio.estado === 'error' ? (
          <div style={{ fontSize: 12, color: '#b3261e', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', whiteSpace: 'normal' }}>
            <span>⚠ {envio.error || 'No se envió'}</span>
            <button type="button" onClick={() => onReintentar(envio)} style={{ background: 'none', border: 'none', color: C.link, cursor: 'pointer', fontWeight: 700, padding: 0 }}>Reintentar</button>
            <button type="button" onClick={() => onDescartar(envio)} style={{ background: 'none', border: 'none', color: C.suave, cursor: 'pointer', padding: 0 }}>Descartar</button>
          </div>
        ) : (
          <div style={{ alignSelf: 'flex-end', fontSize: 11, color: C.suave, marginTop: -2 }} title="Enviando…">
            {conArchivos && envio.progreso < 100 ? `${envio.progreso}% · ` : ''}{formatHora(envio.created_at)} 🕓
          </div>
        )}
      </div>
    </div>
  );
}
