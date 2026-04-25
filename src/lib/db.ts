import knex from 'knex';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data.sqlite');

export const db = knex({
    client: 'better-sqlite3',
    connection: { filename: DB_PATH },
    useNullAsDefault: true,
});

export async function initSchema(): Promise<void> {
    if (!(await db.schema.hasTable('users'))) {
        await db.schema.createTable('users', (t) => {
            t.string('id').primary();
            t.string('target_id').notNullable();
            t.timestamp('created_at').defaultTo(db.fn.now());
            t.timestamp('last_seen_at').defaultTo(db.fn.now());
        });
    }
}
