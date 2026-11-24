import { eq, sql } from 'drizzle-orm';
import { cockroachTable, embed, int4, text } from 'drizzle-orm/cockroach-core';
import { expect } from 'vitest';
import { reset, seed } from '../../../src/index.ts';
import { cockroachTest as test } from '../instrumentation.ts';

const users = cockroachTable('embed_users', {
	id: int4().primaryKey(),
	name: text().notNull(),
	address: embed({
		city: text().notNull(),
		zip: int4(),
		geo: embed({ lat: int4().notNull(), lng: int4() }),
	}),
});

const posts = cockroachTable('embed_posts', {
	id: int4().primaryKey(),
	authorId: int4('author_id').notNull().references(() => users.id),
	meta: embed({ title: text().notNull(), views: int4() }),
});

test.beforeEach(async ({ db }) => {
	await db.execute(sql`drop table if exists embed_posts`);
	await db.execute(sql`drop table if exists embed_users`);
	await db.execute(sql`
		create table embed_users (
			id int4 primary key,
			name text not null,
			address_city text not null,
			address_zip int4,
			address_geo_lat int4 not null,
			address_geo_lng int4
		)
	`);
	await db.execute(sql`
		create table embed_posts (
			id int4 primary key,
			author_id int4 not null references embed_users (id),
			meta_title text not null,
			meta_views int4
		)
	`);
});

test('seeds every column of an embed table, nested groups included', async ({ db }) => {
	await seed(db, { users }, { count: 20 });

	const rows = await db.select().from(users);
	expect(rows.length).toBe(20);
	for (const row of rows) {
		expect(typeof row.address.city).toBe('string');
		expect(row.address.city.length).toBeGreaterThan(0);
		expect(typeof row.address.zip).toBe('number');
		expect(typeof row.address.geo.lat).toBe('number');
		expect(typeof row.address.geo.lng).toBe('number');
	}
});

test('refines embedded columns with nested keys', async ({ db }) => {
	await seed(db, { users }, { count: 10 }).refine((funcs) => ({
		users: {
			columns: {
				address: {
					city: funcs.valuesFromArray({ values: ['Berlin', 'Paris'] }),
					zip: false,
					geo: { lat: funcs.intPrimaryKey() },
				},
			},
		},
	}));

	const rows = await db.select().from(users);
	expect(rows.length).toBe(10);
	for (const row of rows) {
		expect(['Berlin', 'Paris']).toContain(row.address.city);
		expect(row.address.zip).toBeNull();
	}
	expect(rows.map((row) => row.address.geo.lat).sort((a, b) => a - b)).toEqual(
		[...Array(10).keys()].map((i) => i + 1),
	);
});

test('a relation to an embed table keeps its foreign key', async ({ db }) => {
	await seed(db, { users, posts }, { count: 10 });

	const authors = await db.select().from(users);
	const rows = await db.select().from(posts);
	expect(rows.length).toBe(10);
	const ids = new Set(authors.map((author) => author.id));
	for (const row of rows) {
		expect(ids.has(row.authorId)).toBe(true);
		expect(typeof row.meta.title).toBe('string');
	}
});

test('refines an embed table that references another one, with `with`', async ({ db }) => {
	await seed(db, { users, posts }, { count: 3 }).refine((funcs) => ({
		users: { with: { posts: 2 } },
		posts: { columns: { meta: { title: funcs.default({ defaultValue: 'hello' }) } } },
	}));

	expect(await db.select().from(posts).where(eq(posts.meta.title, 'hello'))).toHaveLength(6);
});

test('dryRun returns embedded values nested, as the table writes them', async ({ db }) => {
	const data = await seed(db, { users }, { count: 3 }).dryRun();

	expect(data.users).toHaveLength(3);
	for (const row of data.users) {
		expect(typeof row.address.city).toBe('string');
		expect(typeof row.address.geo.lat).toBe('number');
		expect(Object.keys(row)).not.toContain('address.city');
	}
});

test('reset truncates embed tables', async ({ db }) => {
	await seed(db, { users, posts }, { count: 5 });
	expect((await db.select().from(users)).length).toBe(5);

	await reset(db, { users, posts });
	expect(await db.select().from(users)).toEqual([]);
	expect(await db.select().from(posts)).toEqual([]);
});
