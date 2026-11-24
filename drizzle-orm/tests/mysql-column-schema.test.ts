import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import * as SchemaTransformation from 'effect/SchemaTransformation';
import { createPool, type Pool } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { getColumnSchema } from '~/column-schema.ts';
import { withDomainWrites } from '~/effect-schema';
import { embed, int, mysqlTable, serial, taggedUnion, varchar } from '~/mysql-core';
import { drizzle } from '~/mysql2';
import { defineRelations } from '~/relations';
import { asc, eq, sql } from '~/sql';

// The database tests run against a real MySQL server: set MYSQL_CONNECTION_STRING, for example
// `mysql://root:mysql@127.0.0.1:33306/drizzle` for `docker run -e MYSQL_ROOT_PASSWORD=mysql -e MYSQL_DATABASE=drizzle -p 33306:3306 mysql:8`.
const connectionString = process.env['MYSQL_CONNECTION_STRING'];

const UserId = Schema.Number.pipe(Schema.brand('UserId'));
const Email = Schema.String.pipe(Schema.brand('Email'));
const Cents = Schema.Number.pipe(Schema.brand('Cents'));

const users = mysqlTable('column_schema_users', {
	id: serial().primaryKey().schema(UserId),
	email: varchar({ length: 100 }).notNull().schema(Email),
	balance: int().schema(Cents),
	note: varchar({ length: 100 }),
});

const plainUsers = mysqlTable('column_schema_users', {
	id: serial().primaryKey(),
	email: varchar({ length: 100 }).notNull(),
	balance: int(),
	note: varchar({ length: 100 }),
});

const City = Schema.String.pipe(Schema.brand('City'));
const Latitude = Schema.Number.pipe(Schema.brand('Latitude'));
const Geo = Schema.Struct({ lat: Schema.Number, lng: Schema.Number });
const Address = Schema.Struct({ city: Schema.String });
const Uploader = Schema.Struct({ kind: Schema.String });

const places = mysqlTable('column_schema_places', {
	id: serial().primaryKey(),
	address: embed({
		city: varchar({ length: 100 }).notNull().schema(City),
		geo: embed({ lat: int().schema(Latitude), lng: int() }).schema(Geo),
	}).schema(Address),
	uploader: taggedUnion('kind', varchar({ length: 16 }), {
		staff: { staffId: int().notNull().schema(UserId) },
		system: {},
	}).schema(Uploader),
	plain: embed({ label: varchar({ length: 100 }) }),
});

const plainPlaces = mysqlTable('column_schema_places', {
	id: serial().primaryKey(),
	address: embed({
		city: varchar({ length: 100 }).notNull(),
		geo: embed({ lat: int(), lng: int() }),
	}),
	uploader: taggedUnion('kind', varchar({ length: 16 }), {
		staff: { staffId: int().notNull() },
		system: {},
	}),
	plain: embed({ label: varchar({ length: 100 }) }),
});

describe('column schemas', () => {
	test('a group gives back the Column Schema it was defined with', () => {
		expect(getColumnSchema(places.address)).toBe(Address);
		expect(getColumnSchema(places.address.geo)).toBe(Geo);
		expect(getColumnSchema(places.uploader)).toBe(Uploader);
		expect(getColumnSchema(places.plain)).toBeUndefined();
		expect(getColumnSchema(places.address.city)).toBe(City);
		expect(getColumnSchema(places.address.geo.lat)).toBe(Latitude);
		expect(getColumnSchema(places.uploader.staff.staffId)).toBe(UserId);
		expect(getColumnSchema(places.address.geo.lng)).toBeUndefined();
	});

	test('a builder selection gives back the Column Schemas of what it selects', () => {
		const selection = { id: users.id, address: places.address, geo: places.address.geo };
		expect(getColumnSchema(selection.id)).toBe(UserId);
		expect(getColumnSchema(selection.address)).toBe(Address);
		expect(getColumnSchema(selection.geo)).toBe(Geo);
	});

	test("a group's Column Schema is not one of its columns", () => {
		expect(Object.keys(places.address)).toEqual(['city', 'geo']);
		expect(Object.keys(places.uploader)).toEqual(['kind', 'staff']);
	});

	test('a table with group Column Schemas builds the same SQL as one without', () => {
		const db = drizzle.mock({ relations: defineRelations({ places }) });
		const plainDb = drizzle.mock({ relations: defineRelations({ places: plainPlaces }) });

		const insert = { address: { city: 'Rome', geo: { lat: 1 } }, uploader: { kind: 'staff', staffId: 2 } } as const;
		expect(db.insert(places).values(insert).toSQL()).toEqual(plainDb.insert(plainPlaces).values(insert).toSQL());
		expect(db.update(places).set({ address: { geo: null }, uploader: { kind: 'system' } }).toSQL()).toEqual(
			plainDb.update(plainPlaces).set({ address: { geo: null }, uploader: { kind: 'system' } }).toSQL(),
		);
		expect(db.select({ address: places.address, uploader: places.uploader }).from(places).toSQL()).toEqual(
			plainDb.select({ address: plainPlaces.address, uploader: plainPlaces.uploader }).from(plainPlaces).toSQL(),
		);
		expect(
			db.query.places.findMany({ columns: { address: true, uploader: true }, where: { uploader: { kind: 'staff' } } })
				.toSQL(),
		).toEqual(
			plainDb.query.places
				.findMany({ columns: { address: true, uploader: true }, where: { uploader: { kind: 'staff' } } })
				.toSQL(),
		);
	});

	test('a column gives back the Column Schema it was defined with', () => {
		expect(getColumnSchema(users.id)).toBe(UserId);
		expect(getColumnSchema(users.email)).toBe(Email);
		expect(getColumnSchema(users.balance)).toBe(Cents);
		expect(getColumnSchema(users.note)).toBeUndefined();
	});

	test('a table with Column Schemas builds the same SQL as one without', () => {
		const db = drizzle.mock({ relations: defineRelations({ users }) });
		const plainDb = drizzle.mock({ relations: defineRelations({ users: plainUsers }) });

		const insert = { email: 'a@x.io', balance: 5 };
		expect(
			db
				.insert(users)
				.values(insert)
				.toSQL(),
		).toEqual(plainDb.insert(plainUsers).values(insert).toSQL());
		expect(
			db
				.update(users)
				.set({ balance: 1 })
				.where(eq(users.id, 1))
				.toSQL(),
		).toEqual(plainDb.update(plainUsers).set({ balance: 1 }).where(eq(plainUsers.id, 1)).toSQL());
		expect(
			db
				.select()
				.from(users)
				.where(eq(users.email, 'a'))
				.toSQL(),
		).toEqual(plainDb.select().from(plainUsers).where(eq(plainUsers.email, 'a')).toSQL());
		expect(db.query.users.findMany({ where: { balance: { isNotNull: true } } }).toSQL()).toEqual(
			plainDb.query.users.findMany({ where: { balance: { isNotNull: true } } }).toSQL(),
		);
	});
});

class Money {
	constructor(readonly cents: number) {}
}
const MoneySchema = Schema.Number.pipe(
	Schema.decodeTo(
		Schema.instanceOf(Money),
		SchemaTransformation.transform({
			decode: (cents: number) => new Money(cents),
			encode: (money: Money) => money.cents,
		}),
	),
);
const CheckedEmail = Schema.String.pipe(Schema.check(Schema.isPattern(/@/)), Schema.brand('CheckedEmail'));
class GeoLocation {
	constructor(readonly lat: number, readonly lng: number) {}
}
const GeoSchema = Schema.Struct({ lat: Schema.Number, lng: Schema.Number }).pipe(
	Schema.decodeTo(
		Schema.instanceOf(GeoLocation),
		SchemaTransformation.transform({
			decode: ({ lat, lng }: { readonly lat: number; readonly lng: number }) => new GeoLocation(lat, lng),
			encode: (geo: GeoLocation) => ({ lat: geo.lat, lng: geo.lng }),
		}),
	),
);
type Uploader = { readonly _tag: 'Staff'; readonly id: number } | { readonly _tag: 'System' };
type UploaderRecord = { readonly kind: 'staff'; readonly staffId: number } | { readonly kind: 'system' };
const UploaderSchema = Schema.Union([
	Schema.Struct({ kind: Schema.Literal('staff'), staffId: Schema.toType(UserId) }),
	Schema.Struct({ kind: Schema.Literal('system') }),
]).pipe(
	Schema.decodeTo(
		Schema.declare((u): u is Uploader => typeof u === 'object' && u !== null && '_tag' in u),
		SchemaTransformation.transform({
			decode: (record: UploaderRecord): Uploader =>
				record.kind === 'staff' ? { _tag: 'Staff', id: record.staffId } : { _tag: 'System' },
			encode: (uploader: Uploader): UploaderRecord =>
				uploader._tag === 'Staff' ? { kind: 'staff', staffId: uploader.id } : { kind: 'system' },
		}),
	),
);

const accounts = withDomainWrites(
	mysqlTable('column_schema_accounts', {
		id: serial().primaryKey().schema(UserId),
		email: varchar({ length: 100 }).notNull().schema(CheckedEmail),
		balance: int().schema(MoneySchema),
		note: varchar({ length: 100 }),
		address: embed({
			city: varchar({ length: 100 }).notNull().schema(City),
			zip: varchar({ length: 10 }).schema(Email),
		}),
		geo: embed({ lat: int().notNull(), lng: int().notNull() }).schema(GeoSchema),
		uploader: taggedUnion('kind', varchar({ length: 16 }), {
			staff: { staffId: int().notNull().schema(UserId) },
			system: {},
		}).schema(UploaderSchema),
	}),
);

const email = (value: string) => value as typeof CheckedEmail.Type;
const city = (value: string) => value as typeof City.Type;
const userId = (value: number) => value as typeof UserId.Type;

describe('domain writes', () => {
	const db = drizzle.mock({ relations: defineRelations({ accounts }) });

	test('an insert encodes each value through its Column Schema', () => {
		const query = db
			.insert(accounts)
			.values({
				email: email('a@x.io'),
				balance: Option.some(new Money(250)),
				address: { city: city('Rome'), zip: Option.none() },
				geo: new GeoLocation(1, 2),
				uploader: { _tag: 'Staff', id: 7 },
			})
			.toSQL();
		expect(query.sql).toBe(
			'insert into `column_schema_accounts` (`id`, `email`, `balance`, `note`, `address_city`, `address_zip`, `geo_lat`, `geo_lng`, `uploader_kind`, `uploader_staffId`) values (default, ?, ?, default, ?, ?, ?, ?, ?, ?)',
		);
		expect(query.params).toEqual(['a@x.io', 250, 'Rome', null, 1, 2, 'staff', 7]);
	});

	test("Option.none() writes NULL, and a group's other variant is cleared", () => {
		const query = db
			.update(accounts)
			.set({ balance: Option.none(), uploader: { _tag: 'System' } })
			.where(eq(accounts.id, userId(1)))
			.toSQL();
		expect(query.sql).toBe(
			'update `column_schema_accounts` set `balance` = ?, `uploader_kind` = ?, `uploader_staffId` = ? where `column_schema_accounts`.`id` = ?',
		);
		expect(query.params).toEqual([null, 'system', null, 1]);
	});

	test('a where value is encoded through its Column Schema', () => {
		expect(db.select().from(accounts).where(eq(accounts.balance, new Money(5))).toSQL().params).toEqual([5]);
		expect(
			db.query.accounts.findMany({ where: { balance: { in: [new Money(1), new Money(2)] } } }).toSQL().params,
		).toEqual([1, 2]);
	});

	test('a value that fails to encode is a defect', () => {
		expect(() => db.update(accounts).set({ email: email('not an email') }).toSQL()).toThrow(/@/);
		expect(() => db.select().from(accounts).where(eq(accounts.email, email('nope'))).toSQL()).toThrow(/@/);
	});

	test('columns without a Column Schema write as before', () => {
		expect(db.update(accounts).set({ note: null }).toSQL().params).toEqual([null]);
		expect(db.update(accounts).set({ note: 'plain' }).toSQL().params).toEqual(['plain']);
	});
});

describe('domain writes to a group whose columns have Column Schemas of their own', () => {
	class Wallet {
		constructor(readonly balance: Money, readonly ownerId: number) {}
	}
	// Decodes from the record its columns hold: `balance` is the driver's number, not a `Money`.
	const WalletSchema = Schema.Struct({ balance: Schema.Number, ownerId: Schema.Number }).pipe(
		Schema.decodeTo(
			Schema.instanceOf(Wallet),
			SchemaTransformation.transform({
				decode: ({ balance, ownerId }: { readonly balance: number; readonly ownerId: number }) =>
					new Wallet(new Money(balance), ownerId),
				encode: (wallet: Wallet) => ({ balance: wallet.balance.cents, ownerId: wallet.ownerId }),
			}),
		),
	);
	type Payer = { readonly _tag: 'Staff'; readonly salary: Money } | { readonly _tag: 'System' };
	type PayerRecord = { readonly kind: 'staff'; readonly salary: number } | { readonly kind: 'system' };
	const PayerSchema = Schema.Union([
		Schema.Struct({ kind: Schema.Literal('staff'), salary: Schema.Number }),
		Schema.Struct({ kind: Schema.Literal('system') }),
	]).pipe(
		Schema.decodeTo(
			Schema.declare((u): u is Payer => typeof u === 'object' && u !== null && '_tag' in u),
			SchemaTransformation.transform({
				decode: (record: PayerRecord): Payer =>
					record.kind === 'staff' ? { _tag: 'Staff', salary: new Money(record.salary) } : { _tag: 'System' },
				encode: (payer: Payer): PayerRecord =>
					payer._tag === 'Staff' ? { kind: 'staff', salary: payer.salary.cents } : { kind: 'system' },
			}),
		),
	);
	const wallets = withDomainWrites(
		mysqlTable('column_schema_wallets', {
			id: serial().primaryKey(),
			wallet: embed({ balance: int().notNull().schema(MoneySchema), ownerId: int().notNull() }).schema(WalletSchema),
			payer: taggedUnion('kind', varchar({ length: 16 }), {
				staff: { salary: int().notNull().schema(MoneySchema) },
				system: {},
			}).schema(PayerSchema),
		}),
	);
	const db = drizzle.mock({ relations: defineRelations({ wallets }) });

	test('an insert encodes a group once, not again through its columns', () => {
		const query = db
			.insert(wallets)
			.values({ wallet: new Wallet(new Money(250), 7), payer: { _tag: 'Staff', salary: new Money(900) } })
			.toSQL();
		expect(query.params).toEqual([250, 7, 'staff', 900]);
	});

	test('an update encodes a group once, not again through its columns', () => {
		const query = db
			.update(wallets)
			.set({ wallet: new Wallet(new Money(3), 1), payer: { _tag: 'Staff', salary: new Money(4) } })
			.toSQL();
		expect(query.params).toEqual([3, 1, 'staff', 4]);
	});

	test("a where value on a group's column is still encoded through the column's Column Schema", () => {
		expect(db.select().from(wallets).where(eq(wallets.wallet.balance, new Money(5))).toSQL().params).toEqual([5]);
	});
});

describe.skipIf(!connectionString)('column schemas against MySQL', () => {
	let pool: Pool;
	const relations = defineRelations({ users, accounts, places });
	const connect = (client: Pool) => drizzle({ client, relations });
	let db: ReturnType<typeof connect>;

	beforeAll(async () => {
		pool = createPool({ uri: connectionString! });
		db = connect(pool);
		await db.execute(sql`drop table if exists column_schema_users`);
		await db.execute(sql`drop table if exists column_schema_accounts`);
		await db.execute(sql`drop table if exists column_schema_places`);
		await db.execute(sql`
			create table column_schema_accounts (
				id serial primary key,
				email varchar(100) not null,
				balance int,
				note varchar(100),
				address_city varchar(100) not null,
				address_zip varchar(10),
				geo_lat int not null,
				geo_lng int not null,
				uploader_kind varchar(16) not null,
				\`uploader_staffId\` int
			)
		`);
		await db.execute(sql`
			create table column_schema_places (
				id serial primary key,
				address_city varchar(100) not null,
				address_geo_lat int,
				address_geo_lng int,
				uploader_kind varchar(16) not null,
				\`uploader_staffId\` int,
				plain_label varchar(100)
			)
		`);
		await db.execute(sql`
			create table column_schema_users (
				id serial primary key,
				email varchar(100) not null,
				balance int,
				note varchar(100)
			)
		`);
	});

	afterAll(async () => {
		await db.execute(sql`drop table if exists column_schema_users`);
		await db.execute(sql`drop table if exists column_schema_accounts`);
		await db.execute(sql`drop table if exists column_schema_places`);
		await pool.end();
	});

	beforeEach(async () => {
		await db.execute(sql`truncate table column_schema_users`);
		await db.execute(sql`truncate table column_schema_accounts`);
		await db.execute(sql`truncate table column_schema_places`);
	});

	test('reads come back as the driver reads them, without decoding', async () => {
		await db.insert(users).values([{ email: 'a@x.io', balance: 5 }, { email: 'b@x.io' }]);

		expect(await db.select().from(users).orderBy(asc(users.id))).toEqual([
			{ id: 1, email: 'a@x.io', balance: 5, note: null },
			{ id: 2, email: 'b@x.io', balance: null, note: null },
		]);
		expect(await db.query.users.findMany({ columns: { email: true, balance: true }, orderBy: { id: 'asc' } })).toEqual([
			{ email: 'a@x.io', balance: 5 },
			{ email: 'b@x.io', balance: null },
		]);
	});

	test('groups with Column Schemas read as the driver reads their columns', async () => {
		await db.insert(places).values({
			address: { city: 'Rome', geo: { lat: 1 } },
			uploader: { kind: 'staff', staffId: 3 },
		});

		expect(await db.select().from(places)).toEqual([
			{
				id: 1,
				address: { city: 'Rome', geo: { lat: 1, lng: null } },
				uploader: { kind: 'staff', staffId: 3 },
				plain: { label: null },
			},
		]);
		expect(await db.query.places.findMany({ columns: { address: true, uploader: true } })).toEqual([
			{ address: { city: 'Rome', geo: { lat: 1, lng: null } }, uploader: { kind: 'staff', staffId: 3 } },
		]);
	});

	test('a table with domain writes writes domain values, and reads them back as the driver reads them', async () => {
		await db.insert(accounts).values([
			{
				email: email('a@x.io'),
				balance: Option.some(new Money(250)),
				address: { city: city('Rome'), zip: Option.some('00100' as typeof Email.Type) },
				geo: new GeoLocation(1, 2),
				uploader: { _tag: 'Staff', id: 7 },
			},
			{
				email: email('b@x.io'),
				balance: Option.none(),
				address: { city: city('Oslo') },
				geo: new GeoLocation(3, 4),
				uploader: { _tag: 'System' },
			},
		]);

		expect(await db.select().from(accounts).orderBy(asc(accounts.id))).toEqual([
			{
				id: 1,
				email: 'a@x.io',
				balance: 250,
				note: null,
				address: { city: 'Rome', zip: '00100' },
				geo: { lat: 1, lng: 2 },
				uploader: { kind: 'staff', staffId: 7 },
			},
			{
				id: 2,
				email: 'b@x.io',
				balance: null,
				note: null,
				address: { city: 'Oslo', zip: null },
				geo: { lat: 3, lng: 4 },
				uploader: { kind: 'system' },
			},
		]);

		expect(
			await db.query.accounts.findMany({ columns: { id: true }, where: { balance: { eq: new Money(250) } } }),
		).toEqual([{ id: 1 }]);
		expect(await db.query.accounts.findMany({ columns: { id: true }, where: { balance: { isNull: true } } })).toEqual([
			{ id: 2 },
		]);

		const byEmail = db
			.select({ id: accounts.id })
			.from(accounts)
			.where(eq(accounts.email, sql.placeholder('email')))
			.prepare();
		expect(await byEmail.execute({ email: email('b@x.io') })).toEqual([{ id: 2 }]);

		await db
			.update(accounts)
			.set({ balance: Option.none(), geo: new GeoLocation(5, 6) })
			.where(eq(accounts.id, userId(1)));
		expect(
			await db.select({ balance: accounts.balance, geo: accounts.geo }).from(accounts).where(
				eq(accounts.id, userId(1)),
			),
		)
			.toEqual([{ balance: null, geo: { lat: 5, lng: 6 } }]);
	});
});
