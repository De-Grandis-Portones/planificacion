// pages/DespachoV2Page.jsx
//
// /despacho_v2 - versión mobile-first de Despacho para la cuadrilla,
// pensada para reemplazar en el futuro a /despacho (el tablero clásico de
// workflow) - por ahora conviven, se desarrolla en paralelo (pedido
// explícito del usuario). Login propio (nombre de usuario QC + PIN, no es
// login de admin): cada integrante ve solo los viajes de su(s) cuadrilla(s).
// Standalone - sin sidebar/layout de admin, pantalla completa pensada para
// un celular.
import React, { useEffect, useMemo, useState } from 'react';
import {
  fetchDespachoV2QcUsers, despachoV2Login, fetchDespachoV2Viajes, marcarSalidaDespachoV2, marcarLlegadaDespachoV2,
  fetchParadasDespachoV2, fetchNvDespachoV2, fetchNvAdjuntosDespachoV2, crearSolicitudStDespachoV2,
  fetchNvMedicionMediaDespachoV2, fetchMedicionMediaItemDespachoV2,
  fetchRemitosPorNv, getDespachoV2Token, getDespachoV2User, setDespachoV2Session, clearDespachoV2Session,
  marcarEntregadoDespachoV2, avisarSiguienteDespachoV2,
  fetchParadasRestantesDespachoV2, avisarParadaElegidaDespachoV2,
  fetchGastosDespachoV2, crearGastoDespachoV2, actualizarGastoDespachoV2, deleteGastoDespachoV2,
  fetchChecklistDespachoV2,
  API_BASE_URL,
} from '../src/api';
// Mismo modal de "Pedido de insumos del día" que ya usa /despacho (y el
// resto de los tableros de producción) - pedido explícito del usuario: la
// cuadrilla de /despacho_v2 tiene que poder hacer los mismos pedidos. Sin
// auth de por medio (routes/public/insumos.js es público, solo pide PIN al
// confirmar), así que se reusa tal cual, sin tocarlo.
import InsumosCartButton from '../src/components/InsumosCartButton';

// Motivos de gasto - catálogo simple hoy, "después vamos a agregar más
// motivos" (pedido explícito del usuario): alcanza con extender este array,
// sin backend/migración de por medio (el backend acepta cualquier texto no
// vacío como motivo).
const MOTIVOS_GASTO = ['Refrigerio', 'Hospedaje', 'Otros'];

const BRAND = '#0a6a33';

// ===========================================================================
// Helpers
// ===========================================================================
function fechaLegible(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}
function tamanoLegible(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function waLink(telefono, texto) {
  const digitos = String(telefono || '').replace(/\D/g, '');
  if (!digitos) return null;
  const conCodigo = digitos.startsWith('54') ? digitos : `54${digitos.replace(/^0/, '')}`;
  return `https://wa.me/${conCodigo}${texto ? `?text=${encodeURIComponent(texto)}` : ''}`;
}
// "en aproximadamente X horas" - horas_tramo viene de ruta_real.segmentos_horas
// (duración REAL de ORS para ese tramo puntual, no un acumulado desde la
// salida del viaje - el botón se toca justo al arrancar hacia esa parada).
function formatearDuracion(horas) {
  if (horas == null) return 'poco tiempo';
  if (horas < 1) return `${Math.max(1, Math.round(horas * 60))} minutos`;
  const h = Math.floor(horas);
  const min = Math.round((horas - h) * 60);
  const horaTxt = `${h} hora${h === 1 ? '' : 's'}`;
  return min > 0 ? `${horaTxt} y ${min} minutos` : horaTxt;
}
function horaLegible(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function archivoADataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ===========================================================================
// Estilos compartidos (mobile-first: botones grandes, poco adorno)
// ===========================================================================
const s = {
  pantalla: { minHeight: '100dvh', background: '#f3f4f6', display: 'flex', flexDirection: 'column' },
  header: { background: BRAND, color: '#fff', padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 10, position: 'sticky', top: 0, zIndex: 10 },
  botonBloque: { display: 'block', width: '100%', padding: '14px', borderRadius: 12, border: '1px solid #d1d5db', background: '#fff', fontSize: 16, fontWeight: 800, textAlign: 'center', cursor: 'pointer' },
  botonPrimario: { display: 'block', width: '100%', padding: '14px', borderRadius: 12, border: 'none', background: BRAND, color: '#fff', fontSize: 16, fontWeight: 900, textAlign: 'center', cursor: 'pointer' },
  input: { width: '100%', padding: '12px', borderRadius: 10, border: '1px solid #d1d5db', fontSize: 16, boxSizing: 'border-box' },
  card: { background: '#fff', borderRadius: 14, border: '1px solid #e5e7eb', padding: 14, boxShadow: '0 1px 3px rgba(0,0,0,.06)' },
  // Centrado (no pegado abajo con alignItems:'flex-end' como antes) - en
  // pantallas de escritorio altas ese anclaje al fondo lo dejaba fuera de
  // vista/sin poder interactuar (reportado por el usuario). Centrado +
  // altura tope + scroll interno funciona en cualquier tamaño de pantalla,
  // mismo criterio que el resto de los modales de la app (ej.
  // LogisticaAdjuntosModal.jsx).
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, boxSizing: 'border-box' },
  hoja: { width: '100%', maxWidth: 520, maxHeight: '85vh', overflowY: 'auto', background: '#fff', borderRadius: 18, padding: 18, boxSizing: 'border-box' },
};

// ===========================================================================
// Login
// ===========================================================================
function LoginScreen({ onLogueado }) {
  const [usuarios, setUsuarios] = useState([]);
  const [loading, setLoading] = useState(true);
  const [elegido, setElegido] = useState(null); // { id, name } | null
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const [entrando, setEntrando] = useState(false);

  useEffect(() => {
    fetchDespachoV2QcUsers()
      .then((d) => setUsuarios(d?.usuarios || []))
      .catch((e) => setErr(e?.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  }, []);

  const entrar = async () => {
    if (!elegido || !/^\d{3,10}$/.test(pin)) return;
    setEntrando(true);
    setErr('');
    try {
      const data = await despachoV2Login({ qc_user_id: elegido.id, pin });
      setDespachoV2Session(data.token, data.qc_user);
      onLogueado(data.qc_user);
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
      setPin('');
    } finally {
      setEntrando(false);
    }
  };

  if (elegido) {
    return (
      <div style={{ ...s.pantalla, alignItems: 'center', justifyContent: 'center', padding: 20 }}>
        <div style={{ ...s.card, width: '100%', maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <button type="button" onClick={() => { setElegido(null); setPin(''); setErr(''); }} style={{ alignSelf: 'flex-start', background: 'none', border: 'none', color: BRAND, fontWeight: 800, fontSize: 14, padding: 0 }}>
            ← Volver
          </button>
          <div style={{ fontSize: 20, fontWeight: 900, textAlign: 'center' }}>Hola, {elegido.name}</div>
          <div style={{ fontSize: 13, opacity: 0.7, textAlign: 'center' }}>Ingresá tu PIN</div>
          <input
            type="password" inputMode="numeric" autoFocus value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 10))}
            onKeyDown={(e) => e.key === 'Enter' && entrar()}
            style={{ ...s.input, textAlign: 'center', fontSize: 28, letterSpacing: 8, padding: '16px' }}
            placeholder="••••"
          />
          {err ? <div style={{ color: 'crimson', fontWeight: 700, fontSize: 13, textAlign: 'center' }}>{err}</div> : null}
          <button type="button" style={s.botonPrimario} disabled={entrando || pin.length < 3} onClick={entrar}>
            {entrando ? 'Entrando…' : 'Entrar'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={s.pantalla}>
      <div style={s.header}>
        <div style={{ fontWeight: 900, fontSize: 18 }}>🚚 Despacho</div>
      </div>
      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 14, opacity: 0.75, marginBottom: 4 }}>¿Quién sos?</div>
        {err ? <div style={{ color: 'crimson', fontWeight: 700, fontSize: 13 }}>{err}</div> : null}
        {loading ? (
          <div style={{ opacity: 0.7 }}>Cargando…</div>
        ) : usuarios.length === 0 ? (
          <div style={{ opacity: 0.7 }}>No hay usuarios de cuadrilla cargados todavía.</div>
        ) : (
          usuarios.map((u) => (
            <button key={u.id} type="button" style={s.botonBloque} onClick={() => setElegido(u)}>
              {u.name}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

// ===========================================================================
// PIN de calidad (solo para el cierre de despacho - reusa el mismo QC/PIN
// que ya usa /despacho, ver Backend lib/despachoV2Db.js marcarDespachoOficial).
// ===========================================================================
function PinSheet({ busy, error, onCancelar, onConfirmar }) {
  const [pin, setPin] = useState('');
  return (
    <div style={{ ...s.overlay, zIndex: 10000 }} onMouseDown={(e) => { if (e.target === e.currentTarget) onCancelar(); }}>
      <div style={{ ...s.hoja, maxWidth: 360 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ fontWeight: 900, fontSize: 18 }}>Confirmá tu PIN</div>
          <button type="button" onClick={onCancelar} style={{ marginLeft: 'auto', background: 'none', border: 'none', fontSize: 22, lineHeight: 1, padding: 4 }}>✕</button>
        </div>
        <div style={{ fontSize: 13, opacity: 0.75, marginBottom: 10 }}>
          Es el mismo PIN de calidad que ya usás para autorizar el despacho.
        </div>
        <input
          type="password" inputMode="numeric" autoFocus value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 10))}
          onKeyDown={(e) => e.key === 'Enter' && pin.length >= 3 && onConfirmar(pin)}
          style={{ ...s.input, textAlign: 'center', fontSize: 26, letterSpacing: 6, padding: '14px', marginBottom: 10 }}
          placeholder="••••"
        />
        {error ? <div style={{ color: 'crimson', fontWeight: 700, fontSize: 13, marginBottom: 10 }}>{error}</div> : null}
        <button type="button" style={s.botonPrimario} disabled={busy || pin.length < 3} onClick={() => onConfirmar(pin)}>
          {busy ? 'Confirmando…' : 'Confirmar despacho'}
        </button>
      </div>
    </div>
  );
}

// ===========================================================================
// "¿La ruta sigue como estaba?" - se pregunta SIEMPRE antes de avisar por
// WhatsApp a la siguiente parada (pedido explícito del usuario: a veces se
// altera en el viaje y no hay que avisarle a quien ya no sigue).
// ===========================================================================
function ConfirmarRutaSheet({ siguienteParada, busy, resultado, onSi, onNo, onCerrar }) {
  return (
    <div style={{ ...s.overlay, zIndex: 10000 }} onMouseDown={(e) => { if (e.target === e.currentTarget) onCerrar(); }}>
      <div style={{ ...s.hoja, maxWidth: 400 }}>
        {resultado ? (
          <>
            <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 14, textAlign: 'center' }}>
              {resultado.ok ? '✅ Aviso enviado' : '⚠️ No se pudo avisar'}
            </div>
            <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 16, textAlign: 'center' }}>
              {resultado.ok
                ? `Le avisamos a ${resultado.nombreCliente || 'el próximo cliente'} por WhatsApp.`
                : (resultado.error || 'Error desconocido')}
            </div>
            <button type="button" style={s.botonPrimario} onClick={onCerrar}>Listo</button>
          </>
        ) : siguienteParada ? (
          <>
            <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 10, textAlign: 'center' }}>¿La ruta sigue como estaba?</div>
            <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 14, textAlign: 'center' }}>
              A veces se altera en el viaje - si cambió, no confirmes acá: avisale manualmente desde el NV que corresponda.
            </div>
            <div style={{ background: '#f3f4f6', borderRadius: 10, padding: 12, marginBottom: 16 }}>
              <div style={{ fontSize: 11, opacity: 0.6, fontWeight: 700, textTransform: 'uppercase' }}>Próxima parada</div>
              <div style={{ fontSize: 16, fontWeight: 900 }}>NV {siguienteParada.nv} · {siguienteParada.nombre_cliente || 'Cliente sin nombre'}</div>
              <div style={{ fontSize: 13, opacity: 0.75 }}>Llegando en aproximadamente {formatearDuracion(siguienteParada.horas_tramo)}</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button type="button" style={s.botonPrimario} disabled={busy} onClick={onSi}>
                {busy ? 'Avisando…' : 'Sí, avisarle por WhatsApp'}
              </button>
              <button type="button" style={s.botonBloque} disabled={busy} onClick={onNo}>
                No, la ruta cambió
              </button>
            </div>
          </>
        ) : (
          <>
            <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 14, textAlign: 'center' }}>✅ Listo</div>
            <div style={{ fontSize: 13, opacity: 0.75, marginBottom: 16, textAlign: 'center' }}>Era la última parada de esta ruta.</div>
            <button type="button" style={s.botonPrimario} onClick={onCerrar}>Listo</button>
          </>
        )}
      </div>
    </div>
  );
}

// "La ruta cambió, ¿cuál sigue?" - se abre desde el "No" de ConfirmarRutaSheet
// (pedido explícito del usuario). Lista las paradas-portón que quedaban
// después de la actual en el orden original armado por el sistema; al
// elegir una, manda el aviso para ESA parada puntual.
function ElegirParadaSheet({ viajeId, nvOrigen, busy, resultado, onElegir, onCerrar }) {
  const [paradas, setParadas] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (resultado) return;
    fetchParadasRestantesDespachoV2(viajeId, nvOrigen)
      .then((d) => setParadas(d?.restantes || []))
      .catch((e) => setErr(e?.response?.data?.error || e.message));
  }, [viajeId, nvOrigen, resultado]);

  return (
    <div style={{ ...s.overlay, zIndex: 10000 }} onMouseDown={(e) => { if (e.target === e.currentTarget) onCerrar(); }}>
      <div style={{ ...s.hoja, maxWidth: 400 }}>
        {resultado ? (
          <>
            <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 14, textAlign: 'center' }}>
              {resultado.ok ? '✅ Aviso enviado' : '⚠️ No se pudo avisar'}
            </div>
            <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 16, textAlign: 'center' }}>
              {resultado.ok
                ? `Le avisamos a ${resultado.nombreCliente || 'el cliente elegido'} por WhatsApp.`
                : (resultado.error || 'Error desconocido')}
            </div>
            <button type="button" style={s.botonPrimario} onClick={onCerrar}>Listo</button>
          </>
        ) : (
          <>
            <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 10, textAlign: 'center' }}>¿Cuál es la próxima parada?</div>
            <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 14, textAlign: 'center' }}>
              Elegí a cuál de las paradas que quedan le avisamos que está en camino.
            </div>
            {err ? <div style={{ color: 'crimson', fontWeight: 700, fontSize: 13, marginBottom: 10 }}>{err}</div> : null}
            {paradas == null ? (
              <div style={{ textAlign: 'center', opacity: 0.7, marginBottom: 12 }}>Cargando…</div>
            ) : paradas.length === 0 ? (
              <div style={{ textAlign: 'center', opacity: 0.7, marginBottom: 12 }}>No quedan más paradas en esta ruta.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
                {paradas.map((p) => (
                  <button
                    key={p.nv} type="button" disabled={busy} onClick={() => onElegir(p.nv)}
                    style={{ ...s.botonBloque, textAlign: 'left', padding: 12 }}
                  >
                    <div style={{ fontWeight: 900 }}>NV {p.nv} · {p.nombre_cliente || 'Cliente sin nombre'}</div>
                    <div style={{ fontSize: 12, opacity: 0.7 }}>
                      {[p.distribuidor, p.localidad].filter(Boolean).join(' · ') || '—'} · llegando en aproximadamente {formatearDuracion(p.horas_tramo)}
                    </div>
                  </button>
                ))}
              </div>
            )}
            <button type="button" style={{ background: 'none', border: 'none', color: '#6b7280', fontSize: 13, fontWeight: 700, padding: 6, textAlign: 'center' }} disabled={busy} onClick={onCerrar}>
              Cancelar
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ===========================================================================
// "Marcar entregado/instalado" - cierre OFICIAL real: despacho pide PIN
// (mismo mecanismo que /despacho), instalación no (no existe ese mecanismo
// hoy para ese campo, ver Backend lib/despachoV2Db.js). Al terminar, ofrece
// avisar por WhatsApp a la siguiente parada de la ruta - pero antes SIEMPRE
// pregunta si la ruta sigue igual.
// ===========================================================================
function MarcarEntregadoSection({ nv, viaje, parada, onParadaCambiada, stAbierta }) {
  const [tiposPendientes, setTiposPendientes] = useState(() => parada?.tipos_pendientes || []);
  const [pinAbierto, setPinAbierto] = useState(false);
  const [marcando, setMarcando] = useState(false);
  const [err, setErr] = useState('');
  const [confirmarRuta, setConfirmarRuta] = useState(null); // { siguienteParada } | null
  const [resultadoAviso, setResultadoAviso] = useState(null);
  const [eligiendoParada, setEligiendoParada] = useState(false); // "la ruta cambió" -> picker
  // "¿Quedó todo bien o hubo un problema?" - paso intermedio al cerrar la
  // instalación (pedido explícito del usuario). Si hubo un problema, se
  // exige cargar la solicitud de ST/PV ANTES de cerrar la instalación (así
  // nunca queda "cerrada en silencio" sin que el problema quede registrado
  // en algún lado) - recién al enviarla con éxito se llama confirmarMarcado.
  const [preguntandoInstalacion, setPreguntandoInstalacion] = useState(false);
  const [mostrarStCierre, setMostrarStCierre] = useState(false);
  const [stAbiertaLocal, setStAbiertaLocal] = useState(null);

  if (!parada) return null;

  const cerrarTodo = () => { setConfirmarRuta(null); setResultadoAviso(null); setEligiendoParada(false); };

  const confirmarMarcado = async (tipo, pin) => {
    setMarcando(true);
    setErr('');
    try {
      const r = await marcarEntregadoDespachoV2(viaje.id, nv, { tipo, pin });
      setTiposPendientes((prev) => prev.filter((t) => t !== tipo));
      setPinAbierto(false);
      onParadaCambiada?.();
      // Aviso de WhatsApp apagado por ahora (WHATSAPP_AVISO_HABILITADO) - la
      // cuadrilla sigue avisando manual desde su propio WhatsApp, sin popup.
      if (r?.whatsappAvisoHabilitado) {
        setConfirmarRuta({ siguienteParada: r?.siguienteParada || null });
      }
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    } finally {
      setMarcando(false);
    }
  };

  const avisar = async () => {
    setMarcando(true);
    try {
      const r = await avisarSiguienteDespachoV2(viaje.id, nv);
      setResultadoAviso(r);
    } catch (e) {
      setResultadoAviso({ ok: false, error: e?.response?.data?.error || e.message });
    } finally {
      setMarcando(false);
    }
  };

  const avisarElegida = async (nvDestino) => {
    setMarcando(true);
    try {
      const r = await avisarParadaElegidaDespachoV2(viaje.id, nv, nvDestino);
      setResultadoAviso(r);
    } catch (e) {
      setResultadoAviso({ ok: false, error: e?.response?.data?.error || e.message });
    } finally {
      setMarcando(false);
    }
  };

  const alEnviarStDeCierre = (solicitud) => {
    setMostrarStCierre(false);
    setStAbiertaLocal(solicitud || null);
    confirmarMarcado('instalacion', null);
  };

  const stVisible = stAbiertaLocal || stAbierta;

  if (!tiposPendientes.length) {
    if (!stVisible) return null;
    return (
      <div style={{ ...s.card, marginBottom: 16, background: '#fffbeb', border: '1px solid #fde68a' }}>
        <div style={{ fontWeight: 900, fontSize: 15, textAlign: 'center' }}>✅ Instalación terminada</div>
        <div style={{ fontWeight: 800, color: '#b45309', fontSize: 13, textAlign: 'center', marginTop: 2 }}>
          ⚠️ Con problema reportado (pendiente)
        </div>
        {stVisible.descripcion ? (
          <div style={{ background: '#fff', borderRadius: 10, padding: 10, marginTop: 10, fontSize: 13, opacity: 0.85 }}>
            {stVisible.descripcion}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {tiposPendientes.includes('despacho') ? (
          <button type="button" style={s.botonPrimario} disabled={marcando} onClick={() => { setErr(''); setPinAbierto(true); }}>
            ✅ Marcar despacho entregado
          </button>
        ) : null}
        {tiposPendientes.includes('instalacion') ? (
          preguntandoInstalacion ? (
            <div style={{ ...s.card, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ fontWeight: 800, fontSize: 15, textAlign: 'center', marginBottom: 2 }}>
                ¿Quedó todo bien o hubo algún problema?
              </div>
              <button type="button" style={{ ...s.botonPrimario, background: '#16a34a' }} disabled={marcando} onClick={() => confirmarMarcado('instalacion', null)}>
                {marcando ? 'Marcando…' : '✅ Todo bien'}
              </button>
              <button type="button" style={{ ...s.botonPrimario, background: '#d97706' }} disabled={marcando} onClick={() => { setPreguntandoInstalacion(false); setMostrarStCierre(true); }}>
                ⚠️ Hubo un problema
              </button>
              <button type="button" style={{ background: 'none', border: 'none', color: '#6b7280', fontSize: 13, fontWeight: 700, padding: 2 }} disabled={marcando} onClick={() => setPreguntandoInstalacion(false)}>
                Cancelar
              </button>
            </div>
          ) : (
            <button type="button" style={s.botonPrimario} disabled={marcando} onClick={() => setPreguntandoInstalacion(true)}>
              ✅ Marcar instalación terminada
            </button>
          )
        ) : null}
      </div>
      {err ? <div style={{ color: 'crimson', fontWeight: 700, fontSize: 13, marginTop: 8 }}>{err}</div> : null}

      {pinAbierto ? (
        <PinSheet
          busy={marcando} error={err}
          onCancelar={() => { setPinAbierto(false); setErr(''); }}
          onConfirmar={(pin) => confirmarMarcado('despacho', pin)}
        />
      ) : null}

      {confirmarRuta && !eligiendoParada ? (
        <ConfirmarRutaSheet
          siguienteParada={confirmarRuta.siguienteParada}
          busy={marcando}
          resultado={resultadoAviso}
          onSi={avisar}
          onNo={() => setEligiendoParada(true)}
          onCerrar={cerrarTodo}
        />
      ) : null}

      {eligiendoParada ? (
        <ElegirParadaSheet
          viajeId={viaje.id}
          nvOrigen={nv}
          busy={marcando}
          resultado={resultadoAviso}
          onElegir={avisarElegida}
          onCerrar={cerrarTodo}
        />
      ) : null}

      {mostrarStCierre ? (
        <StFormSheet nv={nv} onClose={() => setMostrarStCierre(false)} onEnviada={alEnviarStDeCierre} />
      ) : null}
    </div>
  );
}

// ===========================================================================
// Detalle de un NV (al tocar una parada-portón)
// ===========================================================================
function NvDetailSheet({ nv, viaje, parada, onParadaCambiada, onClose }) {
  const [detalle, setDetalle] = useState(null);
  const [adjuntos, setAdjuntos] = useState([]);
  const [medicionMedia, setMedicionMedia] = useState([]);
  const [medioAbierto, setMedioAbierto] = useState(null); // { index, nombre_archivo, tipo_mime } | null
  const [remitos, setRemitos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [mostrarSt, setMostrarSt] = useState(false);

  useEffect(() => {
    setLoading(true);
    setErr('');
    Promise.all([
      fetchNvDespachoV2(nv).catch(() => null),
      fetchNvAdjuntosDespachoV2(nv).catch(() => null),
      fetchNvMedicionMediaDespachoV2(nv).catch(() => null),
      fetchRemitosPorNv(nv).catch(() => null),
    ])
      .then(([d, a, m, r]) => {
        setDetalle(d?.nv || null);
        setAdjuntos(a?.adjuntos || []);
        setMedicionMedia(m?.media || []);
        setRemitos(r?.items || []);
      })
      .catch((e) => setErr(e?.response?.data?.error || e.message))
      .finally(() => setLoading(false));
  }, [nv]);

  const waPerfil = waLink(detalle?.telefono);

  return (
    <div style={s.overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={s.hoja}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ fontWeight: 900, fontSize: 20 }}>NV {nv}</div>
          <button type="button" onClick={onClose} style={{ marginLeft: 'auto', background: 'none', border: 'none', fontSize: 22, lineHeight: 1, padding: 4 }}>✕</button>
        </div>

        {loading ? (
          <div style={{ opacity: 0.7 }}>Cargando…</div>
        ) : err ? (
          <div style={{ color: 'crimson', fontWeight: 700 }}>{err}</div>
        ) : (
          <>
            <MarcarEntregadoSection nv={nv} viaje={viaje} parada={parada} onParadaCambiada={onParadaCambiada} stAbierta={detalle?.st_abierta} />

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
              <Campo label="Cliente" valor={detalle?.nombre_cliente} />
              <Campo label="Distribuidor" valor={detalle?.distribuidor} />
              <Campo label="Localidad" valor={detalle?.localidad} />
              <Campo label="Dirección" valor={detalle?.direccion} />
              <Campo label="Ancho x Alto" valor={detalle?.ancho && detalle?.alto ? `${detalle.ancho} x ${detalle.alto}` : null} />
              <Campo label="Revestimiento" valor={detalle?.revestimiento} />
              <Campo label="Color del revestimiento" valor={detalle?.color_revestimiento} />
              <Campo label="Apertura" valor={detalle?.automatico_manual} />
              {waPerfil ? (
                <a href={waPerfil} target="_blank" rel="noopener noreferrer" style={{ ...s.botonBloque, background: '#25D366', color: '#fff', border: 'none' }}>
                  💬 WhatsApp al cliente
                </a>
              ) : null}
              {detalle?.maps_url ? (
                <a href={detalle.maps_url} target="_blank" rel="noopener noreferrer" style={{ ...s.botonBloque, background: '#4285F4', color: '#fff', border: 'none' }}>
                  📍 Ver en Google Maps
                </a>
              ) : null}
            </div>

            <div style={{ fontWeight: 900, fontSize: 14, marginBottom: 6 }}>📄 Remito</div>
            {remitos.length === 0 ? (
              <div style={{ fontSize: 13, opacity: 0.6, marginBottom: 16 }}>No se encontró remito para este NV.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
                {remitos.map((r, i) => (
                  <a
                    key={i} href={`${API_BASE_URL}/remitos-proxy/${r.tipo}/${r.sucursal}/${r.numero}/pdf`}
                    target="_blank" rel="noopener noreferrer" style={s.botonBloque}
                  >
                    {r.tipo} {r.sucursal}-{r.numero} · {fechaLegible(r.fecha)}
                  </a>
                ))}
              </div>
            )}

            <div style={{ fontWeight: 900, fontSize: 14, marginBottom: 6 }}>📎 Adjuntos</div>
            {adjuntos.length === 0 ? (
              <div style={{ fontSize: 13, opacity: 0.6, marginBottom: 6 }}>Sin adjuntos cargados.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 6 }}>
                {adjuntos.map((a) => (
                  <a key={a.id} href={a.url} target="_blank" rel="noopener noreferrer" style={{ ...s.botonBloque, textAlign: 'left', display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span>{String(a.tipo_mime || '').startsWith('image/') ? '🖼️' : '📄'}</span>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}>{a.nombre_archivo}</span>
                  </a>
                ))}
              </div>
            )}
            <div style={{ fontSize: 11, opacity: 0.55, marginBottom: 16 }}>Fotos adjuntas desde acá: más adelante.</div>

            <div style={{ fontWeight: 900, fontSize: 14, marginBottom: 6 }}>📸 Fotos/Videos de la medición</div>
            {medicionMedia.length === 0 ? (
              <div style={{ fontSize: 13, opacity: 0.6, marginBottom: 16 }}>El vendedor no adjuntó fotos/videos al medir este portón.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
                {medicionMedia.map((m) => (
                  <button
                    key={m.index} type="button"
                    onClick={() => setMedioAbierto({ index: m.index, nombre_archivo: m.nombre_archivo, tipo_mime: m.tipo_mime })}
                    style={{ ...s.botonBloque, textAlign: 'left', display: 'flex', gap: 8, alignItems: 'center' }}
                  >
                    <span>{String(m.tipo_mime || '').startsWith('video/') ? '🎥' : '🖼️'}</span>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}>{m.nombre_archivo}</span>
                    <span style={{ fontSize: 11, opacity: 0.6 }}>{tamanoLegible(m.tamano_bytes)}</span>
                  </button>
                ))}
              </div>
            )}

            <button type="button" style={{ ...s.botonPrimario, background: '#dc2626' }} onClick={() => setMostrarSt(true)}>
              🛠️ ST/PV — Reportar un problema
            </button>
          </>
        )}
      </div>
      {mostrarSt ? <StFormSheet nv={nv} onClose={() => setMostrarSt(false)} /> : null}
      {medioAbierto ? (
        <MedicionMediaViewer nv={nv} medio={medioAbierto} onClose={() => setMedioAbierto(null)} />
      ) : null}
    </div>
  );
}

// Visor de UNA foto/video de medición - se pide recién acá (no en el
// listado) porque el archivo entero viaja en base64 dentro del JSON y puede
// pesar varios MB (hasta 30MB un video) - pedirlos todos de entrada haría
// re-lento el detalle del portón para nada, si la cuadrilla ni los mira.
function MedicionMediaViewer({ nv, medio, onClose }) {
  const [dataUrl, setDataUrl] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    setDataUrl(null);
    setErr('');
    fetchMedicionMediaItemDespachoV2(nv, medio.index)
      .then((d) => setDataUrl(d?.item?.data_url || null))
      .catch((e) => setErr(e?.response?.data?.error || e.message));
  }, [nv, medio.index]);

  const esVideo = String(medio.tipo_mime || '').startsWith('video/');

  return (
    <div style={{ ...s.overlay, zIndex: 10001 }} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ ...s.hoja, maxWidth: 480 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ fontWeight: 900, fontSize: 15, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{medio.nombre_archivo}</div>
          <button type="button" onClick={onClose} style={{ marginLeft: 8, background: 'none', border: 'none', fontSize: 22, lineHeight: 1, padding: 4 }}>✕</button>
        </div>
        {err ? (
          <div style={{ color: 'crimson', fontWeight: 700, textAlign: 'center', padding: 20 }}>{err}</div>
        ) : !dataUrl ? (
          <div style={{ opacity: 0.7, textAlign: 'center', padding: 20 }}>Cargando…</div>
        ) : esVideo ? (
          <video src={dataUrl} controls style={{ width: '100%', borderRadius: 10, background: '#000' }} />
        ) : (
          <img src={dataUrl} alt={medio.nombre_archivo} style={{ width: '100%', borderRadius: 10 }} />
        )}
      </div>
    </div>
  );
}

function Campo({ label, valor }) {
  if (!valor) return null;
  return (
    <div>
      <div style={{ fontSize: 11, opacity: 0.6, fontWeight: 700, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700 }}>{valor}</div>
    </div>
  );
}

// ===========================================================================
// ST/PV: reportar un problema (Servicio Técnico / Post Venta) con foto/video
// ===========================================================================
function StFormSheet({ nv, onClose, onEnviada }) {
  const [descripcion, setDescripcion] = useState('');
  const [archivo, setArchivo] = useState(null); // { name, type, size, data_url } | null
  const [subiendo, setSubiendo] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState(false);

  const onArchivoElegido = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    const esVideo = f.type.startsWith('video/');
    const limite = esVideo ? 5 * 1024 * 1024 : 15 * 1024 * 1024;
    if (f.size > limite) {
      setErr(`El archivo es muy pesado (máximo ${esVideo ? '5MB para video' : '15MB'}).`);
      return;
    }
    setErr('');
    const dataUrl = await archivoADataUrl(f);
    setArchivo({ name: f.name, type: f.type, size: f.size, data_url: dataUrl });
  };

  const enviar = async () => {
    if (!descripcion.trim()) { setErr('Contá qué pasó.'); return; }
    setSubiendo(true);
    setErr('');
    try {
      const r = await crearSolicitudStDespachoV2(nv, { descripcion: descripcion.trim(), attachment: archivo });
      setOk(true);
      onEnviada?.(r?.solicitud || null);
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    } finally {
      setSubiendo(false);
    }
  };

  return (
    <div style={{ ...s.overlay, zIndex: 10000 }} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={s.hoja}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ fontWeight: 900, fontSize: 18 }}>Reportar un problema — NV {nv}</div>
          <button type="button" onClick={onClose} style={{ marginLeft: 'auto', background: 'none', border: 'none', fontSize: 22, lineHeight: 1, padding: 4 }}>✕</button>
        </div>

        {ok ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '10px 0' }}>
            <div style={{ fontWeight: 900, fontSize: 16, textAlign: 'center' }}>✅ Solicitud enviada</div>
            <button type="button" style={s.botonPrimario} onClick={onClose}>Listo</button>
          </div>
        ) : (
          <>
            <div style={{ fontSize: 13, opacity: 0.75, marginBottom: 10 }}>
              Contá qué pasó (se rayó, se golpeó, falta algo, etc.) - se manda como solicitud a Servicio Técnico / Post Venta.
            </div>
            <textarea
              className="pp-input" style={{ ...s.input, minHeight: 100, marginBottom: 10 }}
              placeholder="Ej: llegó con un rayón en la hoja izquierda"
              value={descripcion} onChange={(e) => setDescripcion(e.target.value)}
            />
            <label style={{ ...s.botonBloque, marginBottom: 6, display: 'block' }}>
              {archivo ? `✅ ${archivo.name}` : '📷 Adjuntar foto o video'}
              <input type="file" accept="image/*,video/*" style={{ display: 'none' }} onChange={onArchivoElegido} />
            </label>
            {archivo?.type?.startsWith('image/') ? (
              <img src={archivo.data_url} alt="" style={{ width: '100%', borderRadius: 10, marginBottom: 10 }} />
            ) : null}
            {err ? <div style={{ color: 'crimson', fontWeight: 700, fontSize: 13, marginBottom: 10 }}>{err}</div> : null}
            <button type="button" style={s.botonPrimario} disabled={subiendo} onClick={enviar}>
              {subiendo ? 'Enviando…' : 'Enviar solicitud'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ===========================================================================
// Detalle de una parada extra (hotel, etc.)
// ===========================================================================
function ParadaExtraSheet({ parada, onClose }) {
  return (
    <div style={s.overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={s.hoja}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ fontWeight: 900, fontSize: 18 }}>🏨 {parada.nombre}</div>
          <button type="button" onClick={onClose} style={{ marginLeft: 'auto', background: 'none', border: 'none', fontSize: 22, lineHeight: 1, padding: 4 }}>✕</button>
        </div>
        {parada.maps_url ? (
          <a href={parada.maps_url} target="_blank" rel="noopener noreferrer" style={{ ...s.botonBloque, background: '#4285F4', color: '#fff', border: 'none' }}>
            📍 Ver en Google Maps
          </a>
        ) : (
          <div style={{ opacity: 0.6, fontSize: 13 }}>Sin ubicación cargada.</div>
        )}
      </div>
    </div>
  );
}

// ===========================================================================
// Gastos del viaje ("rendición de gastos") - pedido explícito del usuario:
// fecha (seteada hoy) + motivo + monto + foto/PDF del ticket. Se comparte
// entre toda la cuadrilla del viaje (cualquier integrante ve/carga/borra los
// mismos gastos, no hay un dueño individual).
// ===========================================================================
function montoLegible(n) {
  return Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 });
}

// Fila de un gasto ya cargado - si algún campo quedó incierto para la IA
// (campos_inciertos), se puede corregir ahí mismo con un tap (pedido
// explícito del usuario). Corregir NO le saca el resaltado a logística -
// sigue viendo estado_revision='revisar' aunque se arregle acá.
function GastoRow({ gasto, viajeId, onCambio, onBorrar }) {
  const [editando, setEditando] = useState(null); // 'fecha'|'motivo'|'monto'|'tipo_comprobante'|null
  const [valor, setValor] = useState('');
  const [guardando, setGuardando] = useState(false);
  const incierto = (campo) => (gasto.campos_inciertos || []).includes(campo);

  const abrirEdicion = (campo, valorActual) => {
    setEditando(campo);
    setValor(String(valorActual ?? ''));
  };

  const guardar = async () => {
    setGuardando(true);
    try {
      const patch = { [editando]: editando === 'monto' ? Number(valor) : valor };
      await actualizarGastoDespachoV2(viajeId, gasto.id, patch);
      setEditando(null);
      onCambio();
    } finally {
      setGuardando(false);
    }
  };

  const campoStyle = (campo) => ({
    cursor: 'pointer',
    ...(incierto(campo) ? { color: '#b45309', textDecoration: 'underline dotted', fontWeight: 800 } : {}),
  });

  return (
    <div style={{ border: '1px solid #f0f0f0', borderRadius: 10, padding: 8 }}>
      {gasto.estado_revision === 'revisar' ? (
        <div style={{ fontSize: 10, fontWeight: 800, color: '#b45309', marginBottom: 4 }}>
          ⚠️ La IA no pudo leer algo con confianza - revisá lo subrayado {gasto.detalle_revision ? `(${gasto.detalle_revision})` : ''}
        </div>
      ) : null}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {editando === 'monto' ? (
            <div style={{ display: 'flex', gap: 6 }}>
              <input type="number" inputMode="decimal" style={{ ...s.input, padding: 6, fontSize: 13 }} value={valor} onChange={(e) => setValor(e.target.value)} autoFocus />
              <button type="button" style={{ fontSize: 12 }} disabled={guardando} onClick={guardar}>✓</button>
            </div>
          ) : editando === 'motivo' ? (
            <div style={{ display: 'flex', gap: 6 }}>
              <select style={{ ...s.input, padding: 6, fontSize: 13 }} value={valor} onChange={(e) => setValor(e.target.value)} autoFocus>
                {MOTIVOS_GASTO.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <button type="button" style={{ fontSize: 12 }} disabled={guardando} onClick={guardar}>✓</button>
            </div>
          ) : (
            <div style={{ fontWeight: 800, fontSize: 13 }}>
              <span onClick={() => abrirEdicion('motivo', gasto.motivo)} style={campoStyle('motivo')}>{gasto.motivo || '(sin motivo)'}</span>
              {' · $'}
              <span onClick={() => abrirEdicion('monto', gasto.monto)} style={campoStyle('monto')}>{montoLegible(gasto.monto)}</span>
            </div>
          )}
          {editando === 'fecha' ? (
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              <input type="date" style={{ ...s.input, padding: 6, fontSize: 12 }} value={valor} onChange={(e) => setValor(e.target.value)} autoFocus />
              <button type="button" style={{ fontSize: 12 }} disabled={guardando} onClick={guardar}>✓</button>
            </div>
          ) : (
            <div style={{ fontSize: 11, opacity: 0.6 }}>
              <span onClick={() => abrirEdicion('fecha', gasto.fecha)} style={campoStyle('fecha')}>{fechaLegible(gasto.fecha) || '(sin fecha)'}</span>
              {' · '}{gasto.cargado_por || '—'}
              {gasto.tipo_comprobante ? ` · ${gasto.tipo_comprobante}` : ''}
            </div>
          )}
        </div>
        <a href={gasto.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 18, textDecoration: 'none' }} title="Ver ticket">
          {String(gasto.tipo_mime || '').startsWith('image/') ? '🖼️' : '📄'}
        </a>
        <button type="button" onClick={() => onBorrar(gasto.id)} style={{ background: 'none', border: 'none', color: '#991b1b', fontSize: 16, cursor: 'pointer', padding: 4 }}>🗑️</button>
      </div>
    </div>
  );
}

function GastosSheet({ viaje, onClose }) {
  const [gastos, setGastos] = useState(null);
  const [err, setErr] = useState('');
  const [subiendo, setSubiendo] = useState(false);

  const cargar = () => {
    fetchGastosDespachoV2(viaje.id).then((d) => setGastos(d?.gastos || [])).catch((e) => setErr(e?.response?.data?.error || e.message));
  };
  useEffect(cargar, [viaje.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = (gastos || []).reduce((acc, g) => acc + Number(g.monto), 0);

  const onArchivoElegido = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setSubiendo(true);
    setErr('');
    try {
      await crearGastoDespachoV2(viaje.id, f);
      cargar();
    } catch (e2) {
      setErr(e2?.response?.data?.error || e2.message);
    } finally {
      setSubiendo(false);
    }
  };

  const borrar = async (gastoId) => {
    if (!window.confirm('¿Borrar este gasto?')) return;
    try {
      await deleteGastoDespachoV2(viaje.id, gastoId);
      cargar();
    } catch (e) {
      setErr(e?.response?.data?.error || e.message);
    }
  };

  return (
    <div style={s.overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={s.hoja}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ fontWeight: 900, fontSize: 18 }}>💰 Gastos del viaje</div>
          <button type="button" onClick={onClose} style={{ marginLeft: 'auto', background: 'none', border: 'none', fontSize: 22, lineHeight: 1, padding: 4 }}>✕</button>
        </div>

        <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 12 }}>
          Se comparte entre toda la cuadrilla - subí la foto o PDF del ticket y la IA completa los datos sola.
          Si algo queda subrayado en naranja, tocalo para corregirlo.
        </div>

        <label style={{ ...s.botonPrimario, display: 'block', textAlign: 'center', marginBottom: 16 }}>
          {subiendo ? 'Leyendo el comprobante…' : '📷 Agregar gasto (foto o PDF)'}
          <input type="file" accept="image/*,application/pdf" style={{ display: 'none' }} disabled={subiendo} onChange={onArchivoElegido} />
        </label>
        {err ? <div style={{ color: 'crimson', fontWeight: 700, fontSize: 13, marginBottom: 10 }}>{err}</div> : null}

        <div style={{ fontWeight: 900, fontSize: 14, marginBottom: 6 }}>Gastos cargados</div>
        {gastos == null ? (
          <div style={{ opacity: 0.6, fontSize: 13 }}>Cargando…</div>
        ) : gastos.length === 0 ? (
          <div style={{ opacity: 0.6, fontSize: 13 }}>Todavía no hay gastos cargados.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
            {gastos.map((g) => (
              <GastoRow key={g.id} gasto={g} viajeId={viaje.id} onCambio={cargar} onBorrar={borrar} />
            ))}
          </div>
        )}
        {gastos?.length ? (
          <div style={{ textAlign: 'right', fontWeight: 900, fontSize: 16, borderTop: '1px solid #e5e7eb', paddingTop: 8 }}>
            Total: ${montoLegible(total)}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ===========================================================================
// Fila de una parada dentro de la lista desplegable de un viaje
// ===========================================================================
function ParadaRow({ parada, viaje, onAbrirNv, onAbrirExtra }) {
  if (parada.tipo === 'extra') {
    return (
      <div
        onClick={() => onAbrirExtra(parada)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 8px', borderBottom: '1px solid #f0f0f0', cursor: 'pointer' }}
      >
        <span style={{ fontSize: 18 }}>🏨</span>
        <div style={{ fontWeight: 700, fontSize: 14 }}>{parada.nombre}</div>
      </div>
    );
  }
  const label = parada.tipos_pendientes.length === 2 ? 'Desp. + Inst.' : parada.tipos_pendientes[0] === 'despacho' ? 'Despacho' : 'Instalación';
  return (
    <div
      onClick={() => onAbrirNv({ nv: parada.nv, viaje, parada })}
      style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 8px', borderBottom: '1px solid #f0f0f0', cursor: 'pointer' }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div style={{ fontWeight: 900, fontSize: 14 }}>NV {parada.nv}</div>
        <div style={{ fontSize: 10, fontWeight: 800, padding: '2px 7px', borderRadius: 999, background: '#eef2ff', color: '#3730a3' }}>{label}</div>
      </div>
      <div style={{ fontSize: 13, opacity: 0.85 }}>{parada.nombre_cliente || 'Cliente sin nombre'}</div>
      <div style={{ fontSize: 12, opacity: 0.65 }}>
        {[parada.distribuidor, parada.localidad].filter(Boolean).join(' · ') || '—'}
      </div>
    </div>
  );
}

// "Antes de arrancar…" - checklist configurable (/admin/logistica-fechas,
// panel de configuración, botón CheckList) que la cuadrilla debe completar
// para habilitar el botón Play (pedido explícito del usuario). Si el admin
// no cargó ítems para este tipo de viaje, ni se llega a mostrar (ver
// tocarPlay: arranca directo).
function ChecklistSheet({ tipo, busy, errorExterno, onConfirmar, onCerrar }) {
  const [items, setItems] = useState(null);
  const [marcados, setMarcados] = useState(() => new Set());
  const [err, setErr] = useState('');

  useEffect(() => {
    fetchChecklistDespachoV2(tipo)
      .then((d) => setItems(d?.items || []))
      .catch((e) => setErr(e?.response?.data?.error || e.message));
  }, [tipo]);

  const toggle = (id) => {
    setMarcados((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const todoTildado = Array.isArray(items) && items.length > 0 && items.every((it) => marcados.has(it.id));

  return (
    <div style={{ ...s.overlay, zIndex: 10000 }} onMouseDown={(e) => { if (e.target === e.currentTarget) onCerrar(); }}>
      <div style={{ ...s.hoja, maxWidth: 420 }}>
        <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 10, textAlign: 'center' }}>Antes de arrancar…</div>
        <div style={{ fontSize: 13, opacity: 0.8, marginBottom: 14, textAlign: 'center' }}>
          Tildá cada ítem para habilitar el viaje.
        </div>
        {err || errorExterno ? <div style={{ color: 'crimson', fontWeight: 700, fontSize: 13, marginBottom: 10, textAlign: 'center' }}>{err || errorExterno}</div> : null}
        {items == null ? (
          <div style={{ textAlign: 'center', opacity: 0.7, marginBottom: 12 }}>Cargando…</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
            {items.map((it) => (
              <label
                key={it.id}
                style={{ ...s.botonBloque, display: 'flex', gap: 10, alignItems: 'center', cursor: 'pointer', background: marcados.has(it.id) ? '#dcfce7' : '#fff' }}
              >
                <input type="checkbox" checked={marcados.has(it.id)} onChange={() => toggle(it.id)} style={{ width: 18, height: 18, flex: '0 0 auto' }} />
                <span style={{ fontSize: 14 }}>{it.texto}</span>
              </label>
            ))}
          </div>
        )}
        <button type="button" style={s.botonPrimario} disabled={busy || !todoTildado} onClick={() => onConfirmar(items.map((it) => it.id))}>
          {busy ? 'Arrancando…' : '▶ Confirmar y arrancar viaje'}
        </button>
        <button type="button" style={{ background: 'none', border: 'none', color: '#6b7280', fontSize: 13, fontWeight: 700, padding: 10, textAlign: 'center', width: '100%' }} disabled={busy} onClick={onCerrar}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

// ===========================================================================
// Tarjeta de un viaje
// ===========================================================================
function ViajeCard({ viaje, onCambio, onAbrirNv, onAbrirExtra }) {
  const [expandido, setExpandido] = useState(false);
  const [paradas, setParadas] = useState(null);
  const [cargandoParadas, setCargandoParadas] = useState(false);
  const [marcando, setMarcando] = useState(false);
  const [marcandoLlegada, setMarcandoLlegada] = useState(false);
  const [mostrarGastos, setMostrarGastos] = useState(false);
  const [mostrarChecklist, setMostrarChecklist] = useState(false);
  const [errChecklist, setErrChecklist] = useState('');

  const toggleExpandir = async () => {
    if (!expandido && paradas == null) {
      setCargandoParadas(true);
      try {
        const d = await fetchParadasDespachoV2(viaje.id);
        setParadas(d?.paradas || []);
      } catch {
        setParadas([]);
      } finally {
        setCargandoParadas(false);
      }
    }
    setExpandido((v) => !v);
  };

  // Refresca la lista de paradas de ESTE viaje (ej. después de marcar un
  // portón entregado/instalado) - la lista ya cargada queda cacheada en
  // `paradas`, así que sin esto seguiría mostrando "Desp. + Inst." aunque ya
  // se haya cerrado uno de los dos.
  const recargarParadas = async () => {
    try {
      const d = await fetchParadasDespachoV2(viaje.id);
      setParadas(d?.paradas || []);
    } catch {}
  };

  // Botón Play: si el admin configuró ítems de checklist para el tipo de
  // este viaje (solo_despacho | con_instalacion), primero hay que tildarlos
  // todos (pedido explícito del usuario) - si no hay ninguno cargado,
  // arranca directo, como antes de este feature.
  const tocarPlay = async () => {
    if (marcando || viaje.hora_salida_real) return;
    setMarcando(true);
    try {
      const { items } = await fetchChecklistDespachoV2(viaje.checklist_tipo);
      if (items?.length) {
        setMostrarChecklist(true);
      } else {
        await marcarSalidaDespachoV2(viaje.id, { tipo: viaje.checklist_tipo, item_ids: [] });
        onCambio();
      }
    } finally {
      setMarcando(false);
    }
  };

  const confirmarChecklist = async (itemIds) => {
    setMarcando(true);
    setErrChecklist('');
    try {
      await marcarSalidaDespachoV2(viaje.id, { tipo: viaje.checklist_tipo, item_ids: itemIds });
      setMostrarChecklist(false);
      onCambio();
    } catch (e) {
      setErrChecklist(e?.response?.data?.error || e.message);
    } finally {
      setMarcando(false);
    }
  };

  const marcarLlegada = async () => {
    if (marcandoLlegada || viaje.hora_llegada_real) return;
    if (!window.confirm('¿Confirmás que el viaje terminó? Esto cierra el rango de fechas para la rendición de gastos.')) return;
    setMarcandoLlegada(true);
    try {
      await marcarLlegadaDespachoV2(viaje.id);
      onCambio();
    } finally {
      setMarcandoLlegada(false);
    }
  };

  return (
    <div style={s.card}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <button type="button" onClick={toggleExpandir} style={{ background: 'none', border: 'none', fontSize: 22, padding: 4, lineHeight: 1, flex: '0 0 auto' }} title="Ver paradas">
          ☰
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 900, fontSize: 16 }}>{viaje.nombre}</div>
          <div style={{ fontSize: 13, opacity: 0.75 }}>
            {fechaLegible(viaje.fecha)}{viaje.hora_salida ? ` · sale ${viaje.hora_salida}` : ''}
          </div>
        </div>
        <button
          type="button" onClick={tocarPlay} disabled={marcando}
          style={{
            flex: '0 0 auto', width: 44, height: 44, borderRadius: 999, border: 'none',
            background: viaje.hora_salida_real ? '#16a34a' : BRAND, color: '#fff', fontSize: 18,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          title={viaje.hora_salida_real ? `Salió a las ${horaLegible(viaje.hora_salida_real)}` : 'Marcar salida'}
        >
          {viaje.hora_salida_real ? '✅' : '▶'}
        </button>
      </div>

      {viaje.hora_salida_real ? (
        <div style={{ fontSize: 12, fontWeight: 800, color: '#0a6a33', marginTop: 6 }}>Salió a las {horaLegible(viaje.hora_salida_real)}</div>
      ) : null}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10, fontSize: 12 }}>
        <Chip>🚚 {viaje.vehiculo_nombre || 'sin vehículo'}</Chip>
        <Chip>🚪 {viaje.cantidad_portones} portón{viaje.cantidad_portones === 1 ? '' : 'es'}</Chip>
        <Chip>📍 {viaje.cantidad_paradas} parada{viaje.cantidad_paradas === 1 ? '' : 's'}</Chip>
        {viaje.distancia_km ? <Chip>🛣️ {viaje.distancia_km} km</Chip> : null}
      </div>

      <div style={{ fontSize: 12, opacity: 0.75, marginTop: 8 }}>
        👥 {viaje.cuadrilla_nombre}{viaje.cuadrilla_miembros?.length ? `: ${viaje.cuadrilla_miembros.map((m) => `${m.name}${m.rol ? ` (${m.rol})` : ''}`).join(', ')}` : ''}
      </div>

      <button type="button" style={{ ...s.botonBloque, marginTop: 10, padding: '10px', fontSize: 13 }} onClick={() => setMostrarGastos(true)}>
        💰 Gastos del viaje
      </button>

      {viaje.hora_salida_real ? (
        <button
          type="button"
          style={{
            ...s.botonBloque, marginTop: 6, padding: '10px', fontSize: 13,
            background: viaje.hora_llegada_real ? '#f0fdf4' : undefined,
            color: viaje.hora_llegada_real ? '#16a34a' : undefined,
            borderColor: viaje.hora_llegada_real ? '#16a34a' : undefined,
          }}
          disabled={marcandoLlegada || !!viaje.hora_llegada_real}
          onClick={marcarLlegada}
          title="Cierra el rango de fechas para la rendición de gastos - sin esto, logística no puede aprobarla"
        >
          {viaje.hora_llegada_real
            ? `✅ Viaje finalizado (${horaLegible(viaje.hora_llegada_real)})`
            : marcandoLlegada ? 'Marcando…' : '🏁 Finalizar viaje'}
        </button>
      ) : null}

      {expandido ? (
        <div style={{ marginTop: 10, borderTop: '1px solid #eee', paddingTop: 6 }}>
          {cargandoParadas ? (
            <div style={{ fontSize: 13, opacity: 0.6, padding: 8 }}>Cargando paradas…</div>
          ) : !paradas?.length ? (
            <div style={{ fontSize: 13, opacity: 0.6, padding: 8 }}>Todavía no tiene paradas cargadas.</div>
          ) : (
            paradas.map((p, i) => (
              <ParadaRow
                key={p.tipo === 'extra' ? `extra-${i}` : `nv-${p.nv}`} parada={p} viaje={viaje}
                onAbrirNv={(payload) => onAbrirNv({ ...payload, onParadaCambiada: recargarParadas })}
                onAbrirExtra={onAbrirExtra}
              />
            ))
          )}
        </div>
      ) : null}

      {mostrarGastos ? <GastosSheet viaje={viaje} onClose={() => setMostrarGastos(false)} /> : null}
      {mostrarChecklist ? (
        <ChecklistSheet
          tipo={viaje.checklist_tipo}
          busy={marcando}
          errorExterno={errChecklist}
          onConfirmar={confirmarChecklist}
          onCerrar={() => { setMostrarChecklist(false); setErrChecklist(''); }}
        />
      ) : null}
    </div>
  );
}

function Chip({ children }) {
  return <span style={{ padding: '3px 9px', borderRadius: 999, background: '#f3f4f6', border: '1px solid #e5e7eb', fontWeight: 700 }}>{children}</span>;
}

// ===========================================================================
// Lista de viajes (pantalla principal logueado)
// ===========================================================================
function ViajesScreen({ qcUser, onSalir }) {
  const [rango, setRango] = useState('10d'); // '10d' | 'todos'
  const [viajes, setViajes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [nvAbierto, setNvAbierto] = useState(null); // { nv, viaje, parada } | null
  const [extraAbierta, setExtraAbierta] = useState(null);

  const cargar = () => {
    setErr('');
    setLoading(true);
    fetchDespachoV2Viajes(rango)
      .then((d) => setViajes(d?.viajes || []))
      .catch((e) => {
        if (e?.response?.status === 401) { clearDespachoV2Session(); onSalir(); return; }
        setErr(e?.response?.data?.error || e.message);
      })
      .finally(() => setLoading(false));
  };

  useEffect(cargar, [rango]);

  return (
    <div style={s.pantalla}>
      <div style={s.header}>
        <div style={{ fontWeight: 900, fontSize: 16 }}>👋 {qcUser?.name}</div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <InsumosCartButton seccion="despacho" />
          <button type="button" onClick={() => { clearDespachoV2Session(); onSalir(); }} style={{ background: 'rgba(255,255,255,.15)', border: 'none', color: '#fff', borderRadius: 8, padding: '6px 10px', fontSize: 12, fontWeight: 700 }}>
            Salir
          </button>
        </div>
      </div>

      <div style={{ padding: '10px 14px', display: 'flex', gap: 6 }}>
        <button
          type="button" onClick={() => setRango('10d')}
          style={{ flex: 1, padding: '9px', borderRadius: 10, border: '1px solid #d1d5db', fontWeight: 800, fontSize: 13, background: rango === '10d' ? BRAND : '#fff', color: rango === '10d' ? '#fff' : '#111' }}
        >
          Próximos 10 días
        </button>
        <button
          type="button" onClick={() => setRango('todos')}
          style={{ flex: 1, padding: '9px', borderRadius: 10, border: '1px solid #d1d5db', fontWeight: 800, fontSize: 13, background: rango === 'todos' ? BRAND : '#fff', color: rango === 'todos' ? '#fff' : '#111' }}
        >
          Toda la programación
        </button>
      </div>

      <div style={{ flex: 1, padding: '4px 14px 24px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {err ? <div style={{ color: 'crimson', fontWeight: 700, fontSize: 13 }}>{err}</div> : null}
        {loading ? (
          <div style={{ opacity: 0.7, padding: 20, textAlign: 'center' }}>Cargando…</div>
        ) : viajes.length === 0 ? (
          <div style={{ opacity: 0.6, padding: 20, textAlign: 'center', fontSize: 14 }}>No hay viajes para mostrar.</div>
        ) : (
          viajes.map((v) => (
            <ViajeCard key={v.id} viaje={v} onCambio={cargar} onAbrirNv={setNvAbierto} onAbrirExtra={setExtraAbierta} />
          ))
        )}
      </div>

      {nvAbierto != null ? (
        <NvDetailSheet
          nv={nvAbierto.nv} viaje={nvAbierto.viaje} parada={nvAbierto.parada}
          onParadaCambiada={nvAbierto.onParadaCambiada}
          onClose={() => setNvAbierto(null)}
        />
      ) : null}
      {extraAbierta ? <ParadaExtraSheet parada={extraAbierta} onClose={() => setExtraAbierta(null)} /> : null}
    </div>
  );
}

// ===========================================================================
export default function DespachoV2Page() {
  const [qcUser, setQcUser] = useState(() => (getDespachoV2Token() ? getDespachoV2User() : null));

  if (!qcUser) {
    return <LoginScreen onLogueado={setQcUser} />;
  }
  return <ViajesScreen qcUser={qcUser} onSalir={() => setQcUser(null)} />;
}
