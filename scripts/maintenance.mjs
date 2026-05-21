import { initSchema, openDb, purgeExpiredEvents } from '../packages/shared/dist/index.js';

const db = openDb();
initSchema(db);
const result = purgeExpiredEvents(db);
console.log('Retention purge:', result);
