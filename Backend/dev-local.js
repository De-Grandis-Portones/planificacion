// Arranca el backend contra la copia local de Postgres (planta_dev) en vez
// de Supabase real. `npm run dev`/`npm start` siguen intactos, sin tocar
// esto — es un punto de entrada nuevo y separado, no un cambio al existente.
process.env.USE_LOCAL_DB = '1';
require('./server/index.js');
