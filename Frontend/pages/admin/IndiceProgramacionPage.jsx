// pages/admin/IndiceProgramacionPage.jsx
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getAdminToken,
  adminGetNotaNodo,
  adminSetNotaNodo,
  adminListNotaEntradas,
  adminSetNotaEntrada,
  adminDeleteNotaEntrada,
  adminListUsuariosPrueba,
  adminAddUsuarioPrueba,
  adminDeleteUsuarioPrueba,
} from '../../src/api';

// Para mostrar el nombre de quien está escribiendo la nota apenas empieza a
// tipear, sin esperar a que se confirme el guardado (notaMeta.updatedBy solo
// se actualiza después de que el servidor responde).
function currentAdminUsername() {
  try {
    const token = getAdminToken();
    const payload = String(token || '').split('.')[1];
    if (!payload) return '';
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
    const decoded = JSON.parse(atob(b64 + pad));
    return decoded?.username || '';
  } catch {
    return '';
  }
}

const nodeBoxStyle = {
  position: 'absolute',
  zIndex: 2,
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  boxShadow: 'var(--shadow)',
  padding: '14px 18px',
  minHeight: 56,
  width: 170,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  textAlign: 'center',
  fontWeight: 900,
  color: 'var(--text)',
  userSelect: 'none',
  touchAction: 'none',
};

// Posiciones y conexiones de fábrica del diagrama. Cada usuario puede mover
// las cajas y crear/borrar líneas desde el navegador; esos cambios se
// guardan solo en su localStorage (ver LS_KEY), nunca en el servidor - así
// cada uno puede reordenar el diagrama a su gusto sin pisar lo de otro.
// Tres columnas y cinco filas bien alineadas: las cajas conectadas por una
// línea recta (vertical u horizontal) comparten exactamente la misma x o y,
// para que esa línea salga perfectamente derecha en vez de en diagonal.
const COL_LEFT = 15;
const COL_CENTER = 50;
const COL_RIGHT = 85;
const ROW_1 = 10;
const ROW_2 = 30;
const ROW_3 = 50;
const ROW_4 = 70;
const ROW_5 = 90;

const DEFAULT_NODES = [
  { id: 'fidelitytools', label: 'FidelityTools', x: COL_LEFT, y: ROW_2, special: 'fidelitytools' },
  { id: 'precios', label: 'Actualización de precios', x: COL_CENTER, y: ROW_1 },
  { id: 'top', label: 'Integrador', x: COL_CENTER, y: ROW_2 },
  { id: 'planificador', label: 'Planificador', x: COL_RIGHT, y: ROW_2, brand: true },
  { id: 'left', label: 'Presupuestador', x: COL_LEFT, y: ROW_3 },
  { id: 'center', label: 'Odoo', x: COL_CENTER, y: ROW_3, special: 'odoo' },
  { id: 'right', label: 'Remitos', x: COL_RIGHT, y: ROW_3 },
  { id: 'sisAntiguo', label: 'Sistema antiguo', x: COL_LEFT, y: ROW_4 },
  { id: 'bottom', label: 'Información de venta', x: COL_CENTER, y: ROW_4 },
  { id: 'importador', label: 'Importador', x: COL_CENTER, y: ROW_5 },
  // Arriba de Planificador, misma columna - así la línea a Planificador sale derecha.
  { id: 'supabase', label: 'Base de Datos Supabase', x: COL_RIGHT, y: ROW_1 },
];

const DEFAULT_EDGES = [
  { id: 'fidelitytools__left', from: 'fidelitytools', to: 'left' },
  { id: 'precios__top', from: 'precios', to: 'top' },
  { id: 'left__center', from: 'left', to: 'center' },
  { id: 'center__right', from: 'center', to: 'right' },
  { id: 'center__bottom', from: 'center', to: 'bottom' },
  { id: 'bottom__importador', from: 'bottom', to: 'importador' },
  { id: 'top__center', from: 'top', to: 'center' },
  { id: 'left__top', from: 'left', to: 'top' },
  { id: 'center__planificador', from: 'center', to: 'planificador' },
  { id: 'bottom__right', from: 'bottom', to: 'right' },
  { id: 'sisAntiguo__top', from: 'sisAntiguo', to: 'top' },
  { id: 'top__supabase', from: 'top', to: 'supabase' },
  { id: 'supabase__planificador', from: 'supabase', to: 'planificador' },
  { id: 'planificador__precios', from: 'planificador', to: 'precios' },
  { id: 'right__planificador', from: 'right', to: 'planificador' },
  { id: 'sisAntiguo__right', from: 'sisAntiguo', to: 'right' },
];

const LS_KEY = 'ip_diagram_layout_v1';

function defaultPositions() {
  const base = {};
  DEFAULT_NODES.forEach((n) => { base[n.id] = { x: n.x, y: n.y }; });
  return base;
}

function loadStoredLayout() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function persistLayout(positions, edges) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ positions, edges }));
  } catch {}
}

// Contenido que se muestra al hacer click en cada cuadro. Faltan definir
// los que no son Integrador/Planificador/Presupuestador/Remitos.
const NODE_CONTENT = {
  planificador: {
    label: 'Planificador',
    description:
      'Es el sistema interno de gestión de producción: un tablero tipo kanban que trackea cada ' +
      'portón e iPanel a través de todas las etapas de fabricación (diseño, láser, corte, plegado, ' +
      'armado, revestimiento, pintura, inyección, despacho), con inicio/fin de etapa y control de ' +
      'calidad. Antes de entrar a producción, cada partida pasa por autorizaciones de preproducción, ' +
      'y hay un circuito aparte para revisión de piezas observadas/rechazadas y su refabricación.',
    items: [
      'Tablero de producción (/board y tableros por sección/etapa)',
      'CreateGate: carga y planificación de portones/NV, fechas de producción y salida',
      'Status Portones / Status iPanels: estado y avance por NV',
      'Planta / Planta simple: vistas de solo lectura del estado de planta',
      'Autorizaciones de Preproducción (portones e iPanels)',
      'Revisión / Refabricación: piezas observadas, rechazadas y reingreso a fabricación',
      'Stats Portones: estadísticas de producción',
    ],
    adminUser: 'admin',
    adminPassword: 'admin123',
    url: '/index',
    database: [
      'SQL Server "WebApp" (legado): dbo.Pre_Produccion — se sincroniza fecha_prod/fecha_plan_entrega cuando se edita un iPanel que ya está en producción',
      'Supabase (propia): public.admin_users, public.preproduccion_valores / preproduccion_valores_ipanels (mismas tablas que llena Integrador, acá se editan por etapa), logística, servicio técnico, insumos, QC y las notas de este mismo diagrama',
      'Mismo proyecto Supabase que Integrador y Presupuestador — no son bases separadas',
    ],
  },
  top: {
    label: 'Integrador',
    description:
      'Es el puente entre el sistema viejo de ventas (SQL Server, tablas NTASVTAS / INTASVTAS / ' +
      'PRODUCTOS) y Odoo/Supabase: sincroniza los valores de Portones e iPanels para que ' +
      'Planificador los pueda cargar en el tablero de producción. Además incluye una segunda ' +
      'mini-herramienta (ARCA Comprobantes) que importa CSV de comprobantes recibidos y los carga ' +
      'como facturas de compra en Odoo, ya conciliadas.',
    items: [
      'Sync principal (dflex-sync): trae NV de Portones/iPanels desde SQL Server y Odoo, permite revisar y editar valores antes de mandarlos a producción',
      'Bloqueo de iPanels: partidas que nunca deben entrar a preproducción (lista en base + hardcodeada como respaldo)',
      'Fórmulas: asignación de propiedades desde Nota de Venta, con comparación integrador vs. presupuestador',
      'ARCA Comprobantes: importa CSV de comprobantes recibidos y crea facturas de compra + pago conciliado en Odoo',
    ],
    adminUser: 'dflex-sync: login con usuario real de Supabase Auth (sin cuenta fija) · ARCA Comprobantes: admin',
    adminPassword: 'dflex-sync: la del usuario (rol admin/formula_editor/viewer según app_users) · ARCA Comprobantes: ver ARCA_AUTH_PASSWORD en el .env',
    database: [
      'SQL Server "Paneles" (solo lectura): dbo.NTASVTAS (cabecera NV), dbo.INTASVTAS (línea/producto), dbo.PRODUCTOS (descripción)',
      'Supabase: escribe/lee public.preproduccion_valores_ipanels y public.ipanel_sync_blocklist; login/roles de dflex-sync en public.app_users',
      'Mismo SQL Server y mismo proyecto Supabase que usan Planificador y Presupuestador',
    ],
  },
  left: {
    label: 'Presupuestador',
    description:
      'Es la herramienta central de ventas: cotiza portones, puertas e iPanels contra los precios y ' +
      'listas de Odoo, y de ahí en más maneja mediciones, aprobación comercial y técnica, ' +
      'planificación de producción y comisiones de vendedores. Los roles (superusuario, ' +
      'distribuidor, vendedor, encargado comercial, revisión técnica, medidor, logística, ' +
      'administración) viven todos en una sola tabla de usuarios.',
    items: [
      'Cotizador: arma presupuestos de portones/puertas/iPanels contra el catálogo y precios de Odoo',
      'Mediciones: carga y seguimiento de medidas a campo antes de aprobar',
      'Aprobación comercial / técnica: circuito de revisión antes de pasar a producción',
      'Planificación de producción: asigna fechas y orden de fabricación',
      'Comisiones: cada vendedor ve lo que lleva comisionado (consulta la API externa de Informe)',
      'Panel superusuario: catálogo de puertas, reglas técnicas, usuarios y permisos',
    ],
    adminUser: 'no hay un usuario fijo de sistema',
    adminPassword: 'pedir un usuario real, o crear uno con is_superuser = true en presupuestador_users',
    database: [
      'Supabase (propia): public.presupuestador_users (login/roles), public.presupuestador_quotes (esto es justo lo que lee Remitos si el NV todavía no llegó a producción), catálogo de puertas, reglas técnicas, mediciones',
      'No usa SQL Server directo — todo lo de ventas/precios/stock sale de Odoo',
      'Mismo proyecto Supabase que Integrador y Planificador',
    ],
  },
  right: {
    label: 'Remitos',
    description:
      'Genera el remito en PDF y las etiquetas de despacho (.lbx para Brother P-touch) de un Portón ' +
      'o iPanel a partir del número de NV. Primero busca lo que ya sincronizó el Integrador o cargó ' +
      'Planificador; si el pedido todavía no llegó a producción, usa directamente lo que cotizó ' +
      'Presupuestador.',
    items: [
      'Remito por NV: busca cliente, dirección y detalle de ítems, arma el PDF',
      'Etiquetas LBX: etiqueta grande + 4 chicas para imprimir en Brother P-touch',
      'Fallback automático: si el NV no tiene datos cargados en ninguna tabla, arma un ítem resumen con los campos del sistema viejo para no dejar el remito sin ítems',
    ],
    adminUser: '—',
    adminPassword: 'sin login, uso interno directo',
    database: [
      'SQL Server "Portones" (propia) + lee "Paneles" (NTASVTAS/INTASVTAS/PRODUCTOS) y "WebApp.dbo.Pre_Produccion" (fecha de venta) — mismo server que el resto',
      'Supabase (solo lectura): primero public.preproduccion_valores / preproduccion_valores_ipanels; si no hay nada, cae a public.presupuestador_quotes',
      'No tiene tablas propias en Supabase, solo lee de las otras apps',
    ],
  },
  bottom: {
    label: 'Información de venta',
    description:
      'No es un programa: es la tabla legado WebApp.dbo.Pre_Produccion, en el mismo SQL Server ' +
      'viejo que usa Planificador. Ahí queda cargada la info de la venta (cliente, dirección, ' +
      'localidad, fecha, NV) que después consumen Integrador, Planificador y Remitos. Revisé los ' +
      '4 repos clonados y ninguno escribe ahí (no hay ningún INSERT/UPDATE a esa tabla) — quien la ' +
      'llena corre por fuera de este workspace, probablemente el "Importador" de al lado.',
    items: [
      'La lee Integrador (dflex-sync): consulta interna a WebApp.dbo.Pre_Produccion por NV, para el listado de portones legado',
      'La lee Remitos: Fecha/fecha/Fecha_NV para imprimir "FECHA DE VENTA" en la etiqueta grande de iPanels',
      'La lee Planificador: fechas de producción/despacho de iPanels ya sincronizados a producción',
    ],
    adminUser: 'no aplica — es una tabla de SQL Server, no un programa con login propio',
    adminPassword: 'se accede con el mismo SQL_USER/SQL_PASSWORD que ya usan Integrador, Planificador y Remitos',
    database: [
      'SQL Server "WebApp": tabla dbo.Pre_Produccion (mismo server que el resto de la infraestructura)',
      'Ningún repo de los 4 clonados escribe acá — solo lectura desde Integrador, Planificador y Remitos',
    ],
  },
  precios: {
    label: 'Actualización de precios',
    description:
      'No es un repo aparte: es una página HTML suelta (Frontend/public/listas-precios.html de ' +
      'Planificador) para tocar precios de Odoo sin entrar a Odoo. Habla con dos backends distintos ' +
      'al mismo tiempo: le pide a Presupuestador (cotizador-back) las empresas/listas/productos y ' +
      'aplica los aumentos, y le pide al Backend de Planificador la categoría de cada producto ' +
      '(por tag de Odoo) para poder aumentar solo Portones, Ipanels, Puertas, Plegados u Otros.',
    items: [
      'Empresas y listas: GET /api/price-lists/companies y /api/price-lists/lists (cotizador-back) — trae las pricelists de Odoo por compañía',
      'Regla de edición: Vert puede editar todas sus listas; Dflex solo la lista "Predeterminada" (las demás son de solo consulta y se acomodan solas cuando se actualiza la Predeterminada)',
      'Editar un producto suelto: PATCH /api/price-lists/items/:id (fixed_price)',
      'Aumento masivo: POST /api/price-lists/increase — por lista actual, por todas las editables, por selección manual (checkboxes) o por categoría filtrada',
      'Categorías: GET/PUT /price-categories/map (Backend de Planificador) — asigna cada tag de producto de Odoo a una categoría',
      'La página guarda en localStorage qué backend de Presupuestador usar (por defecto Render, no Vercel) — si algo no carga, revisar esa URL primero',
    ],
    adminUser: 'no es login de usuario — el llamado a /price-categories/* va con una API key fija en el header x-api-key',
    adminPassword: 'misma variable IA_API_KEY del Backend de Planificador (la que protege /api/ia/portones/...); ojo que esa key ya queda expuesta en el HTML público, no la traten como secreta',
    url: '/listas-precios.html',
    database: [
      'Sin base propia para precios: lee y escribe directo sobre Odoo — product.pricelist y product.pricelist.item (vía cotizador-back)',
      'Una sola tabla propia en el Supabase compartido: public.price_category_map (qué tag de Odoo corresponde a qué categoría), manejada por el Backend de Planificador',
    ],
  },
  supabase: {
    label: 'Base de Datos Supabase',
    description:
      'Es el Postgres compartido (proyecto único en Supabase) que usan Integrador, Planificador y ' +
      'Presupuestador para guardar sus propias tablas, y que Remitos consulta en solo lectura. No ' +
      'es una base por app: varias tablas se escriben desde un repo y se leen desde otro, así que ' +
      'un cambio de esquema en una puede romper otro repo sin que se note en el que lo cambió.',
    items: [
      'app_users — roles de login de Integrador (dflex-sync: admin/formula_editor/viewer)',
      'admin_users — login del panel admin de Planificador',
      'preproduccion_valores / preproduccion_valores_ipanels — las llena Integrador al sincronizar, las edita Planificador por etapa, las lee Remitos para armar el remito',
      'ipanel_sync_blocklist — partidas de iPanel que Integrador nunca debe sincronizar',
      'presupuestador_users — login y roles (superusuario, vendedor, distribuidor, etc.) de Presupuestador',
      'presupuestador_quotes — cotizaciones de Presupuestador; Remitos las usa como fallback si el NV todavía no llegó a producción',
      'catálogo de puertas, reglas técnicas, mediciones — propias de Presupuestador',
      'logística, servicio técnico, insumos, QC, notas de nodo (las de este mismo diagrama) — propias de Planificador',
    ],
    adminUser: 'no es login de ninguna app — es acceso al dashboard de Supabase (SQL editor, tablas, auth)',
    adminPassword: 'pedir invitación al proyecto a quien administre la cuenta de Supabase',
    database: [
      'Un solo proyecto para Integrador, Planificador (prod) y Presupuestador — connection string en DATABASE_URL / SUPABASE_DB_URL de cada .env',
      'Remitos se conecta aparte con SUPABASE_DATABASE_URL, pero apunta al mismo proyecto (solo lectura)',
      'Pooler en aws-1-us-east-2.pooler.supabase.com — revisar PGSSLMODE/SSL de cada repo, no todos lo configuran igual',
    ],
  },
};

const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });

// "hace 5 min" en vez de la fecha completa - más fácil de leer de un vistazo
// para saber si lo que dice la nota está fresco o es de hace rato.
function formatRelativeTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const diffSec = Math.round((date.getTime() - Date.now()) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 45) return 'recién';
  if (abs < 3600) return RELATIVE_TIME_FORMATTER.format(Math.round(diffSec / 60), 'minute');
  if (abs < 86400) return RELATIVE_TIME_FORMATTER.format(Math.round(diffSec / 3600), 'hour');
  if (abs < 2592000) return RELATIVE_TIME_FORMATTER.format(Math.round(diffSec / 86400), 'day');
  return date.toLocaleDateString('es-AR');
}

// Crece con el texto (como el cuadro de escribir de un chat) en vez de tener
// un tamaño fijo con tirador para agrandar a mano.
function autosizeTextarea(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

const innerBoxStyle = {
  flex: 1,
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '8px 6px',
  fontSize: 12,
  fontWeight: 800,
  background: 'var(--bg, rgba(0,0,0,.03))',
  textAlign: 'center',
};

function DiagramNode({ node, pos, connectMode, selected, onPointerDown }) {
  const isOdoo = node.special === 'odoo';
  const isFidelityTools = node.special === 'fidelitytools';
  return (
    <div
      className="ip-node"
      onPointerDown={(e) => onPointerDown(e, node.id)}
      style={{
        ...(isOdoo ? { position: 'absolute', zIndex: 2, touchAction: 'none', userSelect: 'none' } : nodeBoxStyle),
        ...(node.brand ? { border: '2px solid var(--brand)' } : {}),
        ...(isFidelityTools ? { width: 230, minHeight: 96, flexDirection: 'column', gap: 8 } : {}),
        left: `${pos.x}%`,
        top: `${pos.y}%`,
        transform: 'translate(-50%, -50%)',
        cursor: connectMode ? 'crosshair' : 'grab',
        outline: selected ? '3px solid var(--brand)' : 'none',
        outlineOffset: 2,
      }}
    >
      {isOdoo ? (
        <div style={{ background: '#714B67', borderRadius: 32, padding: '28px 40px', display: 'flex', justifyContent: 'center' }}>
          <img src="/logos/odoo.png" alt="Odoo" draggable={false} style={{ maxWidth: 220, width: '100%', height: 'auto', pointerEvents: 'none' }} />
        </div>
      ) : isFidelityTools ? (
        <>
          <div>FidelityTools</div>
          <div style={{ display: 'flex', gap: 8, width: '100%' }}>
            <div style={innerBoxStyle}>CRM</div>
            <div style={innerBoxStyle}>Chatbot+</div>
          </div>
        </>
      ) : node.label}
    </div>
  );
}

export default function IndiceProgramacionPage() {
  const nav = useNavigate();
  const [openNode, setOpenNode] = useState(null);
  const [openNodeLabel, setOpenNodeLabel] = useState('');
  const [fidelityChoiceOpen, setFidelityChoiceOpen] = useState(false);
  // Link + usuario/contraseña editables: se guardan juntos por nodo en
  // public.notas_nodo, así que lo que carga uno lo ve el resto del equipo.
  const [link, setLink] = useState('');
  // Variables de entorno e info de programación: igual que link, un solo
  // texto compartido por nodo (public.notas_nodo.env_vars / .info_programacion),
  // se guarda solo al salir del campo.
  const [envVars, setEnvVars] = useState('');
  const [infoProgramacion, setInfoProgramacion] = useState('');
  // "¿Qué se está trabajando acá?" - a diferencia de link/acceso, es UNA FILA
  // POR ADMIN (public.notas_nodo_entradas): notaEntradas trae la de todos,
  // misNotaTexto es mi borrador local. Así nadie pisa lo de otro.
  const [misNotaTexto, setMisNotaTexto] = useState('');
  const [notaEntradas, setNotaEntradas] = useState([]);
  const [entradasLoading, setEntradasLoading] = useState(false);
  const [entradaSaving, setEntradaSaving] = useState(false);
  const [entradasError, setEntradasError] = useState('');
  // adminUserInput/adminPasswordInput: lo que se está tipeando (borrador).
  // savedAdminUser/savedAdminPassword: lo último realmente guardado - es lo
  // que se muestra como texto fijo hasta que alguien aprieta "Editar".
  const [adminUserInput, setAdminUserInput] = useState('');
  const [adminPasswordInput, setAdminPasswordInput] = useState('');
  const [savedAdminUser, setSavedAdminUser] = useState('');
  const [savedAdminPassword, setSavedAdminPassword] = useState('');
  const [editingAccess, setEditingAccess] = useState(false);
  const [notaMeta, setNotaMeta] = useState(null);
  const [notaLoading, setNotaLoading] = useState(false);
  const [notaSaving, setNotaSaving] = useState(false);
  const [accessError, setAccessError] = useState('');

  // Usuarios de prueba: varios por nodo, en tabla aparte (notas_nodo_usuarios_prueba).
  const [testUsers, setTestUsers] = useState([]);
  const [testUsersLoading, setTestUsersLoading] = useState(false);
  const [newTestUser, setNewTestUser] = useState({ etiqueta: '', usuario: '', password: '' });
  const [testUserSaving, setTestUserSaving] = useState(false);
  const [testUserError, setTestUserError] = useState('');

  // Mensaje de error legible desde una respuesta de axios (o "sin conexión"
  // si ni siquiera hubo respuesta del servidor - típico de backend caído o
  // apuntando a otra URL).
  const describeApiError = (err) =>
    err?.response?.data?.error || err?.response?.statusText || err?.message || 'Error desconocido';

  const [positions, setPositions] = useState(() => {
    const stored = loadStoredLayout();
    const base = defaultPositions();
    if (stored?.positions) {
      Object.keys(base).forEach((id) => {
        if (stored.positions[id]) base[id] = stored.positions[id];
      });
    }
    return base;
  });
  const [edges, setEdges] = useState(() => {
    const stored = loadStoredLayout();
    return Array.isArray(stored?.edges) ? stored.edges : DEFAULT_EDGES;
  });
  const [connectMode, setConnectMode] = useState(false);
  const [connectFrom, setConnectFrom] = useState(null);
  // Notas temporales: solo en memoria (nunca se guardan), para anotar algo
  // mientras se explica el diagrama - desaparecen solas al recargar la página.
  const [tempNotes, setTempNotes] = useState([]);
  const canvasRef = useRef(null);
  const dragRef = useRef(null);
  const misNotaRef = useRef(null);

  const resetLayout = () => {
    try { localStorage.removeItem(LS_KEY); } catch {}
    setPositions(defaultPositions());
    setEdges(DEFAULT_EDGES);
    setConnectFrom(null);
  };

  const toggleEdge = (a, b) => {
    setEdges((prev) => {
      const existing = prev.find((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a));
      const next = existing ? prev.filter((e) => e.id !== existing.id) : [...prev, { id: `${a}__${b}__${Date.now()}`, from: a, to: b }];
      persistLayout(positions, next);
      return next;
    });
  };

  const removeEdge = (edgeId) => {
    setEdges((prev) => {
      const next = prev.filter((e) => e.id !== edgeId);
      persistLayout(positions, next);
      return next;
    });
  };

  const addTempNote = () => {
    const id = `temp-${Date.now()}`;
    setTempNotes((prev) => [...prev, { id, x: 78 + (prev.length % 4) * 3, y: 8 + (prev.length % 4) * 6, text: '' }]);
  };

  const removeTempNote = (id) => setTempNotes((prev) => prev.filter((n) => n.id !== id));

  const updateTempNoteText = (id, text) => setTempNotes((prev) => prev.map((n) => (n.id === id ? { ...n, text } : n)));

  // Rutas internas (empiezan con "/") navegan con el router, salvo que sean
  // páginas estáticas (.html en /public, ej. listas-precios.html): esas no
  // son una ruta de React Router, necesitan recarga completa del navegador
  // (mismo criterio que ya usa IndexPage con isStaticPage). Todo lo demás
  // (otro dominio: Vercel/Render/Odoo/Supabase) se abre en pestaña nueva.
  const isStaticPage = (path) => /\.html(?:$|[?#])/.test(String(path || ''));
  const goToProgram = (url) => {
    if (!url) return;
    if (url.startsWith('/')) {
      if (isStaticPage(url)) window.location.href = url;
      else nav(url);
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  const handleNodeClick = (id, label) => {
    if (connectMode) {
      if (!connectFrom) { setConnectFrom(id); return; }
      if (connectFrom === id) { setConnectFrom(null); return; }
      toggleEdge(connectFrom, id);
      setConnectFrom(null);
      return;
    }
    if (id === 'fidelitytools') { setFidelityChoiceOpen(true); return; }
    openNodeModal(id, label);
  };

  const handlePointerMove = (e) => {
    const st = dragRef.current;
    if (!st || !canvasRef.current) return;
    const dx = e.clientX - st.startClientX;
    const dy = e.clientY - st.startClientY;
    if (!st.moved && Math.hypot(dx, dy) < 4) return;
    st.moved = true;
    const rect = canvasRef.current.getBoundingClientRect();
    const xPct = Math.min(97, Math.max(3, ((e.clientX - rect.left) / rect.width) * 100));
    const yPct = Math.min(97, Math.max(3, ((e.clientY - rect.top) / rect.height) * 100));
    if (st.kind === 'temp') {
      setTempNotes((prev) => prev.map((n) => (n.id === st.id ? { ...n, x: xPct, y: yPct } : n)));
    } else {
      setPositions((prev) => ({ ...prev, [st.id]: { x: xPct, y: yPct } }));
    }
  };

  const handlePointerUp = () => {
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
    const st = dragRef.current;
    dragRef.current = null;
    if (!st) return;
    if (st.kind === 'temp') return; // las notas temporales nunca se guardan
    if (st.moved) {
      setPositions((prev) => { persistLayout(prev, edges); return prev; });
    } else {
      handleNodeClick(st.id, st.label);
    }
  };

  const handlePointerDown = (e, id) => {
    e.stopPropagation();
    const node = DEFAULT_NODES.find((n) => n.id === id);
    dragRef.current = { kind: 'node', id, label: node?.label, startClientX: e.clientX, startClientY: e.clientY, moved: false };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  };

  const handleTempPointerDown = (e, id) => {
    e.stopPropagation();
    dragRef.current = { kind: 'temp', id, startClientX: e.clientX, startClientY: e.clientY, moved: false };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
  };

  useEffect(() => {
    const t = getAdminToken();
    if (!t) nav('/admin/login', { replace: true });
  }, [nav]);

  useEffect(() => {
    if (!openNode) return;
    setLink('');
    setEnvVars('');
    setInfoProgramacion('');
    setAdminUserInput('');
    setAdminPasswordInput('');
    setSavedAdminUser('');
    setSavedAdminPassword('');
    setEditingAccess(false);
    setNotaMeta(null);
    setAccessError('');
    setNotaLoading(true);
    adminGetNotaNodo(openNode)
      .then(({ data }) => {
        const u = data?.admin_user || '';
        const p = data?.admin_password || '';
        setLink(data?.link || '');
        setEnvVars(data?.env_vars || '');
        setInfoProgramacion(data?.info_programacion || '');
        setAdminUserInput(u);
        setAdminPasswordInput(p);
        setSavedAdminUser(u);
        setSavedAdminPassword(p);
        // Si todavía no hay nada guardado, arranca directo en modo edición.
        setEditingAccess(!(u && p));
        setNotaMeta(data?.updated_by ? { updatedBy: data.updated_by, updatedAt: data.updated_at } : null);
      })
      .catch((err) => setAccessError(`No se pudo cargar: ${describeApiError(err)}`))
      .finally(() => setNotaLoading(false));
  }, [openNode]);

  useEffect(() => {
    if (!openNode) return;
    setTestUsers([]);
    setNewTestUser({ etiqueta: '', usuario: '', password: '' });
    setTestUserError('');
    setTestUsersLoading(true);
    adminListUsuariosPrueba(openNode)
      .then(({ data }) => setTestUsers(Array.isArray(data?.usuarios) ? data.usuarios : []))
      .catch((err) => setTestUserError(`No se pudo cargar la lista: ${describeApiError(err)}`))
      .finally(() => setTestUsersLoading(false));
  }, [openNode]);

  const cargarEntradas = () => {
    if (!openNode) return;
    adminListNotaEntradas(openNode)
      .then(({ data }) => setNotaEntradas(Array.isArray(data?.entradas) ? data.entradas : []))
      .catch(() => {});
  };

  useEffect(() => {
    if (!openNode) return;
    setMisNotaTexto('');
    setNotaEntradas([]);
    setEntradasError('');
    setEntradasLoading(true);
    adminListNotaEntradas(openNode)
      .then(({ data }) => {
        const entradas = Array.isArray(data?.entradas) ? data.entradas : [];
        setNotaEntradas(entradas);
        const mia = entradas.find((e) => e.autor_username === currentAdminUsername());
        setMisNotaTexto(mia?.texto || '');
        setTimeout(() => autosizeTextarea(misNotaRef.current), 0);
      })
      .catch((err) => setEntradasError(`No se pudo cargar: ${describeApiError(err)}`))
      .finally(() => setEntradasLoading(false));

    // Mientras el modal está abierto, refresca cada 6s lo que escribieron
    // los demás (nunca toca mi propio borrador local) - así se siente "en
    // tiempo real" sin necesitar un websocket.
    const interval = setInterval(cargarEntradas, 6000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openNode]);

  const saveField = (payload) => {
    if (!openNode) return;
    setNotaSaving(true);
    adminSetNotaNodo(openNode, payload)
      .then(({ data }) => setNotaMeta(data?.updated_by ? { updatedBy: data.updated_by, updatedAt: data.updated_at } : null))
      .catch(() => {})
      .finally(() => setNotaSaving(false));
  };

  // El link se guarda solo al salir del campo (no manda usuario ni
  // contraseña, así nunca los toca sin querer).
  const saveLink = () => saveField({ link });

  // Mismo criterio que el link: se guardan solo al salir del campo, cada uno
  // independiente del resto (ver comentario en notasNodoDb.setNota).
  const saveEnvVars = () => saveField({ env_vars: envVars });
  const saveInfoProgramacion = () => saveField({ info_programacion: infoProgramacion });

  // Guarda MI entrada (nunca la de otro - el autor lo pone el backend según
  // quién está logueado). Actualiza la lista completa con lo que devuelve el
  // servidor para que se vea al toque en el resto de las pestañas/usuarios.
  // Se guarda solo con el botón "Enviar" - no hay autoguardado mientras se
  // escribe (a propósito, para no publicar algo a medio terminar).
  const saveMiEntrada = () => {
    if (!openNode) return;
    setEntradaSaving(true);
    adminSetNotaEntrada(openNode, misNotaTexto)
      .then(() => cargarEntradas())
      .catch(() => {})
      .finally(() => setEntradaSaving(false));
  };

  // Botón "Terminé, liberar": vacía y borra MI entrada de un click, sin
  // tocar las de nadie más.
  const liberarMiEntrada = () => {
    setMisNotaTexto('');
    if (!openNode) return;
    setEntradaSaving(true);
    adminDeleteNotaEntrada(openNode)
      .then(() => cargarEntradas())
      .catch(() => {})
      .finally(() => setEntradaSaving(false));
  };

  // El acceso (usuario/contraseña) SOLO se guarda con el botón "Guardar".
  // Una vez guardado, queda fijo como texto (savedAdminUser/Password) y sale
  // del modo edición - no se pierde ni "se va" al tocar otra cosa.
  const saveAccess = () => {
    if (!openNode) return;
    const usuario = adminUserInput.trim();
    const password = adminPasswordInput.trim();
    if (!usuario || !password) return;
    setNotaSaving(true);
    setAccessError('');
    adminSetNotaNodo(openNode, { admin_user: usuario, admin_password: password })
      .then(({ data }) => {
        // Si el backend no devolvió lo que mandamos (ej. porque es una
        // versión vieja del servidor que todavía no conoce admin_user/
        // admin_password), avisamos en vez de festejar un guardado que en
        // realidad no pasó.
        if ((data?.admin_user || '') !== usuario || (data?.admin_password || '') !== password) {
          setAccessError('El servidor respondió pero no guardó usuario/contraseña — puede que el backend que estás usando todavía no tenga este cambio.');
          return;
        }
        setNotaMeta(data?.updated_by ? { updatedBy: data.updated_by, updatedAt: data.updated_at } : null);
        setSavedAdminUser(usuario);
        setSavedAdminPassword(password);
        setEditingAccess(false);
      })
      .catch((err) => setAccessError(`No se pudo guardar: ${describeApiError(err)}`))
      .finally(() => setNotaSaving(false));
  };

  const startEditAccess = () => {
    setAdminUserInput(savedAdminUser);
    setAdminPasswordInput(savedAdminPassword);
    setEditingAccess(true);
  };

  const cancelEditAccess = () => {
    setAdminUserInput(savedAdminUser);
    setAdminPasswordInput(savedAdminPassword);
    setEditingAccess(false);
  };

  const addTestUser = () => {
    if (!openNode) return;
    const usuario = newTestUser.usuario.trim();
    const password = newTestUser.password.trim();
    if (!usuario || !password) return; // los dos campos son obligatorios para guardar
    setTestUserSaving(true);
    setTestUserError('');
    adminAddUsuarioPrueba(openNode, { etiqueta: newTestUser.etiqueta.trim(), usuario, password })
      .then(({ data }) => {
        if (!data?.id) {
          setTestUserError('El servidor respondió pero no devolvió el usuario guardado — revisá si el backend tiene este cambio.');
          return;
        }
        setTestUsers((prev) => [...prev, data]);
        setNewTestUser({ etiqueta: '', usuario: '', password: '' });
      })
      .catch((err) => setTestUserError(`No se pudo guardar: ${describeApiError(err)}`))
      .finally(() => setTestUserSaving(false));
  };

  const removeTestUser = (id) => {
    if (!openNode) return;
    setTestUsers((prev) => prev.filter((u) => u.id !== id));
    adminDeleteUsuarioPrueba(openNode, id).catch((err) => setTestUserError(`No se pudo borrar: ${describeApiError(err)}`));
  };

  const openContent = openNode ? NODE_CONTENT[openNode] : null;

  const openNodeModal = (id, label) => {
    setOpenNode(id);
    setOpenNodeLabel(label);
  };

  return (
    <div className="container">
      <style>{`
        .ip-node { transition: transform .15s ease, box-shadow .15s ease; }
        .ip-node:hover { transform: scale(1.06); box-shadow: 0 8px 20px rgba(0,0,0,.18); }

        @keyframes ip-fade-in {
          from { opacity: 0; transform: translateY(-4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .ip-entrada-nueva { animation: ip-fade-in .35s ease; }

        .ip-section-label {
          display: flex; align-items: center; gap: 6px;
          font-size: 11px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase;
          color: var(--brand-700); margin: 0 0 8px;
        }
        .ip-lead { font-size: 15px; line-height: 1.6; color: var(--text); margin: 0; }
        .ip-divider { height: 1px; border: none; background: var(--border); margin: 18px 0; }

        .ip-access-box {
          border: 1px solid color-mix(in srgb, var(--brand) 35%, var(--border));
          background: var(--brand-100);
          border-radius: 10px;
          padding: 12px 14px;
          margin-top: 10px;
          box-shadow: 0 2px 10px rgba(15, 23, 42, .05);
        }
        .ip-access-row { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text); line-height: 1.5; }
        .ip-access-row + .ip-access-row { margin-top: 5px; }
        .ip-access-key { font-weight: 800; color: var(--brand-700); min-width: 82px; flex: none; }
        .ip-access-input {
          flex: 1; min-width: 0; border: none; background: transparent;
          border-bottom: 1px dashed color-mix(in srgb, var(--brand) 45%, var(--border));
          font: inherit; font-size: 12.5px; color: var(--text); padding: 2px 0;
        }
        .ip-access-input:focus { outline: none; border-bottom-style: solid; }
        .ip-access-input::placeholder { color: var(--muted); }
        .ip-access-value { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; color: var(--text); }

        .ip-note-textarea {
          width: 100%; box-sizing: border-box;
          border: 1px solid var(--border); border-radius: 8px;
          padding: 8px 10px; font: inherit; font-size: 12.5px;
          color: var(--text); background: var(--surface);
          resize: vertical; min-height: 70px;
        }
        .ip-note-textarea:focus { outline: none; border-color: var(--brand); }
        .ip-note-textarea--mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre; }

        .ip-modal-list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; }
        .ip-modal-list li { position: relative; padding-left: 18px; color: var(--text); line-height: 1.5; font-size: 13.5px; }
        .ip-modal-list li::before {
          content: ''; position: absolute; left: 0; top: 7px; width: 6px; height: 6px;
          border-radius: 50%; background: var(--brand);
        }

        .ip-db-list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; }
        .ip-db-row {
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 12px; line-height: 1.55; color: var(--text);
          background: color-mix(in srgb, var(--brand) 6%, var(--surface));
          border: 1px solid var(--border); border-left: 3px solid var(--brand);
          border-radius: 8px; padding: 9px 12px;
          box-shadow: 0 1px 4px rgba(15, 23, 42, .04);
        }

        .ip-testusers-grid {
          display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
          gap: 10px; margin-bottom: 10px;
        }
        .ip-testuser-card {
          position: relative;
          border: 1px solid color-mix(in srgb, var(--brand) 30%, var(--border));
          background: linear-gradient(180deg, color-mix(in srgb, var(--brand) 9%, var(--surface)), var(--surface));
          border-radius: 10px;
          padding: 10px 30px 10px 12px;
          box-shadow: 0 2px 8px rgba(15, 23, 42, .06);
          transition: box-shadow .15s ease, transform .15s ease;
        }
        .ip-testuser-card:hover { box-shadow: 0 4px 14px rgba(15, 23, 42, .1); transform: translateY(-1px); }
        .ip-testuser-label {
          font-weight: 800; color: var(--brand-700); font-size: 12px; margin-bottom: 4px;
        }
        .ip-testuser-row {
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 11.5px; color: var(--text); line-height: 1.55; word-break: break-all;
        }
        .ip-testuser-del {
          position: absolute; top: 6px; right: 8px; border: none; background: transparent;
          color: var(--muted); cursor: pointer; font-weight: 900; font-size: 15px; line-height: 1;
          padding: 2px 4px; border-radius: 6px;
        }
        .ip-testuser-del:hover { color: #fff; background: var(--brand); }
        .ip-testuser-empty { font-size: 12.5px; color: var(--muted); margin-bottom: 10px; }

        .ip-testuser-form { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
        .ip-testuser-form input {
          border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px;
          font: inherit; font-size: 12.5px; background: var(--surface); color: var(--text);
          min-width: 130px; flex: 1;
        }
        .ip-testuser-form input:focus { outline: none; border-color: var(--brand); }
        .ip-testuser-form .btn { flex: none; }
      `}</style>

      <div className="header-row" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h1 className="h1" style={{ margin: 0 }}>Índice de Programación</h1>
          <span className="idx-pill">BETA</span>
        </div>
      </div>

      <div style={{ margin: '4px 0 10px', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          className="btn"
          onClick={() => { setConnectMode((v) => !v); setConnectFrom(null); }}
        >
          {connectMode ? 'Listo (salir de editar conexiones)' : 'Editar conexiones'}
        </button>
        <button type="button" className="btn" onClick={addTempNote}>+ Nota temporal</button>
        <button type="button" className="btn" onClick={resetLayout}>Restablecer diagrama</button>
        {connectMode && (
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            Click en dos cajas para crear o quitar una conexión. Click en una línea para borrarla.
          </span>
        )}
      </div>

      <div style={{ overflow: 'auto', padding: '10px 0' }}>
        <div ref={canvasRef} style={{ position: 'relative', maxWidth: 1000, height: 960, margin: '0 auto' }}>
          <svg
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
          >
            {edges.map((e) => {
              const a = positions[e.from];
              const b = positions[e.to];
              if (!a || !b) return null;
              return (
                <g key={e.id}>
                  <line
                    x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                    stroke="transparent"
                    strokeWidth={5}
                    vectorEffect="non-scaling-stroke"
                    style={{ pointerEvents: connectMode ? 'stroke' : 'none', cursor: connectMode ? 'pointer' : 'default' }}
                    onClick={() => connectMode && removeEdge(e.id)}
                  />
                  <line
                    x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                    stroke="var(--border)"
                    strokeWidth={2}
                    vectorEffect="non-scaling-stroke"
                    style={{ pointerEvents: 'none' }}
                  />
                </g>
              );
            })}
          </svg>

          {DEFAULT_NODES.map((n) => (
            <DiagramNode
              key={n.id}
              node={n}
              pos={positions[n.id] || { x: n.x, y: n.y }}
              connectMode={connectMode}
              selected={connectFrom === n.id}
              onPointerDown={handlePointerDown}
            />
          ))}

          {tempNotes.map((n) => (
            <div
              key={n.id}
              style={{
                position: 'absolute',
                left: `${n.x}%`,
                top: `${n.y}%`,
                transform: 'translate(-50%, -50%)',
                zIndex: 3,
                width: 160,
                background: '#fff6b0',
                border: '1px dashed #c9a800',
                borderRadius: 8,
                boxShadow: 'var(--shadow)',
              }}
            >
              <div
                onPointerDown={(e) => handleTempPointerDown(e, n.id)}
                style={{
                  cursor: 'grab',
                  touchAction: 'none',
                  userSelect: 'none',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '4px 6px',
                  borderBottom: '1px dashed #c9a800',
                  fontSize: 11,
                  fontWeight: 700,
                  color: '#7a5d00',
                }}
              >
                <span>Nota temporal</span>
                <button
                  type="button"
                  onClick={() => removeTempNote(n.id)}
                  style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontWeight: 900, color: '#7a5d00', lineHeight: 1, fontSize: 14 }}
                >
                  ×
                </button>
              </div>
              <textarea
                value={n.text}
                onChange={(e) => updateTempNoteText(n.id, e.target.value)}
                placeholder="Escribí algo..."
                rows={3}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  border: 'none',
                  background: 'transparent',
                  resize: 'vertical',
                  padding: 6,
                  font: 'inherit',
                  color: '#5a4600',
                }}
              />
            </div>
          ))}
        </div>
      </div>

      {fidelityChoiceOpen && (
        <div
          onClick={() => setFidelityChoiceOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15,23,42,.5)',
            backdropFilter: 'blur(2px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 50,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 16,
              boxShadow: '0 24px 60px rgba(15, 23, 42, .22)',
              padding: 20,
              minWidth: 260,
            }}
          >
            <h2 style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 900, color: 'var(--text)' }}>FidelityTools</h2>
            <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--muted)' }}>¿Qué querés abrir?</p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                className="btn"
                style={{ flex: 1 }}
                onClick={() => { setFidelityChoiceOpen(false); openNodeModal('crm', 'CRM'); }}
              >
                CRM
              </button>
              <button
                type="button"
                className="btn"
                style={{ flex: 1 }}
                onClick={() => { setFidelityChoiceOpen(false); openNodeModal('chatbox', 'Chatbot+'); }}
              >
                Chatbot+
              </button>
            </div>
          </div>
        </div>
      )}

      {openNode && (
        <div
          onClick={() => setOpenNode(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15,23,42,.5)',
            backdropFilter: 'blur(2px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 50,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 16,
              boxShadow: '0 24px 60px rgba(15, 23, 42, .22)',
              padding: 20,
              minWidth: 320,
              maxWidth: '90vw',
              maxHeight: '80vh',
              overflow: 'auto',
            }}
          >
            <div style={{ marginBottom: 12, paddingBottom: 12, borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <h2
                  onClick={() => goToProgram(openContent?.url)}
                  title={openContent?.url ? 'Ir a este programa' : undefined}
                  style={{
                    margin: 0,
                    fontSize: 20,
                    fontWeight: 900,
                    color: openContent?.url ? 'var(--brand-700)' : 'var(--text)',
                    cursor: openContent?.url ? 'pointer' : 'default',
                  }}
                >
                  {openContent?.label || openNodeLabel}
                </h2>
                <button type="button" className="btn" onClick={() => setOpenNode(null)}>Cerrar</button>
              </div>
            </div>

            <p className="ip-lead" style={{ margin: 0 }}>
              {openContent?.description || 'Descripción pendiente de definir.'}
            </p>

            {openContent && (
              <div className="ip-access-box">
                <div className="ip-section-label" style={{ marginBottom: 8 }}>🔗 Link</div>
                <div className="ip-access-row">
                  <input
                    type="url"
                    className="ip-access-input"
                    value={link}
                    onChange={(e) => setLink(e.target.value)}
                    onBlur={saveLink}
                    disabled={notaLoading}
                    placeholder="https://..."
                  />
                  {link.trim() && (
                    <button
                      type="button"
                      className="btn"
                      style={{ flex: 'none', padding: '4px 10px' }}
                      onClick={() => goToProgram(link.trim())}
                    >
                      Abrir ↗
                    </button>
                  )}
                </div>
              </div>
            )}

            {openContent && (
              <div className="ip-access-box">
                <div className="ip-section-label" style={{ marginBottom: 8 }}>🔒 Acceso</div>

                {notaLoading ? (
                  <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Cargando…</div>
                ) : editingAccess ? (
                  <>
                    <div className="ip-access-row">
                      <span className="ip-access-key">Usuario</span>
                      <input
                        type="text"
                        className="ip-access-input"
                        value={adminUserInput}
                        onChange={(e) => setAdminUserInput(e.target.value)}
                        disabled={notaLoading}
                        placeholder="Usuario"
                      />
                    </div>
                    <div className="ip-access-row">
                      <span className="ip-access-key">Contraseña</span>
                      <input
                        type="text"
                        className="ip-access-input"
                        value={adminPasswordInput}
                        onChange={(e) => setAdminPasswordInput(e.target.value)}
                        disabled={notaLoading}
                        placeholder="Contraseña"
                      />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                      <button
                        type="button"
                        className="btn btn--brand"
                        onClick={saveAccess}
                        disabled={notaSaving || !adminUserInput.trim() || !adminPasswordInput.trim()}
                      >
                        {notaSaving ? 'Guardando…' : 'Guardar'}
                      </button>
                      {savedAdminUser && savedAdminPassword && (
                        <button type="button" className="btn" onClick={cancelEditAccess} disabled={notaSaving}>
                          Cancelar
                        </button>
                      )}
                      {(adminUserInput.trim() || adminPasswordInput.trim()) && !(adminUserInput.trim() && adminPasswordInput.trim()) && (
                        <div style={{ fontSize: 11, color: 'var(--muted)' }}>Faltan cargar los dos campos para poder guardar.</div>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="ip-access-row">
                      <span className="ip-access-key">Usuario</span>
                      <span className="ip-access-value">{savedAdminUser}</span>
                    </div>
                    <div className="ip-access-row">
                      <span className="ip-access-key">Contraseña</span>
                      <span className="ip-access-value">{savedAdminPassword}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                      <button type="button" className="btn" onClick={startEditAccess}>Editar</button>
                      {notaMeta?.updatedBy && (
                        <div style={{ fontSize: 11, color: 'var(--muted)' }}>Última edición: {notaMeta.updatedBy}</div>
                      )}
                    </div>
                  </>
                )}

                {accessError && (
                  <div style={{ fontSize: 11.5, color: '#c0392b', marginTop: 8 }}>{accessError}</div>
                )}
              </div>
            )}

            {openContent && (
              <div className="ip-access-box">
                <div className="ip-section-label" style={{ marginBottom: 8 }}>🧩 Variables de entorno</div>
                <textarea
                  className="ip-note-textarea ip-note-textarea--mono"
                  value={envVars}
                  onChange={(e) => setEnvVars(e.target.value)}
                  onBlur={saveEnvVars}
                  disabled={notaLoading}
                  placeholder={'CLAVE=valor\nOTRA_CLAVE=valor'}
                  rows={5}
                />
              </div>
            )}

            {openContent && (
              <div className="ip-access-box">
                <div className="ip-section-label" style={{ marginBottom: 8 }}>📝 Información para programación</div>
                <textarea
                  className="ip-note-textarea"
                  value={infoProgramacion}
                  onChange={(e) => setInfoProgramacion(e.target.value)}
                  onBlur={saveInfoProgramacion}
                  disabled={notaLoading}
                  placeholder="Detalles técnicos, decisiones, cosas a tener en cuenta para tocar este código..."
                  rows={4}
                />
              </div>
            )}

            {openContent?.items?.length > 0 && (
              <>
                <hr className="ip-divider" />
                <div className="ip-section-label">⚙️ Qué hace</div>
                <ul className="ip-modal-list">
                  {openContent.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </>
            )}

            {openContent && (
              <>
                <hr className="ip-divider" />
                <div className="ip-section-label">👥 Usuarios de prueba</div>

                {testUsers.length > 0 ? (
                  <div className="ip-testusers-grid">
                    {testUsers.map((u) => (
                      <div key={u.id} className="ip-testuser-card">
                        <button
                          type="button"
                          className="ip-testuser-del"
                          onClick={() => removeTestUser(u.id)}
                          title="Borrar este usuario de prueba"
                        >
                          ×
                        </button>
                        {u.etiqueta && <div className="ip-testuser-label">{u.etiqueta}</div>}
                        <div className="ip-testuser-row">usuario: {u.usuario}</div>
                        <div className="ip-testuser-row">contraseña: {u.password}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="ip-testuser-empty">
                    {testUsersLoading ? 'Cargando…' : 'Todavía no hay usuarios de prueba cargados.'}
                  </div>
                )}

                <div className="ip-testuser-form">
                  <input
                    type="text"
                    placeholder="Etiqueta (opcional, ej: Vendedor)"
                    value={newTestUser.etiqueta}
                    onChange={(e) => setNewTestUser((prev) => ({ ...prev, etiqueta: e.target.value }))}
                  />
                  <input
                    type="text"
                    placeholder="Usuario"
                    value={newTestUser.usuario}
                    onChange={(e) => setNewTestUser((prev) => ({ ...prev, usuario: e.target.value }))}
                  />
                  <input
                    type="text"
                    placeholder="Contraseña"
                    value={newTestUser.password}
                    onChange={(e) => setNewTestUser((prev) => ({ ...prev, password: e.target.value }))}
                  />
                  <button
                    type="button"
                    className="btn btn--brand"
                    onClick={addTestUser}
                    disabled={testUserSaving || !newTestUser.usuario.trim() || !newTestUser.password.trim()}
                  >
                    {testUserSaving ? 'Guardando…' : '+ Agregar'}
                  </button>
                </div>

                {testUserError && (
                  <div style={{ fontSize: 11.5, color: '#c0392b', marginTop: 6 }}>{testUserError}</div>
                )}
              </>
            )}

            {openContent?.database?.length > 0 && (
              <>
                <hr className="ip-divider" />
                <div className="ip-section-label">🗄️ Base de datos</div>
                <ul className="ip-db-list">
                  {openContent.database.map((item) => (
                    <li key={item} className="ip-db-row">{item}</li>
                  ))}
                </ul>
              </>
            )}

            {openContent && (() => {
              const miUsername = currentAdminUsername();
              const otrasEntradas = notaEntradas.filter((e) => e.autor_username !== miUsername);
              const miEntradaGuardada = notaEntradas.find((e) => e.autor_username === miUsername);
              const haySinEnviar = (miEntradaGuardada?.texto || '') !== misNotaTexto;
              const hayAlgo = misNotaTexto.trim() || otrasEntradas.length > 0;
              return (
                <div style={{ marginTop: 16 }}>
                  <hr className="ip-divider" />
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <span
                        aria-hidden="true"
                        style={{
                          width: 8, height: 8, borderRadius: '50%', flex: 'none',
                          background: hayAlgo ? 'var(--brand)' : 'var(--muted)',
                          boxShadow: hayAlgo ? '0 0 0 3px color-mix(in srgb, var(--brand) 25%, transparent)' : 'none',
                        }}
                      />
                      <span className="ip-section-label" style={{ margin: 0 }}>¿Qué se está trabajando acá?</span>
                    </div>
                    {misNotaTexto.trim() && !entradasLoading && (
                      <button
                        type="button"
                        className="btn"
                        style={{ padding: '3px 10px', fontSize: 11 }}
                        onClick={liberarMiEntrada}
                        disabled={entradaSaving}
                      >
                        Terminé, liberar
                      </button>
                    )}
                  </div>

                  {/* Mi entrada: cada admin edita y borra SOLO la suya - nunca
                      pisa lo que escribió otro, aunque estén tipeando al
                      mismo tiempo en el mismo cuadro. El "usuario-" solo
                      aparece adentro del cuadro, delante del texto, y recién
                      cuando hay algo escrito (no antes). */}
                  <div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 4,
                        boxSizing: 'border-box',
                        border: '1px solid var(--border)',
                        background: 'var(--surface)',
                        borderRadius: 10,
                        padding: '8px 12px',
                        boxShadow: '0 1px 4px rgba(15, 23, 42, .04)',
                      }}
                    >
                      {misNotaTexto.trim() && (
                        <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--brand-700)', flex: 'none', whiteSpace: 'nowrap' }}>
                          {miUsername || 'Vos'}-
                        </span>
                      )}
                      <textarea
                        ref={misNotaRef}
                        value={misNotaTexto}
                        onChange={(e) => {
                          const val = e.target.value;
                          setMisNotaTexto(val);
                          autosizeTextarea(e.target);
                        }}
                        onKeyDown={(e) => {
                          // Como en un chat: Enter manda, Shift+Enter hace un
                          // salto de línea.
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            if (haySinEnviar && !entradasLoading && !entradaSaving) saveMiEntrada();
                          }
                        }}
                        disabled={entradasLoading}
                        rows={1}
                        style={{
                          flex: 1,
                          minWidth: 0,
                          boxSizing: 'border-box',
                          border: 'none',
                          outline: 'none',
                          padding: 0,
                          margin: 0,
                          font: 'inherit',
                          fontSize: 13,
                          lineHeight: 1.4,
                          color: 'var(--text)',
                          background: 'transparent',
                          resize: 'none',
                          overflow: 'hidden',
                        }}
                        placeholder="yo estoy trabajando acá... (Enter envía)"
                      />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 4 }}>
                      <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                        {entradasLoading
                          ? 'Cargando…'
                          : entradaSaving
                            ? 'Enviando…'
                            : haySinEnviar
                              ? 'Sin enviar'
                              : miEntradaGuardada
                                ? `Enviado · ${formatRelativeTime(miEntradaGuardada.updated_at)}`
                                : ''}
                      </div>
                      <button
                        type="button"
                        className="btn btn--brand"
                        style={{ padding: '4px 12px', fontSize: 12 }}
                        onClick={saveMiEntrada}
                        disabled={entradasLoading || entradaSaving || !haySinEnviar}
                      >
                        Enviar
                      </button>
                    </div>
                  </div>

                  {entradasError && (
                    <div style={{ fontSize: 11.5, color: '#c0392b', marginTop: 6 }}>{entradasError}</div>
                  )}

                  {/* Entradas de los demás - solo lectura, cada una con el
                      nombre de quien la escribió delante del texto. */}
                  {otrasEntradas.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                      {otrasEntradas.map((e) => (
                        <div
                          key={e.autor_username}
                          className="ip-entrada-nueva"
                          style={{
                            border: '1px solid var(--border)',
                            borderRadius: 10,
                            padding: '8px 12px',
                            background: 'var(--surface)',
                            boxShadow: '0 1px 4px rgba(15, 23, 42, .04)',
                          }}
                        >
                          <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', color: 'var(--text)' }}>
                            <span style={{ fontWeight: 800, color: 'var(--brand-700)' }}>{e.autor_username}-</span>
                            {e.texto}
                          </div>
                          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                            {formatRelativeTime(e.updated_at)}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}

          </div>
        </div>
      )}
    </div>
  );
}
