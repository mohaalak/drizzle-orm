import { MysqlClient } from '@effect/sql-mysql2';
import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';
import { createPool, type Pool } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import * as MySqlDrizzle from '~/effect-mysql2';
import {
	alias,
	camelCase,
	embed,
	getTableConfig,
	index,
	int,
	mysqlTable,
	serial,
	snakeCase,
	text,
	varchar,
} from '~/mysql-core';
import { drizzle } from '~/mysql2';
import { defineRelations } from '~/relations';
import { asc, eq, sql } from '~/sql';

// These tests run against a real MySQL server: set MYSQL_CONNECTION_STRING, for example
// `mysql://root:mysql@127.0.0.1:33306/drizzle` for `docker run -e MYSQL_ROOT_PASSWORD=mysql -e MYSQL_DATABASE=drizzle -p 33306:3306 mysql:8`.
const connectionString = process.env['MYSQL_CONNECTION_STRING'];

const users = mysqlTable('embed_users', {
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

const plain = mysqlTable('embed_plain', { id: serial().primaryKey(), cityId: int() });

const shops = mysqlTable('embed_shops', {
	id: serial().primaryKey(),
	location: embed({ city: varchar({ length: 100 }).notNull(), geo: embed({ lat: int() }) }),
});

const orders = mysqlTable('embed_orders', {
	id: serial().primaryKey(),
	shopId: int().notNull(),
	delivery: embed({ city: varchar({ length: 100 }) }),
});

const relations = defineRelations({ shops, orders }, (r) => ({
	shops: { orders: r.many.orders({ from: r.shops.id, to: r.orders.shopId }) },
	orders: { shop: r.one.shops({ from: r.orders.shopId, to: r.shops.id, optional: false }) },
}));

describe.skipIf(!connectionString)('embed', () => {
	let pool: Pool;
	let db: ReturnType<typeof drizzle>;

	beforeAll(async () => {
		pool = createPool({ uri: connectionString! });
		db = drizzle({ client: pool });

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
		await pool.end();
	});

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
			'select cast(`id` as char), `name`, `address_street`, `address_city`, `address_geo_lat`, `address_geo_lng`, `billing_zip_code` from `embed_users` where `embed_users`.`address_city` = ?',
		);
	});

	test('insert takes nested values, and select returns nested rows', async () => {
		const [inserted] = await db.insert(users).values({
			name: 'Ada',
			address: { street: 'Main St', city: 'Berlin', geo: { lat: 52, lng: 13 } },
			billing: { zip: '10115' },
		}).$returningId();
		expect(inserted).toStrictEqual({ id: 1 });

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

	test('update orders by a column inside a group', () => {
		expect(
			db.update(users).set({ name: 'x' }).orderBy((t) => t.address.city).limit(1).toSQL().sql,
		).toBe('update `embed_users` set `name` = ? order by `embed_users`.`address_city` limit ?');
		expect(db.delete(users).orderBy((t) => t.address.city).limit(1).toSQL().sql).toBe(
			'delete from `embed_users` order by `embed_users`.`address_city` limit ?',
		);
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
		expect(getTableConfig(mysqlTable('t', definition())).columns.map((column) => column.name)).toEqual([
			'homeAddress_zipCode',
			'street',
		]);
	});

	test('tables without groups are unaffected', async () => {
		expect(Object.keys(plain)).toContain('cityId');
		expect(db.insert(plain).values({ cityId: 1 }).toSQL().sql).toBe(
			'insert into `embed_plain` (`id`, `cityId`) values (default, ?)',
		);
		await db.insert(plain).values({ cityId: 7 });
		expect(await db.select().from(plain)).toEqual([{ id: 1, cityId: 7 }]);
	});
});

describe.skipIf(!connectionString).each([
	{ jit: false },
	{ jit: true },
])('embed in relational queries (jit: $jit)', ({ jit }) => {
	let pool: Pool;
	const connect = (client: Pool) => drizzle({ client, relations, jit });
	let rqb: ReturnType<typeof connect>;

	beforeAll(async () => {
		pool = createPool({ uri: connectionString! });
		rqb = connect(pool);

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
});

describe.skipIf(!connectionString)('embed in the effect driver', () => {
	const run = <A, E>(effect: Effect.Effect<A, E, MysqlClient.MysqlClient>) =>
		Effect.runPromise(
			effect.pipe(
				Effect.scoped,
				Effect.provide(MysqlClient.layer({ url: Redacted.make(connectionString!) })),
			),
		);

	test('inserts, selects and queries relations with nested groups', async () => {
		const result = await run(Effect.gen(function*() {
			const db = yield* MySqlDrizzle.make({ relations }).pipe(Effect.provide(MySqlDrizzle.DefaultServices));

			yield* db.execute(sql`drop table if exists embed_orders`);
			yield* db.execute(sql`drop table if exists embed_shops`);
			yield* db.execute(sql`
				create table embed_shops (id serial primary key, location_city varchar(100) not null, location_geo_lat int)
			`);
			yield* db.execute(sql`
				create table embed_orders (id serial primary key, shopId int not null, delivery_city varchar(100))
			`);
			yield* db.insert(shops).values({ location: { city: 'Berlin', geo: { lat: 52 } } });
			yield* db.insert(orders).values([{ shopId: 1, delivery: { city: 'Potsdam' } }, { shopId: 1 }]);
			yield* db.update(shops).set({ location: { geo: null } });

			const selected = yield* db.select().from(shops);
			const queried = yield* db.query.orders.findMany({ with: { shop: true }, orderBy: { id: 'asc' } });

			yield* db.execute(sql`drop table embed_orders`);
			yield* db.execute(sql`drop table embed_shops`);
			return { selected, queried };
		}));

		expect(result.selected).toEqual([{ id: 1, location: { city: 'Berlin', geo: { lat: null } } }]);
		expect(result.queried).toEqual([
			{
				id: 1,
				shopId: 1,
				delivery: { city: 'Potsdam' },
				shop: { id: 1, location: { city: 'Berlin', geo: { lat: null } } },
			},
			{
				id: 2,
				shopId: 1,
				delivery: { city: null },
				shop: { id: 1, location: { city: 'Berlin', geo: { lat: null } } },
			},
		]);
	});
});
