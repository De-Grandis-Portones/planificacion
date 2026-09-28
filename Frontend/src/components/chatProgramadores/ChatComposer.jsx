// src/components/chatProgramadores/ChatComposer.jsx — barra para escribir del
// Chat de Programadores: texto que crece, emojis, adjuntos (📎 o Ctrl+V),
// autocompletado de @menciones y las barras de "Respondiendo a…" /
// "Editando mensaje". El envío en sí lo resuelve la página.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { colorForUsername } from '../../utils/userAvatar';
import { CitaMensaje } from './ChatBurbuja';
import { C, EMOJIS, iconoArchivo } from './chatComun';

const botonIcono = {
  background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, lineHeight: 1,
  padding: 6, borderRadius: 999, color: '#54656f', flex: '0 0 auto',
};

// "@par|" justo antes del cursor -> { inicio, query }
function mencionEnCurso(valor, cursor) {
  const m = valor.slice(0, cursor).match(/(^|[\s(])@([A-Za-z0-9._-]*)$/);
  if (!m) return null;
  return { inicio: cursor - m[2].length - 1, query: m[2].toLowerCase() };
}

function BarraContexto({ children, onCerrar, titulo }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px 0', background: '#f0f2f5' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {titulo && <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--brand, #008241)', marginBottom: 2 }}>{titulo}</div>}
        {children}
      </div>
      <button type="button" onClick={onCerrar} title="Cancelar (Esc)" style={{ ...botonIcono, fontSize: 18 }}>✕</button>
    </div>
  );
}

export default function ChatComposer({
  texto, setTexto, inputRef, deshabilitado, yo, miembros,
  pendientes, onAgregarArchivos, onQuitarPendiente,
  respondiendoA, onCancelarRespuesta, editando, onCancelarEdicion, onEditarUltimo,
  onEnviar,
}) {
  const [mostrarEmojis, setMostrarEmojis] = useState(false);
  const [mencion, setMencion] = useState(null); // { inicio, query, indice }
  const emojiRef = useRef(null);
  const fileInputRef = useRef(null);

  const sugerencias = mencion
    ? miembros.filter((u) => u.toLowerCase().includes(mencion.query)).slice(0, 6)
    : [];
  const mostrarSugerencias = sugerencias.length > 0;

  useEffect(() => {
    if (!mostrarEmojis) return undefined;
    function fuera(e) {
      if (emojiRef.current && !emojiRef.current.contains(e.target)) setMostrarEmojis(false);
    }
    document.addEventListener('mousedown', fuera);
    return () => document.removeEventListener('mousedown', fuera);
  }, [mostrarEmojis]);

  // textarea que crece con el texto, hasta ~6 líneas
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [texto, inputRef]);

  function reemplazarEnCursor(ini, fin, insertar) {
    const el = inputRef.current;
    setTexto(texto.slice(0, ini) + insertar + texto.slice(fin));
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = ini + insertar.length;
      el.setSelectionRange(pos, pos);
    });
  }

  function insertarEmoji(emoji) {
    const el = inputRef.current;
    const ini = el?.selectionStart ?? texto.length;
    const fin = el?.selectionEnd ?? texto.length;
    reemplazarEnCursor(ini, fin, emoji);
  }

  function elegirMencion(username) {
    const el = inputRef.current;
    const cursor = el?.selectionStart ?? texto.length;
    reemplazarEnCursor(mencion.inicio, cursor, `@${username} `);
    setMencion(null);
  }

  function actualizarMencion(e) {
    const el = e.target;
    const m = mencionEnCurso(el.value, el.selectionStart ?? el.value.length);
    setMencion((prev) => (m ? { ...m, indice: prev && prev.query === m.query ? prev.indice : 0 } : null));
  }

  function onKeyDown(e) {
    if (mostrarSugerencias) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        setMencion((m) => ({ ...m, indice: (m.indice + delta + sugerencias.length) % sugerencias.length }));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        elegirMencion(sugerencias[Math.min(mencion.indice, sugerencias.length - 1)]);
        return;
      }
    }
    if (e.key === 'Escape') {
      if (mostrarSugerencias) setMencion(null);
      else if (mostrarEmojis) setMostrarEmojis(false);
      else if (editando) onCancelarEdicion();
      else if (respondiendoA) onCancelarRespuesta();
      return;
    }
    // Como WhatsApp Web: ↑ con la caja vacía edita tu último mensaje.
    if (e.key === 'ArrowUp' && !texto && !editando && !pendientes.length) {
      if (onEditarUltimo()) e.preventDefault();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      setMostrarEmojis(false);
      onEnviar();
    }
  }

  function onPaste(e) {
    const files = Array.from(e.clipboardData?.files || []);
    if (files.length && !editando) {
      e.preventDefault();
      onAgregarArchivos(files);
    }
  }

  const puedeEnviar = !deshabilitado && (texto.trim() || (!editando && pendientes.length));

  return (
    <>
      {editando && (
        <BarraContexto titulo="✏️ Editando mensaje" onCerrar={onCancelarEdicion}>
          <div style={{ fontSize: 12.5, color: C.suave, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {editando.texto}
          </div>
        </BarraContexto>
      )}
      {!editando && respondiendoA && (
        <BarraContexto onCerrar={onCancelarRespuesta}>
          <CitaMensaje c={respondiendoA} yo={yo} />
        </BarraContexto>
      )}

      {!editando && pendientes.length > 0 && (
        <div style={{ display: 'flex', gap: 8, padding: '8px 12px', background: '#f0f2f5', borderTop: '1px solid #d1d7db', overflowX: 'auto' }}>
          {pendientes.map((p, i) => (
            <div key={i} style={{ position: 'relative', flex: '0 0 auto' }}>
              {p.previewUrl ? (
                <img src={p.previewUrl} alt={p.file.name} title={p.file.name} style={{ height: 64, width: 64, objectFit: 'cover', borderRadius: 6, display: 'block' }} />
              ) : (
                <div title={p.file.name} style={{ height: 64, width: 120, borderRadius: 6, background: '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 4, gap: 2 }}>
                  <span style={{ fontSize: 22 }}>{iconoArchivo(p.file.name)}</span>
                  <span style={{ fontSize: 10, maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.file.name}</span>
                </div>
              )}
              <button
                type="button"
                onClick={() => onQuitarPendiente(i)}
                title="Quitar"
                style={{ position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: '50%', border: 'none', background: '#54656f', color: '#fff', cursor: 'pointer', fontSize: 12, lineHeight: '20px', padding: 0 }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-end', gap: 4, padding: '8px 10px', background: '#f0f2f5' }}>
        {mostrarSugerencias && (
          <div
            role="listbox"
            style={{
              position: 'absolute', bottom: '100%', left: 96, zIndex: 6, minWidth: 200, marginBottom: 4,
              background: '#fff', border: '1px solid var(--border)', borderRadius: 10, boxShadow: '0 4px 16px rgba(0,0,0,.15)', padding: 4,
            }}
          >
            {sugerencias.map((u, i) => (
              <div
                key={u}
                role="option"
                aria-selected={i === mencion.indice}
                onMouseDown={(e) => { e.preventDefault(); elegirMencion(u); }}
                style={{
                  padding: '6px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 13.5,
                  background: i === mencion.indice ? '#f0f2f5' : 'transparent', color: colorForUsername(u), fontWeight: 600,
                }}
              >
                @{u}
              </div>
            ))}
          </div>
        )}
        <div ref={emojiRef} style={{ position: 'relative' }}>
          <button type="button" style={botonIcono} onClick={() => setMostrarEmojis((v) => !v)} title="Emojis">😊</button>
          {mostrarEmojis && (
            <div
              style={{
                position: 'absolute', bottom: 46, left: 0, zIndex: 5, width: 300, padding: 8,
                background: '#fff', border: '1px solid var(--border)', borderRadius: 10, boxShadow: '0 4px 16px rgba(0,0,0,.15)',
                display: 'grid', gridTemplateColumns: 'repeat(10, 1fr)', gap: 2,
              }}
            >
              {EMOJIS.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => insertarEmoji(e)}
                  style={{ fontSize: 20, background: 'none', border: 'none', cursor: 'pointer', padding: 2, borderRadius: 4 }}
                >
                  {e}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          style={{ ...botonIcono, visibility: editando ? 'hidden' : 'visible' }}
          onClick={() => fileInputRef.current?.click()}
          title="Adjuntar imágenes o archivos"
        >
          📎
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => { onAgregarArchivos(e.target.files); e.target.value = ''; }}
        />
        <textarea
          ref={inputRef}
          rows={1}
          value={texto}
          onChange={(e) => { setTexto(e.target.value); actualizarMencion(e); }}
          onSelect={actualizarMencion}
          onBlur={() => setMencion(null)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          disabled={deshabilitado}
          placeholder={editando ? 'Editá el mensaje' : 'Escribí un mensaje (@ para mencionar)'}
          style={{
            flex: '1 1 auto', resize: 'none', border: 'none', outline: 'none', borderRadius: 8,
            padding: '10px 12px', fontSize: 14, lineHeight: 1.35, fontFamily: 'inherit',
            background: '#fff', color: C.texto, maxHeight: 140, margin: '0 4px',
          }}
        />
        <button
          type="button"
          onClick={() => { setMostrarEmojis(false); onEnviar(); }}
          disabled={!puedeEnviar}
          title={editando ? 'Guardar (Enter)' : 'Enviar (Enter)'}
          style={{
            width: 42, height: 42, borderRadius: '50%', border: 'none', flex: '0 0 auto',
            background: puedeEnviar ? 'var(--brand, #008241)' : '#b8c4cb', color: '#fff',
            cursor: puedeEnviar ? 'pointer' : 'default', fontSize: 18,
          }}
        >
          {editando ? '✓' : '➤'}
        </button>
      </div>
    </>
  );
}
