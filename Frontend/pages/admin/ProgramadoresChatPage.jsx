// pages/admin/ProgramadoresChatPage.jsx
//
// Chat de Programadores: un único grupo tipo WhatsApp entre los usuarios con
// scope programadores:admin (pedido del usuario: "una nueva sección en
// Programadores que sea tipo un chat de WhatsApp"). Texto, emojis,
// @menciones, imágenes y archivos (también pegando una captura con Ctrl+V o
// arrastrando), responder citando, reacciones, editar y eliminar.
// Backend: routes/admin/programadoresChat.js.
//
// Tiempo real: los eventos llegan por el canal que abre
// ChatProgramadoresProvider (NonProductionLayout). Además hay un polling de
// respaldo: cada 30s si el canal está conectado, cada 3s si no. Solo el
// polling avanza lastIdRef: si lo movieran los eventos o el envío propio, un
// mensaje que se perdió en un corte del canal quedaría salteado.
//
// Lo que se manda aparece al instante como burbuja provisoria (🕓) hasta que
// el servidor lo confirma; se reemplaza por la real usando cliente_id.
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  fetchProgramadoresChat, enviarProgramadoresChat, marcarProgramadoresChatLeido,
  editarProgramadoresChat, eliminarProgramadoresChat, reaccionarProgramadoresChat,
} from '../../src/api';
import { getCurrentAdminUsername } from '../../src/utils/adminScopes';
import ChatBurbuja, { BurbujaEnvio } from '../../src/components/chatProgramadores/ChatBurbuja';
import ChatComposer from '../../src/components/chatProgramadores/ChatComposer';
import { useChatProgramadores } from '../../src/components/chatProgramadores/chatContexto';
import {
  C, EXTENSIONES, MAX_ARCHIVOS, MAX_BYTES, aplicarMensajes, mergeMensajes, siCambio,
  claveDia, etiquetaDia, extensionDe, formatBytes, resumenDe,
} from '../../src/components/chatProgramadores/chatComun';

const POLL_MS = 3000;
const POLL_OCULTO_MS = 15000;
const POLL_CONECTADO_MS = 30000;

function Pastilla({ children, innerRef }) {
  return (
    <div ref={innerRef} style={{ display: 'flex', justifyContent: 'center', margin: '10px 0 4px' }}>
      <span
        style={{
          background: '#fff', color: '#54656f', fontSize: 12, padding: '5px 12px', borderRadius: 8,
          boxShadow: '0 1px 0.5px rgba(11,20,26,.13)',
        }}
      >
        {children}
      </span>
    </div>
  );
}

// Aplica una reacción propia localmente (antes de que confirme el servidor).
function reaccionLocal(reacciones, yo, emoji) {
  const sinMia = (reacciones || [])
    .map((r) => ({ ...r, usernames: r.usernames.filter((u) => u !== yo) }))
    .filter((r) => r.usernames.length);
  if (!emoji) return sinMia;
  const existente = sinMia.find((r) => r.emoji === emoji);
  if (existente) existente.usernames = [...existente.usernames, yo];
  else sinMia.push({ emoji, usernames: [yo] });
  return sinMia;
}

function nuevoClienteId() {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export default function ProgramadoresChatPage() {
  const yo = useMemo(() => getCurrentAdminUsername() || '', []);
  const { suscribir, conectado } = useChatProgramadores();

  const [mensajes, setMensajes] = useState([]);
  const [hayMas, setHayMas] = useState(false);
  const [lecturas, setLecturas] = useState([]);
  const [miembros, setMiembros] = useState([]);
  const [cargando, setCargando] = useState(true);
  const [cargandoAnteriores, setCargandoAnteriores] = useState(false);
  const [error, setError] = useState('');
  const [sinAcceso, setSinAcceso] = useState(false);
  const [divisor, setDivisor] = useState(null); // { id, count, mas } de "N mensajes no leídos"

  const [texto, setTexto] = useState('');
  const [pendientes, setPendientes] = useState([]); // adjuntos elegidos: [{ file, previewUrl }]
  const [envios, setEnvios] = useState([]); // burbujas provisorias: [{ clienteId, texto, archivos, respondeA, estado, progreso, error, created_at }]
  const [respondiendoA, setRespondiendoA] = useState(null); // resumenDe(mensaje)
  const [editando, setEditando] = useState(null); // mensaje
  const [menuAbiertoId, setMenuAbiertoId] = useState(null);
  const [resaltadoId, setResaltadoId] = useState(null);
  const [errorEnvio, setErrorEnvio] = useState('');
  const [arrastrando, setArrastrando] = useState(false);
  const [lejosDelFondo, setLejosDelFondo] = useState(false);
  const [nuevosAbajo, setNuevosAbajo] = useState(0);
  const [permisoNotif, setPermisoNotif] = useState(() => (typeof Notification === 'undefined' ? 'no-soportado' : Notification.permission));

  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const divisorRef = useRef(null);
  const lastIdRef = useRef(0);
  const cambiosDesdeRef = useRef(null);
  const lastMarkedRef = useRef(0);
  const atBottomRef = useRef(true);
  const scrollProgramaticoRef = useRef(null);
  const forzarBajarRef = useRef(false);
  const restaurarScrollRef = useRef(null);
  const scrollInicialRef = useRef(false);
  const borradorRef = useRef(''); // lo que había escrito antes de ponerse a editar
  const tickRef = useRef(null);
  const conectadoRef = useRef(conectado);
  conectadoRef.current = conectado;
  const pendientesRef = useRef(pendientes);
  pendientesRef.current = pendientes;
  const mensajesRef = useRef(mensajes);
  mensajesRef.current = mensajes;
  const enviosRef = useRef(envios);
  enviosRef.current = envios;

  const otrosMiembros = useMemo(
    () => miembros.map((x) => x.username).filter((u) => u && u !== yo),
    [miembros, yo]
  );
  const miembrosSet = useMemo(() => new Set(miembros.map((x) => String(x.username).toLowerCase())), [miembros]);
  const textoMiembros = useMemo(() => {
    if (!miembros.length) return 'Chat del equipo';
    const nombres = otrosMiembros.slice();
    if (miembros.some((x) => x.username === yo)) nombres.push('Vos');
    return nombres.join(', ');
  }, [miembros, otrosMiembros, yo]);

  function bajarAlFondo() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    scrollProgramaticoRef.current = el.scrollTop;
    atBottomRef.current = true;
  }

  const quitarEnvios = useCallback((clienteIds) => {
    const ids = new Set(clienteIds);
    for (const e of enviosRef.current) {
      if (!ids.has(e.clienteId)) continue;
      for (const p of e.archivos) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
    }
    setEnvios((prev) => prev.filter((e) => !ids.has(e.clienteId)));
  }, []);

  // Mensajes nuevos o cambiados (del servidor, por evento o polling).
  const incorporar = useCallback((lista) => {
    if (!lista?.length) return;
    const ya = new Set(mensajesRef.current.map((m) => m.id));
    const deOtros = lista.filter((m) => !ya.has(m.id) && m.autor_username !== yo && !m.eliminado).length;
    if (deOtros && !atBottomRef.current) setNuevosAbajo((n) => n + deOtros);
    const confirmados = lista.map((m) => m.cliente_id).filter(Boolean);
    if (confirmados.length) quitarEnvios(confirmados);
    setMensajes((prev) => aplicarMensajes(prev, lista));
  }, [yo, quitarEnvios]);

  // Carga inicial: últimos 50 + dónde quedó leyendo (para el divisor).
  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const { data } = await fetchProgramadoresChat();
        if (cancel) return;
        const lista = data?.mensajes || [];
        const lects = data?.lecturas || [];
        setMensajes((prev) => mergeMensajes(lista, prev.filter((m) => !lista.length || m.id > lista[lista.length - 1].id)));
        setHayMas(!!data?.hayMas);
        setLecturas(lects);
        setMiembros(data?.miembros || []);
        lastIdRef.current = lista.length ? lista[lista.length - 1].id : 0;
        cambiosDesdeRef.current = data?.ahora || null;
        // Sin fila de lectura = primera vez: nada cuenta como no leído.
        const mia = lects.find((l) => l.username === yo);
        if (mia) {
          const noLeidos = lista.filter((m) => m.id > mia.ultimo_leido_id && m.autor_username !== yo && !m.eliminado);
          // Si el primero no leído es el primero de la página, puede haber
          // más atrás que no se trajeron: "50+" en vez de un número exacto.
          if (noLeidos.length) {
            const puedeHaberMas = !!data?.hayMas && noLeidos[0].id === lista[0].id;
            setDivisor({ id: noLeidos[0].id, count: noLeidos.length, mas: puedeHaberMas });
          }
        }
      } catch (err) {
        if (cancel) return;
        if (err?.response?.status === 403) setSinAcceso(true);
        else setError(err?.response?.data?.error || 'No se pudo cargar el chat');
      } finally {
        if (!cancel) setCargando(false);
      }
    })();
    return () => { cancel = true; };
  }, [yo]);

  // Polling de respaldo (lo nuevo + lo cambiado + lecturas).
  useEffect(() => {
    if (cargando || sinAcceso || error) return undefined;
    let cancel = false;
    let timer;
    let enCurso = false;
    async function tick() {
      if (enCurso) return;
      enCurso = true;
      clearTimeout(timer);
      try {
        const { data } = await fetchProgramadoresChat({ despues_de: lastIdRef.current, cambios_desde: cambiosDesdeRef.current || undefined });
        if (cancel) return;
        setLecturas(siCambio(data?.lecturas || []));
        setMiembros(siCambio(data?.miembros || []));
        const lista = data?.mensajes || [];
        if (lista.length) lastIdRef.current = Math.max(lastIdRef.current, ...lista.map((m) => m.id));
        if (data?.ahora) cambiosDesdeRef.current = data.ahora;
        incorporar(lista);
      } catch {
        // silencioso: el 401 lo maneja el interceptor global, lo demás se reintenta
      } finally {
        enCurso = false;
        if (!cancel) {
          const ms = conectadoRef.current ? POLL_CONECTADO_MS : document.hidden ? POLL_OCULTO_MS : POLL_MS;
          timer = setTimeout(tick, ms);
        }
      }
    }
    tickRef.current = tick;
    timer = setTimeout(tick, conectadoRef.current ? POLL_CONECTADO_MS : POLL_MS);
    return () => { cancel = true; clearTimeout(timer); tickRef.current = null; };
  }, [cargando, sinAcceso, error, incorporar]);

  // Eventos en tiempo real.
  useEffect(() => suscribir((ev) => {
    if ((ev.tipo === 'mensaje' || ev.tipo === 'cambio') && ev.mensaje) {
      incorporar([ev.mensaje]);
    } else if (ev.tipo === 'lectura') {
      setLecturas((prev) => {
        const actual = prev.find((l) => l.username === ev.username);
        if (actual && actual.ultimo_leido_id >= ev.ultimo_leido_id) return prev;
        return [...prev.filter((l) => l.username !== ev.username), { username: ev.username, ultimo_leido_id: ev.ultimo_leido_id }];
      });
    } else if (ev.tipo === 'conectado') {
      // (re)conectó: ponerse al día con lo que pudo pasar mientras estaba cortado
      tickRef.current?.();
    }
  }), [suscribir, incorporar]);

  // Marcar leído hasta el último mientras la pestaña esté visible.
  useEffect(() => {
    if (!mensajes.length) return undefined;
    const maxId = mensajes[mensajes.length - 1].id;
    function marcar() {
      if (document.hidden || maxId <= lastMarkedRef.current) return;
      lastMarkedRef.current = maxId;
      marcarProgramadoresChatLeido(maxId).catch(() => { lastMarkedRef.current = 0; });
    }
    marcar();
    document.addEventListener('visibilitychange', marcar);
    return () => document.removeEventListener('visibilitychange', marcar);
  }, [mensajes]);

  // Scroll: al abrir va al divisor (o al fondo); después sigue al fondo solo
  // si ya estaba abajo; al cargar anteriores conserva la posición.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (restaurarScrollRef.current != null) {
      el.scrollTop = el.scrollHeight - restaurarScrollRef.current;
      restaurarScrollRef.current = null;
      return;
    }
    if (!scrollInicialRef.current) {
      if (cargando || !mensajes.length) return;
      scrollInicialRef.current = true;
      if (divisorRef.current) {
        // no scrollIntoView: movería también la página, no solo la lista
        el.scrollTop += divisorRef.current.getBoundingClientRect().top - el.getBoundingClientRect().top - 8;
      } else {
        bajarAlFondo();
      }
      return;
    }
    if (forzarBajarRef.current || atBottomRef.current) {
      forzarBajarRef.current = false;
      bajarAlFondo();
    }
  }, [mensajes, envios, cargando]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    // El evento del scroll que hizo bajarAlFondo() puede llegar DESPUÉS de
    // que una imagen terminó de cargar y agrandó la lista: medido ahí
    // parecería que el usuario subió, y el chat dejaría de seguir al fondo.
    if (scrollProgramaticoRef.current != null && Math.abs(el.scrollTop - scrollProgramaticoRef.current) < 2) {
      setLejosDelFondo(false);
      return;
    }
    scrollProgramaticoRef.current = null;
    const abajo = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    atBottomRef.current = abajo;
    setLejosDelFondo(!abajo);
    if (abajo) setNuevosAbajo(0);
  }

  function onMediaLoad() {
    if (atBottomRef.current) bajarAlFondo();
  }

  async function cargarAnteriores() {
    if (!mensajes.length || cargandoAnteriores) return;
    setCargandoAnteriores(true);
    try {
      const { data } = await fetchProgramadoresChat({ antes_de: mensajes[0].id });
      const el = scrollRef.current;
      restaurarScrollRef.current = el ? el.scrollHeight - el.scrollTop : null;
      setMensajes((prev) => mergeMensajes(prev, data?.mensajes || []));
      setHayMas(!!data?.hayMas);
    } catch (err) {
      setErrorEnvio(err?.response?.data?.error || 'No se pudieron cargar los mensajes anteriores');
    } finally {
      setCargandoAnteriores(false);
    }
  }

  // ---- adjuntos elegidos ----
  function agregarArchivos(lista) {
    const files = Array.from(lista || []);
    if (!files.length || editando) return;
    const actuales = pendientesRef.current;
    const nuevos = [];
    for (const f of files) {
      let file = f;
      // Captura pegada con Ctrl+V: llega como "image.png" - nombre más útil.
      if (/^image\.(png|jpe?g|gif|webp)$/i.test(file.name)) {
        const ext = extensionDe(file.name);
        const hora = new Date().toLocaleTimeString('es-AR', { hour12: false }).replace(/:/g, '-');
        file = new File([file], `captura-${hora}.${ext}`, { type: file.type });
      }
      if (!EXTENSIONES.has(extensionDe(file.name))) {
        setErrorEnvio(`Tipo de archivo no permitido: ${file.name}`);
        continue;
      }
      if (file.size > MAX_BYTES) {
        setErrorEnvio(`"${file.name}" pesa ${formatBytes(file.size)} - el máximo es ${formatBytes(MAX_BYTES)}`);
        continue;
      }
      if (actuales.length + nuevos.length >= MAX_ARCHIVOS) {
        setErrorEnvio(`Máximo ${MAX_ARCHIVOS} archivos por mensaje`);
        break;
      }
      const previewUrl = file.type.startsWith('image/') && extensionDe(file.name) !== 'heic' ? URL.createObjectURL(file) : null;
      nuevos.push({ file, previewUrl });
    }
    if (nuevos.length) setPendientes([...actuales, ...nuevos]);
    inputRef.current?.focus();
  }

  function quitarPendiente(idx) {
    const p = pendientesRef.current[idx];
    if (p?.previewUrl) URL.revokeObjectURL(p.previewUrl);
    setPendientes((prev) => prev.filter((_, i) => i !== idx));
  }

  useEffect(() => () => {
    for (const p of pendientesRef.current) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
    for (const e of enviosRef.current) for (const p of e.archivos) if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
  }, []);

  // ---- enviar (con burbuja provisoria) ----
  function actualizarEnvio(clienteId, cambios) {
    setEnvios((prev) => prev.map((e) => (e.clienteId === clienteId ? { ...e, ...cambios } : e)));
  }

  async function mandar(envio) {
    actualizarEnvio(envio.clienteId, { estado: 'enviando', progreso: 0, error: '' });
    try {
      const { data } = await enviarProgramadoresChat({
        texto: envio.texto,
        archivos: envio.archivos.map((p) => p.file),
        respondeAId: envio.respondeA?.id,
        clienteId: envio.clienteId,
        onProgreso: (p) => actualizarEnvio(envio.clienteId, { progreso: p }),
      });
      forzarBajarRef.current = true;
      incorporar([data.mensaje]);
    } catch (err) {
      actualizarEnvio(envio.clienteId, { estado: 'error', error: err?.response?.data?.error || 'No se pudo enviar' });
    }
  }

  function enviar() {
    if (editando) {
      guardarEdicion();
      return;
    }
    const t = texto.trim();
    if (!t && !pendientes.length) return;
    const envio = {
      clienteId: nuevoClienteId(),
      texto: t,
      archivos: pendientes,
      respondeA: respondiendoA,
      estado: 'enviando',
      progreso: 0,
      error: '',
      created_at: new Date().toISOString(),
    };
    forzarBajarRef.current = true;
    setEnvios((prev) => [...prev, envio]);
    setTexto('');
    setPendientes([]);
    setRespondiendoA(null);
    setDivisor(null);
    setNuevosAbajo(0);
    setErrorEnvio('');
    mandar(envio);
    inputRef.current?.focus();
  }

  // ---- acciones sobre un mensaje ----
  function responder(m) {
    if (editando) cancelarEdicion();
    setRespondiendoA(resumenDe(m));
    inputRef.current?.focus();
  }

  function editar(m) {
    if (!editando) borradorRef.current = texto;
    setRespondiendoA(null);
    setEditando(m);
    setTexto(m.texto || '');
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }

  function cancelarEdicion() {
    setEditando(null);
    setTexto(borradorRef.current);
    borradorRef.current = '';
  }

  // ↑ con la caja vacía: editar el último mensaje propio (como WhatsApp Web).
  function editarUltimo() {
    const ultimo = [...mensajes].reverse().find((m) => m.autor_username === yo && !m.eliminado && m.texto);
    if (!ultimo) return false;
    editar(ultimo);
    return true;
  }

  async function guardarEdicion() {
    const m = editando;
    const t = texto.trim();
    if (!m) return;
    if (!t && !m.adjuntos.length) {
      setErrorEnvio('El mensaje no puede quedar vacío (para sacarlo, usá Eliminar)');
      return;
    }
    if (t === (m.texto || '')) {
      cancelarEdicion();
      return;
    }
    try {
      const { data } = await editarProgramadoresChat(m.id, t);
      incorporar([data.mensaje]);
      cancelarEdicion();
    } catch (err) {
      setErrorEnvio(err?.response?.data?.error || 'No se pudo editar el mensaje');
    }
  }

  async function eliminar(m) {
    if (!window.confirm('¿Eliminar este mensaje? Para todos va a quedar "Este mensaje fue eliminado".')) return;
    try {
      const { data } = await eliminarProgramadoresChat(m.id);
      incorporar([data.mensaje]);
      if (editando?.id === m.id) cancelarEdicion();
      if (respondiendoA?.id === m.id) setRespondiendoA(null);
    } catch (err) {
      setErrorEnvio(err?.response?.data?.error || 'No se pudo eliminar el mensaje');
    }
  }

  async function reaccionar(m, emoji) {
    const actual = mensajesRef.current.find((x) => x.id === m.id) || m;
    const mia = actual.reacciones?.find((r) => r.usernames.includes(yo))?.emoji || null;
    const nueva = mia === emoji ? null : emoji;
    setMensajes((prev) => prev.map((x) => (x.id === m.id ? { ...x, reacciones: reaccionLocal(x.reacciones, yo, nueva) } : x)));
    try {
      const { data } = await reaccionarProgramadoresChat(m.id, nueva);
      incorporar([data.mensaje]);
    } catch (err) {
      incorporar([actual]);
      setErrorEnvio(err?.response?.data?.error || 'No se pudo guardar la reacción');
    }
  }

  async function copiar(m) {
    try {
      await navigator.clipboard.writeText(m.texto || '');
    } catch {
      setErrorEnvio('No se pudo copiar (el navegador no dio permiso)');
    }
  }

  function irACita(id) {
    const cont = scrollRef.current;
    const el = cont?.querySelector(`[data-msg-id="${id}"]`);
    if (!el) {
      setErrorEnvio('Ese mensaje es anterior a los que están cargados: tocá "Cargar mensajes anteriores" arriba.');
      return;
    }
    cont.scrollTop += el.getBoundingClientRect().top - cont.getBoundingClientRect().top - cont.clientHeight / 3;
    setResaltadoId(id);
    setTimeout(() => setResaltadoId((r) => (r === id ? null : r)), 1600);
  }

  // ---- arrastrar archivos ----
  function onDragOver(e) {
    if (editando || !Array.from(e.dataTransfer?.types || []).includes('Files')) return;
    e.preventDefault();
    setArrastrando(true);
  }

  function onDrop(e) {
    e.preventDefault();
    setArrastrando(false);
    agregarArchivos(e.dataTransfer?.files);
  }

  async function pedirPermisoNotif() {
    try {
      setPermisoNotif(await Notification.requestPermission());
    } catch {
      setPermisoNotif(Notification.permission);
    }
  }

  const encabezado = (
    <div className="header-row" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <Link className="btn" to="/index">← Inicio</Link>
      <h2 style={{ margin: 0 }}>Chat de Programadores</h2>
      <div />
    </div>
  );

  if (sinAcceso) {
    return (
      <div>
        {encabezado}
        <div className="card" style={{ padding: 20, marginTop: 14 }}>
          No tenés acceso a este chat: es solo para usuarios con el permiso <b>programadores:admin</b>.
        </div>
      </div>
    );
  }

  const menuHandlers = {
    onMenu: setMenuAbiertoId,
    onMediaLoad,
    onResponder: responder,
    onReaccionar: reaccionar,
    onCopiar: copiar,
    onEditar: editar,
    onEliminar: eliminar,
    onIrACita: irACita,
  };

  return (
    <div>
      {encabezado}
      <div
        onDragOver={onDragOver}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setArrastrando(false); }}
        onDrop={onDrop}
        style={{
          position: 'relative', marginTop: 12, height: 'calc(100vh - 150px)', minHeight: 440,
          display: 'flex', flexDirection: 'column', border: '1px solid var(--border)',
          borderRadius: 12, overflow: 'hidden', background: C.fondo,
        }}
      >
        {/* encabezado del grupo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: 'var(--brand, #008241)', color: '#fff' }}>
          <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'rgba(255,255,255,.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, flex: '0 0 auto' }}>
            💻
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Programadores</div>
            <div style={{ fontSize: 12, opacity: 0.85, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {!cargando && !conectado ? 'Conectando…' : textoMiembros}
            </div>
          </div>
          {permisoNotif === 'default' && (
            <button
              type="button"
              onClick={pedirPermisoNotif}
              title="Avisarte con una notificación del sistema cuando llegue un mensaje y estés en otra pestaña"
              style={{ flex: '0 0 auto', background: 'rgba(255,255,255,.18)', color: '#fff', border: '1px solid rgba(255,255,255,.4)', borderRadius: 999, padding: '5px 12px', fontSize: 12, cursor: 'pointer' }}
            >
              🔔 Activar notificaciones
            </button>
          )}
        </div>

        {/* mensajes */}
        <div ref={scrollRef} onScroll={onScroll} style={{ flex: '1 1 auto', overflowY: 'auto', padding: '8px 5% 12px' }}>
          {cargando && <Pastilla>Cargando mensajes...</Pastilla>}
          {error && <Pastilla><span style={{ color: '#b3261e' }}>{error}</span></Pastilla>}
          {!cargando && !error && hayMas && (
            <div style={{ display: 'flex', justifyContent: 'center', margin: '6px 0' }}>
              <button type="button" className="btn" onClick={cargarAnteriores} disabled={cargandoAnteriores} style={{ fontSize: 12 }}>
                {cargandoAnteriores ? 'Cargando...' : 'Cargar mensajes anteriores'}
              </button>
            </div>
          )}
          {!cargando && !error && !mensajes.length && !envios.length && (
            <Pastilla>Todavía no hay mensajes. ¡Escribí el primero! 👋</Pastilla>
          )}
          {mensajes.map((m, i) => {
            const prev = mensajes[i - 1];
            const nuevoDia = !prev || claveDia(prev.created_at) !== claveDia(m.created_at);
            const esDivisor = divisor && divisor.id === m.id;
            const inicioDeTanda = nuevoDia || esDivisor || !prev || prev.autor_username !== m.autor_username
              || new Date(m.created_at) - new Date(prev.created_at) > 5 * 60 * 1000;
            return (
              <Fragment key={m.id}>
                {nuevoDia && <Pastilla>{etiquetaDia(m.created_at)}</Pastilla>}
                {esDivisor && (
                  <Pastilla innerRef={divisorRef}>
                    {divisor.count === 1 && !divisor.mas ? '1 mensaje no leído' : `${divisor.count}${divisor.mas ? '+' : ''} mensajes no leídos`}
                  </Pastilla>
                )}
                <ChatBurbuja
                  m={m}
                  propio={m.autor_username === yo}
                  inicioDeTanda={inicioDeTanda}
                  lecturas={lecturas}
                  otrosMiembros={otrosMiembros}
                  miembrosSet={miembrosSet}
                  yo={yo}
                  resaltado={resaltadoId === m.id}
                  menuAbierto={menuAbiertoId === m.id}
                  {...menuHandlers}
                />
              </Fragment>
            );
          })}
          {envios.map((e) => (
            <BurbujaEnvio
              key={e.clienteId}
              envio={e}
              miembrosSet={miembrosSet}
              yo={yo}
              onReintentar={mandar}
              onDescartar={(x) => quitarEnvios([x.clienteId])}
            />
          ))}
        </div>

        {lejosDelFondo && (
          <button
            type="button"
            onClick={() => { bajarAlFondo(); setNuevosAbajo(0); }}
            title="Ir al último mensaje"
            style={{
              position: 'absolute', right: 18, bottom: pendientes.length || respondiendoA || editando ? 170 : 86, width: 42, height: 42,
              borderRadius: '50%', border: 'none', background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,.25)',
              cursor: 'pointer', fontSize: 18, color: '#54656f',
            }}
          >
            ↓
            {nuevosAbajo > 0 && (
              <span style={{ position: 'absolute', top: -6, right: -4, background: '#25d366', color: '#fff', borderRadius: 999, fontSize: 11, fontWeight: 700, padding: '1px 6px' }}>
                {nuevosAbajo}
              </span>
            )}
          </button>
        )}

        {errorEnvio && (
          <div style={{ padding: '6px 14px', background: '#fdecea', color: '#b3261e', fontSize: 13, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span>{errorEnvio}</span>
            <button type="button" onClick={() => setErrorEnvio('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit' }}>×</button>
          </div>
        )}

        <ChatComposer
          texto={texto}
          setTexto={setTexto}
          inputRef={inputRef}
          deshabilitado={cargando || !!error}
          yo={yo}
          miembros={otrosMiembros}
          pendientes={pendientes}
          onAgregarArchivos={agregarArchivos}
          onQuitarPendiente={quitarPendiente}
          respondiendoA={respondiendoA}
          onCancelarRespuesta={() => setRespondiendoA(null)}
          editando={editando}
          onCancelarEdicion={cancelarEdicion}
          onEditarUltimo={editarUltimo}
          onEnviar={enviar}
        />

        {arrastrando && (
          <div
            style={{
              position: 'absolute', inset: 0, background: 'rgba(0,130,65,.12)', border: '3px dashed var(--brand, #008241)',
              borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 18, fontWeight: 700, color: 'var(--brand, #008241)', pointerEvents: 'none',
            }}
          >
            Soltá los archivos para adjuntarlos
          </div>
        )}
      </div>
    </div>
  );
}
