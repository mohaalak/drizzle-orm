import { SqliteClient } from '@effect/sql-sqlite-node';
import { createClient } from '@libsql/client';
import Database from 'better-sqlite3';
import * as Effect from 'effect/Effect';
import { beforeAll, describe, expect, test } from 'vitest';
import { drizzle } from '~/better-sqlite3';
import * as EffectSQLite from '~/effect-sqlite-node';
import { drizzle as drizzleLibsql } from '~/libsql';
import { defineRelations } from '~/relations';
import { asc, eq, sql } from '~/sql';
import { alias, camelCase, embed, getTableConfig, index, integer, snakeCase, sqliteTable, text } from '~/sqlite-core';

const users = sqliteTable('users', {
	id: integer().primaryKey({ autoIncrement: true }),
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

const src = sqliteTable('src_embed', {
	name: text().notNull(),
	city: text().notNull(),
	lat: integer(),
});

const createUsers = `
	create table users (
		id integer primary key autoincrement,
		name text not null,
		address_street text,
		address_city text not null,
		address_geo_lat integer,
		address_geo_lng integer,
		billing_zip_code text
	)
`;

const db = drizzle({ client: new Database(':memory:') });

beforeAll(() => {
	db.run(sql.raw(createUsers));
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
			'select "id", "name", "address_street", "address_city", "address_geo_lat", "address_geo_lng", "billing_zip_code" from "users" where "users"."address_city" = ?',
		);
	});

	test('insert takes nested values and returns nested rows', () => {
		const [inserted] = db.insert(users).values({
			name: 'Ada',
			address: { street: 'Main St', city: 'Berlin', geo: { lat: 52, lng: 13 } },
			billing: { zip: '10115' },
		}).returning().all();

		expect(inserted).toEqual({
			id: 1,
			name: 'Ada',
			address: { street: 'Main St', city: 'Berlin', geo: { lat: 52, lng: 13 } },
			billing: { zip: '10115' },
		});

		db.insert(users).values({ name: 'Bob', address: { city: 'Paris' } }).run();

		const rows = db.select().from(users).orderBy(asc(users.id)).all();
		expect(rows).toEqual([
			inserted,
			{
				id: 2,
				name: 'Bob',
				address: { street: null, city: 'Paris', geo: { lat: null, lng: null } },
				billing: { zip: null },
			},
		]);
		expect(db.select().from(users).where(eq(users.id, 2)).get()).toEqual(rows[1]);
	});

	test('update sets nested values, and null clears a group', () => {
		const [updated] = db.update(users)
			.set({ address: { city: 'Rome', geo: null }, billing: null })
			.where(eq(users.id, 1))
			.returning({ id: users.id, address: users.address })
			.all();

		expect(updated).toEqual({
			id: 1,
			address: { street: 'Main St', city: 'Rome', geo: { lat: null, lng: null } },
		});
		expect(db.select({ zip: users.billing.zip }).from(users).where(eq(users.id, 1)).all()).toEqual([{ zip: null }]);
	});

	test('upsert sets nested values on conflict', () => {
		const [upserted] = db.insert(users)
			.values({ id: 2, name: 'Bob', address: { city: 'Oslo' } })
			.onConflictDoUpdate({ target: users.id, set: { address: { city: 'Madrid', geo: { lat: 40 } } } })
			.returning({ address: users.address })
			.all();

		expect(upserted).toEqual({ address: { street: null, city: 'Madrid', geo: { lat: 40, lng: null } } });
	});

	test('delete returns nested rows and orderBy reaches into groups', () => {
		db.insert(users).values({ name: 'Cy', address: { city: 'Zurich' } }).run();
		const [deleted] = db.delete(users).where(eq(users.address.city, 'Zurich')).returning({ address: users.address })
			.all();
		expect(deleted).toEqual({ address: { street: null, city: 'Zurich', geo: { lat: null, lng: null } } });

		expect(
			db.select({ id: users.id }).from(users).orderBy(asc(users.address.city)).all(),
		).toEqual([{ id: 2 }, { id: 1 }]);
		expect(
			db.update(users).set({ name: 'Ada L' }).where(eq(users.id, 1)).orderBy((t) => t.address.city).limit(1)
				.returning({ name: users.name }).all(),
		).toEqual([{ name: 'Ada L' }]);
	});

	test('partial selects can pick a group or a column inside one', () => {
		const rows = db.select({ name: users.name, address: users.address, lat: users.address.geo.lat })
			.from(users)
			.where(eq(users.id, 2))
			.all();

		expect(rows).toEqual([{
			name: 'Bob',
			address: { street: null, city: 'Madrid', geo: { lat: 40, lng: null } },
			lat: 40,
		}]);
	});

	test('joins nest groups under the table, and a missing joined row is null', () => {
		const other = alias(users, 'other');
		const rows = db.select().from(users)
			.leftJoin(other, eq(other.address.city, sql`'Nowhere'`))
			.where(eq(users.id, 2))
			.all();

		expect(rows).toEqual([{
			users: {
				id: 2,
				name: 'Bob',
				address: { street: null, city: 'Madrid', geo: { lat: 40, lng: null } },
				billing: { zip: null },
			},
			other: null,
		}]);
	});

	test('update from a joined table can reference groups', () => {
		const other = alias(users, 'other');
		expect(
			db.update(users).set({ name: 'x' }).from(other).where(eq(other.address.city, users.address.city)).toSQL().sql,
		).toBe('update "users" set "name" = ? from "users" "other" where "other"."address_city" = "users"."address_city"');
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
		expect(getTableConfig(sqliteTable('t', definition())).columns.map((column) => column.name)).toEqual([
			'homeAddress_zipCode',
			'street',
		]);
	});

	test('tables without groups are unaffected', () => {
		const plain = sqliteTable('plain', { id: integer().primaryKey(), cityId: integer() });
		expect(Object.keys(plain)).toContain('cityId');
		expect(db.insert(plain).values({ cityId: 1 }).toSQL().sql).toBe(
			'insert into "plain" ("id", "cityId") values (null, ?)',
		);
	});

	test('insert select takes a nested group, a partial group, a callback, and dotted keys', () => {
		expect(
			db.insert(users).select(
				db.select({
					address: { city: src.city, geo: { lat: src.lat } },
					name: src.name,
				}).from(src).where(eq(src.name, 'Bob')),
			).toSQL(),
		).toEqual({
			sql:
				'insert into "users" ("address_city", "address_geo_lat", "name") select "city", "lat", "name" from "src_embed" where "src_embed"."name" = ?',
			params: ['Bob'],
		});

		expect(db.insert(users).select(db.select({ name: src.name, address: { city: src.city } }).from(src)).toSQL().sql)
			.toBe('insert into "users" ("name", "address_city") select "name", "city" from "src_embed"');

		expect(
			db.insert(users).select((qb) => qb.select({ name: src.name, address: { city: src.city } }).from(src)).toSQL()
				.sql,
		).toBe('insert into "users" ("name", "address_city") select "name", "city" from "src_embed"');

		expect(db.insert(users).select(db.select({ name: src.name, 'address.city': src.city }).from(src)).toSQL().sql)
			.toBe('insert into "users" ("name", "address_city") select "name", "city" from "src_embed"');

		expect(() => db.insert(users).select(db.select({ name: src.name, address: { country: src.city } }).from(src)))
			.toThrow('Insert select error: column "address.country" does not exist in table "users"');

		expect(db.insert(users).select(db.select({ name: users.name, address: users.address }).from(users)).toSQL().sql)
			.toBe(
				'insert into "users" ("name", "address_street", "address_city", "address_geo_lat", "address_geo_lng") select "name", "address_street", "address_city", "address_geo_lat", "address_geo_lng" from "users"',
			);

		expect(db.insert(users).select(db.select().from(users)).toSQL().sql).toBe(
			'insert into "users" ("id", "name", "address_street", "address_city", "address_geo_lat", "address_geo_lng", "billing_zip_code") select "id", "name", "address_street", "address_city", "address_geo_lat", "address_geo_lng", "billing_zip_code" from "users"',
		);

		const plain = sqliteTable('plain_embed', { id: integer().primaryKey(), cityId: integer() });
		expect(db.insert(plain).select(db.select({ cityId: plain.cityId }).from(plain)).toSQL().sql).toBe(
			'insert into "plain_embed" ("cityId") select "cityId" from "plain_embed"',
		);

		expect(db.insert(users).select(sql`select 1`).toSQL().sql).toBe(
			'insert into "users" ("id", "name", "address_street", "address_city", "address_geo_lat", "address_geo_lng", "billing_zip_code") select 1',
		);
	});

	test('insert select writes the nested selection', () => {
		db.run(sql`drop table if exists src_embed`);
		db.run(sql`create table src_embed (name text not null, city text not null, lat integer)`);
		db.insert(src).values({ name: 'Dst', city: 'Madrid', lat: 40 }).run();

		db.insert(users).select(
			db.select({
				address: { city: src.city, geo: { lat: src.lat } },
				name: src.name,
			}).from(src),
		).run();

		expect(
			db.select({ name: users.name, address: users.address }).from(users).where(eq(users.name, 'Dst')).all(),
		).toEqual([{
			name: 'Dst',
			address: { street: null, city: 'Madrid', geo: { lat: 40, lng: null } },
		}]);

		db.delete(users).where(eq(users.name, 'Dst')).run();
		db.run(sql`drop table src_embed`);
	});
});

describe('embed with an async driver', () => {
	const asyncDb = drizzleLibsql({ client: createClient({ url: ':memory:' }) });

	beforeAll(async () => {
		await asyncDb.run(sql.raw(createUsers));
	});

	test('insert, select, update and returning nest groups', async () => {
		const [inserted] = await asyncDb.insert(users).values({
			name: 'Ada',
			address: { street: 'Main St', city: 'Berlin', geo: { lat: 52, lng: 13 } },
		}).returning();
		expect(inserted).toEqual({
			id: 1,
			name: 'Ada',
			address: { street: 'Main St', city: 'Berlin', geo: { lat: 52, lng: 13 } },
			billing: { zip: null },
		});

		const [updated] = await asyncDb.update(users).set({ address: { geo: null } }).returning({ address: users.address });
		expect(updated).toEqual({
			address: { street: 'Main St', city: 'Berlin', geo: { lat: null, lng: null } },
		});

		expect(await asyncDb.select({ city: users.address.city }).from(users)).toEqual([{ city: 'Berlin' }]);
	});
});

const shops = sqliteTable('shops', {
	id: integer().primaryKey({ autoIncrement: true }),
	location: embed({ city: text().notNull(), geo: embed({ lat: integer() }) }),
});

const orders = sqliteTable('orders', {
	id: integer().primaryKey({ autoIncrement: true }),
	shopId: integer().notNull(),
	delivery: embed({ city: text() }),
});

const relations = defineRelations({ shops, orders }, (r) => ({
	shops: { orders: r.many.orders({ from: r.shops.id, to: r.orders.shopId }) },
	orders: { shop: r.one.shops({ from: r.orders.shopId, to: r.shops.id, optional: false }) },
}));

const expectRelational = async (
	rqb: { query: any },
	run: <T>(query: any) => Promise<T>,
) => {
	expect(await run(rqb.query.shops.findFirst())).toEqual({
		id: 1,
		location: { city: 'Berlin', geo: { lat: 52 } },
	});

	const shop = await run(rqb.query.shops.findFirst({ with: { orders: { orderBy: { id: 'asc' } } } }));
	expect(shop).toEqual({
		id: 1,
		location: { city: 'Berlin', geo: { lat: 52 } },
		orders: [
			{ id: 1, shopId: 1, delivery: { city: 'Potsdam' } },
			{ id: 2, shopId: 1, delivery: { city: null } },
		],
	});

	const order = await run(rqb.query.orders.findMany({ with: { shop: true }, orderBy: { id: 'asc' }, limit: 1 }));
	expect(order).toEqual([{
		id: 1,
		shopId: 1,
		delivery: { city: 'Potsdam' },
		shop: { id: 1, location: { city: 'Berlin', geo: { lat: 52 } } },
	}]);
};

describe.each([
	{ jit: false },
	{ jit: true },
])('embed in relational queries (jit: $jit)', ({ jit }) => {
	const rqb = drizzle({ client: new Database(':memory:'), relations, jit });

	beforeAll(() => {
		rqb.run(
			sql`create table shops (id integer primary key autoincrement, location_city text not null, location_geo_lat integer)`,
		);
		rqb.run(
			sql`create table orders (id integer primary key autoincrement, "shopId" integer not null, delivery_city text)`,
		);
		rqb.insert(shops).values({ location: { city: 'Berlin', geo: { lat: 52 } } }).run();
		rqb.insert(orders).values([{ shopId: 1, delivery: { city: 'Potsdam' } }, { shopId: 1 }]).run();
	});

	test('nests groups in the rows it reads and in loaded relations', async () => {
		await expectRelational(rqb, (query) => Promise.resolve(query));
	});

	test('columns, where and orderBy take groups nested', async () => {
		expect(
			await rqb.query.shops.findFirst({
				columns: { location: { geo: true } },
				where: { location: { city: 'Berlin', geo: { lat: { gt: 0 } } } },
				with: { orders: { columns: { delivery: true }, where: { delivery: { city: { isNotNull: true } } } } },
			}),
		).toEqual({ location: { geo: { lat: 52 } }, orders: [{ delivery: { city: 'Potsdam' } }] });

		expect(
			await rqb.query.orders.findMany({
				columns: { 'delivery.city': true },
				where: { shop: { location: { city: 'Berlin' } } },
				orderBy: { delivery: { city: 'asc' } },
			}),
		).toEqual([{ delivery: { city: null } }, { delivery: { city: 'Potsdam' } }]);
	});

	test('sync execution nests groups', () => {
		expect(rqb.query.shops.findFirst().sync()).toEqual({
			id: 1,
			location: { city: 'Berlin', geo: { lat: 52 } },
		});
	});
});

describe('embed in relational queries with an async driver', () => {
	const rqb = drizzleLibsql({ client: createClient({ url: ':memory:' }), relations });

	beforeAll(async () => {
		await rqb.run(
			sql`create table shops (id integer primary key autoincrement, location_city text not null, location_geo_lat integer)`,
		);
		await rqb.run(
			sql`create table orders (id integer primary key autoincrement, "shopId" integer not null, delivery_city text)`,
		);
		await rqb.insert(shops).values({ location: { city: 'Berlin', geo: { lat: 52 } } });
		await rqb.insert(orders).values([{ shopId: 1, delivery: { city: 'Potsdam' } }, { shopId: 1 }]);
	});

	test('nests groups in the rows it reads and in loaded relations', async () => {
		await expectRelational(rqb, (query) => query);
	});
});

describe('embed with the effect driver', () => {
	const program = Effect.gen(function*() {
		const effectDb = yield* EffectSQLite.make({ relations });
		yield* effectDb.run(
			sql`create table shops (id integer primary key autoincrement, location_city text not null, location_geo_lat integer)`,
		);
		yield* effectDb.run(
			sql`create table orders (id integer primary key autoincrement, "shopId" integer not null, delivery_city text)`,
		);
		yield* effectDb.insert(shops).values({ location: { city: 'Berlin', geo: { lat: 52 } } });
		yield* effectDb.insert(orders).values([{ shopId: 1, delivery: { city: 'Potsdam' } }, { shopId: 1 }]);

		const [updated] = yield* effectDb.update(shops).set({ location: { geo: null } }).returning();
		const selected = yield* effectDb.select({ city: shops.location.city }).from(shops);
		const shop = yield* effectDb.query.shops.findFirst({ with: { orders: { orderBy: { id: 'asc' } } } });
		return { updated, selected, shop };
	}).pipe(
		Effect.provide(EffectSQLite.DefaultServices),
		Effect.provide(SqliteClient.layer({ filename: ':memory:' })),
		Effect.scoped,
	);

	test('nests groups in builders and relational queries', async () => {
		const { updated, selected, shop } = await Effect.runPromise(program);

		expect(updated).toEqual({ id: 1, location: { city: 'Berlin', geo: { lat: null } } });
		expect(selected).toEqual([{ city: 'Berlin' }]);
		expect(shop).toEqual({
			id: 1,
			location: { city: 'Berlin', geo: { lat: null } },
			orders: [
				{ id: 1, shopId: 1, delivery: { city: 'Potsdam' } },
				{ id: 2, shopId: 1, delivery: { city: null } },
			],
		});
	});
});
