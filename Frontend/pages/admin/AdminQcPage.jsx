// pages/admin/AdminQcPage.jsx
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api, { clearAdminToken, getAdminToken } from '../../src/api';

const LINES = [
  { key: 'portones', label: 'Portones' },
  { key: 'ipanel', label: 'iPanel' },
  { key: 'prefabricados', label: 'Prefabricados' },
  { key: 'servicio_tecnico', label: 'Servicio Técnico' },
  { key: 'orden_externa', label: 'Orden Externa' },
  { key: 'prueba', label: 'Prueba Laser Plano' },
  { key: 'insumos', label: 'Insumos (pedidos del día)' },
];

const KINDS = [
  { key: 'OBSERVADO', label: 'OBSERVADO' },
  { key: 'RECHAZADO', label: 'RECHAZADO' },
];

// Stages conocidas para permisos QC.
// IMPORTANTE: el value real que se guarda en DB es stage_key.
// Solo cambia el label visible para que sea claro en la pantalla.
// Prefabricados y Servicio Técnico circulan por las mismas secciones físicas
// que portones (ver Frontend/src/constants/sections.js), así que reusan la
// misma lista de etapas para configurar motivos/scopes de QC.
const PORTON_STAGES = [
  { key: 'diseno', label: 'Diseño Tubos' },
  { key: 'diseno_piernas', label: 'Diseño Piernas' },
  { key: 'diseno_revestimiento', label: 'Diseño Revestimiento' },
  { key: 'laser_dintel', label: 'Laser tubos Dintel' },
  { key: 'laser_hojas', label: 'Laser tubos Hojas' },
  { key: 'laser_brazos_espada', label: 'Laser tubos Brazos y Espada' },
  { key: 'guillotina', label: 'Guillotina / Corte piernas' },
  { key: 'corte_revest', label: 'Corte revestimiento' },
  { key: 'plegadora', label: 'Plegadora / Plegado piernas' },
  { key: 'plegado_revest', label: 'Plegado revestimiento' },
  { key: 'armado_piernas', label: 'Armado piernas' },
  { key: 'armado_marco_piernas', label: 'Armado marco piernas' },
  { key: 'armado_hojas', label: 'Armado hojas' },
  { key: 'armado_primario', label: 'Armado primario' },
  { key: 'revestimiento', label: 'Revestimiento' },
  { key: 'pintura', label: 'Pintura sistemas' },
  { key: 'pintura_revestimiento', label: 'Pintura revestimiento' },
  { key: 'inyeccion', label: 'Inyección' },
  { key: 'armado_final', label: 'Armado final' },
  { key: 'despacho', label: 'Despacho' },
];

const STAGES_BY_LINE = {
  portones: PORTON_STAGES,
  ipanel: [
    { key: 'diseno', label: 'Diseño' },
    { key: 'guillotina', label: 'Guillotina / Corte iPanel' },
    { key: 'plegado', label: 'Plegado' },
    { key: 'pintura', label: 'Pintura' },
    { key: 'inyeccion', label: 'Inyección' },
    { key: 'despacho', label: 'Despacho' },
  ],
  prefabricados: PORTON_STAGES,
  servicio_tecnico: PORTON_STAGES,
  orden_externa: PORTON_STAGES,
  // Prueba Laser Plano solo pasa por Corte piernas (guillotina) - un solo paso.
  prueba: [{ key: 'guillotina', label: 'Guillotina / Corte piernas' }],
  // Insumos usa "secciones" por ruta/tablet (guion medio), no stage_key de
  // workflow (guion bajo) — universo distinto, ver lib/insumosSecciones.js.
  insumos: [
    { key: 'diseno', label: 'Diseño' },
    { key: 'laser', label: 'Laser' },
    { key: 'corte', label: 'Corte' },
    { key: 'plegado', label: 'Plegado' },
    { key: 'prefabricados', label: 'Prefabricados / Armado' },
    { key: 'armado-primario', label: 'Armado Primario' },
    { key: 'pintura', label: 'Pintura' },
    { key: 'inyeccion', label: 'Inyección' },
    { key: 'revestimiento', label: 'Revestimiento' },
    { key: 'armado-final', label: 'Armado Final' },
    { key: 'despacho', label: 'Despacho' },
  ],
};

const STAGE_LABELS = Object.fromEntries(
  Object.entries(STAGES_BY_LINE).flatMap(([line, stages]) =>
    stages.map((stage) => [`${line}:${stage.key}`, stage.label])
  )
);

function toBool(v) {
  return v === true;
}

function normalizeText(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

function getStageOptions(line) {
  return STAGES_BY_LINE[line] || [];
}

function stageLabel(line, stageKey) {
  return STAGE_LABELS[`${line}:${stageKey}`] || stageKey || '—';
}

function Modal({ open, title, onClose, children, footer }) {
  if (!open) return null;
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.45)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 9999,
        padding: 16,
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: 'min(980px, 100%)',
          background: 'var(--surface)',
          borderRadius: 12,
          border: '1px solid var(--border)',
          boxShadow: '0 18px 55px rgba(0,0,0,0.25)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: 12,
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'space-between',
            gap: 10,
          }}
        >
          <div style={{ fontWeight: 900 }}>{title}</div>
          <button className="btn" type="button" onClick={onClose}>
            Cerrar
          </button>
        </div>
        <div style={{ padding: 12 }}>{children}</div>
        {footer && (
          <div
            style={{
              padding: 12,
              borderTop: '1px solid var(--border)',
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 8,
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

// El backend ya propaga un scope cargado en "portones" hacia iPanel,
// Prefabricados, Servicio Técnico, Orden Externa, Refabricado y hacia el
// confirmar de pedidos de Insumos de esa misma etapa (ver
// stageCandidatesForScope / INSUMOS_TO_PORTON_STAGE_CANDIDATES en
// server/routes/public/qc.js e insumos.js). Por eso alcanza con tildar la
// etapa una sola vez acá: no hace falta repetirla por línea.
function ScopeEditor({ value, onChange, disabled }) {
  const scopes = Array.isArray(value) ? value : [];

  const checkedStages = useMemo(() => {
    const set = new Set();
    for (const s of scopes) {
      const stageKey = String(s?.stage_key || '').trim();
      const enabled = s?.enabled !== false;
      if (stageKey && enabled) set.add(stageKey);
    }
    return set;
  }, [JSON.stringify(scopes)]);

  const setChecked = (stageKey, checked) => {
    const next = new Set(checkedStages);
    if (checked) next.add(stageKey);
    else next.delete(stageKey);
    onChange(Array.from(next).map((sk) => ({ line: 'portones', stage_key: sk, enabled: true })));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, opacity: disabled ? 0.6 : 1 }}>
      <div style={{ fontSize: 12, opacity: 0.75 }}>
        Marcá la etapa del sector donde puede autorizar. Se aplica sola a iPanel, Prefabricados,
        Servicio Técnico, Orden Externa, Refabricado y a confirmar pedidos de Insumos de esa misma
        etapa — no hace falta repetirla por línea.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 8 }}>
        {PORTON_STAGES.map((stage) => {
          const checked = checkedStages.has(stage.key);
          return (
            <label key={stage.key} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="checkbox"
                disabled={disabled}
                checked={checked}
                onChange={(e) => setChecked(stage.key, e.target.checked)}
              />
              <span>
                <b>{stage.label}</b> <span style={{ opacity: 0.65 }}>({stage.key})</span>
              </span>
            </label>
          );
        })}
      </div>

      <div style={{ fontSize: 12, opacity: 0.7 }}>
        Si el usuario es GLOBAL, los scopes no son necesarios, pero podés dejarlos igual.
      </div>
    </div>
  );
}

export default function AdminQcPage() {
  const nav = useNavigate();

  useEffect(() => {
    const t = getAdminToken();
    if (!t) nav('/admin/login', { replace: true });
  }, [nav]);

  const logout = () => {
    clearAdminToken();
    nav('/admin/login', { replace: true });
  };

  const [loadingUsers, setLoadingUsers] = useState(true);
  const [usersErr, setUsersErr] = useState('');
  const [users, setUsers] = useState([]);

  const reloadUsers = async () => {
    setUsersErr('');
    setLoadingUsers(true);
    try {
      const { data } = await api.get('/admin/qc/users');
      setUsers(data?.users || []);
    } catch (e) {
      const msg = e?.response?.data?.error || e.message;
      setUsersErr(msg);
      if (e?.response?.status === 401) nav('/admin/login', { replace: true });
    } finally {
      setLoadingUsers(false);
    }
  };

  useEffect(() => {
    reloadUsers();
  }, []);

  const [userModalOpen, setUserModalOpen] = useState(false);
  const [userModalMode, setUserModalMode] = useState('create');
  const [editingUser, setEditingUser] = useState(null);

  const [uName, setUName] = useState('');
  const [uPin, setUPin] = useState('');
  const [uIsGlobal, setUIsGlobal] = useState(false);
  const [uIsActive, setUIsActive] = useState(true);
  const [uScopes, setUScopes] = useState([]);

  const [savingUser, setSavingUser] = useState(false);
  const [userFormErr, setUserFormErr] = useState('');

  const openCreateUser = () => {
    setUserModalMode('create');
    setEditingUser(null);
    setUName('');
    setUPin('');
    setUIsGlobal(false);
    setUIsActive(true);
    setUScopes([]);
    setUserFormErr('');
    setUserModalOpen(true);
  };

  const openEditUser = (u) => {
    setUserModalMode('edit');
    setEditingUser(u);
    setUName(u?.name || '');
    setUPin('');
    setUIsGlobal(toBool(u?.is_global));
    setUIsActive(u?.is_active !== false);
    setUScopes(Array.isArray(u?.scopes) ? u.scopes : []);
    setUserFormErr('');
    setUserModalOpen(true);
  };

  const saveUser = async () => {
    setUserFormErr('');
    const nm = String(uName || '').trim();

    if (!nm) {
      setUserFormErr('El nombre es requerido.');
      return;
    }

    const pin = String(uPin || '').trim();
    if (userModalMode === 'create' && !/^\d{3,10}$/.test(pin)) {
      setUserFormErr('PIN inválido (3 a 10 dígitos numéricos).');
      return;
    }
    if (userModalMode === 'edit' && pin && !/^\d{3,10}$/.test(pin)) {
      setUserFormErr('PIN inválido (3 a 10 dígitos numéricos).');
      return;
    }

    try {
      setSavingUser(true);

      if (userModalMode === 'create') {
        await api.post('/admin/qc/users', {
          name: nm,
          pin,
          is_global: uIsGlobal === true,
          is_active: uIsActive === true,
          scopes: Array.isArray(uScopes) ? uScopes : [],
        });
        await reloadUsers();
        setUserModalOpen(false);
        return;
      }

      const id = Number(editingUser?.id);
      if (!Number.isInteger(id)) throw new Error('Usuario inválido (id).');

      const patch = {
        name: nm,
        is_global: uIsGlobal === true,
        is_active: uIsActive === true,
      };
      if (pin) patch.pin = pin;

      await api.put(`/admin/qc/users/${id}`, patch);
      await api.put(`/admin/qc/users/${id}/scopes`, {
        scopes: Array.isArray(uScopes) ? uScopes : [],
      });

      await reloadUsers();
      setUserModalOpen(false);
    } catch (e) {
      setUserFormErr(e?.response?.data?.error || e.message);
    } finally {
      setSavingUser(false);
    }
  };

  const [loadingMot, setLoadingMot] = useState(false);
  const [motErr, setMotErr] = useState('');
  const [motives, setMotives] = useState([]);

  const [mLine, setMLine] = useState('portones');
  const [mKind, setMKind] = useState('RECHAZADO');
  const [mStage, setMStage] = useState('');

  const reloadMotives = async () => {
    setMotErr('');
    setLoadingMot(true);
    try {
      const { data } = await api.get('/admin/qc/motives', {
        params: {
          line: mLine || undefined,
          kind: mKind || undefined,
          stage: mStage ? mStage : undefined,
        },
      });
      setMotives(data?.motives || []);
    } catch (e) {
      setMotErr(e?.response?.data?.error || e.message);
    } finally {
      setLoadingMot(false);
    }
  };

  useEffect(() => {
    reloadMotives();
  }, [mLine, mKind, mStage]);

  const [motModalOpen, setMotModalOpen] = useState(false);
  const [motModalMode, setMotModalMode] = useState('create');
  const [editingMotive, setEditingMotive] = useState(null);

  const [moLine, setMoLine] = useState('portones');
  const [moKind, setMoKind] = useState('RECHAZADO');
  const [moStage, setMoStage] = useState('');
  const [moLabel, setMoLabel] = useState('');
  const [moEnabled, setMoEnabled] = useState(true);
  const [moPriority, setMoPriority] = useState(100);

  const [savingMot, setSavingMot] = useState(false);
  const [motFormErr, setMotFormErr] = useState('');

  const openCreateMotive = () => {
    setMotModalMode('create');
    setEditingMotive(null);
    setMoLine(mLine || 'portones');
    setMoKind(mKind || 'RECHAZADO');
    setMoStage(mStage || '');
    setMoLabel('');
    setMoEnabled(true);
    setMoPriority(100);
    setMotFormErr('');
    setMotModalOpen(true);
  };

  const openEditMotive = (m) => {
    setMotModalMode('edit');
    setEditingMotive(m);
    setMoLine(m?.line || 'portones');
    setMoKind(m?.kind || 'RECHAZADO');
    setMoStage(m?.stage_key || '');
    setMoLabel(m?.label || '');
    setMoEnabled(m?.enabled !== false);
    setMoPriority(Number.isFinite(Number(m?.priority)) ? Number(m.priority) : 100);
    setMotFormErr('');
    setMotModalOpen(true);
  };

  const saveMotive = async () => {
    setMotFormErr('');
    const lb = String(moLabel || '').trim();
    if (!lb) {
      setMotFormErr('Label requerido.');
      return;
    }

    const stageKey = String(moStage || '').trim();
    const payloadStage = stageKey ? stageKey : null;

    try {
      setSavingMot(true);

      if (motModalMode === 'create') {
        await api.post('/admin/qc/motives', {
          line: moLine,
          kind: moKind,
          stage_key: payloadStage,
          label: lb,
          enabled: moEnabled === true,
          priority: Number(moPriority),
        });
        await reloadMotives();
        setMotModalOpen(false);
        return;
      }

      const id = Number(editingMotive?.id);
      if (!Number.isInteger(id)) throw new Error('Motivo inválido (id).');

      await api.put(`/admin/qc/motives/${id}`, {
        label: lb,
        enabled: moEnabled === true,
        priority: Number(moPriority),
        stage_key: payloadStage,
      });

      await reloadMotives();
      setMotModalOpen(false);
    } catch (e) {
      setMotFormErr(e?.response?.data?.error || e.message);
    } finally {
      setSavingMot(false);
    }
  };

  const usersSorted = useMemo(() => (users || []).slice().sort((a, b) => (a.id || 0) - (b.id || 0)), [users]);

  const [uSearch, setUSearch] = useState('');
  const [uFilterActive, setUFilterActive] = useState('all'); // all | active | inactive
  const [uFilterGlobal, setUFilterGlobal] = useState('all'); // all | global | scoped

  const usersFiltered = useMemo(() => {
    const q = normalizeText(uSearch);
    return usersSorted.filter((u) => {
      if (q && !normalizeText(u.name).includes(q)) return false;
      if (uFilterActive === 'active' && u.is_active === false) return false;
      if (uFilterActive === 'inactive' && u.is_active !== false) return false;
      if (uFilterGlobal === 'global' && u.is_global !== true) return false;
      if (uFilterGlobal === 'scoped' && u.is_global === true) return false;
      return true;
    });
  }, [usersSorted, uSearch, uFilterActive, uFilterGlobal]);

  const [motSearch, setMotSearch] = useState('');

  const motivesFiltered = useMemo(() => {
    const q = normalizeText(motSearch);
    if (!q) return motives || [];
    return (motives || []).filter((m) => normalizeText(m.label).includes(q));
  }, [motives, motSearch]);

  return (
    <div className="container" style={{ maxWidth: 1200 }}>
      <div className="header-row" style={{ alignItems: 'center' }}>
        <h2 className="h1">Admin – QC (Usuarios y Motivos)</h2>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link className="btn" to="/admin">
            Volver
          </Link>
          <Link className="btn" to="/">
            Inicio
          </Link>
          <button className="btn" type="button" onClick={reloadUsers}>
            Refrescar
          </button>
          <button className="btn" type="button" onClick={logout}>
            Salir
          </button>
        </div>
      </div>

      <div style={{ marginTop: 12, border: '1px solid var(--border)', borderRadius: 12, padding: 12, background: 'var(--surface)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ fontWeight: 900, fontSize: 16 }}>Usuarios QC</div>
          <button className="btn btn--brand" type="button" onClick={openCreateUser}>
            + Nuevo usuario
          </button>
        </div>

        <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, opacity: 0.75, fontWeight: 800 }}>Buscar por nombre</span>
            <input
              className="btn"
              value={uSearch}
              onChange={(e) => setUSearch(e.target.value)}
              placeholder="Nombre…"
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, opacity: 0.75, fontWeight: 800 }}>Estado</span>
            <select className="btn" value={uFilterActive} onChange={(e) => setUFilterActive(e.target.value)}>
              <option value="all">Todos</option>
              <option value="active">Activos</option>
              <option value="inactive">Inactivos</option>
            </select>
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, opacity: 0.75, fontWeight: 800 }}>Permisos</span>
            <select className="btn" value={uFilterGlobal} onChange={(e) => setUFilterGlobal(e.target.value)}>
              <option value="all">Todos</option>
              <option value="global">Global</option>
              <option value="scoped">Con permisos por etapa</option>
            </select>
          </label>
        </div>

        {usersErr && <div style={{ color: 'crimson', fontWeight: 800, marginTop: 10 }}>{usersErr}</div>}
        {loadingUsers ? (
          <div style={{ marginTop: 10 }}>Cargando usuarios…</div>
        ) : (
          <div style={{ overflowX: 'auto', marginTop: 10 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', borderBottom: '1px solid var(--border)', padding: 8 }}>ID</th>
                  <th style={{ textAlign: 'left', borderBottom: '1px solid var(--border)', padding: 8 }}>Nombre</th>
                  <th style={{ textAlign: 'left', borderBottom: '1px solid var(--border)', padding: 8 }}>Activo</th>
                  <th style={{ textAlign: 'left', borderBottom: '1px solid var(--border)', padding: 8 }}>Global</th>
                  <th style={{ textAlign: 'left', borderBottom: '1px solid var(--border)', padding: 8 }}>Scopes</th>
                  <th style={{ textAlign: 'left', borderBottom: '1px solid var(--border)', padding: 8 }}>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {usersFiltered.map((u) => {
                  const scopes = Array.isArray(u?.scopes) ? u.scopes : [];
                  const scopeCount = scopes.filter((s) => s?.enabled !== false).length;

                  return (
                    <tr key={u.id}>
                      <td style={{ padding: 8, borderBottom: '1px solid #eee' }}>{u.id}</td>
                      <td style={{ padding: 8, borderBottom: '1px solid #eee', fontWeight: 800 }}>{u.name}</td>
                      <td style={{ padding: 8, borderBottom: '1px solid #eee' }}>{u.is_active !== false ? 'Sí' : 'No'}</td>
                      <td style={{ padding: 8, borderBottom: '1px solid #eee' }}>{u.is_global === true ? 'Sí' : 'No'}</td>
                      <td style={{ padding: 8, borderBottom: '1px solid #eee' }}>
                        {u.is_global === true ? <span style={{ fontWeight: 800 }}>GLOBAL</span> : <span>{scopeCount} permisos</span>}
                      </td>
                      <td style={{ padding: 8, borderBottom: '1px solid #eee' }}>
                        <button className="btn btn--brand" type="button" onClick={() => openEditUser(u)}>
                          Editar
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {usersSorted.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ padding: 10, opacity: 0.7 }}>
                      Sin usuarios.
                    </td>
                  </tr>
                )}
                {usersSorted.length > 0 && usersFiltered.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ padding: 10, opacity: 0.7 }}>
                      Sin resultados para la búsqueda/filtro actual.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={{ marginTop: 14, border: '1px solid var(--border)', borderRadius: 12, padding: 12, background: 'var(--surface)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ fontWeight: 900, fontSize: 16 }}>Motivos QC</div>
          <button className="btn btn--brand" type="button" onClick={openCreateMotive}>
            + Nuevo motivo
          </button>
        </div>

        <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, opacity: 0.75, fontWeight: 800 }}>Línea</span>
            <select className="btn" value={mLine} onChange={(e) => setMLine(e.target.value)}>
              {LINES.map((x) => (
                <option key={x.key} value={x.key}>
                  {x.label}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, opacity: 0.75, fontWeight: 800 }}>Tipo</span>
            <select className="btn" value={mKind} onChange={(e) => setMKind(e.target.value)}>
              {KINDS.map((x) => (
                <option key={x.key} value={x.key}>
                  {x.label}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, opacity: 0.75, fontWeight: 800 }}>Etapa (opcional)</span>
            <select className="btn" value={mStage} onChange={(e) => setMStage(e.target.value)}>
              <option value="">(Todas)</option>
              {getStageOptions(mLine).map((stage) => (
                <option key={stage.key} value={stage.key}>
                  {stage.label} ({stage.key})
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, opacity: 0.75, fontWeight: 800 }}>Buscar por label</span>
            <input
              className="btn"
              value={motSearch}
              onChange={(e) => setMotSearch(e.target.value)}
              placeholder="Texto del motivo…"
            />
          </label>

          <button className="btn" type="button" onClick={reloadMotives} disabled={loadingMot}>
            {loadingMot ? 'Cargando…' : 'Refrescar'}
          </button>
        </div>

        {motErr && <div style={{ color: 'crimson', fontWeight: 800, marginTop: 10 }}>{motErr}</div>}

        <div style={{ overflowX: 'auto', marginTop: 10 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', borderBottom: '1px solid var(--border)', padding: 8 }}>ID</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid var(--border)', padding: 8 }}>Línea</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid var(--border)', padding: 8 }}>Tipo</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid var(--border)', padding: 8 }}>Etapa</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid var(--border)', padding: 8 }}>Label</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid var(--border)', padding: 8 }}>Enabled</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid var(--border)', padding: 8 }}>Prioridad</th>
                <th style={{ textAlign: 'left', borderBottom: '1px solid var(--border)', padding: 8 }}>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {motivesFiltered.map((m) => (
                <tr key={m.id}>
                  <td style={{ padding: 8, borderBottom: '1px solid #eee' }}>{m.id}</td>
                  <td style={{ padding: 8, borderBottom: '1px solid #eee' }}>{m.line}</td>
                  <td style={{ padding: 8, borderBottom: '1px solid #eee', fontWeight: 800 }}>{m.kind}</td>
                  <td style={{ padding: 8, borderBottom: '1px solid #eee' }}>
                    {m.stage_key ? `${stageLabel(m.line, m.stage_key)} (${m.stage_key})` : '—'}
                  </td>
                  <td style={{ padding: 8, borderBottom: '1px solid #eee' }}>{m.label}</td>
                  <td style={{ padding: 8, borderBottom: '1px solid #eee' }}>{m.enabled !== false ? 'Sí' : 'No'}</td>
                  <td style={{ padding: 8, borderBottom: '1px solid #eee' }}>{m.priority}</td>
                  <td style={{ padding: 8, borderBottom: '1px solid #eee' }}>
                    <button className="btn btn--brand" type="button" onClick={() => openEditMotive(m)}>
                      Editar
                    </button>
                  </td>
                </tr>
              ))}
              {!loadingMot && (motives || []).length === 0 && (
                <tr>
                  <td colSpan={8} style={{ padding: 10, opacity: 0.7 }}>
                    Sin motivos para el filtro actual.
                  </td>
                </tr>
              )}
              {!loadingMot && (motives || []).length > 0 && motivesFiltered.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ padding: 10, opacity: 0.7 }}>
                    Sin resultados para la búsqueda actual.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Modal
        open={userModalOpen}
        title={userModalMode === 'create' ? 'Crear usuario QC' : `Editar usuario QC #${editingUser?.id}`}
        onClose={() => setUserModalOpen(false)}
        footer={
          <>
            <button className="btn" type="button" onClick={() => setUserModalOpen(false)} disabled={savingUser}>
              Cancelar
            </button>
            <button className="btn btn--brand" type="button" onClick={saveUser} disabled={savingUser}>
              {savingUser ? 'Guardando…' : 'Guardar'}
            </button>
          </>
        }
      >
        {userFormErr && <div style={{ color: 'crimson', fontWeight: 800, marginBottom: 10 }}>{userFormErr}</div>}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontWeight: 900 }}>Nombre</span>
            <input className="btn" value={uName} onChange={(e) => setUName(e.target.value)} />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontWeight: 900 }}>PIN {userModalMode === 'edit' ? '(solo si querés cambiarlo)' : ''}</span>
            <input
              className="btn"
              value={uPin}
              onChange={(e) => setUPin(e.target.value)}
              inputMode="numeric"
              placeholder={userModalMode === 'edit' ? 'Dejar vacío para no cambiar' : '3 a 10 dígitos'}
            />
          </label>

          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={uIsActive} onChange={(e) => setUIsActive(e.target.checked)} />
            <span style={{ fontWeight: 900 }}>Activo</span>
          </label>

          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={uIsGlobal} onChange={(e) => setUIsGlobal(e.target.checked)} />
            <span style={{ fontWeight: 900 }}>GLOBAL</span>
          </label>
        </div>

        <div style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 900, marginBottom: 8 }}>Permisos (scopes por etapa)</div>
          <ScopeEditor value={uScopes} onChange={setUScopes} disabled={false} />
        </div>
      </Modal>

      <Modal
        open={motModalOpen}
        title={motModalMode === 'create' ? 'Crear motivo QC' : `Editar motivo QC #${editingMotive?.id}`}
        onClose={() => setMotModalOpen(false)}
        footer={
          <>
            <button className="btn" type="button" onClick={() => setMotModalOpen(false)} disabled={savingMot}>
              Cancelar
            </button>
            <button className="btn btn--brand" type="button" onClick={saveMotive} disabled={savingMot}>
              {savingMot ? 'Guardando…' : 'Guardar'}
            </button>
          </>
        }
      >
        {motFormErr && <div style={{ color: 'crimson', fontWeight: 800, marginBottom: 10 }}>{motFormErr}</div>}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontWeight: 900 }}>Línea</span>
            <select className="btn" value={moLine} onChange={(e) => setMoLine(e.target.value)} disabled={motModalMode === 'edit'}>
              {LINES.map((x) => (
                <option key={x.key} value={x.key}>
                  {x.label}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontWeight: 900 }}>Tipo</span>
            <select className="btn" value={moKind} onChange={(e) => setMoKind(e.target.value)} disabled={motModalMode === 'edit'}>
              {KINDS.map((x) => (
                <option key={x.key} value={x.key}>
                  {x.label}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontWeight: 900 }}>Etapa (opcional)</span>
            <select className="btn" value={moStage} onChange={(e) => setMoStage(e.target.value)}>
              <option value="">(Sin etapa específica)</option>
              {getStageOptions(moLine).map((stage) => (
                <option key={stage.key} value={stage.key}>
                  {stage.label} ({stage.key})
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontWeight: 900 }}>Prioridad</span>
            <input className="btn" value={String(moPriority)} onChange={(e) => setMoPriority(e.target.value)} inputMode="numeric" />
          </label>

          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" checked={moEnabled} onChange={(e) => setMoEnabled(e.target.checked)} />
            <span style={{ fontWeight: 900 }}>Enabled</span>
          </label>

          <div />
        </div>

        <div style={{ marginTop: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontWeight: 900 }}>Label</span>
            <input className="btn" value={moLabel} onChange={(e) => setMoLabel(e.target.value)} />
          </label>

          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
            Recordatorio: los motivos aplican solo a estados QC <b>OBSERVADO</b> y <b>RECHAZADO</b>.
          </div>
        </div>
      </Modal>
    </div>
  );
}
