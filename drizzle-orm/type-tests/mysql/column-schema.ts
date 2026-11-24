import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import type { Equal } from 'type-tests/utils.ts';
import { Expect } from 'type-tests/utils.ts';
import { type ColumnSchemaOf, getColumnSchema } from '~/column-schema.ts';
import { withDomainWrites } from '~/effect-schema/index.ts';
import type { FilteredUnionTags, NarrowRowByFilter, NotNullFilterKeys } from '~/mysql-core/index.ts';
import { embed, int, mysqlTable, serial, taggedUnion, varchar } from '~/mysql-core/index.ts';
import { drizzle } from '~/mysql2/index.ts';
import { defineRelations } from '~/relations.ts';
import { eq, inArray, isNull } from '~/sql/expressions/index.ts';
import type { InferInsertModel, InferSelectModel } from '~/table.ts';
import { db } from './db.ts';

const UserId = Schema.Number.pipe(Schema.brand('UserId'));
const Email = Schema.String.pipe(Schema.brand('Email'));
const Cents = Schema.Number.pipe(Schema.brand('Cents'));

const users = mysqlTable('users_column_schema', {
	id: serial().primaryKey().schema(UserId),
	email: varchar({ length: 100 }).notNull().schema(Email),
	balance: int().schema(Cents),
	note: varchar({ length: 100 }),
});

const plainUsers = mysqlTable('users_column_schema', {
	id: serial().primaryKey(),
	email: varchar({ length: 100 }).notNull(),
	balance: int(),
	note: varchar({ length: 100 }),
});

// A column's Column Schema is read from the column, in the type and at runtime.
Expect<Equal<ColumnSchemaOf<typeof users.id>, typeof UserId>>();
Expect<Equal<ColumnSchemaOf<typeof users.balance>, typeof Cents>>();
Expect<Equal<ColumnSchemaOf<typeof users.note>, undefined>>();
Expect<Equal<ReturnType<typeof getColumnSchema<typeof users.email>>, typeof Email>>();

// Recording a Column Schema leaves the table's read and write types as they were.
Expect<Equal<typeof users.$inferSelect, typeof plainUsers.$inferSelect>>();
Expect<Equal<typeof users.$inferInsert, typeof plainUsers.$inferInsert>>();
Expect<Equal<InferSelectModel<typeof users>, InferSelectModel<typeof plainUsers>>>();
Expect<Equal<InferInsertModel<typeof users>, InferInsertModel<typeof plainUsers>>>();
Expect<Equal<(typeof users.id)['_']['data'], number>>();

// The Column Schema's encoded side is what the column holds.
// @ts-expect-error - a string schema cannot describe an int column
int().schema(Email);

// ----------------------------------------------------------------------------- groups

const City = Schema.String.pipe(Schema.brand('City'));
const Latitude = Schema.Number.pipe(Schema.brand('Latitude'));
class GeoLocation {
	private readonly kind = 'geo';
	constructor(readonly lat: number, readonly lng: number) {}
}
const Geo = Schema.declare((u): u is GeoLocation => u instanceof GeoLocation);
const Address = Schema.Struct({ city: Schema.String });
const Uploader = Schema.Struct({ kind: Schema.String });

const places = mysqlTable('places_column_schema', {
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

const plainPlaces = mysqlTable('places_column_schema', {
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

// A group's Column Schema is read from the group of the table, in the type and at runtime.
Expect<Equal<ColumnSchemaOf<typeof places.address>, typeof Address>>();
Expect<Equal<ColumnSchemaOf<typeof places.address.geo>, typeof Geo>>();
Expect<Equal<ColumnSchemaOf<typeof places.uploader>, typeof Uploader>>();
Expect<Equal<ColumnSchemaOf<typeof places.plain>, undefined>>();
Expect<Equal<ColumnSchemaOf<typeof places.address.city>, typeof City>>();
Expect<Equal<ColumnSchemaOf<typeof places.address.geo.lat>, typeof Latitude>>();
Expect<Equal<ColumnSchemaOf<typeof places.uploader.staff.staffId>, typeof UserId>>();
Expect<Equal<ReturnType<typeof getColumnSchema<typeof places.address>>, typeof Address>>();

// A builder selection holds the table's columns and groups, so their Column Schemas are read from it.
const selection = { id: users.id, address: places.address, geo: places.address.geo };
Expect<Equal<ColumnSchemaOf<typeof selection.id>, typeof UserId>>();
Expect<Equal<ColumnSchemaOf<typeof selection.address>, typeof Address>>();
Expect<Equal<ColumnSchemaOf<typeof selection.geo>, typeof Geo>>();

// Group Column Schemas leave the table's read and write types as they were.
Expect<Equal<typeof places.$inferSelect, typeof plainPlaces.$inferSelect>>();
Expect<Equal<typeof places.$inferInsert, typeof plainPlaces.$inferInsert>>();
Expect<Equal<InferInsertModel<typeof places>, InferInsertModel<typeof plainPlaces>>>();

{
	const rows = await db.select().from(places);
	const plainRows = await db.select().from(plainPlaces);
	Expect<Equal<typeof rows, typeof plainRows>>();

	const picked = await db.select({ address: places.address, geo: places.address.geo, uploader: places.uploader })
		.from(places);
	const plainPicked = await db.select({
		address: plainPlaces.address,
		geo: plainPlaces.address.geo,
		uploader: plainPlaces.uploader,
	}).from(plainPlaces);
	Expect<Equal<typeof picked, typeof plainPicked>>();

	const returned = await db.update(places).set({ address: { city: 'Rome' } });
	const plainReturned = await db.update(plainPlaces).set({ address: { city: 'Rome' } });
	Expect<Equal<typeof returned, typeof plainReturned>>();

	db.insert(places).values({ address: { city: 'Rome' }, uploader: { kind: 'staff', staffId: 1 } });
	db.update(places).set({ address: { geo: { lat: 1 } }, uploader: { kind: 'system' } });
}

{
	// Column Schemas are read from the tables of a relational schema, as a read that selects `columns` or `with` does.
	const relations = defineRelations({ places, users }, (r) => ({
		places: { owner: r.one.users({ from: r.places.id, to: r.users.id }) },
	}));
	Expect<Equal<ColumnSchemaOf<typeof relations.places.table.address>, typeof Address>>();
	Expect<Equal<ColumnSchemaOf<typeof relations.places.table.address.city>, typeof City>>();
	Expect<Equal<ColumnSchemaOf<typeof relations.users.table.id>, typeof UserId>>();

	const rqb = drizzle.mock({ relations });
	const plainRqb = drizzle.mock({ relations: defineRelations({ places: plainPlaces }) });
	const row = await rqb.query.places.findFirst({ columns: { address: true, uploader: true } });
	const plainRow = await plainRqb.query.places.findFirst({ columns: { address: true, uploader: true } });
	Expect<Equal<typeof row, typeof plainRow>>();
	const full = await rqb.query.places.findFirst({ with: { owner: true } });
	Expect<Equal<NonNullable<typeof full>['owner'], typeof users.$inferSelect | null>>();
}

// ----------------------------------------------------------------------------- isNotNull narrowing

{
	const relations = defineRelations({ users, places });
	const rqb = drizzle.mock({ relations });

	// `isNotNull` on a nullable column drops `null` from that field.
	const set = await rqb.query.users.findFirst({ where: { balance: { isNotNull: true } } });
	Expect<Equal<typeof set, { id: number; email: string; balance: number; note: string | null } | undefined>>();

	const picked = await rqb.query.users.findMany({
		columns: { balance: true },
		where: { balance: { isNotNull: true } },
	});
	Expect<Equal<typeof picked, { balance: number }[]>>();

	// It narrows beside a union's tag, and inside a group.
	const both = await rqb.query.places.findFirst({
		where: { uploader: { kind: 'staff' }, address: { geo: { lat: { isNotNull: true } } } },
	});
	Expect<Equal<NonNullable<typeof both>['uploader'], { kind: 'staff'; staffId: number }>>();
	Expect<Equal<NonNullable<typeof both>['address']['geo'], { lat: number; lng: number | null }>>();

	// Other filters leave the field nullable.
	const isNull = await rqb.query.users.findFirst({ where: { balance: { isNull: true } } });
	Expect<Equal<NonNullable<typeof isNull>['balance'], number | null>>();
	const equal = await rqb.query.users.findFirst({ where: { balance: 5 } });
	Expect<Equal<NonNullable<typeof equal>['balance'], number | null>>();
	const underOr = await rqb.query.users.findFirst({ where: { OR: [{ balance: { isNotNull: true } }] } });
	Expect<Equal<NonNullable<typeof underOr>['balance'], number | null>>();
	const none = await rqb.query.users.findFirst({ where: { id: 1 } });
	Expect<Equal<typeof none, typeof users.$inferSelect | undefined>>();

	// The narrowing types are exported, to narrow a row computed elsewhere.
	type Where = { balance: { isNotNull: true }; uploader: { kind: 'staff' } };
	Expect<Equal<NotNullFilterKeys<Where>, 'balance'>>();
	Expect<Equal<FilteredUnionTags<Where['uploader']['kind']>, 'staff'>>();
	Expect<
		Equal<
			NarrowRowByFilter<{ balance: number | null; note: string | null }, typeof users._.columns, Where>,
			{ balance: number; note: string | null }
		>
	>();
}

// ----------------------------------------------------------------------------- domain writes

const Zip = Schema.String.pipe(Schema.brand('Zip'));

const accountColumns = {
	id: serial().primaryKey().schema(UserId),
	email: varchar({ length: 100 }).notNull().schema(Email),
	balance: int().schema(Cents),
	note: varchar({ length: 100 }),
	address: embed({ city: varchar({ length: 100 }).notNull().schema(City), zip: varchar({ length: 10 }).schema(Zip) }),
	geo: embed({ lat: int().notNull(), lng: int().notNull() }).schema(Geo),
	uploader: taggedUnion('kind', varchar({ length: 16 }), {
		staff: { staffId: int().notNull().schema(UserId) },
		system: {},
	}),
};
const accounts = withDomainWrites(mysqlTable('accounts_domain_writes', accountColumns));
const recordedAccounts = mysqlTable('accounts_domain_writes', accountColumns);

type UserId = typeof UserId.Type;
type Email = typeof Email.Type;
type Cents = typeof Cents.Type;
type City = typeof City.Type;
type Zip = typeof Zip.Type;
declare const userId: UserId;
declare const email: Email;
declare const cents: Cents;
declare const city: City;

// Reads keep the driver's types.
Expect<Equal<typeof accounts.$inferSelect, typeof recordedAccounts.$inferSelect>>();
Expect<Equal<InferSelectModel<typeof accounts>, InferSelectModel<typeof recordedAccounts>>>();
{
	const rows = await db.select().from(accounts);
	const recordedRows = await db.select().from(recordedAccounts);
	Expect<Equal<typeof rows, typeof recordedRows>>();

	const picked = await db.select({ id: accounts.id, address: accounts.address, geo: accounts.geo }).from(accounts);
	Expect<
		Equal<typeof picked, {
			id: number;
			address: { city: string; zip: string | null };
			geo: { lat: number; lng: number };
		}[]>
	>();

	const relations = defineRelations({ accounts });
	const rqb = drizzle.mock({ relations });
	const row = await rqb.query.accounts.findFirst({ where: { email } });
	Expect<Equal<typeof row, typeof recordedAccounts.$inferSelect | undefined>>();
	const narrowed = await rqb.query.accounts.findFirst({
		columns: { balance: true },
		where: { balance: { isNotNull: true } },
	});
	Expect<Equal<typeof narrowed, { balance: number } | undefined>>();
}

// Writes take the Column Schemas' domain values, `Option` for a nullable column, and a group's domain value.
Expect<
	Equal<InferInsertModel<typeof accounts>, {
		email: Email;
		address: { city: City; zip?: Option.Option<Zip> | undefined };
		geo: GeoLocation;
		uploader: { kind: 'staff'; staffId: UserId } | { kind: 'system' };
		id?: UserId | undefined;
		balance?: Option.Option<Cents> | undefined;
		note?: string | null | undefined;
	}>
>();
{
	db.insert(accounts).values({
		email,
		balance: Option.some(cents),
		address: { city, zip: Option.none() },
		geo: new GeoLocation(1, 2),
		uploader: { kind: 'staff', staffId: userId },
	});
	db.insert(accounts).values({
		email,
		note: null,
		address: { city },
		geo: new GeoLocation(1, 2),
		uploader: { kind: 'system' },
	});
	// dprint-ignore
	// @ts-expect-error - a plain string is not an Email
	db.insert(accounts).values({ email: 'a@x.io', address: { city }, geo: new GeoLocation(1, 2), uploader: { kind: 'system' } });
	// dprint-ignore
	// @ts-expect-error - a nullable column with a Column Schema takes an Option, not null
	db.insert(accounts).values({ email, balance: null, address: { city }, geo: new GeoLocation(1, 2), uploader: { kind: 'system' } });
	// dprint-ignore
	// @ts-expect-error - a group with a Column Schema takes its domain value, not its columns
	db.insert(accounts).values({ email, address: { city }, geo: { lat: 1, lng: 2 }, uploader: { kind: 'system' } });
	// dprint-ignore
	// @ts-expect-error - a variant column with a Column Schema takes its domain value
	db.insert(accounts).values({ email, address: { city }, geo: new GeoLocation(1, 2), uploader: { kind: 'staff', staffId: 1 } });

	db.update(accounts).set({
		balance: Option.none(),
		email,
		geo: new GeoLocation(3, 4),
		address: { zip: Option.none() },
	});
	db.update(accounts).set({ uploader: { kind: 'staff', staffId: userId } });
	// @ts-expect-error - a nullable column with a Column Schema is cleared with Option.none()
	db.update(accounts).set({ balance: null });
	// @ts-expect-error - a group with a Column Schema is written whole
	db.update(accounts).set({ geo: { lat: 1 } });
}

// `where` values take the domain value: `eq` takes A on a nullable column, and `isNull` / `isNotNull` test for null.
{
	db.select().from(accounts).where(eq(accounts.id, userId));
	db.select().from(accounts).where(eq(accounts.balance, cents));
	db.select().from(accounts).where(inArray(accounts.address.city, [city]));
	db.select().from(accounts).where(isNull(accounts.balance));
	db.select().from(accounts).where(eq(accounts.uploader.staff.staffId, userId));
	db.select().from(accounts).where(eq(accounts.note, 'plain'));
	// @ts-expect-error - a plain number is not a UserId
	db.select().from(accounts).where(eq(accounts.id, 1));
	// @ts-expect-error - `eq` takes the domain value, not an Option
	db.select().from(accounts).where(eq(accounts.balance, Option.some(cents)));

	const rqb = drizzle.mock({ relations: defineRelations({ accounts }) });
	rqb.query.accounts.findMany({ where: { id: userId, balance: { eq: cents }, address: { city } } });
	rqb.query.accounts.findMany({ where: { balance: { isNull: true }, uploader: { staff: { staffId: userId } } } });
	// @ts-expect-error - a plain string is not an Email
	rqb.query.accounts.findMany({ where: { email: 'a@x.io' } });
	// @ts-expect-error - a plain number is not Cents
	rqb.query.accounts.findMany({ where: { balance: { in: [1] } } });
}
