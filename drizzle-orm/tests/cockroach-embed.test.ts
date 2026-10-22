import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { drizzle } from '~/cockroach';
import {
	alias,
	camelCase,
	cockroachTable,
	embed,
	getTableConfig,
	index,
	int4,
	snakeCase,
	text,
} from '~/cockroach-core';
import { defineRelations } from '~/relations';
import { asc, eq, sql } from '~/sql';

// The `toSQL()` tests run on a mock client. The rest run against a real CockroachDB server: set
// COCKROACH_CONNECTION_STRING, for example `postgresql://root@localhost:26257/defaultdb?sslmode=disable`.
const connectionString = process.env['COCKROACH_CONNECTION_STRING'];

const users = cockroachTable('embed_users', {
	id: int4().primaryKey(),
	name: text().notNull(),
	address: embed({
		street: text(),
		city: text().notNull(),
		geo: embed({
			lat: int4(),
			lng: int4(),
		}),
	}),
	billing: embed({
		zip: text('billing_zip_code'),
	}, { prefix: 'bill_' }),
}, (t) => [index('embed_users_city_idx').on(t.address.city)]);

const plain = cockroachTable('embed_plain', { id: int4().primaryKey(), cityId: int4() });

const src = cockroachTable('embed_src', {
	name: text().notNull(),
	city: text().notNull(),
	lat: int4(),
});

const shops = cockroachTable('embed_shops', {
	id: int4().primaryKey(),
	location: embed({ city: text().notNull(), geo: embed({ lat: int4() }) }),
});

const orders = cockroachTable('embed_orders', {
	id: int4().primaryKey(),
	shopId: int4().notNull(),
	delivery: embed({ city: text() }),
});

const relations = defineRelations({ shops, orders }, (r) => ({
	shops: { orders: r.many.orders({ from: r.shops.id, to: r.orders.shopId }) },
	orders: { shop: r.one.shops({ from: r.orders.shopId, to: r.shops.id, optional: false }) },
}));

describe('embed (no database)', () => {
	const mock = drizzle.mock();

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
		expect(mock.select().from(users).where(eq(users.address.city, 'Berlin')).toSQL().sql).toBe(
			'select "id", "name", "address_street", "address_city", "address_geo_lat", "address_geo_lng", "billing_zip_code" from "embed_users" where "embed_users"."address_city" = $1',
		);
	});

	test('insert flattens nested values', () => {
		expect(
			mock.insert(users).values({
				id: 1,
				name: 'Ada',
				address: { street: 'Main St', city: 'Berlin', geo: { lat: 52 } },
				billing: { zip: '10115' },
			}).returning().toSQL(),
		).toEqual({
			sql:
				'insert into "embed_users" ("id", "name", "address_street", "address_city", "address_geo_lat", "address_geo_lng", "billing_zip_code") values ($1, $2, $3, $4, $5, default, $6) returning "id", "name", "address_street", "address_city", "address_geo_lat", "address_geo_lng", "billing_zip_code"',
			params: [1, 'Ada', 'Main St', 'Berlin', 52, '10115'],
		});
	});

	test('on conflict do update takes nested values, and null clears a group', () => {
		expect(
			mock.insert(users).values({ id: 1, name: 'Ada', address: { city: 'Berlin' } }).onConflictDoUpdate({
				target: users.id,
				set: { address: { city: 'Hamburg', geo: null }, billing: null },
			}).toSQL().sql,
		).toBe(
			'insert into "embed_users" ("id", "name", "address_street", "address_city", "address_geo_lat", "address_geo_lng", "billing_zip_code") values ($1, $2, default, $3, default, default, default) on conflict ("id") do update set "address_city" = $4, "address_geo_lat" = $5, "address_geo_lng" = $6, "billing_zip_code" = $7',
		);
	});

	test('update sets nested values, and null clears a group', () => {
		expect(
			mock.update(users)
				.set({ address: { city: 'Rome', geo: null }, billing: null })
				.where(eq(users.id, 1))
				.returning({ id: users.id, address: users.address })
				.toSQL(),
		).toEqual({
			sql:
				'update "embed_users" set "address_city" = $1, "address_geo_lat" = $2, "address_geo_lng" = $3, "billing_zip_code" = $4 where "embed_users"."id" = $5 returning "id", "address_street", "address_city", "address_geo_lat", "address_geo_lng"',
			params: ['Rome', null, null, null, 1],
		});
	});

	test('update from and delete returning use the nested shape', () => {
		const other = alias(users, 'other');
		expect(
			mock.update(users).set({ name: 'x' }).from(other).where(eq(users.address.city, other.address.city))
				.toSQL().sql,
		).toBe(
			'update "embed_users" set "name" = $1 from "embed_users" "other" where "embed_users"."address_city" = "other"."address_city"',
		);
		expect(mock.delete(users).where(eq(users.address.geo.lat, 1)).returning({ city: users.address.city }).toSQL().sql)
			.toBe('delete from "embed_users" where "embed_users"."address_geo_lat" = $1 returning "address_city"');
	});

	test('aliases reference their own table inside groups', () => {
		const other = alias(users, 'other');
		expect(mock.select({ city: other.address.city }).from(other).toSQL().sql).toBe(
			'select "address_city" from "embed_users" "other"',
		);
		expect(mock.select().from(users).innerJoin(other, eq(other.address.city, users.address.city)).toSQL().sql)
			.toContain('on "other"."address_city" = "embed_users"."address_city"');
	});

	test('rejects a group written as something other than an object', () => {
		expect(() => mock.insert(users).values({ id: 1, name: 'X', address: sql`null` as any })).toThrow(
			'Embedded group "address" in table "embed_users" must be written as an object of its columns',
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
		expect(getTableConfig(cockroachTable('t', definition())).columns.map((column) => column.name)).toEqual([
			'homeAddress_zipCode',
			'street',
		]);
	});

	test('tables without groups are unaffected', () => {
		expect(Object.keys(plain)).toContain('cityId');
		expect(mock.insert(plain).values({ id: 1, cityId: 1 }).toSQL().sql).toBe(
			'insert into "embed_plain" ("id", "cityId") values ($1, $2)',
		);
	});

	test('relational queries select groups under their flat columns', () => {
		const rqb = drizzle.mock({ relations });
		expect(rqb.query.shops.findFirst().toSQL().sql).toContain('"location_city"');
		expect(rqb.query.orders.findMany({ with: { shop: true } }).toSQL().sql).toContain('"delivery_city"');
	});

	test('insert select takes a nested group, a partial group, a callback, and dotted keys', () => {
		expect(
			mock.insert(users).select(
				mock.select({
					address: { city: src.city, geo: { lat: src.lat } },
					name: src.name,
				}).from(src).where(eq(src.name, 'Bob')),
			).toSQL(),
		).toEqual({
			sql:
				'insert into "embed_users" ("address_city", "address_geo_lat", "name") select "city", "lat", "name" from "embed_src" where "embed_src"."name" = $1',
			params: ['Bob'],
		});

		expect(
			mock.insert(users).select(mock.select({ name: src.name, address: { city: src.city } }).from(src)).toSQL().sql,
		).toBe('insert into "embed_users" ("name", "address_city") select "name", "city" from "embed_src"');

		expect(
			mock.insert(users).select((qb) => qb.select({ name: src.name, address: { city: src.city } }).from(src)).toSQL()
				.sql,
		).toBe('insert into "embed_users" ("name", "address_city") select "name", "city" from "embed_src"');

		expect(
			mock.insert(users).select(mock.select({ name: src.name, 'address.city': src.city }).from(src)).toSQL().sql,
		).toBe('insert into "embed_users" ("name", "address_city") select "name", "city" from "embed_src"');

		expect(() => mock.insert(users).select(mock.select({ name: src.name, address: { country: src.city } }).from(src)))
			.toThrow('Insert select error: column "address.country" does not exist in table "embed_users"');

		expect(
			mock.insert(users).select(mock.select({ name: users.name, address: users.address }).from(users)).toSQL().sql,
		).toBe(
			'insert into "embed_users" ("name", "address_street", "address_city", "address_geo_lat", "address_geo_lng") select "name", "address_street", "address_city", "address_geo_lat", "address_geo_lng" from "embed_users"',
		);

		expect(mock.insert(users).select(mock.select().from(users)).toSQL().sql).toBe(
			'insert into "embed_users" ("id", "name", "address_street", "address_city", "address_geo_lat", "address_geo_lng", "billing_zip_code") select "id", "name", "address_street", "address_city", "address_geo_lat", "address_geo_lng", "billing_zip_code" from "embed_users"',
		);

		expect(mock.insert(plain).select(mock.select({ cityId: plain.cityId }).from(plain)).toSQL().sql).toBe(
			'insert into "embed_plain" ("cityId") select "cityId" from "embed_plain"',
		);

		expect(mock.insert(users).select(sql`select 1`).toSQL().sql).toBe(
			'insert into "embed_users" ("id", "name", "address_street", "address_city", "address_geo_lat", "address_geo_lng", "billing_zip_code") select 1',
		);
	});
});

describe.skipIf(!connectionString)('embed', () => {
	let pool: pg.Pool;
	let db: ReturnType<typeof drizzle>;

	beforeAll(async () => {
		pool = new pg.Pool({ connectionString });
		db = drizzle({ client: pool });

		await db.execute(sql`drop table if exists embed_users`);
		await db.execute(sql`drop table if exists embed_plain`);
		await db.execute(sql`
			create table embed_users (
				id int4 primary key,
				name text not null,
				address_street text,
				address_city text not null,
				address_geo_lat int4,
				address_geo_lng int4,
				billing_zip_code text
			)
		`);
		await db.execute(sql`create table embed_plain (id int4 primary key, "cityId" int4)`);
	});

	afterAll(async () => {
		await db.execute(sql`drop table if exists embed_users`);
		await db.execute(sql`drop table if exists embed_plain`);
		await pool.end();
	});

	test('insert takes nested values and returns nested rows', async () => {
		const [inserted] = await db.insert(users).values({
			id: 1,
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

		await db.insert(users).values({ id: 2, name: 'Bob', address: { city: 'Paris' } });

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

	test('on conflict do update takes nested values, and null clears a group', async () => {
		await db.insert(users).values({ id: 1, name: 'Ada', address: { city: 'Berlin' } }).onConflictDoUpdate({
			target: users.id,
			set: { address: { city: 'Hamburg', geo: { lat: 53 } } },
		});
		expect(await db.select({ address: users.address }).from(users).where(eq(users.id, 1))).toEqual([{
			address: { street: 'Main St', city: 'Hamburg', geo: { lat: 53, lng: 13 } },
		}]);

		await db.insert(users).values({ id: 1, name: 'Ada', address: { city: 'Hamburg' } }).onConflictDoUpdate({
			target: users.id,
			set: { address: { city: 'Berlin', geo: { lat: 52 } }, billing: null },
		});
		expect(await db.select({ zip: users.billing.zip }).from(users).where(eq(users.id, 1))).toEqual([{ zip: null }]);
	});

	test('update sets nested values, and null clears a group', async () => {
		const [updated] = await db.update(users)
			.set({ address: { city: 'Rome', geo: null }, billing: { zip: '00100' } })
			.where(eq(users.id, 1))
			.returning({ id: users.id, address: users.address });

		expect(updated).toEqual({
			id: 1,
			address: { street: 'Main St', city: 'Rome', geo: { lat: null, lng: null } },
		});

		await db.update(users).set({ billing: null }).where(eq(users.id, 1));
		expect(await db.select({ zip: users.billing.zip }).from(users).where(eq(users.id, 1))).toEqual([{ zip: null }]);
	});

	test('update from joins on a column inside a group', async () => {
		const other = alias(users, 'other');
		const rows = await db.update(users)
			.set({ name: 'Bob2' })
			.from(other)
			.where(eq(users.id, 2))
			.returning({ name: users.name });
		expect(rows).toEqual([{ name: 'Bob2' }]);
	});

	test('partial selects can pick a group or a column inside one', async () => {
		const rows = await db.select({ name: users.name, address: users.address, lat: users.address.geo.lat })
			.from(users)
			.where(eq(users.id, 2));

		expect(rows).toEqual([{
			name: 'Bob2',
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
			embed_users: {
				id: 2,
				name: 'Bob2',
				address: { street: null, city: 'Paris', geo: { lat: null, lng: null } },
				billing: { zip: null },
			},
			other: null,
		}]);
	});

	test('delete returns nested rows', async () => {
		const [deleted] = await db.delete(users).where(eq(users.id, 2)).returning();
		expect(deleted).toEqual({
			id: 2,
			name: 'Bob2',
			address: { street: null, city: 'Paris', geo: { lat: null, lng: null } },
			billing: { zip: null },
		});
	});

	test('nests a selected table in subqueries', async () => {
		await db.insert(users).values({ id: 3, name: 'Sub', address: { city: 'Lyon', geo: { lat: 4 } } });
		const sq = db.select({ user: users }).from(users).where(eq(users.name, 'Sub')).as('sq');

		expect(sq.user.address.geo.lat.name).toBe('address_geo_lat');
		const rows = await db.select({ city: sq.user.address.city, lat: sq.user.address.geo.lat }).from(sq);
		expect(rows).toStrictEqual([{ city: 'Lyon', lat: 4 }]);
	});

	test('insert select writes the nested selection', async () => {
		await db.execute(sql`drop table if exists embed_src`);
		await db.execute(sql`create table embed_src (name text not null, city text not null, lat int4)`);
		await db.insert(src).values({ name: 'Dst', city: 'Lyon', lat: 4 });

		await db.insert(users).select(
			db.select({
				id: sql<number>`4`,
				address: { city: src.city, geo: { lat: src.lat } },
				name: src.name,
			}).from(src),
		);

		expect(await db.select().from(users).where(eq(users.id, 4))).toEqual([{
			id: 4,
			name: 'Dst',
			address: { street: null, city: 'Lyon', geo: { lat: 4, lng: null } },
			billing: { zip: null },
		}]);

		await db.delete(users).where(eq(users.id, 4));
		await db.execute(sql`drop table embed_src`);
	});
});

describe.skipIf(!connectionString).each([
	{ jit: false },
	{ jit: true },
])('embed in relational queries (jit: $jit)', ({ jit }) => {
	let pool: pg.Pool;
	let rqb: ReturnType<typeof drizzle<typeof relations>>;

	beforeAll(async () => {
		pool = new pg.Pool({ connectionString });
		rqb = drizzle({ client: pool, relations, jit });

		await rqb.execute(sql`drop table if exists embed_orders`);
		await rqb.execute(sql`drop table if exists embed_shops`);
		await rqb.execute(sql`
			create table embed_shops (id int4 primary key, location_city text not null, location_geo_lat int4)
		`);
		await rqb.execute(sql`
			create table embed_orders (id int4 primary key, "shopId" int4 not null, delivery_city text)
		`);
		await rqb.insert(shops).values({ id: 1, location: { city: 'Berlin', geo: { lat: 52 } } });
		await rqb.insert(orders).values([{ id: 1, shopId: 1, delivery: { city: 'Potsdam' } }, { id: 2, shopId: 1 }]);
	});

	afterAll(async () => {
		await rqb.execute(sql`drop table if exists embed_orders`);
		await rqb.execute(sql`drop table if exists embed_shops`);
		await pool.end();
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

	test('columns, where and orderBy take groups nested', async () => {
		expect(
			await rqb.query.shops.findFirst({
				columns: { location: { geo: true } },
				where: { location: { city: 'Berlin', geo: { lat: { gt: 0 } } } },
				with: {
					orders: {
						columns: { delivery: true },
						where: { delivery: { city: { isNotNull: true } } },
					},
				},
			}),
		).toEqual({ location: { geo: { lat: 52 } }, orders: [{ delivery: { city: 'Potsdam' } }] });

		expect(
			await rqb.query.orders.findMany({
				columns: { 'delivery.city': true },
				where: { shop: { location: { city: 'Berlin' } } },
				orderBy: { delivery: { city: 'asc' } },
			}),
		).toEqual(
			// unlike Postgres, CockroachDB sorts nulls first in ascending order
			[{ delivery: { city: null } }, { delivery: { city: 'Potsdam' } }],
		);
	});
});
