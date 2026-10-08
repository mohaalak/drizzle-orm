import { beforeAll, describe, expect, test } from 'vitest';
import { alias, camelCase, embed, getTableConfig, index, integer, pgTable, serial, snakeCase, text } from '~/pg-core';
import { drizzle } from '~/pglite';
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
