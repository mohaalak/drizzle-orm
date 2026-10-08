import { beforeAll, describe, expect, test } from 'vitest';
import { alias, camelCase, embed, getTableConfig, index, integer, pgTable, serial, snakeCase, text } from '~/pg-core';
import { drizzle } from '~/pglite';
import { defineRelations } from '~/relations';
import { asc, eq, sql } from '~/sql';

const users = pgTable('users', {
	id: serial().primaryKey(),
	name: text().notNull(),
	address: embed({
		street: text(),
		city: text().notNull(),
		geo: embed({
			lat: integer(),
			lng: integer(),
		}),
	}),
	billing: embed({
		zip: text('billing_zip_code'),
	}, { prefix: 'bill_' }),
}, (t) => [index('users_city_idx').on(t.address.city)]);

const db = drizzle('memory://');

beforeAll(async () => {
	await db.execute(sql`
		create table users (
			id serial primary key,
			name text not null,
			address_street text,
			address_city text not null,
			address_geo_lat integer,
			address_geo_lng integer,
			billing_zip_code text
		)
	`);
});

describe('embed', () => {
	test('flattens groups into prefixed columns', () => {
		const { columns, indexes } = getTableConfig(users);
		expect(columns.map((column) => column.name)).toEqual([
			'id',
			'name',
			'address_street',
			'address_city',
			'address_geo_lat',
			'address_geo_lng',
			'billing_zip_code',
		]);
		expect(columns.find((column) => column.name === 'address_city')!.notNull).toBe(true);
		expect(indexes[0]!.config.columns.map((column) => (column as any).name)).toEqual(['address_city']);
	});

	test('exposes groups as nested columns', () => {
		expect(users.address.city.name).toBe('address_city');
		expect(users.address.geo.lat.name).toBe('address_geo_lat');
		expect(db.select().from(users).where(eq(users.address.city, 'Berlin')).toSQL().sql).toBe(
			'select "id", "name", "address_street", "address_city", "address_geo_lat", "address_geo_lng", "billing_zip_code" from "users" where "users"."address_city" = $1',
		);
	});

	test('insert takes nested values and returns nested rows', async () => {
		const [inserted] = await db.insert(users).values({
			name: 'Ada',
			address: { street: 'Main St', city: 'Berlin', geo: { lat: 52, lng: 13 } },
			billing: { zip: '10115' },
		}).returning();

		expect(inserted).toEqual({
			id: 1,
			name: 'Ada',
			address: { street: 'Main St', city: 'Berlin', geo: { lat: 52, lng: 13 } },
			billing: { zip: '10115' },
		});

		await db.insert(users).values({ name: 'Bob', address: { city: 'Paris' } });

		const rows = await db.select().from(users).orderBy(asc(users.id));
		expect(rows).toEqual([
			inserted,
			{
				id: 2,
				name: 'Bob',
				address: { street: null, city: 'Paris', geo: { lat: null, lng: null } },
				billing: { zip: null },
			},
		]);
	});

	test('update sets nested values, and null clears a group', async () => {
		const [updated] = await db.update(users)
			.set({ address: { city: 'Rome', geo: null }, billing: null })
			.where(eq(users.id, 1))
			.returning({ id: users.id, address: users.address });

		expect(updated).toEqual({
			id: 1,
			address: { street: 'Main St', city: 'Rome', geo: { lat: null, lng: null } },
		});
		expect(await db.select({ zip: users.billing.zip }).from(users).where(eq(users.id, 1))).toEqual([{ zip: null }]);
	});

	test('partial selects can pick a group or a column inside one', async () => {
		const rows = await db.select({ name: users.name, address: users.address, lat: users.address.geo.lat })
			.from(users)
			.where(eq(users.id, 2));

		expect(rows).toEqual([{
			name: 'Bob',
			address: { street: null, city: 'Paris', geo: { lat: null, lng: null } },
			lat: null,
		}]);
	});

	test('joins nest groups under the table, and a missing joined row is null', async () => {
		const other = alias(users, 'other');
		const rows = await db.select().from(users)
			.leftJoin(other, eq(other.address.city, sql`'Nowhere'`))
			.where(eq(users.id, 2));

		expect(rows).toEqual([{
			users: {
				id: 2,
				name: 'Bob',
				address: { street: null, city: 'Paris', geo: { lat: null, lng: null } },
				billing: { zip: null },
			},
			other: null,
		}]);
	});

	test('aliases reference their own table inside groups', () => {
		const other = alias(users, 'other');
		expect(db.select({ city: other.address.city }).from(other).toSQL().sql).toBe(
			'select "address_city" from "users" "other"',
		);
		expect(db.select().from(users).innerJoin(other, eq(other.address.city, users.address.city)).toSQL().sql)
			.toContain('on "other"."address_city" = "users"."address_city"');
	});

	test('rejects a group written as something other than an object', () => {
		expect(() => db.insert(users).values({ name: 'X', address: sql`null` as any })).toThrow(
			'Embedded group "address" in table "users" must be written as an object of its columns',
		);
	});

	test('table casing applies to the prefixed name', () => {
		const definition = () => ({
			homeAddress: embed({ zipCode: text(), streetName: text('street') }),
		});
		expect(getTableConfig(snakeCase.table('t', definition())).columns.map((column) => column.name)).toEqual([
			'home_address_zip_code',
			'street',
		]);
		expect(getTableConfig(camelCase.table('t', definition())).columns.map((column) => column.name)).toEqual([
			'homeAddressZipCode',
			'street',
		]);
		expect(getTableConfig(pgTable('t', definition())).columns.map((column) => column.name)).toEqual([
			'homeAddress_zipCode',
			'street',
		]);
	});

	test('tables without groups are unaffected', () => {
		const plain = pgTable('plain', { id: serial().primaryKey(), cityId: integer() });
		expect(Object.keys(plain)).toContain('cityId');
		expect(db.insert(plain).values({ cityId: 1 }).toSQL().sql).toBe(
			'insert into "plain" ("id", "cityId") values (default, $1)',
		);
	});
});

const shops = pgTable('shops', {
	id: serial().primaryKey(),
	location: embed({ city: text().notNull(), geo: embed({ lat: integer() }) }),
});

const orders = pgTable('orders', {
	id: serial().primaryKey(),
	shopId: integer().notNull(),
	delivery: embed({ city: text() }),
});

const relations = defineRelations({ shops, orders }, (r) => ({
	shops: { orders: r.many.orders({ from: r.shops.id, to: r.orders.shopId }) },
	orders: { shop: r.one.shops({ from: r.orders.shopId, to: r.shops.id, optional: false }) },
}));

describe.each([
	{ jit: false },
	{ jit: true },
])('embed in relational queries (jit: $jit)', ({ jit }) => {
	const rqb = drizzle('memory://', { relations, jit });

	beforeAll(async () => {
		await rqb.execute(sql`
			create table shops (id serial primary key, location_city text not null, location_geo_lat integer)
		`);
		await rqb.execute(sql`create table orders (id serial primary key, "shopId" integer not null, delivery_city text)`);
		await rqb.insert(shops).values({ location: { city: 'Berlin', geo: { lat: 52 } } });
		await rqb.insert(orders).values([{ shopId: 1, delivery: { city: 'Potsdam' } }, { shopId: 1 }]);
	});

	test('nests groups in the rows it reads', async () => {
		expect(await rqb.query.shops.findFirst()).toEqual({ id: 1, location: { city: 'Berlin', geo: { lat: 52 } } });
	});

	test('nests groups in loaded relations', async () => {
		const shop = await rqb.query.shops.findFirst({ with: { orders: { orderBy: { id: 'asc' } } } });
		expect(shop).toEqual({
			id: 1,
			location: { city: 'Berlin', geo: { lat: 52 } },
			orders: [
				{ id: 1, shopId: 1, delivery: { city: 'Potsdam' } },
				{ id: 2, shopId: 1, delivery: { city: null } },
			],
		});

		const order = await rqb.query.orders.findMany({ with: { shop: true }, orderBy: { id: 'asc' }, limit: 1 });
		expect(order).toEqual([{
			id: 1,
			shopId: 1,
			delivery: { city: 'Potsdam' },
			shop: { id: 1, location: { city: 'Berlin', geo: { lat: 52 } } },
		}]);
	});
});
