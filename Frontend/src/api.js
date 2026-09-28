// src/api.js
import axios from 'axios';

const API_BASE =
  import.meta.env.VITE_API_URL ||
  import.meta.env.VITE_API_BASE ||
  'http://localhost:4000';

// Exportado para armar a mano un link ABSOLUTO al backend (ej. el PDF del
// remito en despacho_v2: un <a href="/remitos-proxy/...">  relativo apunta
// al propio dominio del FRONTEND -Vercel-, no al backend -Render-, y ahí
// no hay ninguna ruta así, cae al router de React y termina en el login).
export const API_BASE_URL = String(API_BASE).replace(/\/+$/, '');

const api = axios.create({
  baseURL: String(API_BASE).replace(/\/+$/, ''), // sin trailing slash
  // 30s en vez de 15s: el backend en Render se "duerme" con inactividad y el
  // primer pedido después de eso tarda en despertarlo (cold start).
  timeout: 30000,
});

// ====== ADMIN TOKEN (localStorage) ======
// Clave "nueva" (la que estás usando en el login page)
const LS_TOKEN_PRIMARY = 'dg_admin_token';
// Clave "vieja" para compatibilidad con código anterior
const LS_TOKEN_FALLBACK = 'admin_token';

export function getAdminToken() {
  try {
    const a = localStorage.getItem(LS_TOKEN_PRIMARY);
    if (a && String(a).trim()) return String(a).trim();

    const b = localStorage.getItem(LS_TOKEN_FALLBACK);
    return b ? String(b).trim() : '';
  } catch {
    return '';
  }
}

export function setAdminToken(t) {
  try {
    const v = String(t || '').trim();
    localStorage.setItem(LS_TOKEN_PRIMARY, v);
    // compatibilidad
    localStorage.setItem(LS_TOKEN_FALLBACK, v);
  } catch {}
}

export function clearAdminToken() {
  try {
    localStorage.removeItem(LS_TOKEN_PRIMARY);
    localStorage.removeItem(LS_TOKEN_FALLBACK);
  } catch {}
}

// Inyecta token si existe
api.interceptors.request.use((config) => {
  const t = getAdminToken();
  if (t) config.headers.Authorization = `Bearer ${t}`;
  return config;
});

// Si el token vencido/inválido - avisa (evento global, lo escucha
// SessionExpiredOverlay) en vez de dejar que cada pantalla muestre su propio
// error crudo (ej. "Network Error"). Se excluye /admin/login: ahí un 401 es
// "usuario o contraseña incorrectos", no una sesión vencida.
api.interceptors.response.use(
  (res) => res,
  (error) => {
    const status = error?.response?.status;
    const url = error?.config?.url || '';
    if (status === 401 && !url.includes('/admin/login')) {
      window.dispatchEvent(new CustomEvent('admin-session-expired'));
    }
    return Promise.reject(error);
  }
);

// ====== /despacho_v2 (login de cuadrilla: nombre QC + PIN) ======
// Instancia de axios PROPIA, separada de `api` - no debe mezclarse con el
// token de admin (ni pisarlo ni ser pisada por él): quien entra acá nunca
// tiene ni necesita un login de admin.
const apiDespachoV2 = axios.create({
  baseURL: String(API_BASE).replace(/\/+$/, ''),
  timeout: 15000,
});
const LS_DESPACHO_V2_TOKEN = 'despacho_v2_token';
const LS_DESPACHO_V2_USER = 'despacho_v2_user'; // { id, name } - para mostrar sin depender de un request

export function getDespachoV2Token() {
  try { return localStorage.getItem(LS_DESPACHO_V2_TOKEN) || ''; } catch { return ''; }
}
export function setDespachoV2Session(token, qcUser) {
  try {
    localStorage.setItem(LS_DESPACHO_V2_TOKEN, token || '');
    localStorage.setItem(LS_DESPACHO_V2_USER, JSON.stringify(qcUser || null));
  } catch {}
}
export function getDespachoV2User() {
  try { return JSON.parse(localStorage.getItem(LS_DESPACHO_V2_USER) || 'null'); } catch { return null; }
}
export function clearDespachoV2Session() {
  try {
    localStorage.removeItem(LS_DESPACHO_V2_TOKEN);
    localStorage.removeItem(LS_DESPACHO_V2_USER);
  } catch {}
}

apiDespachoV2.interceptors.request.use((config) => {
  const t = getDespachoV2Token();
  if (t) config.headers.Authorization = `Bearer ${t}`;
  return config;
});

// Mismo aviso de sesión vencida que en `api`, pero para la cuadrilla de
// /despacho_v2 (excluye /despacho-v2/login: ahí un 401 es PIN incorrecto).
apiDespachoV2.interceptors.response.use(
  (res) => res,
  (error) => {
    const status = error?.response?.status;
    const url = error?.config?.url || '';
    if (status === 401 && !url.includes('/despacho-v2/login')) {
      window.dispatchEvent(new CustomEvent('despacho-session-expired'));
    }
    return Promise.reject(error);
  }
);

export async function fetchDespachoV2QcUsers() {
  const { data } = await apiDespachoV2.get('/despacho-v2/qc-users');
  return data;
}
export async function despachoV2Login({ qc_user_id, pin }) {
  const { data } = await apiDespachoV2.post('/despacho-v2/login', { qc_user_id, pin });
  return data;
}
export async function fetchDespachoV2Viajes(rango) {
  const { data } = await apiDespachoV2.get('/despacho-v2/viajes', { params: { rango } });
  return data;
}
// checklist: { tipo, item_ids } - obligatorio la primera vez que se arranca
// el viaje (ver checklistDb.confirmarChecklistViaje en el backend); se
// ignora en un segundo toque (el viaje ya arrancó, ya no tiene efecto).
export async function marcarSalidaDespachoV2(viajeId, checklist) {
  const { data } = await apiDespachoV2.post(`/despacho-v2/viajes/${viajeId}/marcar-salida`, {
    checklist_tipo: checklist?.tipo,
    checklist_item_ids: checklist?.item_ids,
  });
  return data;
}
// Ítems activos del checklist de arranque para un tipo (solo_despacho | con_instalacion).
export async function fetchChecklistDespachoV2(tipo) {
  const { data } = await apiDespachoV2.get(`/despacho-v2/checklist/${tipo}`);
  return data;
}
export async function marcarLlegadaDespachoV2(viajeId) {
  const { data } = await apiDespachoV2.post(`/despacho-v2/viajes/${viajeId}/marcar-llegada`);
  return data;
}
export async function fetchParadasDespachoV2(viajeId) {
  const { data } = await apiDespachoV2.get(`/despacho-v2/viajes/${viajeId}/paradas`);
  return data;
}
export async function fetchNvDespachoV2(nv) {
  const { data } = await apiDespachoV2.get(`/despacho-v2/nv/${nv}`);
  return data;
}
export async function fetchNvAdjuntosDespachoV2(nv) {
  const { data } = await apiDespachoV2.get(`/despacho-v2/nv/${nv}/adjuntos`);
  return data;
}
// Fotos/videos adjuntados al tomar la medición en el Presupuestador (listado
// liviano, sin el archivo en sí).
export async function fetchNvMedicionMediaDespachoV2(nv) {
  const { data } = await apiDespachoV2.get(`/despacho-v2/nv/${nv}/medicion-media`);
  return data;
}
// El archivo puntual (data URL base64) - se pide recién al tocar un ítem.
export async function fetchMedicionMediaItemDespachoV2(nv, index) {
  const { data } = await apiDespachoV2.get(`/despacho-v2/nv/${nv}/medicion-media/${index}`);
  return data;
}
export async function crearSolicitudStDespachoV2(nv, { descripcion, attachment }) {
  const { data } = await apiDespachoV2.post(`/despacho-v2/nv/${nv}/st`, { descripcion, attachment }, { timeout: 30000 });
  return data;
}
// Remito por NV - endpoint ya público, sin login de despacho_v2 (routes/public/remitosProxy.js).
export async function fetchRemitosPorNv(nv) {
  const { data } = await apiDespachoV2.get('/remitos-proxy/search-by-nv', { params: { nv } });
  return data;
}
// "Marcar entregado/instalado" - cierre OFICIAL (despacho: pin; instalación:
// sin pin). Devuelve la siguiente parada-portón de la ruta (o null si esta
// era la última) para preguntarle al usuario antes de avisar por WhatsApp.
export async function marcarEntregadoDespachoV2(viajeId, nv, { tipo, pin } = {}) {
  const { data } = await apiDespachoV2.post(`/despacho-v2/viajes/${viajeId}/nv/${nv}/marcar-entregado`, { tipo, pin });
  return data;
}
// Se llama SOLO después de que el usuario confirmó "sí, la ruta sigue así".
export async function avisarSiguienteDespachoV2(viajeId, nv) {
  const { data } = await apiDespachoV2.post(`/despacho-v2/viajes/${viajeId}/nv/${nv}/avisar-siguiente`);
  return data;
}
// "La ruta cambió" - paradas-portón que quedaban después de `nv` en el
// orden original, para el picker de "¿cuál sigue?".
export async function fetchParadasRestantesDespachoV2(viajeId, nv) {
  const { data } = await apiDespachoV2.get(`/despacho-v2/viajes/${viajeId}/nv/${nv}/paradas-restantes`);
  return data;
}
// Manda el aviso para la parada que el usuario eligió a mano (ruta cambiada).
export async function avisarParadaElegidaDespachoV2(viajeId, nvOrigen, nvDestino) {
  const { data } = await apiDespachoV2.post(`/despacho-v2/viajes/${viajeId}/nv/${nvOrigen}/avisar-parada/${nvDestino}`);
  return data;
}
// Gastos del viaje ("rendición de gastos") - se comparte entre toda la
// cuadrilla del viaje, no solo quien los subió.
export async function fetchGastosDespachoV2(viajeId) {
  const { data } = await apiDespachoV2.get(`/despacho-v2/viajes/${viajeId}/gastos`);
  return data;
}
// Sube la foto/PDF PRIMERO - la IA lee fecha/motivo/monto/tipo de
// comprobante (ver server/lib/logisticaGastosIa.js), no hace falta
// completar nada a mano de entrada.
export async function crearGastoDespachoV2(viajeId, archivo) {
  const form = new FormData();
  form.append('archivo', archivo);
  const { data } = await apiDespachoV2.post(`/despacho-v2/viajes/${viajeId}/gastos`, form, { timeout: 60000 });
  return data;
}
export async function actualizarGastoDespachoV2(viajeId, gastoId, patch) {
  const { data } = await apiDespachoV2.patch(`/despacho-v2/viajes/${viajeId}/gastos/${gastoId}`, patch);
  return data;
}
export async function deleteGastoDespachoV2(viajeId, gastoId) {
  const { data } = await apiDespachoV2.delete(`/despacho-v2/viajes/${viajeId}/gastos/${gastoId}`);
  return data;
}

/* ========= Portones ========= */
export const fetchPortones = () => api.get('/portones');
export const createPorton = (payload) => api.post('/portones', payload);
export const startStage = (id, stage) => api.post(`/portones/${id}/stage`, { stage, action: 'start' });
export const stopStage = (id, stage) => api.post(`/portones/${id}/stage`, { stage, action: 'stop' });

export const setFechaPlan = (id, fechaOrNull) => api.post(`/portones/${id}/fecha-plan`, { fecha_plan: fechaOrNull });
export const setFechaProd = (id, fechaOrNull) => api.post(`/portones/${id}/fecha-prod`, { fecha_prod: fechaOrNull });
export const setFechaNV = (id, fechaOrNull) => api.post(`/portones/${id}/fecha-nv`, { fecha_nv: fechaOrNull });
export const setFechaMed = (id, fechaOrNull) => api.post(`/portones/${id}/fecha-med`, { fecha_med: fechaOrNull });

export const setFechaPlanEntrega = (id, fechaOrNull) =>
  api.post(`/portones/${id}/fecha-plan-entrega`, { fecha_plan_entrega: fechaOrNull });

// Flujo Logística (Fase 2c del motor de reglas de tiempo): fecha editable
// aparte de fecha_plan_entrega. Null = usa fecha_plan_entrega como fallback.
export const setFechaDespachoLogistica = (id, fechaOrNull) =>
  api.post(`/portones/${id}/fecha-despacho-logistica`, { fecha_despacho_logistica: fechaOrNull });

export const setSistemaPorton = (id, sistemaOrNull) =>
  api.post(`/portones/${id}/sistema`, { sistema: sistemaOrNull });

// Alias más explícito (uso interno en Preproducción)
export const setPortonSistema = setSistemaPorton;

/* ========= Observaciones Portones ========= */
export const getPortonObservaciones = (id) => api.get(`/portones/${id}/observaciones`);
export const savePortonObservaciones = (id, observaciones) => api.post(`/portones/${id}/observaciones`, { observaciones });
export const updatePortonObservaciones = (id, observaciones) => api.put(`/portones/${id}/observaciones`, { observaciones });
export const setPortonObservaciones = (id, observaciones) => updatePortonObservaciones(id, observaciones);

/* ========= iPanels productivos ========= */
export const fetchIpanels = (params = {}) => api.get('/ipanel', { params });
export const createIpanel = (payload) => api.post('/ipanel', payload);
export const startIpanelStage = (id, stage) => api.post(`/ipanel/${id}/stage`, { stage, action: 'start' });
export const stopIpanelStage = (id, stage) => api.post(`/ipanel/${id}/stage`, { stage, action: 'stop' });

/* ========= Preproducción iPanels: datos desde SQL ya sincronizados ========= */
export const fetchIpanelPreproduccionValores = (params = {}) =>
  api.get('/preproduccion-valores-ipanels', { params });

export const updateIpanelPreproduccionValor = (id, patch) =>
  api.patch(`/preproduccion-valores-ipanels/${id}`, patch);

export const enviarIpanelPreproduccionAProduccion = (id, payload = {}) =>
  api.post(`/preproduccion-valores-ipanels/${id}/enviar-produccion`, payload);

/* ========= Fechas iPanels productivos ========= */
export const setIpanelFechaProd = (id, fechaOrNull) => api.post(`/ipanel/${id}/fecha-prod`, { fecha_prod: fechaOrNull });
export const setIpanelFechaNV = (id, fechaOrNull) => api.post(`/ipanel/${id}/fecha-nv`, { fecha_nv: fechaOrNull });
export const setIpanelFechaMed = (id, fechaOrNull) => api.post(`/ipanel/${id}/fecha-med`, { fecha_med: fechaOrNull });
export const setIpanelFechaPlan = (id, fechaOrNull) => api.post(`/ipanel/${id}/fecha-plan`, { fecha_plan: fechaOrNull });

export const setIpanelFechaPlanEntrega = (id, fechaOrNull) =>
  api.post(`/ipanel/${id}/fecha-plan-entrega`, { fecha_plan_entrega: fechaOrNull });

/* ========= Observaciones iPanels ========= */
export const getIpanelObservaciones = (id) => api.get(`/ipanel/${id}/observaciones`);
export const saveIpanelObservaciones = (id, observaciones) => api.post(`/ipanel/${id}/observaciones`, { observaciones });
export const updateIpanelObservaciones = (id, observaciones) => api.put(`/ipanel/${id}/observaciones`, { observaciones });
export const setIpanelObservaciones = (id, observaciones) => updateIpanelObservaciones(id, observaciones);

/* ============ ADMIN WORKFLOW ============ */
export async function adminLogin(username, password) {
  const { data } = await api.post('/admin/login', { username, password });
  if (data?.token) setAdminToken(data.token);
  return data;
}

export async function getWorkflowConfig(line) {
  const { data } = await api.get('/admin/workflow/config', { params: { line } });
  return data;
}

export async function saveWorkflowConfig(line, payload) {
  const { data } = await api.put('/admin/workflow/config', payload, { params: { line } });
  return data;
}

export async function getWorkflowConditionFields(line) {
  const { data } = await api.get('/admin/workflow/condition-fields', { params: { line } });
  return data;
}

/* ============ ADMIN SCHEDULING (motor de reglas de tiempo — Fase 0/1, en sombra) ============ */
export async function getSchedulingStandard(line) {
  const { data } = await api.get('/admin/scheduling/standard', { params: { line } });
  return data;
}

export async function saveSchedulingStandard(line, standards) {
  const { data } = await api.put('/admin/scheduling/standard', { standards }, { params: { line } });
  return data;
}

export async function getSchedulingRules(line) {
  const { data } = await api.get('/admin/scheduling/rules', { params: { line } });
  return data;
}

export async function saveSchedulingRules(line, rules) {
  const { data } = await api.put('/admin/scheduling/rules', { rules }, { params: { line } });
  return data;
}

export async function getSchedulingPreview(line, limit) {
  const { data } = await api.get('/admin/scheduling/preview', { params: { line, limit } });
  return data;
}

export async function getSchedulingRegressionPreview(line, { porton_id, limit, mode, flow } = {}) {
  // La regresión de flota recorre varios portones — puede tardar más que el
  // timeout global de 15s (mismo criterio que ya usan las llamadas a IA en
  // este archivo, ej. recomendarLogisticaViajeIa).
  const { data } = await api.get('/admin/scheduling/regression/preview', {
    params: { line, porton_id, limit, mode, flow },
    timeout: 60000,
  });
  return data;
}

// Fase 3: recursos físicos compartidos entre etapas (ej. una sola cortadora
// para guillotina + corte_revest). El catálogo (scheduling_resource) es
// global, no por línea; el mapeo (scheduling_stage_resource) sí es por línea.
export async function getSchedulingResources() {
  const { data } = await api.get('/admin/scheduling/resources');
  return data;
}

export async function saveSchedulingResource(resource) {
  const { data } = await api.post('/admin/scheduling/resources', resource);
  return data;
}

export async function deleteSchedulingResource(resourceKey) {
  const { data } = await api.delete(`/admin/scheduling/resources/${encodeURIComponent(resourceKey)}`);
  return data;
}

export async function getSchedulingStageResource(line) {
  const { data } = await api.get('/admin/scheduling/stage-resource', { params: { line } });
  return data;
}

export async function saveSchedulingStageResource(line, mappings) {
  const { data } = await api.put('/admin/scheduling/stage-resource', { mappings }, { params: { line } });
  return data;
}

// Calendario laboral por recurso (categoría "Tiempo"). Sin cargar nada, un
// recurso cae al fallback Lun-Vie 08:00-18:00 (ver lib/scheduling/calendar.js).
export async function getSchedulingCalendar(resourceKey) {
  const { data } = await api.get('/admin/scheduling/calendar', { params: { resource_key: resourceKey } });
  return data;
}

export async function saveSchedulingCalendar(resourceKey, shifts) {
  const { data } = await api.put('/admin/scheduling/calendar', { shifts }, { params: { resource_key: resourceKey } });
  return data;
}

// resourceKey null/undefined = excepciones globales (feriado de planta completa).
export async function getSchedulingCalendarExceptions(resourceKey) {
  const { data } = await api.get('/admin/scheduling/calendar/exceptions', {
    params: resourceKey ? { resource_key: resourceKey } : {},
  });
  return data;
}

export async function saveSchedulingCalendarExceptions(resourceKey, exceptions) {
  const { data } = await api.put('/admin/scheduling/calendar/exceptions', { exceptions }, {
    params: resourceKey ? { resource_key: resourceKey } : {},
  });
  return data;
}

// Variables de recurso (Fase 3b): atributos de sección/máquina (no del
// portón) que se suman al contexto de evaluación de las etapas mapeadas a
// ese resource_key. resourceKey null/undefined = todas (todas las secciones).
export async function getSchedulingResourceVariables(resourceKey) {
  const { data } = await api.get('/admin/scheduling/resource-variables', {
    params: resourceKey ? { resource_key: resourceKey } : {},
  });
  return data;
}

export async function saveSchedulingResourceVariables(resourceKey, variables) {
  const { data } = await api.put('/admin/scheduling/resource-variables', { variables }, { params: { resource_key: resourceKey } });
  return data;
}

/* ============ QC (CALIDAD) ============ */
export async function qcGetMotives({ line, kind, stage }) {
  const { data } = await api.get('/qc/motives', {
    params: { line, kind, stage: stage ?? null },
    headers: { 'Cache-Control': 'no-cache' },
  });
  return data;
}

export async function qcAuthorize(payload) {
  const { data } = await api.post('/qc/authorize', payload, {
    headers: { 'Cache-Control': 'no-cache' },
  });
  return data;
}

export async function qcHistory({ line, item_id }) {
  const t = Date.now();
  const { data } = await api.get(
    `/qc/history/${encodeURIComponent(line)}/${encodeURIComponent(item_id)}`,
    {
      params: { t },
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
    }
  );
  return data;
}

export async function qcSummary({ line, item_ids, stage_key } = {}) {
  const payload = {
    line: String(line || '').trim(),
    item_ids: Array.isArray(item_ids)
      ? item_ids.map((n) => Number(n)).filter((n) => Number.isInteger(n))
      : [],
    stage_key: stage_key == null ? null : String(stage_key).trim(),
  };

  const { data } = await api.post('/qc/summary', payload, {
    headers: { 'Cache-Control': 'no-cache' },
  });
  return data;
}

/* ============ ADMIN QC (CRUD usuarios + motivos) ============ */
export async function adminQcUsersList() {
  const { data } = await api.get('/admin/qc/users');
  return data;
}

export async function adminQcUsersCreate(payload) {
  const { data } = await api.post('/admin/qc/users', payload);
  return data;
}

export async function adminQcUsersUpdate(id, payload) {
  const { data } = await api.put(`/admin/qc/users/${id}`, payload);
  return data;
}

export async function adminQcUsersReplaceScopes(id, scopes) {
  const { data } = await api.put(`/admin/qc/users/${id}/scopes`, { scopes });
  return data;
}

export async function adminQcMotivesList(params = {}) {
  const { data } = await api.get('/admin/qc/motives', { params });
  return data;
}

export async function adminQcMotivesCreate(payload) {
  const { data } = await api.post('/admin/qc/motives', payload);
  return data;
}

export async function adminQcMotivesUpdate(id, payload) {
  const { data } = await api.put(`/admin/qc/motives/${id}`, payload);
  return data;
}

/* ========= Bases (Planta / Despachar) ========= */
export const getPlantaBase = () => api.get('/planta/base');
export const postPlantaBase = (payload) => api.post('/planta/base', payload);
export const getPlantaBases = () => api.get('/planta/bases');

export const getDespacharBase = () => api.get('/despachar/base');
export const postDespacharBase = (payload) => api.post('/despachar/base', payload);
export const getDespacharBases = () => api.get('/despachar/bases');

/* ========= Preproducción portones ========= */
export const fetchPreproduccionValores = () => api.get('/preproduccion-valores');
export const updatePreproduccionValor = (id, patch) => api.put(`/preproduccion-valores/${id}`, { patch });
export const fetchNvQuoteLines = (nv) => api.get(`/preproduccion-valores/${nv}/quote-lines`);
export const fetchNvLines = (nv, tipo = 'NV') =>
  api.get(`/preproduccion-valores/${nv}/nv-lines`, { params: { tipo } });

// --------------------
// ADMIN USERS / SCOPES
// --------------------
export function fetchUsers() {
  return api.get('/admin/users');
}

export function createUser(payload) {
  return api.post('/admin/users', payload);
}

export function updateUser(id, patch) {
  return api.patch(`/admin/users/${id}`, patch);
}

export function setUserPassword(id, payload) {
  return api.post(`/admin/users/${id}/password`, payload);
}

export function fetchScopes() {
  return api.get('/admin/scopes');
}

/* ========= Prefabricados ========= */
export const fetchPrefabricadoTipos = () => api.get('/prefabricados/tipos');
export const fetchPrefabricados = () => api.get('/prefabricados');
export const createPrefabricadoOrden = (payload) => api.post('/prefabricados', payload);
export const startPrefabricadoStage = (id, stage) => api.post(`/prefabricados/${id}/stage`, { stage, action: 'start' });
export const stopPrefabricadoStage = (id, stage) => api.post(`/prefabricados/${id}/stage`, { stage, action: 'stop' });

export const adminListPrefabricadoTipos = () => api.get('/admin/prefabricados/tipos');
export const adminCreatePrefabricadoTipo = (payload) => api.post('/admin/prefabricados/tipos', payload);
export const adminUpdatePrefabricadoTipo = (id, payload) => api.put(`/admin/prefabricados/tipos/${id}`, payload);

/* ========= Servicio Técnico ========= */
export const fetchServicioTecnico = () => api.get('/servicio-tecnico');
export const startStStage = (id, stage) => api.post(`/servicio-tecnico/${id}/stage`, { stage, action: 'start' });
export const stopStStage = (id, stage) => api.post(`/servicio-tecnico/${id}/stage`, { stage, action: 'stop' });
export const createPruebaLaserOrden = (descripcion, pasoPorPlegadora) =>
  api.post('/servicio-tecnico/prueba-laser', { descripcion, paso_por_plegadora: Boolean(pasoPorPlegadora) });

export const adminListStOrdenes = () => api.get('/admin/servicio-tecnico/ordenes');
export const adminCreateStOrden = (payload) => api.post('/admin/servicio-tecnico/ordenes', payload);

/* ========= Solicitudes de Servicio Técnico (paso antes de generar una ST de producción) ========= */
export async function fetchStSolicitudNvInfo(numero) {
  const { data } = await api.get(`/admin/servicio-tecnico/solicitudes/nv-info/${encodeURIComponent(numero)}`);
  return data;
}
export async function fetchStSolicitudNvHistorial(numero) {
  const { data } = await api.get(`/admin/servicio-tecnico/solicitudes/nv-historial/${encodeURIComponent(numero)}`);
  return data;
}
export async function fetchStSolicitudes(estado) {
  const { data } = await api.get('/admin/servicio-tecnico/solicitudes', { params: estado ? { estado } : {} });
  return data;
}
export async function fetchStSolicitud(id) {
  const { data } = await api.get(`/admin/servicio-tecnico/solicitudes/${id}`);
  return data;
}
export async function createStSolicitud(payload) {
  const { data } = await api.post('/admin/servicio-tecnico/solicitudes', payload);
  return data;
}
export async function updateStSolicitud(id, patch) {
  const { data } = await api.patch(`/admin/servicio-tecnico/solicitudes/${id}`, patch);
  return data;
}
export async function deleteStSolicitud(id) {
  const { data } = await api.delete(`/admin/servicio-tecnico/solicitudes/${id}`);
  return data;
}
export async function agregarStHistorial(id, payload) {
  const { data } = await api.post(`/admin/servicio-tecnico/solicitudes/${id}/historial`, payload);
  return data;
}
export async function fetchStPortonesPendientesMedicion() {
  const { data } = await api.get('/admin/servicio-tecnico/mediciones-pendientes');
  return data;
}

/* ========= Planificación de Fechas + Viajes de Servicio Técnico ========= */
export async function fetchStFechasItems() {
  const { data } = await api.get('/admin/servicio-tecnico/viajes-fechas/items');
  return data;
}
export async function patchStFechaItem(tipo, id, fecha) {
  const { data } = await api.patch(`/admin/servicio-tecnico/viajes-fechas/items/${tipo}/${encodeURIComponent(id)}`, { fecha });
  return data;
}
export async function fetchStLogisticaSombraFechas() {
  const { data } = await api.get('/admin/servicio-tecnico/viajes-fechas/logistica-sombra');
  return data;
}
export async function fetchStViajesConfig() {
  const { data } = await api.get('/admin/servicio-tecnico/viajes-fechas/config');
  return data;
}
export async function createStVehiculo(payload) {
  const { data } = await api.post('/admin/servicio-tecnico/viajes-fechas/vehiculos', payload);
  return data;
}
export async function updateStVehiculo(id, patch) {
  const { data } = await api.patch(`/admin/servicio-tecnico/viajes-fechas/vehiculos/${id}`, patch);
  return data;
}
export async function deleteStVehiculo(id) {
  const { data } = await api.delete(`/admin/servicio-tecnico/viajes-fechas/vehiculos/${id}`);
  return data;
}
export async function createStCuadrilla(payload) {
  const { data } = await api.post('/admin/servicio-tecnico/viajes-fechas/cuadrillas', payload);
  return data;
}
export async function updateStCuadrilla(id, patch) {
  const { data } = await api.patch(`/admin/servicio-tecnico/viajes-fechas/cuadrillas/${id}`, patch);
  return data;
}
export async function deleteStCuadrilla(id) {
  const { data } = await api.delete(`/admin/servicio-tecnico/viajes-fechas/cuadrillas/${id}`);
  return data;
}
export async function setStCuadrillaMiembros(id, qcUserIds) {
  const { data } = await api.put(`/admin/servicio-tecnico/viajes-fechas/cuadrillas/${id}/miembros`, { qc_user_ids: qcUserIds });
  return data;
}
export async function fetchStSemanas() {
  const { data } = await api.get('/admin/servicio-tecnico/viajes-fechas/semanas');
  return data;
}
export async function fetchStSemanaDetalle(semana) {
  const { data } = await api.get(`/admin/servicio-tecnico/viajes-fechas/semanas/${encodeURIComponent(semana)}`);
  return data;
}
export async function fetchStLogisticaSombra(semana) {
  const { data } = await api.get(`/admin/servicio-tecnico/viajes-fechas/semanas/${encodeURIComponent(semana)}/logistica-sombra`);
  return data;
}
export async function crearStViaje(semana, payload) {
  const { data } = await api.post(`/admin/servicio-tecnico/viajes-fechas/semanas/${encodeURIComponent(semana)}/viajes`, payload);
  return data;
}
export async function patchStViaje(id, patch) {
  const { data } = await api.patch(`/admin/servicio-tecnico/viajes-fechas/viajes/${id}`, patch);
  return data;
}
export async function borrarStViaje(id) {
  const { data } = await api.delete(`/admin/servicio-tecnico/viajes-fechas/viajes/${id}`);
  return data;
}
export async function asignarStItem(viajeId, payload) {
  const { data } = await api.post(`/admin/servicio-tecnico/viajes-fechas/viajes/${viajeId}/items`, payload);
  return data;
}
export async function desasignarStItem(viajeId, tipo, itemId) {
  const { data } = await api.delete(`/admin/servicio-tecnico/viajes-fechas/viajes/${viajeId}/items/${tipo}/${encodeURIComponent(itemId)}`);
  return data;
}
export async function reordenarStViaje(viajeId, items) {
  const { data } = await api.put(`/admin/servicio-tecnico/viajes-fechas/viajes/${viajeId}/orden`, { items });
  return data;
}

/* ========= IA de Servicio Técnico (espejo de la IA de Logística) ========= */
export async function fetchStIaConfig() {
  const { data } = await api.get('/admin/servicio-tecnico/viajes-fechas/ia/config');
  return data;
}
export async function updateStIaConfig(patch) {
  const { data } = await api.patch('/admin/servicio-tecnico/viajes-fechas/ia/config', patch);
  return data;
}
export async function fetchStItemsSinFecha() {
  const { data } = await api.get('/admin/servicio-tecnico/viajes-fechas/items-sin-fecha');
  return data;
}
export async function recomendarStViajeIa(items) {
  const { data } = await api.post('/admin/servicio-tecnico/viajes-fechas/ia/recomendar-viaje', { items }, { timeout: 90000 });
  return data;
}
export async function planificarStRutasIa() {
  const { data } = await api.post('/admin/servicio-tecnico/viajes-fechas/ia/planificar', {}, { timeout: 180000 });
  return data;
}
export async function cerrarStSemana(semana) {
  const { data } = await api.post(`/admin/servicio-tecnico/viajes-fechas/semanas/${encodeURIComponent(semana)}/cerrar`);
  return data;
}
export async function reabrirStSemana(semana) {
  const { data } = await api.post(`/admin/servicio-tecnico/viajes-fechas/semanas/${encodeURIComponent(semana)}/reabrir`);
  return data;
}

/* ========= Refabricación ========= */
export const fetchRefabricacionPendientes = () => api.get('/refabricacion/pendientes');

// payload debe incluir { parent_nv, pin, fecha_prod, detalle_refabricacion, etapas_a_realizar }
export const crearRefabricacion = (payload) => api.post('/refabricacion', payload);

// nv: NV entero del portón; pin: PIN del usuario QC global
export const aprobarRevision = (nv, pin) => api.post(`/portones/${nv}/revision-ok`, { pin });

/* ========= Insumos (pedidos diarios por sección + dashboard Compras) ========= */
export const fetchInsumosSecciones = () => api.get('/insumos/secciones');
export const fetchInsumosProductos = (seccion) => api.get('/insumos/productos', { params: { seccion } });
export const fetchInsumosPedidoHoy = (seccion) => api.get('/insumos/pedidos/hoy', { params: { seccion } });
export const upsertInsumosPedidoItem = (pedidoId, payload) => api.post(`/insumos/pedidos/${pedidoId}/items`, payload);
export const deleteInsumosPedidoItem = (pedidoId, itemId) => api.delete(`/insumos/pedidos/${pedidoId}/items/${itemId}`);
export const confirmInsumosPedido = (pedidoId, pin) => api.post(`/insumos/pedidos/${pedidoId}/confirm`, { pin });

export const adminFetchInsumosCategorias = (refresh) => api.get('/admin/insumos/categorias', { params: refresh ? { refresh: 1 } : {} });
export const adminFetchInsumosCategoriaProductos = (categId) => api.get(`/admin/insumos/categorias/${categId}/productos`);
export const adminFetchInsumosCategoriaMap = () => api.get('/admin/insumos/categoria-map');
export const adminSaveInsumosCategoriaMap = (entries) => api.put('/admin/insumos/categoria-map', { entries });
export const adminListInsumosPedidos = (params) => api.get('/admin/insumos/pedidos', { params });
export const adminListInsumosItems = (params) => api.get('/admin/insumos/items', { params });
export const adminGetInsumosPedido = (id) => api.get(`/admin/insumos/pedidos/${id}`);
export const adminUpdateInsumosPedidoItem = (pedidoId, itemId, patch) => api.put(`/admin/insumos/pedidos/${pedidoId}/items/${itemId}`, patch);
export const adminAddInsumosPedidoItem = (pedidoId, payload) => api.post(`/admin/insumos/pedidos/${pedidoId}/items`, payload);
export const adminSetInsumoProductoNombre = (productoId, nombreDisplay) =>
  api.put(`/admin/insumos/productos/${productoId}/nombre`, { nombre_display: nombreDisplay });

export const adminGetNotaNodo = (nodoId) => api.get(`/admin/notas-nodo/${nodoId}`);
// payload: { nota, admin_user, admin_password } - los tres se guardan juntos;
// el acceso principal solo se pisa si vienen los dos campos cargados.
export const adminSetNotaNodo = (nodoId, payload) => api.put(`/admin/notas-nodo/${nodoId}`, payload);

// "¿Qué se está trabajando acá?" - una entrada por admin (nunca se pisan
// entre sí). El autor lo pone el backend (req.admin.username), no el body.
export const adminListNotaEntradas = (nodoId) => api.get(`/admin/notas-nodo/${nodoId}/entradas`);
export const adminSetNotaEntrada = (nodoId, texto) => api.put(`/admin/notas-nodo/${nodoId}/entradas`, { texto });
export const adminDeleteNotaEntrada = (nodoId) => api.delete(`/admin/notas-nodo/${nodoId}/entradas`);

export const adminListUsuariosPrueba = (nodoId) => api.get(`/admin/notas-nodo/${nodoId}/usuarios-prueba`);
export const adminAddUsuarioPrueba = (nodoId, { etiqueta, usuario, password }) =>
  api.post(`/admin/notas-nodo/${nodoId}/usuarios-prueba`, { etiqueta, usuario, password });
export const adminDeleteUsuarioPrueba = (nodoId, id) =>
  api.delete(`/admin/notas-nodo/${nodoId}/usuarios-prueba/${id}`);
export const adminFetchInsumosSeccionesCierre = () => api.get('/admin/insumos/secciones-cierre');
export const adminSaveInsumosSeccionesCierre = (entries) => api.put('/admin/insumos/secciones-cierre', { entries });

/* ========= Consultas de Logística (a Técnica / Comercial, vía /a) =========
   "kind" es 'technical' o 'commercial'. Escriben directo sobre las mismas
   tablas que usa el Presupuestador para sus tickets de vendedor/distribuidor
   (misma base de datos), a nombre de la cuenta compartida "Logística". */
export const fetchLogisticaConsultas = (kind, status = 'open') =>
  api.get(`/admin/logistica-consultas/${kind}`, { params: { status } });
export const fetchLogisticaConsultaDetail = (kind, id) => api.get(`/admin/logistica-consultas/${kind}/${id}`);
export const createLogisticaConsulta = (kind, payload) => api.post(`/admin/logistica-consultas/${kind}`, payload);
export const addLogisticaConsultaMessage = (kind, id, payload) =>
  api.post(`/admin/logistica-consultas/${kind}/${id}/messages`, payload);
export const markLogisticaConsultaRead = (kind, id) => api.post(`/admin/logistica-consultas/${kind}/${id}/read`, {});
export const fetchLogisticaConsultasUnreadSummary = (kind) => api.get(`/admin/logistica-consultas/${kind}/unread-summary`);

/* ========= Sistema de Tickets (botón junto a "Menú" / "Refrescar") =========
   Cualquier admin logueado puede crear un ticket y ver/responder los propios;
   también puede ver/responder/cerrar cualquier ticket desde /admin/tickets
   (sin scope propio, como /admin/indice-programacion). */
export const createTicket = (payload) => api.post('/admin/tickets', payload);
export const fetchMyTickets = () => api.get('/admin/tickets/mine');
export const fetchMyTicketDetail = (id) => api.get(`/admin/tickets/mine/${id}`);
export const addMyTicketMessage = (id, payload) => api.post(`/admin/tickets/mine/${id}/messages`, payload);
export const cancelMyTicket = (id) => api.delete(`/admin/tickets/mine/${id}`);
export const fetchAdminTickets = (params) => api.get('/admin/tickets', { params });
export const fetchAdminTicketDetail = (id) => api.get(`/admin/tickets/${id}`);
export const addAdminTicketMessage = (id, payload) => api.post(`/admin/tickets/${id}/messages`, payload);
export const updateTicketStatus = (id, estado) => api.patch(`/admin/tickets/${id}/status`, { estado });
// "Asignarme"/"Tomar" (quedo yo como quien está trabajando en esto) o
// "Quitarme" (queda sin nadie) - un click directo, en cualquier estado.
export const assignTicketToMe = (id) => api.patch(`/admin/tickets/${id}/asignado`, { accion: 'asignar' });
export const unassignTicket = (id) => api.patch(`/admin/tickets/${id}/asignado`, { accion: 'liberar' });
// Solo para tarjetas "tarea" (creadas a mano en el tablero) - mueve la
// tarjeta a otra columna del tablero, sin tocar su estado.
export const updateTicketBoardColumn = (id, column) => api.patch(`/admin/tickets/${id}/board-column`, { column });
// Borra el ticket sea cual sea su estado (pendiente/en curso/cerrado).
export const deleteAdminTicket = (id) => api.delete(`/admin/tickets/${id}`);
// "Apartados": columnas extra del tablero que un admin crea a mano ("+
// Nuevo apartado" en AdminTicketsBoardPage.jsx), además de las fijas.
export const fetchTicketApartados = () => api.get('/admin/tickets/apartados');
export const createTicketApartado = (nombre) => api.post('/admin/tickets/apartados', { nombre });
export const deleteTicketApartado = (clave) => api.delete(`/admin/tickets/apartados/${encodeURIComponent(clave)}`);

/* ========= Reuniones y Tareas (/admin/reuniones) =========
   Agenda compartida entre admins - sin scope propio, cualquier admin
   logueado ve/crea/edita/borra cualquier reunión (mismo criterio que
   /admin/tickets). El link a "tareas" apunta a la columna "Tareas" del
   tablero de Tickets (/admin/tickets-tablero), no es una pantalla nueva. */
export const fetchReuniones = (params) => api.get('/admin/reuniones', { params });
export const createReunion = (payload) => api.post('/admin/reuniones', payload);
export const updateReunion = (id, payload) => api.put(`/admin/reuniones/${id}`, payload);
export const deleteReunion = (id) => api.delete(`/admin/reuniones/${id}`);

/* ========= Chat de Programadores (/admin/programadores/chat) =========
   Un único grupo tipo WhatsApp, solo scope programadores:admin.
   params: { despues_de } (polling) | { antes_de } (anteriores) | nada. */
export const fetchProgramadoresChat = (params) => api.get('/admin/programadores/chat/mensajes', { params });
// clienteId: id temporal de la burbuja "enviando" (vuelve en la respuesta y
// en el evento en tiempo real). onProgreso(0-100): avance de la subida.
export function enviarProgramadoresChat({ texto, archivos = [], respondeAId, clienteId, onProgreso }) {
  const form = new FormData();
  if (texto) form.append('texto', texto);
  if (respondeAId) form.append('responde_a_id', String(respondeAId));
  if (clienteId) form.append('cliente_id', clienteId);
  for (const f of archivos) form.append('archivos', f);
  return api.post('/admin/programadores/chat/mensajes', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 120000, // subir varios archivos grandes tarda más que los 30s por defecto
    onUploadProgress: onProgreso
      ? (e) => { if (e.total) onProgreso(Math.round((e.loaded / e.total) * 100)); }
      : undefined,
  });
}
export const editarProgramadoresChat = (id, texto) => api.put(`/admin/programadores/chat/mensajes/${id}`, { texto });
// Borrado lógico: queda "Este mensaje fue eliminado".
export const eliminarProgramadoresChat = (id) => api.delete(`/admin/programadores/chat/mensajes/${id}`);
// emoji null quita la reacción propia.
export const reaccionarProgramadoresChat = (id, emoji) => api.put(`/admin/programadores/chat/mensajes/${id}/reaccion`, { emoji });
export const marcarProgramadoresChatLeido = (hastaId) => api.post('/admin/programadores/chat/leido', { hasta_id: hastaId });
export const fetchProgramadoresChatNoLeidos = () => api.get('/admin/programadores/chat/no-leidos');

/* ========= Logística de Viajes (despacho + instalación por semana, desde /a) =========
   Arma "viajes" (fecha + zona + cuadrilla + vehículo) por semana ISO y reparte en
   ellos los portones con despacho/instalación de esa semana. Ver
   Backend/server/routes/admin/logisticaViajes.js. */
export async function fetchLogisticaViajesConfig() {
  const { data } = await api.get('/admin/logistica/config');
  return data;
}

export async function createLogisticaZona(payload) {
  const { data } = await api.post('/admin/logistica/zonas', payload);
  return data;
}
export async function updateLogisticaZona(id, patch) {
  const { data } = await api.patch(`/admin/logistica/zonas/${id}`, patch);
  return data;
}
export async function deleteLogisticaZona(id) {
  const { data } = await api.delete(`/admin/logistica/zonas/${id}`);
  return data;
}

export async function createLogisticaVehiculo(payload) {
  const { data } = await api.post('/admin/logistica/vehiculos', payload);
  return data;
}
export async function updateLogisticaVehiculo(id, patch) {
  const { data } = await api.patch(`/admin/logistica/vehiculos/${id}`, patch);
  return data;
}
export async function deleteLogisticaVehiculo(id) {
  const { data } = await api.delete(`/admin/logistica/vehiculos/${id}`);
  return data;
}

export async function createLogisticaCuadrilla(payload) {
  const { data } = await api.post('/admin/logistica/cuadrillas', payload);
  return data;
}
export async function updateLogisticaCuadrilla(id, patch) {
  const { data } = await api.patch(`/admin/logistica/cuadrillas/${id}`, patch);
  return data;
}
export async function deleteLogisticaCuadrilla(id) {
  const { data } = await api.delete(`/admin/logistica/cuadrillas/${id}`);
  return data;
}
export async function setLogisticaCuadrillaMiembros(id, qcUserIds) {
  const { data } = await api.put(`/admin/logistica/cuadrillas/${id}/miembros`, { qc_user_ids: qcUserIds });
  return data;
}

// CheckList de arranque de viaje en /despacho_v2 (botón Play) - dos tipos:
// solo_despacho | con_instalacion. Los ítems vienen junto al resto de la
// config (fetchLogisticaViajesConfig -> config.checklist_items).
export async function createLogisticaChecklistItem(payload) {
  const { data } = await api.post('/admin/logistica/checklist-items', payload);
  return data;
}
export async function updateLogisticaChecklistItem(id, patch) {
  const { data } = await api.patch(`/admin/logistica/checklist-items/${id}`, patch);
  return data;
}
export async function deleteLogisticaChecklistItem(id) {
  const { data } = await api.delete(`/admin/logistica/checklist-items/${id}`);
  return data;
}

export async function createLogisticaReglaCapacidad(payload) {
  const { data } = await api.post('/admin/logistica/reglas-capacidad', payload);
  return data;
}
export async function updateLogisticaReglaCapacidad(id, patch) {
  const { data } = await api.patch(`/admin/logistica/reglas-capacidad/${id}`, patch);
  return data;
}
export async function deleteLogisticaReglaCapacidad(id) {
  const { data } = await api.delete(`/admin/logistica/reglas-capacidad/${id}`);
  return data;
}

export async function createLogisticaZonaReferencia(payload) {
  const { data } = await api.post('/admin/logistica/zona-referencias', payload);
  return data;
}
export async function deleteLogisticaZonaReferencia(id) {
  const { data } = await api.delete(`/admin/logistica/zona-referencias/${id}`);
  return data;
}

export async function createLogisticaReglaEnvio(payload) {
  const { data } = await api.post('/admin/logistica/reglas-envio', payload);
  return data;
}
export async function updateLogisticaReglaEnvio(id, patch) {
  const { data } = await api.patch(`/admin/logistica/reglas-envio/${id}`, patch);
  return data;
}
export async function deleteLogisticaReglaEnvio(id) {
  const { data } = await api.delete(`/admin/logistica/reglas-envio/${id}`);
  return data;
}

export async function fetchLogisticaIaConfig() {
  const { data } = await api.get('/admin/logistica/ia/config');
  return data;
}
export async function updateLogisticaIaConfig(patch) {
  const { data } = await api.patch('/admin/logistica/ia/config', patch);
  return data;
}
export async function recomendarLogisticaViajeIa(nvs) {
  // La IA puede tardar bastante más que el timeout global (razonamiento
  // adaptativo + JSON estructurado - probado ~20-25s con pocos portones).
  const { data } = await api.post('/admin/logistica/ia/recomendar-viaje', { nvs }, { timeout: 90000 });
  return data;
}
export async function fetchLogisticaPortonesSinViaje() {
  const { data } = await api.get('/admin/logistica/portones-sin-viaje');
  return data;
}
export async function fetchLogisticaSinFechaSalida() {
  const { data } = await api.get('/admin/logistica/sin-fecha-salida');
  return data;
}
export async function asignarLogisticaFechaSalida(items, fecha) {
  const { data } = await api.patch('/admin/logistica/sin-fecha-salida/asignar', { items, fecha });
  return data;
}
export async function planificarLogisticaRutasIa() {
  // Una llamada a la IA por zona (en paralelo) - probado ~130s con una zona
  // grande (20 portones); le damos bastante margen.
  const { data } = await api.post('/admin/logistica/ia/planificar', {}, { timeout: 180000 });
  return data;
}

export async function fetchLogisticaSemanas() {
  const { data } = await api.get('/admin/logistica/semanas');
  return data;
}
export async function fetchLogisticaSemanaDetalle(semana) {
  const { data } = await api.get(`/admin/logistica/semanas/${encodeURIComponent(semana)}`);
  return data;
}
export async function crearLogisticaViaje(semana, payload) {
  const { data } = await api.post(`/admin/logistica/semanas/${encodeURIComponent(semana)}/viajes`, payload);
  return data;
}
export async function patchLogisticaViaje(id, patch) {
  const { data } = await api.patch(`/admin/logistica/viajes/${id}`, patch);
  return data;
}
export async function borrarLogisticaViaje(id) {
  const { data } = await api.delete(`/admin/logistica/viajes/${id}`);
  return data;
}
export async function asignarLogisticaPorton(viajeId, portonId, tipo) {
  const { data } = await api.post(`/admin/logistica/viajes/${viajeId}/portones`, { porton_id: portonId, tipo });
  return data;
}
export async function desasignarLogisticaPorton(viajeId, portonId, tipo) {
  const { data } = await api.delete(
    `/admin/logistica/viajes/${viajeId}/portones/${encodeURIComponent(portonId)}`,
    { params: { tipo } }
  );
  return data;
}
export async function reordenarLogisticaViaje(viajeId, items) {
  const { data } = await api.put(`/admin/logistica/viajes/${viajeId}/orden`, { items });
  return data;
}
export async function toggleLogisticaViajeZona(viajeId, zonaId, habilitada) {
  const { data } = await api.patch(`/admin/logistica/viajes/${viajeId}/zonas/${zonaId}`, { habilitada });
  return data;
}
export async function recalcularLogisticaRutaViaje(viajeId) {
  const { data } = await api.post(`/admin/logistica/viajes/${viajeId}/recalcular-ruta`, {});
  return data;
}
// Paradas que no son un portón (ej. alojamiento) - catálogo reutilizable +
// asignación por viaje. Ver Backend/server/lib/logisticaParadasExtra.js.
export async function fetchLogisticaPuntosExtra() {
  const { data } = await api.get('/admin/logistica/puntos-extra');
  return data;
}
export async function createLogisticaPuntoExtra(payload) {
  const { data } = await api.post('/admin/logistica/puntos-extra', payload);
  return data;
}
export async function updateLogisticaPuntoExtra(id, patch) {
  const { data } = await api.patch(`/admin/logistica/puntos-extra/${id}`, patch);
  return data;
}
export async function deleteLogisticaPuntoExtra(id) {
  const { data } = await api.delete(`/admin/logistica/puntos-extra/${id}`);
  return data;
}
export async function fetchLogisticaWhatsappTemplates() {
  const { data } = await api.get('/admin/logistica/whatsapp-templates');
  return data;
}
export async function fetchLogisticaWhatsappConversaciones() {
  const { data } = await api.get('/admin/logistica/whatsapp/conversaciones');
  return data;
}
export async function fetchLogisticaWhatsappMensajes(telefono) {
  const { data } = await api.get(`/admin/logistica/whatsapp/conversaciones/${encodeURIComponent(telefono)}/mensajes`);
  return data;
}
export async function enviarLogisticaWhatsappMensaje(telefono, texto) {
  const { data } = await api.post(`/admin/logistica/whatsapp/conversaciones/${encodeURIComponent(telefono)}/mensajes`, { texto });
  return data;
}
export async function setLogisticaWhatsappNombreContacto(telefono, nombre) {
  const { data } = await api.patch(`/admin/logistica/whatsapp/conversaciones/${encodeURIComponent(telefono)}/nombre`, { nombre });
  return data;
}
export async function enviarLogisticaWhatsappTemplateSimple(telefono, name, language) {
  const { data } = await api.post(`/admin/logistica/whatsapp/conversaciones/${encodeURIComponent(telefono)}/template-simple`, { name, language });
  return data;
}
export async function enviarLogisticaWhatsappMedia(telefono, archivo, caption) {
  const form = new FormData();
  form.append('archivo', archivo);
  if (caption) form.append('caption', caption);
  const { data } = await api.post(`/admin/logistica/whatsapp/conversaciones/${encodeURIComponent(telefono)}/media`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data;
}
export async function asignarLogisticaParadaExtra(viajeId, puntoExtraId) {
  const { data } = await api.post(`/admin/logistica/viajes/${viajeId}/paradas-extra`, { punto_extra_id: puntoExtraId });
  return data;
}
export async function desasignarLogisticaParadaExtra(viajeId, puntoExtraId) {
  const { data } = await api.delete(`/admin/logistica/viajes/${viajeId}/paradas-extra/${puntoExtraId}`);
  return data;
}
// patch: { duracion_minutos?, hora_salida_siguiente? } - duracion_minutos es
// para cualquier parada (ej. "retirar un cobro" = 15 min); hora_salida_siguiente
// es solo para paradas de descanso/hospedaje (la ruta retoma desde ese
// horario al día siguiente). Cualquiera de los dos acepta null para borrarlo.
export async function updateLogisticaParadaExtraViaje(viajeId, puntoExtraId, patch) {
  const { data } = await api.patch(`/admin/logistica/viajes/${viajeId}/paradas-extra/${puntoExtraId}`, patch);
  return data;
}

// Adjuntos (DNI, certificado de reincidencia que piden algunos countrys,
// etc.) - de un viaje y/o de un NV puntual. Ver Backend/server/routes/admin/logisticaAdjuntos.js.
export async function fetchLogisticaAdjuntos({ viajeId, nv } = {}) {
  const params = {};
  if (viajeId != null) params.viaje_id = viajeId;
  if (nv != null) params.nv = nv;
  const { data } = await api.get('/admin/logistica/adjuntos', { params });
  return data;
}
export async function uploadLogisticaAdjunto({ viajeId, nv, descripcion, archivo }) {
  const form = new FormData();
  if (viajeId != null) form.append('viaje_id', String(viajeId));
  if (nv != null) form.append('nv', String(nv));
  if (descripcion) form.append('descripcion', descripcion);
  form.append('archivo', archivo);
  // Timeout más largo que el default (15s) - una foto de celular puede
  // pesar varios MB y tardar más en subir, sobre todo desde el celular en
  // el depósito con mala señal.
  const { data } = await api.post('/admin/logistica/adjuntos', form, { timeout: 60000 });
  return data;
}
export async function deleteLogisticaAdjunto(id) {
  const { data } = await api.delete(`/admin/logistica/adjuntos/${id}`);
  return data;
}
// Catálogo de adjuntos por integrante de cuadrilla (ej. DNI) - se sube una
// vez y de ahí se "habilita" (sin volver a subirlo) para un viaje y/o NV.
export async function fetchLogisticaAdjuntosMiembro(qcUserId) {
  const { data } = await api.get(`/admin/logistica/adjuntos-miembro/${qcUserId}`);
  return data;
}
export async function fetchLogisticaAdjuntosMiembroPorCuadrilla(cuadrillaId) {
  const { data } = await api.get(`/admin/logistica/adjuntos-miembro/por-cuadrilla/${cuadrillaId}`);
  return data;
}
export async function uploadLogisticaAdjuntoMiembro({ qc_user_id, descripcion, archivo }) {
  const form = new FormData();
  form.append('qc_user_id', String(qc_user_id));
  if (descripcion) form.append('descripcion', descripcion);
  form.append('archivo', archivo);
  const { data } = await api.post('/admin/logistica/adjuntos-miembro', form, { timeout: 60000 });
  return data;
}
export async function deleteLogisticaAdjuntoMiembro(id) {
  const { data } = await api.delete(`/admin/logistica/adjuntos-miembro/${id}`);
  return data;
}
export async function habilitarLogisticaAdjuntoMiembro({ origen_miembro_id, viaje_id, nv }) {
  const { data } = await api.post('/admin/logistica/adjuntos/habilitar-miembro', { origen_miembro_id, viaje_id, nv });
  return data;
}
// Foto de perfil (integrante) y foto de vehículo - una sola cada uno, para
// el collage del mensaje automático de WhatsApp "en camino".
export async function fetchLogisticaFotoQcUser(qcUserId) {
  const { data } = await api.get(`/admin/logistica/qc-users/${qcUserId}/foto`);
  return data;
}
export async function uploadLogisticaFotoQcUser(qcUserId, archivo) {
  const form = new FormData();
  form.append('archivo', archivo);
  const { data } = await api.post(`/admin/logistica/qc-users/${qcUserId}/foto`, form, { timeout: 60000 });
  return data;
}
export async function deleteLogisticaFotoQcUser(qcUserId) {
  const { data } = await api.delete(`/admin/logistica/qc-users/${qcUserId}/foto`);
  return data;
}
export async function fetchLogisticaFotoVehiculo(vehiculoId) {
  const { data } = await api.get(`/admin/logistica/vehiculos/${vehiculoId}/foto`);
  return data;
}
export async function uploadLogisticaFotoVehiculo(vehiculoId, archivo) {
  const form = new FormData();
  form.append('archivo', archivo);
  const { data } = await api.post(`/admin/logistica/vehiculos/${vehiculoId}/foto`, form, { timeout: 60000 });
  return data;
}
export async function deleteLogisticaFotoVehiculo(vehiculoId) {
  const { data } = await api.delete(`/admin/logistica/vehiculos/${vehiculoId}/foto`);
  return data;
}
export async function cerrarLogisticaSemana(semana) {
  const { data } = await api.post(`/admin/logistica/semanas/${encodeURIComponent(semana)}/cerrar`, {});
  return data;
}
export async function reabrirLogisticaSemana(semana) {
  const { data } = await api.post(`/admin/logistica/semanas/${encodeURIComponent(semana)}/reabrir`, {});
  return data;
}

// Puntos de mapa (lat/lng resueltos de end_customer.maps_url) para una
// lista de NV — "Ver mapa" por semana/viaje.
export async function fetchLogisticaMapa(nvs) {
  const { data } = await api.get('/admin/logistica/mapa', { params: { nvs: (nvs || []).join(',') } });
  return data;
}

// Detalle de una semana (items asignados + sin asignar, con ubicación/zona)
// para el mapa de Planificación de Fechas filtrado por semana.
export async function fetchLogisticaSemanaMapa(semana) {
  const { data } = await api.get(`/admin/logistica/semana/${encodeURIComponent(semana)}/mapa`);
  return data;
}

// "Semana prometida" (producción reservada por el Presupuestador + margen configurable).
export async function fetchLogisticaPromesaConfig() {
  const { data } = await api.get('/admin/logistica/promesa-config');
  return data;
}
export async function updateLogisticaPromesaConfig(patch) {
  const { data } = await api.patch('/admin/logistica/promesa-config', patch);
  return data;
}
export async function fetchLogisticaSemanaPromesaMapa(semana) {
  const { data } = await api.get(`/admin/logistica/semana/${encodeURIComponent(semana)}/mapa-promesa`);
  return data;
}

// Mensaje de texto (borrador) para mandarle a la cuadrilla de un viaje.
export async function fetchLogisticaMensajeViaje(viajeId) {
  const { data } = await api.get(`/admin/logistica/viajes/${viajeId}/mensaje`);
  return data;
}

// Modo de pruebas: manda el aviso "en camino" (collage + plantilla) de este
// viaje a un teléfono cualquiera, para ver cómo sale antes de que se dispare
// en producción con el cliente real.
export async function probarAvisoWhatsappViaje(viajeId, { telefono, nombreCliente, horasTexto }) {
  const { data } = await api.post(`/admin/logistica/viajes/${viajeId}/probar-aviso-whatsapp`, { telefono, nombreCliente, horasTexto });
  return data;
}

// Rendiciones de gastos (consulta) - una fila por viaje con gastos
// cargados desde /despacho_v2, con su detalle (gastos + ticket adjunto) y total.
export async function fetchLogisticaRendiciones() {
  const { data } = await api.get('/admin/logistica/rendiciones');
  return data;
}
export async function fetchLogisticaRendicionDetalle(viajeId) {
  const { data } = await api.get(`/admin/logistica/rendiciones/${viajeId}`);
  return data;
}
export async function aprobarLogisticaRendicion(viajeId) {
  const { data } = await api.post(`/admin/logistica/rendiciones/${viajeId}/aprobar`);
  return data;
}

export default api;
