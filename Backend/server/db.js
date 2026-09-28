const { Pool } = require('pg');

// Dos formas de apagar SSL para un Postgres local (no lo soporta), que
// convergieron en ramas distintas — se sostienen las dos, cualquiera de las
// dos alcanza. USE_LOCAL_DB la setea dev-local.js (ver ese archivo);
// DB_SSL=false es la variable suelta que ya usaba otra parte del código. En
// producción (Supabase) ninguna de las dos está definida, así que sigue
// usando SSL exactamente como antes.
const useSsl = process.env.DB_SSL !== 'false' && !process.env.USE_LOCAL_DB;

const pool = new Pool({
  connectionString: process.env.SUPABASE_DB_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});

module.exports = { pool };
