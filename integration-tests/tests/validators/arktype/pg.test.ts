import { type Type, type } from 'arktype';
import { type Equal, sql } from 'drizzle-orm';
import { createInsertSchema, createSelectSchema, createUpdateSchema } from 'drizzle-orm/arktype';
import { bigintNarrow, bigintStringModeSchema, jsonSchema } from 'drizzle-orm/arktype/column';
import type { NestModelPartial } from 'drizzle-orm/embed';
import {
	customType,
	embed,
	integer,
	json,
	jsonb,
	pgEnum,
	pgMaterializedView,
	pgSchema,
	pgTable,
	pgView,
	serial,
	taggedUnion,
	text,
} from 'drizzle-orm/pg-core';
import { CONSTANTS } from 'drizzle-orm/utils';
import type { TopLevelCondition } from 'json-rules-engine';
import { expect, test } from 'vitest';
import { type DeepSimplify, Expect, expectEnumValues, expectSchemaShape } from './utils';

const integerSchema = type.keywords.number.integer.atLeast(CONSTANTS.INT32_MIN).atMost(CONSTANTS.INT32_MAX);
const integerNullableSchema = integerSchema.or(type.null);
const integerOptionalSchema = integerSchema.optional();
const integerNullableOptionalSchema = integerSchema.or(type.null).optional();

const textSchema = type.string;
const textOptionalSchema = textSchema.optional();
const textNullableSchema = textSchema.or(type.null);
const textNullableOptionalSchema = textNullableSchema.optional();

const anySchema = type('unknown.any');

const extendedSchema = integerSchema.atMost(1000);
const extendedNullableSchema = extendedSchema.or(type.null);
const extendedOptionalSchema = extendedSchema.optional();

const customSchema = type.string.pipe(Number);

test('table - select', (t) => {
	const table = pgTable('test', {
		id: serial().primaryKey(),
		name: text().notNull(),
	});

	const result = createSelectSchema(table);
	const expected = type({ id: integerSchema, name: textSchema });
	expectSchemaShape(t, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

test('table in schema - select', (tc) => {
	const schema = pgSchema('test');
	const table = schema.table('test', {
		id: serial().primaryKey(),
		name: text().notNull(),
	});

	const result = createSelectSchema(table);
	const expected = type({ id: integerSchema, name: textSchema });
	expectSchemaShape(tc, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

test('table - insert', (t) => {
	const table = pgTable('test', {
		id: integer().generatedAlwaysAsIdentity().primaryKey(),
		name: text().notNull(),
		age: integer(),
	});

	const result = createInsertSchema(table);
	const expected = type({ name: textSchema, age: integerNullableOptionalSchema });
	expectSchemaShape(t, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

test('table - update', (t) => {
	const table = pgTable('test', {
		id: integer().generatedAlwaysAsIdentity().primaryKey(),
		name: text().notNull(),
		age: integer(),
	});

	const result = createUpdateSchema(table);
	const expected = type({
		name: textOptionalSchema,
		age: integerNullableOptionalSchema,
	});
	expectSchemaShape(t, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

const embedTable = pgTable('test', {
	id: integer().generatedAlwaysAsIdentity().primaryKey(),
	address: embed({
		city: text().notNull(),
		zip: integer(),
		geo: embed({ lat: integer().notNull(), lng: integer().notNull() }),
	}),
	tags: embed({ main: text(), extra: text() }),
});

test('embedded columns - select', (t) => {
	const result = createSelectSchema(embedTable);
	const expected = type({
		id: integerSchema,
		address: {
			city: textSchema,
			zip: integerNullableSchema,
			geo: { lat: integerSchema, lng: integerSchema },
		},
		tags: { main: textNullableSchema, extra: textNullableSchema },
	});
	expectSchemaShape(t, expected).from(result);
	expectSchemaShape(t, expected.get('address')).from(result.get('address'));
	expectSchemaShape(t, expected.get('address').get('geo')).from(result.get('address').get('geo'));
	Expect<Equal<typeof result, typeof expected>>();

	const row = {
		id: 1,
		address: { city: 'Berlin', zip: null, geo: { lat: 1, lng: 2 } },
		tags: { main: 'a', extra: null },
	};
	const parsed = result(row);
	if (parsed instanceof type.errors) throw new Error(parsed.summary);
	expect(parsed).toStrictEqual(row);
	expect(result({ id: 1, 'address.city': 'Berlin' }) instanceof type.errors).toBe(true);
});

test('embedded columns - insert', (t) => {
	const result = createInsertSchema(embedTable);
	const expected = type({
		address: {
			city: textSchema,
			zip: integerNullableOptionalSchema,
			geo: { lat: integerSchema, lng: integerSchema },
		},
		tags: type({ main: textNullableOptionalSchema, extra: textNullableOptionalSchema }).optional(),
	});
	expectSchemaShape(t, expected).from(result);
	expectSchemaShape(t, expected.get('address')).from(result.get('address'));
	Expect<Equal<typeof result, typeof expected>>();

	const accepted = result({ address: { city: 'Berlin', geo: { lat: 1, lng: 2 } } });
	expect(accepted instanceof type.errors).toBe(false);
	expect(result({ address: { geo: { lat: 1, lng: 2 } } }) instanceof type.errors).toBe(true);
	expect(result({}) instanceof type.errors).toBe(true);
});

test('embedded columns - update', (t) => {
	const result = createUpdateSchema(embedTable);
	const expected = type({
		address: type({
			city: textOptionalSchema,
			zip: integerNullableOptionalSchema,
			geo: type({ lat: integerOptionalSchema, lng: integerOptionalSchema }).or(type.null).optional(),
		}).or(type.null).optional(),
		tags: type({ main: textNullableOptionalSchema, extra: textNullableOptionalSchema }).or(type.null).optional(),
	});
	expectSchemaShape(t, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();

	expect(result({}) instanceof type.errors).toBe(false);
	expect(result({ address: { geo: { lat: 3 } } }) instanceof type.errors).toBe(false);
	expect(result({ tags: null }) instanceof type.errors).toBe(false);
});

test('embedded columns - refine', (t) => {
	const result = createInsertSchema(embedTable, {
		address: { city: (schema) => schema.atLeastLength(2), geo: { lat: type.string.pipe(Number) } },
	});
	const expected = type({
		address: {
			city: textSchema.atLeastLength(2),
			zip: integerNullableOptionalSchema,
			geo: { lat: customSchema, lng: integerSchema },
		},
		tags: type({ main: textNullableOptionalSchema, extra: textNullableOptionalSchema }).optional(),
	});
	expectSchemaShape(t, expected.get('address')).from(result.get('address'));
	Expect<Equal<typeof result, typeof expected>>();

	expect(result({ address: { city: 'B', geo: { lat: '1', lng: 2 } } }) instanceof type.errors).toBe(true);
	const parsed = result({ address: { city: 'Berlin', geo: { lat: '1', lng: 2 } } });
	if (parsed instanceof type.errors) throw new Error(parsed.summary);
	expect(parsed.address.geo.lat).toBe(1);

	// @ts-expect-error - unknown key in a group
	createInsertSchema(embedTable, { address: { country: type.string } });
});

const unionTable = pgTable('test', {
	id: serial().primaryKey(),
	uploader: taggedUnion('kind', text(), {
		staff: { staffId: integer().notNull(), note: text(), rank: integer().notNull().default(1) },
		parent: {
			parentId: integer().notNull(),
			phone: embed({ number: text().notNull() }),
			via: taggedUnion('channel', text(), {
				app: { version: text().notNull() },
				email: { address: text().notNull() },
			}),
		},
		system: {},
	}),
	owner: taggedUnion('kind', text(), {
		campus: { campusId: integer().notNull() },
		staff: { campusId: integer(), staffId: integer().notNull() },
		nobody: {},
	}),
});

const staffRow = { kind: 'staff', staffId: 1, note: null, rank: 2 } as const;
const parentRow = {
	kind: 'parent',
	parentId: 2,
	phone: { number: '123' },
	via: { channel: 'email', address: 'a@b.c' },
} as const;

test('tagged union - select', () => {
	const result = createSelectSchema(unionTable);
	Expect<Equal<typeof result.infer, typeof unionTable.$inferSelect>>();

	const rows = [
		{ id: 1, uploader: staffRow, owner: { kind: 'campus', campusId: 1 } },
		{ id: 2, uploader: parentRow, owner: { kind: 'staff', campusId: null, staffId: 3 } },
		{ id: 3, uploader: { kind: 'system' }, owner: { kind: 'nobody' } },
	];
	for (const row of rows) expect(result(row)).toStrictEqual(row);

	const row = rows[0]!;
	// Unknown tag
	expect(result({ ...row, uploader: { kind: 'robot' } }) instanceof type.errors).toBe(true);
	// Missing a required field of the variant, including a nullable one
	expect(result({ ...row, uploader: { kind: 'staff', note: null, rank: 1 } }) instanceof type.errors).toBe(true);
	expect(result({ ...row, uploader: { kind: 'staff', staffId: 1, rank: 1 } }) instanceof type.errors).toBe(true);
	// A field of another variant
	expect(result({ ...row, uploader: { kind: 'system', staffId: 1 } }) instanceof type.errors).toBe(true);
	expect(result({ ...row, owner: { kind: 'nobody', campusId: 1 } }) instanceof type.errors).toBe(true);
	// A shared column is nullable only in the variants that declare it so
	expect(result({ ...row, owner: { kind: 'campus', campusId: null } }) instanceof type.errors).toBe(true);
	// A nested union is discriminated too
	expect(result({ ...row, uploader: { ...parentRow, via: { channel: 'app', address: 'a' } } }) instanceof type.errors)
		.toBe(true);
});

test('tagged union - insert', () => {
	const result = createInsertSchema(unionTable);
	Expect<Equal<typeof result.infer, typeof unionTable.$inferInsert>>();

	const values = [
		{ uploader: { kind: 'staff', staffId: 1 }, owner: { kind: 'staff', staffId: 3 } },
		{ uploader: parentRow, owner: { kind: 'campus', campusId: 1 } },
		{ uploader: { kind: 'system' }, owner: { kind: 'nobody' } },
	];
	for (const value of values) expect(result(value)).toStrictEqual(value);

	const value = values[0]!;
	expect(result({ owner: value.owner }) instanceof type.errors).toBe(true);
	expect(result({ ...value, uploader: { kind: 'robot' } }) instanceof type.errors).toBe(true);
	expect(result({ ...value, uploader: { kind: 'staff' } }) instanceof type.errors).toBe(true);
	expect(result({ ...value, uploader: { kind: 'system', staffId: 1 } }) instanceof type.errors).toBe(true);
	expect(result({ ...value, uploader: { ...parentRow, phone: undefined } }) instanceof type.errors).toBe(true);
});

test('tagged union - update', () => {
	const result = createUpdateSchema(unionTable);
	Expect<
		Equal<
			DeepSimplify<typeof result.infer>,
			DeepSimplify<NestModelPartial<typeof unionTable['_']['columns'], never>>
		>
	>();

	const sets = [
		{},
		{ uploader: { kind: 'staff', note: 'renamed' } },
		{ uploader: { kind: 'parent', via: { channel: 'app' } }, owner: { kind: 'campus' } },
	];
	for (const set of sets) expect(result(set)).toStrictEqual(set);

	expect(result({ uploader: { staffId: 1 } }) instanceof type.errors).toBe(true);
	expect(result({ uploader: null }) instanceof type.errors).toBe(true);
	expect(result({ uploader: { kind: 'robot' } }) instanceof type.errors).toBe(true);
	expect(result({ uploader: { kind: 'system', staffId: 1 } }) instanceof type.errors).toBe(true);
});

test('tagged union - refine', () => {
	const result = createSelectSchema(unionTable, {
		id: (schema) => schema.atMost(100),
		uploader: {
			staff: { staffId: (schema) => schema.atMost(10) },
			parent: { via: { app: { version: type.string.atMostLength(1) } } },
		},
		owner: { campusId: (schema) => schema.atLeast(1) },
	});
	Expect<Equal<typeof result.infer, typeof unionTable.$inferSelect>>();

	const row = { id: 1, uploader: staffRow, owner: { kind: 'campus', campusId: 1 } };
	expect(result(row)).toStrictEqual(row);
	expect(result({ ...row, id: 101 }) instanceof type.errors).toBe(true);
	expect(result({ ...row, uploader: { ...staffRow, staffId: 11 } }) instanceof type.errors).toBe(true);
	expect(result({ ...row, uploader: { ...parentRow, via: { channel: 'app', version: '22' } } }) instanceof type.errors)
		.toBe(true);
	// A shared column's refinement applies in every variant that declares it
	expect(result({ ...row, owner: { kind: 'campus', campusId: 0 } }) instanceof type.errors).toBe(true);
	expect(result({ ...row, owner: { kind: 'staff', campusId: 0, staffId: 1 } }) instanceof type.errors).toBe(true);
	expect(result({ ...row, owner: { kind: 'staff', campusId: null, staffId: 1 } }) instanceof type.errors).toBe(false);

	// @ts-expect-error - a union's tag column cannot be refined
	createSelectSchema(unionTable, { uploader: { kind: type.string } });
});

test('tagged union - view selecting a union', () => {
	const view = pgView('test_view').as((qb) =>
		qb.select({ uploader: unionTable.uploader, staff: unionTable.uploader.staff }).from(unionTable)
	);

	const result = createSelectSchema(view);
	Expect<Equal<DeepSimplify<typeof result.infer>, DeepSimplify<typeof view.$inferSelect>>>();

	// Outside its union, a variant's columns read as stored: nullable
	const row = { uploader: staffRow, staff: { staffId: null, note: null, rank: null } };
	expect(result(row)).toStrictEqual(row);
	expect(result({ ...row, uploader: { kind: 'robot' } }) instanceof type.errors).toBe(true);
});

test('view qb - select', (t) => {
	const table = pgTable('test', {
		id: serial().primaryKey(),
		name: text().notNull(),
	});
	const view = pgView('test').as((qb) => qb.select({ id: table.id, age: sql``.as('age') }).from(table));

	const result = createSelectSchema(view);
	const expected = type({ id: integerSchema, age: anySchema });
	expectSchemaShape(t, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

test('view columns - select', (t) => {
	const view = pgView('test', {
		id: serial().primaryKey(),
		name: text().notNull(),
	}).as(sql``);

	const result = createSelectSchema(view);
	const expected = type({ id: integerSchema, name: textSchema });
	expectSchemaShape(t, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

test('materialized view qb - select', (t) => {
	const table = pgTable('test', {
		id: serial().primaryKey(),
		name: text().notNull(),
	});
	const view = pgMaterializedView('test').as((qb) => qb.select({ id: table.id, age: sql``.as('age') }).from(table));

	const result = createSelectSchema(view);
	const expected = type({ id: integerSchema, age: anySchema });
	expectSchemaShape(t, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

test('materialized view columns - select', (t) => {
	const view = pgMaterializedView('test', {
		id: serial().primaryKey(),
		name: text().notNull(),
	}).as(sql``);

	const result = createSelectSchema(view);
	const expected = type({ id: integerSchema, name: textSchema });
	expectSchemaShape(t, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

test('view with nested fields - select', (t) => {
	const table = pgTable('test', {
		id: serial().primaryKey(),
		name: text().notNull(),
	});
	const view = pgView('test').as((qb) =>
		qb.select({
			id: table.id,
			nested: {
				name: table.name,
				age: sql``.as('age'),
			},
			table,
		}).from(table)
	);

	const result = createSelectSchema(view);
	const expected = type({
		id: integerSchema,
		nested: { name: textSchema, age: anySchema },
		table: { id: integerSchema, name: textSchema },
	});
	expectSchemaShape(t, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

test('enum - select', (t) => {
	const enum_ = pgEnum('test', ['a', 'b', 'c']);

	const result = createSelectSchema(enum_);
	const expected = type.enumerated('a', 'b', 'c');
	expectEnumValues(t, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

test('nullability - select', (t) => {
	const table = pgTable('test', {
		c1: integer(),
		c2: integer().notNull(),
		c3: integer().default(1),
		c4: integer().notNull().default(1),
	});

	const result = createSelectSchema(table);
	const expected = type({
		c1: integerNullableSchema,
		c2: integerSchema,
		c3: integerNullableSchema,
		c4: integerSchema,
	});
	expectSchemaShape(t, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

test('nullability - insert', (t) => {
	const table = pgTable('test', {
		c1: integer(),
		c2: integer().notNull(),
		c3: integer().default(1),
		c4: integer().notNull().default(1),
		c5: integer().generatedAlwaysAs(sql`1`),
		c6: integer().generatedAlwaysAsIdentity(),
		c7: integer().generatedByDefaultAsIdentity(),
	});

	const result = createInsertSchema(table);
	const expected = type({
		c1: integerNullableOptionalSchema,
		c2: integerSchema,
		c3: integerNullableOptionalSchema,
		c4: integerOptionalSchema,
		c7: integerOptionalSchema,
	});
	expectSchemaShape(t, expected).from(result);
});

test('nullability - update', (t) => {
	const table = pgTable('test', {
		c1: integer(),
		c2: integer().notNull(),
		c3: integer().default(1),
		c4: integer().notNull().default(1),
		c5: integer().generatedAlwaysAs(sql`1`),
		c6: integer().generatedAlwaysAsIdentity(),
		c7: integer().generatedByDefaultAsIdentity(),
	});

	const result = createUpdateSchema(table);
	const expected = type({
		c1: integerNullableOptionalSchema,
		c2: integerOptionalSchema,
		c3: integerNullableOptionalSchema,
		c4: integerOptionalSchema,
		c7: integerOptionalSchema,
	});
	expectSchemaShape(t, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

test('refine table - select', (t) => {
	const table = pgTable('test', {
		c1: integer(),
		c2: integer().notNull(),
		c3: integer().notNull(),
	});

	const result = createSelectSchema(table, {
		c2: (schema) => schema.atMost(1000),
		c3: type.string.pipe(Number),
	});
	const expected = type({
		c1: integerNullableSchema,
		c2: extendedSchema,
		c3: customSchema,
	});
	expectSchemaShape(t, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

test('refine table - select with custom data type', (t) => {
	const customText = customType({ codec: 'text', dataType: () => 'text' });
	const table = pgTable('test', {
		c1: integer(),
		c2: integer().notNull(),
		c3: integer().notNull(),
		c4: customText(),
	});

	const customTextSchema = type.string.atLeastLength(1).atMostLength(100);
	const result = createSelectSchema(table, {
		c2: (schema) => schema.atMost(1000),
		c3: type.string.pipe(Number),
		c4: customTextSchema,
	});
	const expected = type({
		c1: integerNullableSchema,
		c2: extendedSchema,
		c3: customSchema,
		c4: customTextSchema,
	});

	expectSchemaShape(t, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

test('refine table - insert', (t) => {
	const table = pgTable('test', {
		c1: integer(),
		c2: integer().notNull(),
		c3: integer().notNull(),
		c4: integer().generatedAlwaysAs(sql`1`),
	});

	const result = createInsertSchema(table, {
		c2: (schema) => schema.atMost(1000),
		c3: type.string.pipe(Number),
	});
	const expected = type({
		c1: integerNullableOptionalSchema,
		c2: extendedSchema,
		c3: customSchema,
	});
	expectSchemaShape(t, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

test('refine table - update', (t) => {
	const table = pgTable('test', {
		c1: integer(),
		c2: integer().notNull(),
		c3: integer().notNull(),
		c4: integer().generatedAlwaysAs(sql`1`),
	});

	const result = createUpdateSchema(table, {
		c2: (schema) => schema.atMost(1000),
		c3: type.string.pipe(Number),
	});
	const expected = type({
		c1: integerNullableOptionalSchema,
		c2: extendedOptionalSchema,
		c3: customSchema,
	});
	expectSchemaShape(t, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

test('refine view - select', (t) => {
	const table = pgTable('test', {
		c1: integer(),
		c2: integer(),
		c3: integer(),
		c4: integer(),
		c5: integer(),
		c6: integer(),
	});
	const view = pgView('test').as((qb) =>
		qb.select({
			c1: table.c1,
			c2: table.c2,
			c3: table.c3,
			nested: {
				c4: table.c4,
				c5: table.c5,
				c6: table.c6,
			},
			table,
		}).from(table)
	);

	const result = createSelectSchema(view, {
		c2: (schema) => schema.atMost(1000),
		c3: type.string.pipe(Number),
		nested: {
			c5: (schema) => schema.atMost(1000),
			c6: type.string.pipe(Number),
		},
		table: {
			c2: (schema) => schema.atMost(1000),
			c3: type.string.pipe(Number),
		},
	});
	const expected = type({
		c1: integerNullableSchema,
		c2: extendedNullableSchema,
		c3: customSchema,
		nested: type({
			c4: integerNullableSchema,
			c5: extendedNullableSchema,
			c6: customSchema,
		}),
		table: type({
			c1: integerNullableSchema,
			c2: extendedNullableSchema,
			c3: customSchema,
			c4: integerNullableSchema,
			c5: integerNullableSchema,
			c6: integerNullableSchema,
		}),
	});
	expectSchemaShape(t, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

test('all data types', (t) => {
	const table = pgTable('test', ({
		bigint,
		bigserial,
		bit,
		boolean,
		date,
		char,
		cidr,
		doublePrecision,
		geometry,
		halfvec,
		inet,
		integer,
		interval,
		json,
		jsonb,
		line,
		macaddr,
		macaddr8,
		numeric,
		point,
		real,
		serial,
		smallint,
		smallserial,
		text,
		sparsevec,
		time,
		timestamp,
		uuid,
		varchar,
		vector,
	}) => ({
		bigint1: bigint({ mode: 'number' }).notNull(),
		bigint2: bigint({ mode: 'bigint' }).notNull(),
		bigint3: bigint({ mode: 'string' }).notNull(),
		bigserial1: bigserial({ mode: 'number' }).notNull(),
		bigserial2: bigserial({ mode: 'bigint' }).notNull(),
		bit: bit({ dimensions: 5 }).notNull(),
		boolean: boolean().notNull(),
		date1: date({ mode: 'date' }).notNull(),
		date2: date({ mode: 'string' }).notNull(),
		char1: char({ length: 10 }).notNull(),
		char2: char({ length: 1, enum: ['a', 'b', 'c'] }).notNull(),
		cidr: cidr().notNull(),
		doublePrecision: doublePrecision().notNull(),
		geometry1: geometry({ type: 'point', mode: 'tuple' }).notNull(),
		geometry2: geometry({ type: 'point', mode: 'xy' }).notNull(),
		halfvec: halfvec({ dimensions: 3 }).notNull(),
		inet: inet().notNull(),
		integer: integer().notNull(),
		interval: interval().notNull(),
		json: json().notNull(),
		jsonb: jsonb().notNull(),
		line1: line({ mode: 'abc' }).notNull(),
		line2: line({ mode: 'tuple' }).notNull(),
		macaddr: macaddr().notNull(),
		macaddr8: macaddr8().notNull(),
		numeric1: numeric({ mode: 'number' }).notNull(),
		numeric2: numeric({ mode: 'bigint' }).notNull(),
		numeric3: numeric({ mode: 'string' }).notNull(),
		point1: point({ mode: 'xy' }).notNull(),
		point2: point({ mode: 'tuple' }).notNull(),
		real: real().notNull(),
		serial: serial().notNull(),
		smallint: smallint().notNull(),
		smallserial: smallserial().notNull(),
		text1: text().notNull(),
		text2: text({ enum: ['a', 'b', 'c'] }).notNull(),
		sparsevec: sparsevec({ dimensions: 3 }).notNull(),
		time: time().notNull(),
		timestamp1: timestamp({ mode: 'date' }).notNull(),
		timestamp2: timestamp({ mode: 'string' }).notNull(),
		uuid: uuid().notNull(),
		varchar1: varchar({ length: 10 }).notNull(),
		varchar2: varchar({ length: 1, enum: ['a', 'b', 'c'] }).notNull(),
		vector: vector({ dimensions: 3 }).notNull(),
		array1: integer().array().notNull(),
		array2: integer().array('[][]').notNull(),
		array3: varchar({ length: 10 }).array('[][]').notNull(),
	}));

	const result = createSelectSchema(table);
	const expected = type({
		bigint1: type.keywords.number.integer.atLeast(Number.MIN_SAFE_INTEGER).atMost(Number.MAX_SAFE_INTEGER),
		bigint2: type.bigint.narrow(bigintNarrow),
		bigint3: bigintStringModeSchema,
		bigserial1: type.keywords.number.integer.atLeast(Number.MIN_SAFE_INTEGER).atMost(Number.MAX_SAFE_INTEGER),
		bigserial2: type.bigint.narrow(bigintNarrow),
		bit: type(/^[01]{5}$/).describe('a string containing ones or zeros while being 5 characters long'),
		boolean: type.boolean,
		date1: type.Date,
		date2: type.string,
		char1: type.string.atMostLength(10),
		char2: type.enumerated('a', 'b', 'c'),
		cidr: type.string,
		doublePrecision: type.number.atLeast(CONSTANTS.INT48_MIN).atMost(CONSTANTS.INT48_MAX),
		geometry1: type([type.number, type.number]),
		geometry2: type({ x: type.number, y: type.number }),
		halfvec: type.number.array().exactlyLength(3),
		inet: type.string,
		integer: type.keywords.number.integer.atLeast(CONSTANTS.INT32_MIN).atMost(CONSTANTS.INT32_MAX),
		interval: type.string,
		json: jsonSchema,
		jsonb: jsonSchema,
		line1: type({ a: type.number, b: type.number, c: type.number }),
		line2: type([type.number, type.number, type.number]),
		macaddr: type.string,
		macaddr8: type.string,
		numeric1: type.number.atLeast(Number.MIN_SAFE_INTEGER).atMost(Number.MAX_SAFE_INTEGER),
		numeric2: type.bigint.narrow(bigintNarrow),
		numeric3: type.string,
		point1: type({ x: type.number, y: type.number }),
		point2: type([type.number, type.number]),
		real: type.number.atLeast(CONSTANTS.INT24_MIN).atMost(CONSTANTS.INT24_MAX),
		serial: type.keywords.number.integer.atLeast(CONSTANTS.INT32_MIN).atMost(CONSTANTS.INT32_MAX),
		smallint: type.keywords.number.integer.atLeast(CONSTANTS.INT16_MIN).atMost(CONSTANTS.INT16_MAX),
		smallserial: type.keywords.number.integer.atLeast(CONSTANTS.INT16_MIN).atMost(CONSTANTS.INT16_MAX),
		text1: type.string,
		text2: type.enumerated('a', 'b', 'c'),
		sparsevec: type.string,
		time: type.string,
		timestamp1: type.Date,
		timestamp2: type.string,
		uuid: type(/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu).describe('a RFC-4122-compliant UUID'),
		varchar1: type.string.atMostLength(10),
		varchar2: type.enumerated('a', 'b', 'c'),
		vector: type.number.array().exactlyLength(3),
		array1: integerSchema.array(),
		array2: integerSchema.array().array(),
		array3: type.string.atMostLength(10).array().array(),
	});
	expectSchemaShape(t, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

/* Infinitely recursive type */ {
	const TopLevelCondition: Type<TopLevelCondition> = type('unknown.any') as any;

	const column = customType<{
		data: TopLevelCondition;
	}>({
		codec: undefined,
		dataType: () => 'object TopLevelCondition',
	});
	const table = pgTable('test', {
		tlc: column('tlc'),
	});

	const result = createSelectSchema(table, {
		tlc: TopLevelCondition,
	});
	const expected = type({
		tlc: TopLevelCondition,
	});

	Expect<Equal<typeof result, typeof expected>>();
}

/* Disallow unknown keys in table refinement - select */ {
	const table = pgTable('test', { id: integer() });
	// @ts-expect-error
	createSelectSchema(table, { unknown: type.string });
}

/* Disallow unknown keys in table refinement - insert */ {
	const table = pgTable('test', { id: integer() });
	// @ts-expect-error
	createInsertSchema(table, { unknown: type.string });
}

/* Disallow unknown keys in table refinement - update */ {
	const table = pgTable('test', { id: integer() });
	// @ts-expect-error
	createUpdateSchema(table, { unknown: type.string });
}

/* Disallow unknown keys in view qb - select */ {
	const table = pgTable('test', { id: integer() });
	const view = pgView('test').as((qb) => qb.select().from(table));
	const mView = pgMaterializedView('test').as((qb) => qb.select().from(table));
	const nestedSelect = pgView('test').as((qb) => qb.select({ table }).from(table));
	// @ts-expect-error
	createSelectSchema(view, { unknown: type.string });
	// @ts-expect-error
	createSelectSchema(mView, { unknown: type.string });
	// @ts-expect-error
	createSelectSchema(nestedSelect, { table: { unknown: type.string } });
}

/* Disallow unknown keys in view columns - select */ {
	const view = pgView('test', { id: integer() }).as(sql``);
	const mView = pgView('test', { id: integer() }).as(sql``);
	// @ts-expect-error
	createSelectSchema(view, { unknown: type.string });
	// @ts-expect-error
	createSelectSchema(mView, { unknown: type.string });
}
