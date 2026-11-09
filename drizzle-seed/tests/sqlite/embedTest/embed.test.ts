import BetterSqlite3 from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { embed, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { seed } from '../../../src/index.ts';

const users = sqliteTable('users', {
	id: integer().primaryKey(),
	contact: embed({
		email: text().notNull(),
		geo: embed({ lat: integer().notNull(), lng: integer() }),
	}),
});

const posts = sqliteTable('posts', {
	id: integer().primaryKey(),
	authorId: integer('author_id').notNull().references(() => users.id),
	meta: embed({ title: text().notNull() }),
});

const prepare = () => {
	const db = drizzle({ client: new BetterSqlite3(':memory:') });
	db.run(sql`
		create table users (
			id integer primary key,
			contact_email text not null,
			contact_geo_lat integer not null,
			contact_geo_lng integer
		)
	`);
	db.run(sql`
		create table posts (
			id integer primary key,
			author_id integer not null references users (id),
			meta_title text not null
		)
	`);
	return db;
};

test('seeds every column of an embed table, nested groups and relations included', async () => {
	const db = prepare();
	await seed(db, { users, posts }, { count: 10 });

	const rows = await db.select().from(users);
	expect(rows.length).toBe(10);
	for (const row of rows) {
		// picked by the column's own name, not its `contact.` path
		expect(row.contact.email).toMatch(/@/);
		expect(typeof row.contact.geo.lat).toBe('number');
		expect(typeof row.contact.geo.lng).toBe('number');
	}

	const ids = new Set(rows.map((row) => row.id));
	const postRows = await db.select().from(posts);
	expect(postRows.length).toBe(10);
	for (const post of postRows) {
		expect(ids.has(post.authorId)).toBe(true);
		expect(typeof post.meta.title).toBe('string');
	}
});

test('refines embedded columns as a nested object', async () => {
	const db = prepare();
	await seed(db, { users }, { count: 5 }).refine((funcs) => ({
		users: { columns: { contact: { geo: { lat: funcs.default({ defaultValue: 7 }), lng: false } } } },
	}));

	const rows = await db.select().from(users);
	expect(rows.map((row) => row.contact.geo)).toStrictEqual(new Array(5).fill({ lat: 7, lng: null }));
});
