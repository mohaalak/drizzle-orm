import { sql } from 'drizzle-orm';
import { embed, int, mssqlTable, varchar } from 'drizzle-orm/mssql-core';
import { expect } from 'vitest';
import { seed } from '../../../src/index.ts';
import { mssqlTest as test } from '../instrumentation.ts';

const users = mssqlTable('embed_users', {
	id: int().primaryKey(),
	contact: embed({
		email: varchar({ length: 256 }).notNull(),
		geo: embed({ lat: int().notNull(), lng: int() }),
	}),
});

const posts = mssqlTable('embed_posts', {
	id: int().primaryKey(),
	authorId: int('author_id').notNull().references(() => users.id),
	meta: embed({ title: varchar({ length: 256 }).notNull() }),
});

test.beforeEach(async ({ db }) => {
	await db.execute(sql`drop table if exists embed_posts`);
	await db.execute(sql`drop table if exists embed_users`);
	await db.execute(sql`
		create table embed_users (
			id int primary key,
			contact_email varchar(256) not null,
			contact_geo_lat int not null,
			contact_geo_lng int
		)
	`);
	await db.execute(sql`
		create table embed_posts (
			id int primary key,
			author_id int not null references embed_users (id),
			meta_title varchar(256) not null
		)
	`);
});

test.afterEach(async ({ db }) => {
	await db.execute(sql`drop table if exists embed_posts`);
	await db.execute(sql`drop table if exists embed_users`);
});

test('seeds every column of an embed table, nested groups and relations included', async ({ db }) => {
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

test('refines embedded columns as a nested object', async ({ db }) => {
	await seed(db, { users }, { count: 5 }).refine((funcs) => ({
		users: { columns: { contact: { geo: { lat: funcs.default({ defaultValue: 7 }), lng: false } } } },
	}));

	const rows = await db.select().from(users);
	expect(rows.map((row) => row.contact.geo)).toStrictEqual(new Array(5).fill({ lat: 7, lng: null }));
});
