import { initSchema, openDb } from '../packages/shared/dist/index.js';

const db = openDb();
initSchema(db);
console.log('Database initialized:', process.env.MGA_DB_PATH ?? '(default mga/data/mga.db)');
