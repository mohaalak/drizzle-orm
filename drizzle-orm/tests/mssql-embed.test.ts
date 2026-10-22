import mssql from 'mssql';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
	alias,
	camelCase,
	embed,
	getTableConfig,
	index,
	int,
	mssqlTable,
	snakeCase,
	text,
	varchar,
} from '~/mssql-core';
import { drizzle } from '~/node-mssql';
import { getMsSqlConnectionParams } from '~/node-mssql/driver';
import { defineRelations } from '~/relations';
import { asc, eq, sql } from '~/sql';

// The tests that run queries need a real SQL Server database: set MSSQL_CONNECTION_STRING, for example
// `mssql://sa:Drizzle_embed1@127.0.0.1:14330/drizzle_embed?encrypt=true&trustServerCertificate=true`
// for `docker run -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD=Drizzle_embed1 -p 14330:1433 mcr.microsoft.com/mssql/server:2022-latest`
// and an existing `drizzle_embed` database. The rest only build SQL.
const connectionString = process.env['MSSQL_CONNECTION_STRING'];

const users = mssqlTable('embed_users', {
	id: int().primaryKey().identity(),
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

const plain = mssqlTable('embed_plain', { id: int().primaryKey().identity(), cityId: int() });

const src = mssqlTable('embed_src', {
	name: varchar({ length: 100 }).notNull(),
	city: varchar({ length: 100 }).notNull(),
	lat: int(),
});

const shops = mssqlTable('embed_shops', {
	id: int().primaryKey().identity(),
	location: embed({ city: varchar({ length: 100 }).notNull(), geo: embed({ lat: int() }) }),
});

const orders = mssqlTable('embed_orders', {
	id: int().primaryKey().identity(),
	shopId: int().notNull(),
	delivery: embed({ city: varchar({ length: 100 }) }),
});

const relations = defineRelations({ shops, orders }, (r) => ({
	shops: { orders: r.many.orders({ from: r.shops.id, to: r.orders.shopId }) },
	orders: { shop: r.one.shops({ from: r.orders.shopId, to: r.shops.id, optional: false }) },
}));

const mock = drizzle.mock({ relations });

describe('embed (query building)', () => {
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
		expect(mock.select().from(users).where(eq(users.address.city, 'Berlin')).toSQL()).toStrictEqual({
			sql:
				'select [id], [name], [address_street], [address_city], [address_geo_lat], [address_geo_lng], [billing_zip_code] from [embed_users] where [embed_users].[address_city] = @par0',
			params: ['Berlin'],
		});
	});

	test('insert flattens nested values', () => {
		expect(
			mock.insert(users).values({ name: 'Ada', address: { city: 'Berlin', geo: { lat: 52 } }, billing: { zip: '1' } })
				.toSQL(),
		).toStrictEqual({
			sql:
				'insert into [embed_users] ([name], [address_street], [address_city], [address_geo_lat], [address_geo_lng], [billing_zip_code]) values (@par0, default, @par1, @par2, default, @par3)',
			params: ['Ada', 'Berlin', 52, '1'],
		});
	});

	test('output reads every column of the groups', () => {
		expect(
			mock.insert(users).output({ zip: users.billing.zip }).values({
				name: 'Ada',
				address: { city: 'Berlin' },
			}).toSQL().sql,
		).toBe(
			'insert into [embed_users] ([name], [address_street], [address_city], [address_geo_lat], [address_geo_lng], [billing_zip_code]) output INSERTED.[billing_zip_code] values (@par0, default, @par1, default, default, default)',
		);
		expect(mock.delete(users).output().toSQL().sql).toBe(
			'delete from [embed_users] output DELETED.[id], DELETED.[name], DELETED.[address_street], DELETED.[address_city], DELETED.[address_geo_lat], DELETED.[address_geo_lng], DELETED.[billing_zip_code]',
		);
		expect(
			mock.update(users).set({ name: 'x' }).output({ deleted: { lat: users.address.geo.lat }, inserted: true }).toSQL()
				.sql,
		).toBe(
			'update [embed_users] set [name] = @par0 output INSERTED.[id], INSERTED.[name], INSERTED.[address_street], INSERTED.[address_city], INSERTED.[address_geo_lat], INSERTED.[address_geo_lng], INSERTED.[billing_zip_code], DELETED.[address_geo_lat]',
		);
	});

	test('output takes a whole group, a nested group, and plain columns', () => {
		expect(
			mock.insert(users).output({ address: users.address }).values({ name: 'Ada', address: { city: 'Berlin' } }).toSQL()
				.sql,
		).toBe(
			'insert into [embed_users] ([name], [address_street], [address_city], [address_geo_lat], [address_geo_lng], [billing_zip_code]) output INSERTED.[address_street], INSERTED.[address_city], INSERTED.[address_geo_lat], INSERTED.[address_geo_lng] values (@par0, default, @par1, default, default, default)',
		);
		expect(
			mock.insert(users).output({ name: users.name, geo: users.address.geo }).values({
				name: 'Ada',
				address: { city: 'Berlin' },
			}).toSQL().sql,
		).toBe(
			'insert into [embed_users] ([name], [address_street], [address_city], [address_geo_lat], [address_geo_lng], [billing_zip_code]) output INSERTED.[name], INSERTED.[address_geo_lat], INSERTED.[address_geo_lng] values (@par0, default, @par1, default, default, default)',
		);
		expect(
			mock.insert(users).output({
				address: { city: users.address.city, geo: users.address.geo },
				label: sql<string>`${users.name}`,
			}).values({ name: 'Ada', address: { city: 'Berlin' } }).toSQL().sql,
		).toBe(
			'insert into [embed_users] ([name], [address_street], [address_city], [address_geo_lat], [address_geo_lng], [billing_zip_code]) output INSERTED.[address_city], INSERTED.[address_geo_lat], INSERTED.[address_geo_lng], INSERTED.[name] values (@par0, default, @par1, default, default, default)',
		);

		expect(mock.delete(users).output({ address: users.address }).toSQL().sql).toBe(
			'delete from [embed_users] output DELETED.[address_street], DELETED.[address_city], DELETED.[address_geo_lat], DELETED.[address_geo_lng]',
		);
		expect(mock.delete(users).output({ name: users.name, geo: users.address.geo }).toSQL().sql).toBe(
			'delete from [embed_users] output DELETED.[name], DELETED.[address_geo_lat], DELETED.[address_geo_lng]',
		);

		expect(
			mock.update(users).set({ name: 'x' }).output({
				inserted: { address: users.address },
				deleted: { geo: users.address.geo, name: users.name },
			}).toSQL().sql,
		).toBe(
			'update [embed_users] set [name] = @par0 output INSERTED.[address_street], INSERTED.[address_city], INSERTED.[address_geo_lat], INSERTED.[address_geo_lng], DELETED.[address_geo_lat], DELETED.[address_geo_lng], DELETED.[name]',
		);
		expect(mock.update(plain).set({ cityId: 1 }).output({ inserted: { cityId: plain.cityId } }).toSQL().sql).toBe(
			'update [embed_plain] set [cityId] = @par0 output INSERTED.[cityId]',
		);
	});

	test('update sets nested values, and null clears a group', () => {
		expect(
			mock.update(users).set({ address: { city: 'Rome', geo: null }, billing: null }).where(eq(users.id, 1)).toSQL(),
		).toStrictEqual({
			sql:
				'update [embed_users] set [address_city] = @par0, [address_geo_lat] = @par1, [address_geo_lng] = @par2, [billing_zip_code] = @par3 where [embed_users].[id] = @par4',
			params: ['Rome', null, null, null, 1],
		});
	});

	test('aliases reference their own table inside groups', () => {
		const other = alias(users, 'other');
		expect(mock.select({ city: other.address.city }).from(other).toSQL().sql).toBe(
			'select [address_city] from [embed_users] [other]',
		);
		expect(mock.select().from(users).innerJoin(other, eq(other.address.city, users.address.city)).toSQL().sql)
			.toContain('on [other].[address_city] = [embed_users].[address_city]');
	});

	test('relational queries select embedded columns by a key SQL Server will not nest', () => {
		const { sql: query } = mock.query.shops.findMany({ with: { orders: true } }).toSQL();
		expect(query).toContain('[d0].[location_city] as [location.city]');
		// `for json path` reads a `.` in an alias as a path: nested rows rename it and nest the rows afterwards
		expect(query).toContain('[d1].[delivery_city] as [delivery→city]');
	});

	test('rejects a group written as something other than an object', () => {
		expect(() => mock.insert(users).values({ name: 'X', address: sql`null` as any })).toThrow(
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
		expect(getTableConfig(mssqlTable('t', definition())).columns.map((column) => column.name)).toEqual([
			'homeAddress_zipCode',
			'street',
		]);
	});

	test('tables without groups are unaffected', () => {
		expect(Object.keys(plain)).toContain('cityId');
		expect(mock.insert(plain).values({ cityId: 1 }).toSQL().sql).toBe(
			'insert into [embed_plain] ([cityId]) values (@par0)',
		);
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
				'insert into [embed_users] ([address_city], [address_geo_lat], [name]) select [city], [lat], [name] from [embed_src] where [embed_src].[name] = @par0',
			params: ['Bob'],
		});

		expect(
			mock.insert(users).select(mock.select({ name: src.name, address: { city: src.city } }).from(src)).toSQL().sql,
		).toBe('insert into [embed_users] ([name], [address_city]) select [name], [city] from [embed_src]');

		expect(
			mock.insert(users).select((qb) => qb.select({ name: src.name, address: { city: src.city } }).from(src)).toSQL()
				.sql,
		).toBe('insert into [embed_users] ([name], [address_city]) select [name], [city] from [embed_src]');

		expect(
			mock.insert(users).select(mock.select({ name: src.name, 'address.city': src.city }).from(src)).toSQL().sql,
		).toBe('insert into [embed_users] ([name], [address_city]) select [name], [city] from [embed_src]');

		expect(() => mock.insert(users).select(mock.select({ name: src.name, address: { country: src.city } }).from(src)))
			.toThrow('Insert select error: column "address.country" does not exist in table "embed_users"');

		expect(
			mock.insert(users).select(mock.select({ name: users.name, address: users.address }).from(users)).toSQL().sql,
		).toBe(
			'insert into [embed_users] ([name], [address_street], [address_city], [address_geo_lat], [address_geo_lng]) select [name], [address_street], [address_city], [address_geo_lat], [address_geo_lng] from [embed_users]',
		);

		expect(mock.insert(users).select(mock.select().from(users)).toSQL().sql).toBe(
			'insert into [embed_users] ([id], [name], [address_street], [address_city], [address_geo_lat], [address_geo_lng], [billing_zip_code]) select [id], [name], [address_street], [address_city], [address_geo_lat], [address_geo_lng], [billing_zip_code] from [embed_users]',
		);

		expect(mock.insert(plain).select(mock.select({ cityId: plain.cityId }).from(plain)).toSQL().sql).toBe(
			'insert into [embed_plain] ([cityId]) select [cityId] from [embed_plain]',
		);

		expect(mock.insert(users).select(sql`select 1`).toSQL().sql).toBe(
			'insert into [embed_users] ([name], [address_street], [address_city], [address_geo_lat], [address_geo_lng], [billing_zip_code]) select 1',
		);
	});

	test('a column list can name an embed() group', () => {
		expect(
			mock.insert(users, 'name', 'address').values({
				name: 'Ada',
				address: { city: 'Berlin', geo: { lat: 1 } },
			}).toSQL(),
		).toEqual({
			sql:
				'insert into [embed_users] ([name], [address_street], [address_city], [address_geo_lat], [address_geo_lng]) values (@par0, default, @par1, @par2, default)',
			params: ['Ada', 'Berlin', 1],
		});

		expect(
			mock.insert(users, 'name', 'address.city', 'address.geo').values({
				name: 'Ada',
				address: { city: 'Berlin', geo: { lat: 1 } },
			}).toSQL(),
		).toEqual({
			sql:
				'insert into [embed_users] ([name], [address_city], [address_geo_lat], [address_geo_lng]) values (@par0, @par1, @par2, default)',
			params: ['Ada', 'Berlin', 1],
		});

		expect(
			mock.insert(users, 'name', 'address.city', 'billing').values({
				name: 'Ada',
				address: { city: 'Berlin' },
				billing: { zip: '10115' },
			}).toSQL(),
		).toEqual({
			sql: 'insert into [embed_users] ([name], [address_city], [billing_zip_code]) values (@par0, @par1, @par2)',
			params: ['Ada', 'Berlin', '10115'],
		});

		expect(
			mock.insert(users, 'name', 'address.city').values({ name: 'Ada', address: { city: 'Berlin' } }).toSQL(),
		).toEqual({
			sql: 'insert into [embed_users] ([name], [address_city]) values (@par0, @par1)',
			params: ['Ada', 'Berlin'],
		});

		expect(
			mock.insert(users, 'name', 'address').select(
				mock.select({ name: src.name, address: { city: src.city } }).from(src),
			).toSQL().sql,
		).toBe('insert into [embed_users] ([name], [address_city]) select [name], [city] from [embed_src]');

		// @ts-expect-error - `address` repeats `address.city`
		expect(() => mock.insert(users, 'name', 'address', 'address.city')).toThrow(
			'Duplicate columns are not allowed in insert selection: "address.city"',
		);
		// @ts-expect-error - `address` repeats `address.city`
		expect(() => mock.insert(users, 'name', 'address.city', 'address')).toThrow(
			'Duplicate columns are not allowed in insert selection: "address"',
		);
		// @ts-expect-error - not a column or an embed() group
		expect(() => mock.insert(users, 'name', 'address', 'nope')).toThrow(
			'Column "nope" does not exist in table "embed_users"',
		);
	});
});

describe.skipIf(!connectionString)('embed', () => {
	let client: mssql.ConnectionPool;
	let db: ReturnType<typeof drizzle<{}, mssql.ConnectionPool>>;

	beforeAll(async () => {
		client = await new mssql.ConnectionPool(getMsSqlConnectionParams(connectionString!) as mssql.config).connect();
		db = drizzle({ client });

		await db.execute(sql`drop table if exists embed_users`);
		await db.execute(sql`drop table if exists embed_plain`);
		await db.execute(sql`
			create table embed_users (
				id int identity primary key,
				name varchar(100) not null,
				address_street varchar(100),
				address_city varchar(100) not null,
				address_geo_lat int,
				address_geo_lng int,
				billing_zip_code varchar(20)
			)
		`);
		await db.execute(sql`create table embed_plain (id int identity primary key, cityId int)`);
	});

	afterAll(async () => {
		await db.execute(sql`drop table if exists embed_users`);
		await db.execute(sql`drop table if exists embed_plain`);
		await client.close();
	});

	test('insert takes nested values, and select returns nested rows', async () => {
		const [inserted] = await db.insert(users).output().values({
			name: 'Ada',
			address: { street: 'Main St', city: 'Berlin', geo: { lat: 52, lng: 13 } },
			billing: { zip: '10115' },
		});
		expect(inserted).toEqual({
			id: 1,
			name: 'Ada',
			address: { street: 'Main St', city: 'Berlin', geo: { lat: 52, lng: 13 } },
			billing: { zip: '10115' },
		});

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

	test('update sets nested values, and null clears a group', async () => {
		const [before] = await db.update(users)
			.set({ address: { city: 'Rome', geo: null }, billing: { zip: '00100' } })
			.output({ deleted: { city: users.address.city }, inserted: true })
			.where(eq(users.id, 1));
		expect(before).toEqual({
			deleted: { city: 'Berlin' },
			inserted: {
				id: 1,
				name: 'Ada',
				address: { street: 'Main St', city: 'Rome', geo: { lat: null, lng: null } },
				billing: { zip: '00100' },
			},
		});

		await db.update(users).set({ billing: null }).where(eq(users.id, 1));
		expect(await db.select({ zip: users.billing.zip }).from(users).where(eq(users.id, 1))).toEqual([{ zip: null }]);
	});

	test('delete outputs nested groups', async () => {
		await db.insert(users).values({ name: 'Eve', address: { city: 'Oslo', geo: { lat: 59 } } });
		expect(await db.delete(users).output().where(eq(users.name, 'Eve'))).toEqual([{
			id: 3,
			name: 'Eve',
			address: { street: null, city: 'Oslo', geo: { lat: 59, lng: null } },
			billing: { zip: null },
		}]);
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

	test('top selects embedded rows', async () => {
		expect(await db.select({ city: users.address.city }).top(1).from(users).orderBy(asc(users.id))).toEqual([
			{ city: 'Rome' },
		]);
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

	test('nests a selected table in subqueries', async () => {
		const sq = db.select({ user: users }).from(users).where(eq(users.name, 'Bob')).as('sq');

		expect(sq.user.address.geo.lat.name).toBe('address_geo_lat');
		const rows = await db.select({ city: sq.user.address.city, lat: sq.user.address.geo.lat }).from(sq);
		expect(rows).toStrictEqual([{ city: 'Paris', lat: null }]);
	});

	test('tables without groups are unaffected', async () => {
		await db.insert(plain).values({ cityId: 7 });
		expect(await db.select().from(plain)).toEqual([{ id: 1, cityId: 7 }]);
	});

	test('insert select writes the nested selection', async () => {
		await db.execute(sql`drop table if exists embed_src`);
		await db.execute(sql`
			create table embed_src (
				name varchar(100) not null,
				city varchar(100) not null,
				lat int
			)
		`);
		await db.insert(src).values({ name: 'Dst', city: 'Paris', lat: 52 });

		await db.insert(users).select(
			db.select({
				address: { city: src.city, geo: { lat: src.lat } },
				name: src.name,
			}).from(src),
		);

		expect(await db.select({ name: users.name, address: users.address }).from(users).where(eq(users.name, 'Dst')))
			.toEqual([{
				name: 'Dst',
				address: { street: null, city: 'Paris', geo: { lat: 52, lng: null } },
			}]);

		await db.delete(users).where(eq(users.name, 'Dst'));
		await db.execute(sql`drop table embed_src`);
	});

	test('output returns a whole group, a nested group, and plain columns', async () => {
		const [inserted] = await db.insert(users).output({
			name: users.name,
			address: users.address,
			geo: users.address.geo,
		}).values({
			name: 'Out',
			address: { street: 'A', city: 'Bern', geo: { lat: 46, lng: 7 } },
		});
		expect(inserted).toEqual({
			name: 'Out',
			address: { street: 'A', city: 'Bern', geo: { lat: 46, lng: 7 } },
			geo: { lat: 46, lng: 7 },
		});

		const [updated] = await db.update(users).set({ address: { city: 'Basel' } }).output({
			inserted: { address: users.address, name: users.name },
			deleted: { geo: users.address.geo },
		}).where(eq(users.name, 'Out'));
		expect(updated).toEqual({
			inserted: {
				name: 'Out',
				address: { street: 'A', city: 'Basel', geo: { lat: 46, lng: 7 } },
			},
			deleted: { geo: { lat: 46, lng: 7 } },
		});

		expect(
			await db.delete(users).output({
				city: users.address.city,
				geo: users.address.geo,
			}).where(eq(users.name, 'Out')),
		).toEqual([{
			city: 'Basel',
			geo: { lat: 46, lng: 7 },
		}]);
	});

	test('insert writes a group named in the column list', async () => {
		await db.insert(users, 'name', 'address').values({
			name: 'ColList',
			address: { city: 'Berlin', geo: { lat: 1 } },
		});

		expect(
			await db.select({ name: users.name, address: users.address }).from(users).where(eq(users.name, 'ColList')),
		).toEqual([{
			name: 'ColList',
			address: { street: null, city: 'Berlin', geo: { lat: 1, lng: null } },
		}]);

		await db.delete(users).where(eq(users.name, 'ColList'));
	});
});

describe.skipIf(!connectionString).each([
	{ jit: false },
	{ jit: true },
])('embed in relational queries (jit: $jit)', ({ jit }) => {
	let client: mssql.ConnectionPool;
	let rqb: ReturnType<typeof drizzle<typeof relations, mssql.ConnectionPool>>;

	beforeAll(async () => {
		client = await new mssql.ConnectionPool(getMsSqlConnectionParams(connectionString!) as mssql.config).connect();
		rqb = drizzle({ client, relations, jit });

		await rqb.execute(sql`drop table if exists embed_orders`);
		await rqb.execute(sql`drop table if exists embed_shops`);
		await rqb.execute(sql`
			create table embed_shops (id int identity primary key, location_city varchar(100) not null, location_geo_lat int)
		`);
		await rqb.execute(sql`
			create table embed_orders (id int identity primary key, shopId int not null, delivery_city varchar(100))
		`);
		await rqb.insert(shops).values({ location: { city: 'Berlin', geo: { lat: 52 } } });
		await rqb.insert(orders).values([{ shopId: 1, delivery: { city: 'Potsdam' } }, { shopId: 1 }]);
	});

	afterAll(async () => {
		await rqb.execute(sql`drop table if exists embed_orders`);
		await rqb.execute(sql`drop table if exists embed_shops`);
		await client.close();
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
