import { sql } from 'drizzle-orm';
import { embed, int, serial, singlestoreTable, text, varchar } from 'drizzle-orm/singlestore-core';
import { expect } from 'vitest';
import { seed } from '../../../src/index.ts';
import { singlestoreTest as test } from '../instrumentation.ts';

const users = singlestoreTable('embed_users', {
	id: serial().primaryKey(),
	name: varchar({ length: 100 }).notNull(),
	address: embed({
		city: varchar({ length: 100 }).notNull(),
		zip: int(),
		geo: embed({ lat: int().notNull(), lng: int() }),
	}),
});

const accounts = singlestoreTable('embed_accounts', {
	id: serial().primaryKey(),
	billing: embed({ city: text(), country: varchar('bill_country', { length: 100 }) }, { prefix: 'b_' }),
});

let firstTime = true;
let resolveFunc: (val: any) => void;
const promise = new Promise((resolve) => {
	resolveFunc = resolve;
});
test.beforeEach(async ({ db }) => {
	if (firstTime) {
		firstTime = false;

		await db.execute(sql`
			create table embed_users (
				id serial primary key,
				name varchar(100) not null,
				address_city varchar(100) not null,
				address_zip int,
				address_geo_lat int not null,
				address_geo_lng int
			)
		`);
		await db.execute(sql`create table embed_accounts (id serial primary key, b_city text, bill_country varchar(100))`);

		resolveFunc('');
	}
	await promise;
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

test('embedded columns keep their own names and prefixes', async ({ db }) => {
	await seed(db, { accounts }, { count: 5 });

	const rows = await db.select().from(accounts);
	expect(rows).toHaveLength(5);
	expect(rows.every((row) => typeof row.billing.city === 'string' && typeof row.billing.country === 'string')).toBe(
		true,
	);
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
