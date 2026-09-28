const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const healthRoutes = require('./routes/health');

const adminAuthRoutes = require('./routes/admin/auth');
const adminUsersRoutes = require('./routes/admin/users');
const adminTicketsRoutes = require('./routes/admin/tickets');
const adminQcRoutes = require('./routes/admin/qc');
const adminWorkflowRoutes = require('./routes/admin/workflow');
const adminPrefabricadosRoutes = require('./routes/admin/prefabricados');
const adminServicioTecnicoRoutes = require('./routes/admin/servicioTecnico');
const adminSchedulingRoutes = require('./routes/admin/scheduling');
const adminServicioTecnicoViajesRoutes = require('./routes/admin/servicioTecnicoViajes');
const adminInsumosRoutes = require('./routes/admin/insumos');
const adminLogisticaConsultasRoutes = require('./routes/admin/logisticaConsultas');
const adminLogisticaViajesRoutes = require('./routes/admin/logisticaViajes');
const adminLogisticaAdjuntosRoutes = require('./routes/admin/logisticaAdjuntos');
const adminNotasNodoRoutes = require('./routes/admin/notasNodo');
const adminReunionesRoutes = require('./routes/admin/reuniones');
const adminProgramadoresChatRoutes = require('./routes/admin/programadoresChat');

const plantaRoutes = require('./routes/public/planta');
const despacharRoutes = require('./routes/public/despachar');
const preproduccionRoutes = require('./routes/public/preproduccion');
const qcRoutes = require('./routes/public/qc');
const workflowRoutes = require('./routes/public/workflow');
const portonesRoutes = require('./routes/public/portones');
const ipanelRoutes = require('./routes/public/ipanel');
const ipanelPreprodRoutes = require('./routes/public/ipanelPreprod');
const remitosProxyRoutes = require('./routes/public/remitosProxy');
const refabricacionRoutes = require('./routes/public/refabricacion');
const priceCategoriesRoutes = require('./routes/public/priceCategories');
const prefabricadosRoutes = require('./routes/public/prefabricados');
const servicioTecnicoRoutes = require('./routes/public/servicioTecnico');
const insumosRoutes = require('./routes/public/insumos');
const despachoV2Routes = require('./routes/public/despachoV2');
const webhookWhatsappRoutes = require('./routes/public/webhookWhatsapp');
const iaRoutes = require('./routes/external/ia');

const { errorHandler } = require('./middleware/errorHandler');

const app = express();

// Para que caches/CDN varien por Origin
app.use((req, res, next) => { res.header('Vary', 'Origin'); next(); });

const defaultOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://planificacion-pi.vercel.app',
];

const envOrigins = (process.env.FRONTEND_ORIGINS || '')
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean);

const allowedOrigins = Array.from(new Set([...envOrigins, ...defaultOrigins]));
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    const clean = origin.replace(/\/$/, '');
    if (allowedOrigins.includes(clean)) return cb(null, true);
    // En desarrollo permitimos cualquier localhost/127.0.0.1 (Vite, etc.)
    if (process.env.NODE_ENV !== 'production') {
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(clean)) {
        return cb(null, true);
      }
    }
    return cb(new Error(`CORS bloqueado para: ${origin}`));
  },
}));
app.options('*', cors());

// 25mb: los adjuntos de las Consultas a Técnica/Comercial (mismo tope que usa
// el Presupuestador) viajan como data URL en el body JSON.
app.use(express.json({ limit: '25mb' }));
app.use(morgan('dev'));

// Routes
app.use('/', healthRoutes);

app.use('/admin', adminAuthRoutes);
app.use('/admin', adminUsersRoutes);
app.use('/admin', adminTicketsRoutes);
// Montado antes que qc/workflow/prefabricados/servicio-tecnico: esos routers usan
// router.use(adminAuth, requireScope(SU_SCOPE)) SIN path especifico, asi que
// interceptan cualquier /admin/* que llegue a ellos primero (incluso rutas que no
// son suyas) y cortan la cadena antes de que Express pruebe el siguiente router.
// Montando insumos antes evitamos que un usuario con SOLO compras:admin choque
// contra el scope de otra feature.
app.use('/admin', adminInsumosRoutes);
app.use('/admin', adminLogisticaConsultasRoutes);
app.use('/admin', adminLogisticaViajesRoutes);
app.use('/admin', adminLogisticaAdjuntosRoutes);
app.use('/admin', adminQcRoutes);
app.use('/admin', adminWorkflowRoutes);
app.use('/admin', adminPrefabricadosRoutes);
app.use('/admin', adminServicioTecnicoRoutes);
app.use('/admin', adminServicioTecnicoViajesRoutes);
app.use('/admin', adminSchedulingRoutes);
app.use('/admin', adminNotasNodoRoutes);
app.use('/admin', adminReunionesRoutes);
app.use('/admin', adminProgramadoresChatRoutes);

// ---------------------------------------------------------------------------
// Backward-compat aliases (legacy frontend)
// ---------------------------------------------------------------------------
// Algunos clientes antiguos consumen /users y /scopes (sin prefijo /admin).
// Montamos el mismo router tambien en la raiz para evitar 404.
// Nota: siguen protegidas por adminAuth (401 si falta token).
app.use('/', adminUsersRoutes);

app.use('/', plantaRoutes);
app.use('/', despacharRoutes);
app.use('/', preproduccionRoutes);
app.use('/', ipanelPreprodRoutes);
app.use('/', qcRoutes);
app.use('/', workflowRoutes);
app.use('/', portonesRoutes);
app.use('/', ipanelRoutes);
app.use('/', remitosProxyRoutes);
app.use('/', refabricacionRoutes);
app.use('/', priceCategoriesRoutes);
app.use('/', prefabricadosRoutes);
app.use('/', servicioTecnicoRoutes);
app.use('/', insumosRoutes);
app.use('/', despachoV2Routes);
app.use('/', webhookWhatsappRoutes);
app.use('/', iaRoutes);

app.use(errorHandler);

module.exports = { app };
