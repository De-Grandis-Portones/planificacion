// src/components/chatProgramadores/ChatProgramadoresProvider.jsx
//
// Canal en tiempo real del Chat de Programadores, uno por pestaña. Vive en
// NonProductionLayout (envuelve todas las pantallas admin) para avisar de
// mensajes nuevos estés donde estés:
// - contador de no leídos (lo usan el botón del encabezado y el Índice),
// - aviso emergente abajo a la izquierda (abajo a la derecha ya está el de
//   WhatsApp de Logística),
// - "(N)" en el título de la pestaña,
// - notificación del sistema con la pestaña en segundo plano, si se dio
//   permiso (se pide desde el encabezado del chat).
//
// El canal (SSE, GET /admin/programadores/chat/stream) se abre solo con la
// pestaña visible: los navegadores permiten ~6 conexiones abiertas por
// servidor y con varias pestañas de la app abiertas se agotarían. Con la
// pestaña oculta se cierra y se revisa el contador cada 30s.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { API_BASE_URL, getAdminToken, fetchProgramadoresChatNoLeidos } from '../../api';
import { getCurrentAdminUsername } from '../../utils/adminScopes';
import { colorForUsername } from '../../utils/userAvatar';
import { ChatProgramadoresContext } from './chatContexto';
import { RUTA_CHAT, puedeUsarChat, previewDe, resumenDe, mencionaA } from './chatComun';

const POLL_OCULTO_MS = 30000;
const REFRESCO_VISIBLE_MS = 60000;
const TOAST_MS = 8000;
const MAX_TOASTS = 3;

function tituloSinContador(t) {
  return String(t || '').replace(/^\(\d+\+?\)\s*/, '');
}

export default function ChatProgramadoresProvider({ children }) {
  const habilitado = puedeUsarChat();
  const yo = getCurrentAdminUsername() || '';
  const nav = useNavigate();
  const { pathname } = useLocation();
  const enChatRef = useRef(false);
  enChatRef.current = pathname === RUTA_CHAT;

  const [noLeidos, setNoLeidos] = useState(0);
  const [conectado, setConectado] = useState(false);
  const [toasts, setToasts] = useState([]);
  const suscriptoresRef = useRef(new Set());
  const conteoRef = useRef(null); // último count conocido; null = todavía no hay línea de base

  const suscribir = useCallback((fn) => {
    suscriptoresRef.current.add(fn);
    return () => suscriptoresRef.current.delete(fn);
  }, []);

  const refrescarNoLeidos = useCallback(async () => {
    try {
      const { data } = await fetchProgramadoresChatNoLeidos();
      const count = Number(data?.count) || 0;
      const anterior = conteoRef.current;
      conteoRef.current = count;
      setNoLeidos(count);
      return { count, anterior, ultimo: data?.ultimo || null };
    } catch {
      return null;
    }
  }, []);

  const quitarToast = useCallback((id) => setToasts((prev) => prev.filter((t) => t.id !== id)), []);

  const notificarSistema = useCallback((titulo, cuerpo) => {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    try {
      const n = new Notification(titulo, { body: cuerpo, tag: 'chat-programadores', icon: '/Favicon.ico' });
      n.onclick = () => {
        window.focus();
        nav(RUTA_CHAT);
        n.close();
      };
    } catch {
      // algunos navegadores (Chrome en Android) solo permiten notificaciones desde un service worker
    }
  }, [nav]);

  // Siempre la versión más nueva (lee pathname/yo actuales) sin reabrir el canal.
  const recibirRef = useRef(null);
  recibirRef.current = (ev) => {
    for (const fn of suscriptoresRef.current) {
      try {
        fn(ev);
      } catch (err) {
        console.error('chat programadores: error en suscriptor', err);
      }
    }
    if (ev.tipo === 'mensaje' && ev.mensaje && ev.mensaje.autor_username !== yo) {
      const leyendo = enChatRef.current && !document.hidden;
      if (leyendo) return; // la página del chat lo marca como leído sola
      conteoRef.current = (conteoRef.current || 0) + 1;
      setNoLeidos(conteoRef.current);
      const m = ev.mensaje;
      const mencion = mencionaA(m.texto, yo);
      const preview = previewDe(resumenDe(m));
      if (document.hidden) {
        notificarSistema(mencion ? `${m.autor_username} te mencionó` : `${m.autor_username} · Programadores`, preview);
      } else if (!enChatRef.current) {
        setToasts((prev) => [...prev.filter((t) => t.id !== m.id), { id: m.id, autor: m.autor_username, preview, mencion }].slice(-MAX_TOASTS));
        if (!mencion) setTimeout(() => quitarToast(m.id), TOAST_MS);
      }
    }
    if (ev.tipo === 'lectura' && ev.username === yo) refrescarNoLeidos();
  };

  // Con la pestaña oculta (canal cerrado): si subió el contador, notificación del sistema.
  const revisarEnSegundoPlanoRef = useRef(null);
  revisarEnSegundoPlanoRef.current = async () => {
    const r = await refrescarNoLeidos();
    if (!r || r.anterior == null || r.count <= r.anterior || !r.ultimo) return;
    const nuevos = r.count - r.anterior;
    const mencion = mencionaA(r.ultimo.texto, yo);
    const titulo = mencion
      ? `${r.ultimo.autor_username} te mencionó`
      : nuevos === 1 ? `${r.ultimo.autor_username} · Programadores` : `${nuevos} mensajes nuevos · Programadores`;
    notificarSistema(titulo, `${nuevos > 1 ? `${r.ultimo.autor_username}: ` : ''}${previewDe(r.ultimo)}`);
  };

  useEffect(() => {
    if (!habilitado) return undefined;
    let cancel = false;
    let controller = null;
    let reintento = null;
    let espera = 1000;
    let abierto = false;
    let pollOculto = null;

    async function abrir() {
      if (cancel || abierto || document.hidden) return;
      abierto = true;
      controller = new AbortController();
      let reintentar = true;
      try {
        const resp = await fetch(`${API_BASE_URL}/admin/programadores/chat/stream`, {
          headers: { Authorization: `Bearer ${getAdminToken()}` },
          signal: controller.signal,
          cache: 'no-store',
        });
        if (resp.status === 401 || resp.status === 403) {
          reintentar = false; // sesión vencida o sin permiso: no insistir
          return;
        }
        if (!resp.ok || !resp.body) throw new Error(`stream ${resp.status}`);
        espera = 1000;
        setConectado(true);
        recibirRef.current({ tipo: 'conectado' });
        refrescarNoLeidos();
        const reader = resp.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let corte = buffer.indexOf('\n\n');
          while (corte >= 0) {
            const bloque = buffer.slice(0, corte);
            buffer = buffer.slice(corte + 2);
            const data = bloque.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
            if (data) {
              try {
                recibirRef.current(JSON.parse(data));
              } catch {
                // evento mal formado: se ignora
              }
            }
            corte = buffer.indexOf('\n\n');
          }
        }
      } catch (err) {
        if (err?.name === 'AbortError') reintentar = false;
      } finally {
        abierto = false;
        setConectado(false);
      }
      if (reintentar && !cancel && !document.hidden) {
        reintento = setTimeout(abrir, espera);
        espera = Math.min(espera * 2, 30000);
      }
    }

    function onVisibilidad() {
      if (document.hidden) {
        controller?.abort();
        clearTimeout(reintento);
        if (!pollOculto) pollOculto = setInterval(() => revisarEnSegundoPlanoRef.current(), POLL_OCULTO_MS);
      } else {
        clearInterval(pollOculto);
        pollOculto = null;
        espera = 1000;
        refrescarNoLeidos();
        abrir();
      }
    }

    refrescarNoLeidos();
    abrir();
    if (document.hidden) onVisibilidad();
    const refresco = setInterval(() => { if (!document.hidden) refrescarNoLeidos(); }, REFRESCO_VISIBLE_MS);
    document.addEventListener('visibilitychange', onVisibilidad);
    return () => {
      cancel = true;
      controller?.abort();
      clearTimeout(reintento);
      clearInterval(pollOculto);
      clearInterval(refresco);
      document.removeEventListener('visibilitychange', onVisibilidad);
    };
  }, [habilitado, refrescarNoLeidos]);

  // "(N)" en el título de la pestaña.
  useEffect(() => {
    if (!habilitado) return;
    const base = tituloSinContador(document.title);
    document.title = noLeidos > 0 ? `(${noLeidos > 99 ? '99+' : noLeidos}) ${base}` : base;
  }, [habilitado, noLeidos]);
  useEffect(() => () => { document.title = tituloSinContador(document.title); }, []);

  // Al entrar al chat, los avisos emergentes ya no hacen falta.
  useEffect(() => {
    if (pathname === RUTA_CHAT) setToasts([]);
  }, [pathname]);

  const valor = useMemo(
    () => ({ habilitado, noLeidos, conectado, suscribir, refrescarNoLeidos }),
    [habilitado, noLeidos, conectado, suscribir, refrescarNoLeidos]
  );

  return (
    <ChatProgramadoresContext.Provider value={valor}>
      {children}
      {toasts.length > 0 && (
        <div style={{ position: 'fixed', bottom: 16, left: 16, zIndex: 20000, display: 'flex', flexDirection: 'column', gap: 8, width: 'min(320px, calc(100vw - 32px))' }}>
          {toasts.map((t) => (
            <div
              key={t.id}
              role="button"
              tabIndex={0}
              onClick={() => { quitarToast(t.id); nav(RUTA_CHAT); }}
              onKeyDown={(e) => { if (e.key === 'Enter') { quitarToast(t.id); nav(RUTA_CHAT); } }}
              style={{
                background: 'var(--surface, #fff)', border: '1px solid var(--border, #d1d5db)',
                borderLeft: `4px solid ${t.mencion ? '#f59e0b' : 'var(--brand, #008241)'}`,
                borderRadius: 10, boxShadow: '0 6px 20px rgba(0,0,0,0.22)', padding: '10px 12px', cursor: 'pointer',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11, opacity: 0.65 }}>💻 Programadores{t.mencion ? ' · te mencionó' : ''}</div>
                  <div style={{ fontWeight: 800, fontSize: 13, color: colorForUsername(t.autor), marginTop: 1 }}>{t.autor}</div>
                  <div style={{ fontSize: 12.5, opacity: 0.85, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.preview}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); quitarToast(t.id); }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', opacity: 0.5, fontSize: 14, flex: '0 0 auto' }}
                  title="Cerrar"
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </ChatProgramadoresContext.Provider>
  );
}
