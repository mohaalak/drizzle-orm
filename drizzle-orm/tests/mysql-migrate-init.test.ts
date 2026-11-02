import { createPool, type Pool } from 'mysql2/promise';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { drizzle } from '~/mysql2';
import { migrate } from '~/mysql2/migrator';
import { sql } from '~/sql';

// Runs against a real MySQL server: set MYSQL_CONNECTION_STRING, for example
// `mysql://root:mysql@127.0.0.1:33306/drizzle` for `docker run -e MYSQL_ROOT_PASSWORD=mysql -e MYSQL_DATABASE=drizzle -p 33306:3306 mysql:8`.
const connectionString = process.env['MYSQL_CONNECTION_STRING'];

const migrationsTable = 'init_baseline_migrations';
let pool: Pool;
let folder: string;

const addMigration = (name: string, statement: string) => {
	mkdirSync(join(folder, name));
	writeFileSync(join(folder, name, 'migration.sql'), statement);
};

const tableExists = async (name: string) => {
	const [rows] = await pool.query(
		'select count(*) as n from information_schema.tables where table_schema = database() and table_name = ?',
		[name],
	);
	return (rows as { n: number }[])[0]!.n > 0;
};

beforeAll(async () => {
	if (!connectionString) return;
	pool = createPool({ uri: connectionString });
	folder = mkdtempSync(join(tmpdir(), 'drizzle-migrate-init-'));
	for (const name of [migrationsTable, 'init_baseline_existing', 'init_baseline_next']) {
		await pool.query(`drop table if exists \`${name}\``);
	}
});

afterAll(async () => {
	if (!connectionString) return;
	for (const name of [migrationsTable, 'init_baseline_existing', 'init_baseline_next']) {
		await pool.query(`drop table if exists \`${name}\``);
	}
	await pool.end();
	rmSync(folder, { recursive: true, force: true });
});

test.skipIf(!connectionString)(
	'init records the baseline as applied, and later migrations run on top of it',
	async () => {
		const db = drizzle({ client: pool });
		addMigration('20260101000000_baseline', 'create table init_baseline_existing (id int primary key)');

		expect(await migrate(db, { migrationsFolder: folder, migrationsTable, init: true })).toBeUndefined();
		expect(await tableExists('init_baseline_existing')).toBe(false);
		const recorded = await db.execute(sql`select name, created_at from ${sql.identifier(migrationsTable)}`);
		expect(recorded[0]).toEqual([{ name: '20260101000000_baseline', created_at: Date.UTC(2026, 0, 1) }]);

		addMigration('20260102000000_next', 'create table init_baseline_next (id int primary key)');
		expect(await migrate(db, { migrationsFolder: folder, migrationsTable, init: true })).toEqual({
			exitCode: 'databaseMigrations',
		});

		await migrate(db, { migrationsFolder: folder, migrationsTable });
		expect(await tableExists('init_baseline_existing')).toBe(false);
		expect(await tableExists('init_baseline_next')).toBe(true);
	},
);
