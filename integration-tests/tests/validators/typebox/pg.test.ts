import { type Equal, sql } from 'drizzle-orm';
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
	text,
} from 'drizzle-orm/pg-core';
import {
	createInsertSchema,
	createSelectSchema,
	createUpdateSchema,
	type GenericSchema,
	jsonSchema,
	TBigIntString,
	TBuffer,
	TDate,
} from 'drizzle-orm/typebox';
import { CONSTANTS } from 'drizzle-orm/utils';
import type { TopLevelCondition } from 'json-rules-engine';
import t, { type Static } from 'typebox';
import { Value } from 'typebox/value';
import { expect, test } from 'vitest';
import { Expect, expectEnumValues, expectSchemaShape } from './utils';

const integerSchema = t.Integer({ minimum: CONSTANTS.INT32_MIN, maximum: CONSTANTS.INT32_MAX });
const integerNullableSchema = t.Union([integerSchema, t.Null()]);
const integerOptionalSchema = t.Optional(integerSchema);
const integerNullableOptionalSchema = t.Optional(t.Union([integerSchema, t.Null()]));

const textSchema = t.String();
const textOptionalSchema = t.Optional(textSchema);
const textNullableSchema = t.Union([textSchema, t.Null()]);
const textNullableOptionalSchema = t.Optional(textNullableSchema);

const anySchema = t.Any();

const extendedSchema = t.Integer({ minimum: CONSTANTS.INT32_MIN, maximum: 1000 });
const extendedNullableSchema = t.Union([extendedSchema, t.Null()]);
const extendedOptionalSchema = t.Optional(extendedSchema);

const customSchema = t.Integer({ minimum: 1, maximum: 10 });

test('table - select', (tc) => {
	const table = pgTable('test', {
		id: serial().primaryKey(),
		name: text().notNull(),
	});

	const result = createSelectSchema(table);
	const expected = t.Object({ id: integerSchema, name: textSchema });
	expectSchemaShape(tc, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

test('table in schema - select', (tc) => {
	const schema = pgSchema('test');
	const table = schema.table('test', {
		id: serial().primaryKey(),
		name: text().notNull(),
	});

	const result = createSelectSchema(table);
	const expected = t.Object({ id: integerSchema, name: textSchema });
	expectSchemaShape(tc, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

test('table - insert', (tc) => {
	const table = pgTable('test', {
		id: integer().generatedAlwaysAsIdentity().primaryKey(),
		name: text().notNull(),
		age: integer(),
	});

	const result = createInsertSchema(table);
	const expected = t.Object({ name: textSchema, age: integerNullableOptionalSchema });
	expectSchemaShape(tc, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

test('table - update', (tc) => {
	const table = pgTable('test', {
		id: integer().generatedAlwaysAsIdentity().primaryKey(),
		name: text().notNull(),
		age: integer(),
	});

	const result = createUpdateSchema(table);
	const expected = t.Object({
		name: textOptionalSchema,
		age: integerNullableOptionalSchema,
	});
	expectSchemaShape(tc, expected).from(result);
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

test('embedded columns - select', (tc) => {
	const result = createSelectSchema(embedTable);
	const expected = t.Object({
		id: integerSchema,
		address: t.Object({
			city: textSchema,
			zip: integerNullableSchema,
			geo: t.Object({ lat: integerSchema, lng: integerSchema }),
		}),
		tags: t.Object({ main: textNullableSchema, extra: textNullableSchema }),
	});
	expectSchemaShape(tc, expected).from(result);
	expectSchemaShape(tc, expected.properties.address).from(result.properties.address);
	expectSchemaShape(tc, expected.properties.address.properties.geo).from(result.properties.address.properties.geo);
	Expect<Equal<typeof result, typeof expected>>();

	const row = {
		id: 1,
		address: { city: 'Berlin', zip: null, geo: { lat: 1, lng: 2 } },
		tags: { main: 'a', extra: null },
	};
	expect(Value.Check(result, row)).toBe(true);
	expect(Value.Parse(result, row)).toStrictEqual(row);
	expect(Value.Check(result, { id: 1, 'address.city': 'Berlin' })).toBe(false);
});

test('embedded columns - insert', (tc) => {
	const result = createInsertSchema(embedTable);
	const expected = t.Object({
		address: t.Object({
			city: textSchema,
			zip: integerNullableOptionalSchema,
			geo: t.Object({ lat: integerSchema, lng: integerSchema }),
		}),
		tags: t.Optional(t.Object({ main: textNullableOptionalSchema, extra: textNullableOptionalSchema })),
	});
	expectSchemaShape(tc, expected).from(result);
	expectSchemaShape(tc, expected.properties.address).from(result.properties.address);
	Expect<Equal<typeof result, typeof expected>>();

	expect(Value.Check(result, { address: { city: 'Berlin', geo: { lat: 1, lng: 2 } } })).toBe(true);
	expect(Value.Check(result, { address: { geo: { lat: 1, lng: 2 } } })).toBe(false);
	expect(Value.Check(result, {})).toBe(false);
});

test('embedded columns - update', (tc) => {
	const result = createUpdateSchema(embedTable);
	const expected = t.Object({
		address: t.Optional(t.Union([
			t.Object({
				city: textOptionalSchema,
				zip: integerNullableOptionalSchema,
				geo: t.Optional(t.Union([
					t.Object({ lat: integerOptionalSchema, lng: integerOptionalSchema }),
					t.Null(),
				])),
			}),
			t.Null(),
		])),
		tags: t.Optional(t.Union([
			t.Object({ main: textNullableOptionalSchema, extra: textNullableOptionalSchema }),
			t.Null(),
		])),
	});
	expectSchemaShape(tc, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();

	expect(Value.Check(result, {})).toBe(true);
	expect(Value.Check(result, { address: { geo: { lat: 3 } } })).toBe(true);
	expect(Value.Check(result, { tags: null })).toBe(true);
});

test('embedded columns - refine', (tc) => {
	const result = createInsertSchema(embedTable, {
		address: { city: (schema) => t.String({ minLength: 2 }), geo: { lat: t.String() } },
	});
	const expected = t.Object({
		address: t.Object({
			city: t.String({ minLength: 2 }),
			zip: integerNullableOptionalSchema,
			geo: t.Object({ lat: t.String(), lng: integerSchema }),
		}),
		tags: t.Optional(t.Object({ main: textNullableOptionalSchema, extra: textNullableOptionalSchema })),
	});
	expectSchemaShape(tc, expected.properties.address).from(result.properties.address);
	Expect<Equal<typeof result, typeof expected>>();

	expect(Value.Check(result, { address: { city: 'B', geo: { lat: '1', lng: 2 } } })).toBe(false);
	expect(Value.Parse(result, { address: { city: 'Berlin', geo: { lat: '1', lng: 2 } } }).address.geo.lat).toBe('1');

	// @ts-expect-error - unknown key in a group
	createInsertSchema(embedTable, { address: { country: t.String() } });
});

test('view qb - select', (tc) => {
	const table = pgTable('test', {
		id: serial().primaryKey(),
		name: text().notNull(),
	});
	const view = pgView('test').as((qb) => qb.select({ id: table.id, age: sql``.as('age') }).from(table));

	const result = createSelectSchema(view);
	const expected = t.Object({ id: integerSchema, age: anySchema });
	expectSchemaShape(tc, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

test('view columns - select', (tc) => {
	const view = pgView('test', {
		id: serial().primaryKey(),
		name: text().notNull(),
	}).as(sql``);

	const result = createSelectSchema(view);
	const expected = t.Object({ id: integerSchema, name: textSchema });
	expectSchemaShape(tc, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

test('materialized view qb - select', (tc) => {
	const table = pgTable('test', {
		id: serial().primaryKey(),
		name: text().notNull(),
	});
	const view = pgMaterializedView('test').as((qb) => qb.select({ id: table.id, age: sql``.as('age') }).from(table));

	const result = createSelectSchema(view);
	const expected = t.Object({ id: integerSchema, age: anySchema });
	expectSchemaShape(tc, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

test('materialized view columns - select', (tc) => {
	const view = pgMaterializedView('test', {
		id: serial().primaryKey(),
		name: text().notNull(),
	}).as(sql``);

	const result = createSelectSchema(view);
	const expected = t.Object({ id: integerSchema, name: textSchema });
	expectSchemaShape(tc, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

test('view with nested fields - select', (tc) => {
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
	const expected = t.Object({
		id: integerSchema,
		nested: t.Object({ name: textSchema, age: anySchema }),
		table: t.Object({ id: integerSchema, name: textSchema }),
	});
	expectSchemaShape(tc, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

test('enum - select', (tc) => {
	const enum_ = pgEnum('test', ['a', 'b', 'c']);

	const result = createSelectSchema(enum_);
	const expected = t.Enum(['a', 'b', 'c']);
	expectEnumValues(tc, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

test('nullability - select', (tc) => {
	const table = pgTable('test', {
		c1: integer(),
		c2: integer().notNull(),
		c3: integer().default(1),
		c4: integer().notNull().default(1),
	});

	const result = createSelectSchema(table);
	const expected = t.Object({
		c1: integerNullableSchema,
		c2: integerSchema,
		c3: integerNullableSchema,
		c4: integerSchema,
	});
	expectSchemaShape(tc, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

test('nullability - insert', (tc) => {
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
	const expected = t.Object({
		c1: integerNullableOptionalSchema,
		c2: integerSchema,
		c3: integerNullableOptionalSchema,
		c4: integerOptionalSchema,
		c7: integerOptionalSchema,
	});
	expectSchemaShape(tc, expected).from(result);
});

test('nullability - update', (tc) => {
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
	const expected = t.Object({
		c1: integerNullableOptionalSchema,
		c2: integerOptionalSchema,
		c3: integerNullableOptionalSchema,
		c4: integerOptionalSchema,
		c7: integerOptionalSchema,
	});
	expectSchemaShape(tc, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

test('refine table - select', (tc) => {
	const table = pgTable('test', {
		c1: integer(),
		c2: integer().notNull(),
		c3: integer().notNull(),
	});

	const result = createSelectSchema(table, {
		c2: (schema) => t.Integer({ minimum: (<any> schema).minimum, maximum: 1000 }),
		c3: t.Integer({ minimum: 1, maximum: 10 }),
	});
	const expected = t.Object({
		c1: integerNullableSchema,
		c2: extendedSchema,
		c3: customSchema,
	});
	expectSchemaShape(tc, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

test('refine table - select with custom data type', (tc) => {
	const customText = customType({ codec: 'text', dataType: () => 'text' });
	const table = pgTable('test', {
		c1: integer(),
		c2: integer().notNull(),
		c3: integer().notNull(),
		c4: customText(),
	});

	const customTextSchema = t.String({ minLength: 1, maxLength: 100 });
	const result = createSelectSchema(table, {
		c2: (schema) => t.Integer({ minimum: (<any> schema).minimum, maximum: 1000 }),
		c3: t.Integer({ minimum: 1, maximum: 10 }),
		c4: customTextSchema,
	});
	const expected = t.Object({
		c1: integerNullableSchema,
		c2: extendedSchema,
		c3: customSchema,
		c4: customTextSchema,
	});

	expectSchemaShape(tc, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

test('refine table - insert', (tc) => {
	const table = pgTable('test', {
		c1: integer(),
		c2: integer().notNull(),
		c3: integer().notNull(),
		c4: integer().generatedAlwaysAs(sql`1`),
	});

	const result = createInsertSchema(table, {
		c2: (schema) => t.Integer({ minimum: (<any> schema).minimum, maximum: 1000 }),
		c3: t.Integer({ minimum: 1, maximum: 10 }),
	});
	const expected = t.Object({
		c1: integerNullableOptionalSchema,
		c2: extendedSchema,
		c3: customSchema,
	});
	expectSchemaShape(tc, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

test('refine table - update', (tc) => {
	const table = pgTable('test', {
		c1: integer(),
		c2: integer().notNull(),
		c3: integer().notNull(),
		c4: integer().generatedAlwaysAs(sql`1`),
	});

	const result = createUpdateSchema(table, {
		c2: (schema) => t.Integer({ minimum: (<any> schema).minimum, maximum: 1000 }),
		c3: t.Integer({ minimum: 1, maximum: 10 }),
	});
	const expected = t.Object({
		c1: integerNullableOptionalSchema,
		c2: extendedOptionalSchema,
		c3: customSchema,
	});
	expectSchemaShape(tc, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

test('refine view - select', (tc) => {
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
		c2: (schema) => t.Integer({ minimum: (<any> schema).minimum, maximum: 1000 }),
		c3: t.Integer({ minimum: 1, maximum: 10 }),
		nested: {
			c5: (schema) => t.Integer({ minimum: (<any> schema).minimum, maximum: 1000 }),
			c6: t.Integer({ minimum: 1, maximum: 10 }),
		},
		table: {
			c2: (schema) => t.Integer({ minimum: (<any> schema).minimum, maximum: 1000 }),
			c3: t.Integer({ minimum: 1, maximum: 10 }),
		},
	});
	const expected = t.Object({
		c1: integerNullableSchema,
		c2: extendedNullableSchema,
		c3: customSchema,
		nested: t.Object({
			c4: integerNullableSchema,
			c5: extendedNullableSchema,
			c6: customSchema,
		}),
		table: t.Object({
			c1: integerNullableSchema,
			c2: extendedNullableSchema,
			c3: customSchema,
			c4: integerNullableSchema,
			c5: integerNullableSchema,
			c6: integerNullableSchema,
		}),
	});
	expectSchemaShape(tc, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

test('all data types', (tc) => {
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
	const expected = t.Object({
		bigint1: t.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
		bigint2: t.BigInt({ minimum: CONSTANTS.INT64_MIN, maximum: CONSTANTS.INT64_MAX }),
		bigint3: new TBigIntString(),
		bigserial1: t.Integer({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
		bigserial2: t.BigInt({ minimum: CONSTANTS.INT64_MIN, maximum: CONSTANTS.INT64_MAX }),
		bit: t.String({ pattern: /^[01]*$/, minLength: 5, maxLength: 5 }),
		boolean: t.Boolean(),
		date1: new TDate(),
		date2: t.String(),
		char1: t.String({ maxLength: 10 }),
		char2: t.Enum(['a', 'b', 'c']),
		cidr: t.String(),
		doublePrecision: t.Number({ minimum: CONSTANTS.INT48_MIN, maximum: CONSTANTS.INT48_MAX }),
		geometry1: t.Tuple([t.Number(), t.Number()]),
		geometry2: t.Object({ x: t.Number(), y: t.Number() }),
		halfvec: t.Array(t.Number(), { minItems: 3, maxItems: 3 }),
		inet: t.String(),
		integer: t.Integer({ minimum: CONSTANTS.INT32_MIN, maximum: CONSTANTS.INT32_MAX }),
		interval: t.String(),
		json: jsonSchema,
		jsonb: jsonSchema,
		line1: t.Object({ a: t.Number(), b: t.Number(), c: t.Number() }),
		line2: t.Tuple([t.Number(), t.Number(), t.Number()]),
		macaddr: t.String(),
		macaddr8: t.String(),
		numeric1: t.Number({ minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
		numeric2: t.BigInt({ minimum: CONSTANTS.INT64_MIN, maximum: CONSTANTS.INT64_MAX }),
		numeric3: t.String(),
		point1: t.Object({ x: t.Number(), y: t.Number() }),
		point2: t.Tuple([t.Number(), t.Number()]),
		real: t.Number({ minimum: CONSTANTS.INT24_MIN, maximum: CONSTANTS.INT24_MAX }),
		serial: t.Integer({ minimum: CONSTANTS.INT32_MIN, maximum: CONSTANTS.INT32_MAX }),
		smallint: t.Integer({ minimum: CONSTANTS.INT16_MIN, maximum: CONSTANTS.INT16_MAX }),
		smallserial: t.Integer({ minimum: CONSTANTS.INT16_MIN, maximum: CONSTANTS.INT16_MAX }),
		text1: t.String(),
		text2: t.Enum(['a', 'b', 'c']),
		sparsevec: t.String(),
		time: t.String(),
		timestamp1: new TDate(),
		timestamp2: t.String(),
		uuid: t.String({ format: 'uuid' }),
		varchar1: t.String({ maxLength: 10 }),
		varchar2: t.Enum(['a', 'b', 'c']),
		vector: t.Array(t.Number(), { minItems: 3, maxItems: 3 }),
		array1: t.Array(integerSchema),
		array2: t.Array(t.Array(integerSchema)),
		array3: t.Array(t.Array(t.String({ maxLength: 10 }))),
	});
	expectSchemaShape(tc, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
	Expect<Equal<Static<typeof result>, Static<typeof expected>>>();
});

/* Infinitely recursive type */ {
	const TopLevelCondition: GenericSchema<TopLevelCondition> = t.Any() as any;

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
	const expected = t.Object({
		tlc: TopLevelCondition,
	});

	Expect<Equal<Static<typeof result>, Static<typeof expected>>>();
}

/* Disallow unknown keys in table refinement - select */ {
	const table = pgTable('test', { id: integer() });
	// @ts-expect-error
	createSelectSchema(table, { unknown: t.String() });
}

/* Disallow unknown keys in table refinement - insert */ {
	const table = pgTable('test', { id: integer() });
	// @ts-expect-error
	createInsertSchema(table, { unknown: t.String() });
}

/* Disallow unknown keys in table refinement - update */ {
	const table = pgTable('test', { id: integer() });
	// @ts-expect-error
	createUpdateSchema(table, { unknown: t.String() });
}

/* Disallow unknown keys in view qb - select */ {
	const table = pgTable('test', { id: integer() });
	const view = pgView('test').as((qb) => qb.select().from(table));
	const mView = pgMaterializedView('test').as((qb) => qb.select().from(table));
	const nestedSelect = pgView('test').as((qb) => qb.select({ table }).from(table));
	// @ts-expect-error
	createSelectSchema(view, { unknown: t.String() });
	// @ts-expect-error
	createSelectSchema(mView, { unknown: t.String() });
	// @ts-expect-error
	createSelectSchema(nestedSelect, { table: { unknown: t.String() } });
}

/* Disallow unknown keys in view columns - select */ {
	const view = pgView('test', { id: integer() }).as(sql``);
	const mView = pgView('test', { id: integer() }).as(sql``);
	// @ts-expect-error
	createSelectSchema(view, { unknown: t.String() });
	// @ts-expect-error
	createSelectSchema(mView, { unknown: t.String() });
}
