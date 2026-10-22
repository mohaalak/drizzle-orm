import { type Connection, createConnection } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { defineRelations } from '~/relations';
import { drizzle, type SingleStoreDriverDatabase } from '~/singlestore';
import {
	alias,
	camelCase,
	embed,
	getTableConfig,
	index,
	int,
	serial,
	singlestoreTable,
	snakeCase,
	text,
	varchar,
} from '~/singlestore-core';
import { asc, eq, sql } from '~/sql';

// Tests that execute queries run against a real SingleStore server: set SINGLESTORE_CONNECTION_STRING, for example
// `singlestore://root:singlestore@127.0.0.1:33307` (the `drizzle` database is created when missing).
// The `toSQL()` tests need no database.
const connectionString = process.env['SINGLESTORE_CONNECTION_STRING'];

const users = singlestoreTable('embed_users', {
	id: serial().primaryKey(),
	name: varchar({ length: 100 }).notNull(),
	address: embed({
		street: varchar({ length: 100 }),
		city: varchar({ length: 100 }).notNull(),
		geo: embed({
			lat: int(),
			lng: int(),
		}),
	}),
	billing: embed({
		zip: varchar('billing_zip_code', { length: 20 }),
	}, { prefix: 'bill_' }),
}, (t) => [index('embed_users_city_idx').on(t.address.city)]);

const plain = singlestoreTable('embed_plain', { id: serial().primaryKey(), cityId: int() });

const shops = singlestoreTable('embed_shops', {
	id: serial().primaryKey(),
	location: embed({ city: varchar({ length: 100 }).notNull(), geo: embed({ lat: int() }) }),
});

const orders = singlestoreTable('embed_orders', {
	id: serial().primaryKey(),
	shopId: int().notNull(),
	delivery: embed({ city: varchar({ length: 100 }) }),
});

const relations = defineRelations({ shops, orders }, (r) => ({
	shops: { orders: r.many.orders({ from: r.shops.id, to: r.orders.shopId }) },
	orders: { shop: r.one.shops({ from: r.orders.shopId, to: r.shops.id, optional: false }) },
}));

describe('embed (no database)', () => {
	const db = drizzle.mock();

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
		expect(users.billing.zip.name).toBe('billing_zip_code');
		expect(db.select().from(users).where(eq(users.address.city, 'Berlin')).toSQL().sql).toBe(
			'select cast(`id` as char), `name`, `address_street`, `address_city`, `address_geo_lat`, `address_geo_lng`, `billing_zip_code` from `embed_users` where `embed_users`.`address_city` = ?',
		);
	});

	test('insert flattens nested values', () => {
		const query = db.insert(users).values({
			name: 'Ada',
			address: { street: 'Main St', city: 'Berlin', geo: { lat: 52 } },
		}).toSQL();
		expect(query.sql).toBe(
			'insert into `embed_users` (`id`, `name`, `address_street`, `address_city`, `address_geo_lat`, `address_geo_lng`, `billing_zip_code`) values (default, ?, ?, ?, ?, default, default)',
		);
		expect(query.params).toEqual(['Ada', 'Main St', 'Berlin', 52]);
	});

	test('on duplicate key update takes nested values, and null clears a group', () => {
		const query = db.insert(users).values({ id: 1, name: 'Ada', address: { city: 'Berlin' } }).onDuplicateKeyUpdate({
			set: { address: { city: 'Hamburg', geo: { lat: 53 } }, billing: null },
		}).toSQL();
		expect(query.sql).toBe(
			'insert into `embed_users` (`id`, `name`, `address_street`, `address_city`, `address_geo_lat`, `address_geo_lng`, `billing_zip_code`) values (?, ?, default, ?, default, default, default) on duplicate key update `address_city` = ?, `address_geo_lat` = ?, `billing_zip_code` = ?',
		);
		expect(query.params).toEqual([1, 'Ada', 'Berlin', 'Hamburg', 53, null]);
	});

	test('update sets nested values, and null clears a group', () => {
		const query = db.update(users)
			.set({ address: { city: 'Rome', geo: null }, billing: null })
			.where(eq(users.id, 1))
			.toSQL();
		expect(query.sql).toBe(
			'update `embed_users` set `address_city` = ?, `address_geo_lat` = ?, `address_geo_lng` = ?, `billing_zip_code` = ? where `embed_users`.`id` = ?',
		);
		expect(query.params).toEqual(['Rome', null, null, null, 1]);
	});

	test('update orders by a column inside a group', () => {
		expect(
			db.update(users).set({ name: 'x' }).orderBy((t) => t.address.city).limit(1).toSQL().sql,
		).toBe('update `embed_users` set `name` = ? order by `embed_users`.`address_city` limit ?');
		expect(db.delete(users).orderBy((t) => t.address.city).limit(1).toSQL().sql).toBe(
			'delete from `embed_users` order by `embed_users`.`address_city` limit ?',
		);
	});

	test('aliases reference their own table inside groups', () => {
		const other = alias(users, 'other');
		expect(db.select({ city: other.address.city }).from(other).toSQL().sql).toBe(
			'select `address_city` from `embed_users` `other`',
		);
		expect(db.select().from(users).innerJoin(other, eq(other.address.city, users.address.city)).toSQL().sql)
			.toContain('on `other`.`address_city` = `embed_users`.`address_city`');
	});

	test('rejects a group written as something other than an object', () => {
		expect(() => db.insert(users).values({ name: 'X', address: sql`null` as any })).toThrow(
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
		expect(getTableConfig(singlestoreTable('t', definition())).columns.map((column) => column.name)).toEqual([
			'homeAddress_zipCode',
			'street',
		]);
	});

	test('tables without groups are unaffected', () => {
		expect(Object.keys(plain)).toContain('cityId');
		expect(db.insert(plain).values({ cityId: 1 }).toSQL().sql).toBe(
			'insert into `embed_plain` (`id`, `cityId`) values (default, ?)',
		);
	});
});

async function connect(): Promise<Connection> {
	const connection = await createConnection({ uri: connectionString!, supportBigNumbers: true });
	await connection.query('create database if not exists drizzle');
	await connection.changeUser({ database: 'drizzle' });
	return connection;
}

describe.skipIf(!connectionString)('embed', () => {
	let client: Connection;
	let db: SingleStoreDriverDatabase;

	beforeAll(async () => {
		client = await connect();
		db = drizzle({ client });

		await db.execute(sql`drop table if exists embed_users`);
		await db.execute(sql`drop table if exists embed_plain`);
		await db.execute(sql`
			create table embed_users (
				id serial primary key,
				name varchar(100) not null,
				address_street varchar(100),
				address_city varchar(100) not null,
				address_geo_lat int,
				address_geo_lng int,
				billing_zip_code varchar(20)
			)
		`);
		await db.execute(sql`create table embed_plain (id serial primary key, cityId int)`);
	});

	afterAll(async () => {
		await db.execute(sql`drop table if exists embed_users`);
		await db.execute(sql`drop table if exists embed_plain`);
		await client.end();
	});

	test('insert takes nested values, and select returns nested rows', async () => {
		const [created] = await db.insert(users).values({
			name: 'Ada',
			address: { street: 'Main St', city: 'Berlin', geo: { lat: 52, lng: 13 } },
			billing: { zip: '10115' },
		}).$returningId();
		expect(created!.id).toBe(1);

		await db.insert(users).values({ name: 'Bob', address: { city: 'Paris' } });

		const rows = await db.select().from(users).orderBy(asc(users.id));
		expect(rows).toEqual([
			{
				id: 1,
				name: 'Ada',
				address: { street: 'Main St', city: 'Berlin', geo: { lat: 52, lng: 13 } },
				billing: { zip: '10115' },
			},
			{
				id: 2,
				name: 'Bob',
				address: { street: null, city: 'Paris', geo: { lat: null, lng: null } },
				billing: { zip: null },
			},
		]);
	});

	test('on duplicate key update takes nested values, and null clears a group', async () => {
		await db.insert(users).values({ id: 1, name: 'Ada', address: { city: 'Berlin' } }).onDuplicateKeyUpdate({
			set: { address: { city: 'Hamburg', geo: { lat: 53 } } },
		});
		expect(await db.select({ address: users.address }).from(users).where(eq(users.id, 1))).toEqual([{
			address: { street: 'Main St', city: 'Hamburg', geo: { lat: 53, lng: 13 } },
		}]);

		await db.insert(users).values({ id: 1, name: 'Ada', address: { city: 'Hamburg' } }).onDuplicateKeyUpdate({
			set: { address: { city: 'Berlin', geo: { lat: 52 } }, billing: null },
		});
		expect(await db.select({ zip: users.billing.zip }).from(users).where(eq(users.id, 1))).toEqual([{ zip: null }]);
	});

	test('update sets nested values, and null clears a group', async () => {
		await db.update(users)
			.set({ address: { city: 'Rome', geo: null }, billing: { zip: '00100' } })
			.where(eq(users.id, 1));

		expect(await db.select({ id: users.id, address: users.address }).from(users).where(eq(users.id, 1))).toEqual([{
			id: 1,
			address: { street: 'Main St', city: 'Rome', geo: { lat: null, lng: null } },
		}]);

		await db.update(users).set({ billing: null }).where(eq(users.id, 1));
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
			embed_users: {
				id: 2,
				name: 'Bob',
				address: { street: null, city: 'Paris', geo: { lat: null, lng: null } },
				billing: { zip: null },
			},
			other: null,
		}]);
	});

	test('tables without groups are unaffected', async () => {
		await db.insert(plain).values({ cityId: 7 });
		expect(await db.select().from(plain)).toEqual([{ id: 1, cityId: 7 }]);
	});
});

describe.skipIf(!connectionString).each([
	{ jit: false },
	{ jit: true },
])('embed in relational queries (jit: $jit)', ({ jit }) => {
	let client: Connection;
	let rqb: SingleStoreDriverDatabase<typeof relations>;

	beforeAll(async () => {
		client = await connect();
		rqb = drizzle({ client, relations, jit });

		await rqb.execute(sql`drop table if exists embed_orders`);
		await rqb.execute(sql`drop table if exists embed_shops`);
		await rqb.execute(sql`
			create table embed_shops (id serial primary key, location_city varchar(100) not null, location_geo_lat int)
		`);
		await rqb.execute(sql`
			create table embed_orders (id serial primary key, shopId int not null, delivery_city varchar(100))
		`);
		await rqb.insert(shops).values({ location: { city: 'Berlin', geo: { lat: 52 } } });
		await rqb.insert(orders).values([{ shopId: 1, delivery: { city: 'Potsdam' } }, { shopId: 1 }]);
	});

	afterAll(async () => {
		await rqb.execute(sql`drop table if exists embed_orders`);
		await rqb.execute(sql`drop table if exists embed_shops`);
		await client.end();
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
			// nulls sort first in ascending order
			[{ delivery: { city: null } }, { delivery: { city: 'Potsdam' } }],
		);
	});
});
