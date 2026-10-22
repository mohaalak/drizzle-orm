import { type Equal, sql } from 'drizzle-orm';
import {
	customType,
	embed,
	integer,
	pgEnum,
	pgMaterializedView,
	pgSchema,
	pgTable,
	pgView,
	serial,
	text,
} from 'drizzle-orm/pg-core';
import { CONSTANTS } from 'drizzle-orm/utils';
import { createInsertSchema, createSelectSchema, createUpdateSchema } from 'drizzle-orm/valibot';
import { bigintStringModeSchema, jsonSchema } from 'drizzle-orm/valibot/column';
import type { TopLevelCondition } from 'json-rules-engine';
import * as v from 'valibot';
import { expect, test } from 'vitest';
import { Expect, expectEnumValues, expectSchemaShape } from './utils';

const integerSchema = v.pipe(v.number(), v.minValue(CONSTANTS.INT32_MIN), v.maxValue(CONSTANTS.INT32_MAX), v.integer());
const integerNullableSchema = v.nullable(integerSchema);
const integerOptionalSchema = v.optional(integerSchema);
const integerNullableOptionalSchema = v.optional(v.nullable(integerSchema));

const textSchema = v.string();
const textOptionalSchema = v.optional(textSchema);
const textNullableSchema = v.nullable(textSchema);
const textNullableOptionalSchema = v.optional(textNullableSchema);

const anySchema = v.any();

const extendedSchema = v.pipe(integerSchema, v.maxValue(1000));
const extendedNullableSchema = v.nullable(extendedSchema);
const extendedOptionalSchema = v.optional(extendedSchema);

const customSchema = v.pipe(v.string(), v.transform(Number));

test('table - select', (t) => {
	const table = pgTable('test', {
		id: serial().primaryKey(),
		name: text().notNull(),
	});

	const result = createSelectSchema(table);
	const expected = v.object({ id: integerSchema, name: textSchema });
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
	const expected = v.object({ id: integerSchema, name: textSchema });
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
	const expected = v.object({ name: textSchema, age: integerNullableOptionalSchema });
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
	const expected = v.object({
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
	const expected = v.object({
		id: integerSchema,
		address: v.object({
			city: textSchema,
			zip: integerNullableSchema,
			geo: v.object({ lat: integerSchema, lng: integerSchema }),
		}),
		tags: v.object({ main: textNullableSchema, extra: textNullableSchema }),
	});
	expectSchemaShape(t, expected).from(result);
	expectSchemaShape(t, expected.entries.address).from(result.entries.address);
	expectSchemaShape(t, expected.entries.address.entries.geo).from(result.entries.address.entries.geo);
	Expect<Equal<typeof result, typeof expected>>();

	const row = {
		id: 1,
		address: { city: 'Berlin', zip: null, geo: { lat: 1, lng: 2 } },
		tags: { main: 'a', extra: null },
	};
	expect(v.parse(result, row)).toStrictEqual(row);
	expect(v.safeParse(result, { id: 1, 'address.city': 'Berlin' }).success).toBe(false);
});

test('embedded columns - insert', (t) => {
	const result = createInsertSchema(embedTable);
	const expected = v.object({
		address: v.object({
			city: textSchema,
			zip: integerNullableOptionalSchema,
			geo: v.object({ lat: integerSchema, lng: integerSchema }),
		}),
		tags: v.optional(v.object({ main: textNullableOptionalSchema, extra: textNullableOptionalSchema })),
	});
	expectSchemaShape(t, expected).from(result);
	expectSchemaShape(t, expected.entries.address).from(result.entries.address);
	Expect<Equal<typeof result, typeof expected>>();

	expect(v.safeParse(result, { address: { city: 'Berlin', geo: { lat: 1, lng: 2 } } }).success).toBe(true);
	expect(v.safeParse(result, { address: { geo: { lat: 1, lng: 2 } } }).success).toBe(false);
	expect(v.safeParse(result, {}).success).toBe(false);
});

test('embedded columns - update', (t) => {
	const result = createUpdateSchema(embedTable);
	const expected = v.object({
		address: v.optional(v.nullable(v.object({
			city: textOptionalSchema,
			zip: integerNullableOptionalSchema,
			geo: v.optional(v.nullable(v.object({ lat: integerOptionalSchema, lng: integerOptionalSchema }))),
		}))),
		tags: v.optional(v.nullable(v.object({ main: textNullableOptionalSchema, extra: textNullableOptionalSchema }))),
	});
	expectSchemaShape(t, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();

	expect(v.safeParse(result, {}).success).toBe(true);
	expect(v.safeParse(result, { address: { geo: { lat: 3 } } }).success).toBe(true);
	expect(v.safeParse(result, { tags: null }).success).toBe(true);
});

test('embedded columns - refine', (t) => {
	const result = createInsertSchema(embedTable, {
		address: {
			city: (schema) => v.pipe(schema, v.minLength(2)),
			geo: { lat: v.pipe(v.string(), v.transform(Number)) },
		},
	});
	const expected = v.object({
		address: v.object({
			city: v.pipe(textSchema, v.minLength(2)),
			zip: integerNullableOptionalSchema,
			geo: v.object({ lat: v.pipe(v.string(), v.transform(Number)), lng: integerSchema }),
		}),
		tags: v.optional(v.object({ main: textNullableOptionalSchema, extra: textNullableOptionalSchema })),
	});
	expectSchemaShape(t, expected.entries.address).from(result.entries.address);
	Expect<Equal<typeof result, typeof expected>>();

	expect(v.safeParse(result, { address: { city: 'B', geo: { lat: '1', lng: 2 } } }).success).toBe(false);
	expect(v.parse(result, { address: { city: 'Berlin', geo: { lat: '1', lng: 2 } } }).address.geo.lat).toBe(1);

	// @ts-expect-error - unknown key in a group
	createInsertSchema(embedTable, { address: { country: v.string() } });
});

test('view qb - select', (t) => {
	const table = pgTable('test', {
		id: serial().primaryKey(),
		name: text().notNull(),
	});
	const view = pgView('test').as((qb) => qb.select({ id: table.id, age: sql``.as('age') }).from(table));

	const result = createSelectSchema(view);
	const expected = v.object({ id: integerSchema, age: anySchema });
	expectSchemaShape(t, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

test('view columns - select', (t) => {
	const view = pgView('test', {
		id: serial().primaryKey(),
		name: text().notNull(),
	}).as(sql``);

	const result = createSelectSchema(view);
	const expected = v.object({ id: integerSchema, name: textSchema });
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
	const expected = v.object({ id: integerSchema, age: anySchema });
	expectSchemaShape(t, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

test('materialized view columns - select', (t) => {
	const view = pgMaterializedView('test', {
		id: serial().primaryKey(),
		name: text().notNull(),
	}).as(sql``);

	const result = createSelectSchema(view);
	const expected = v.object({ id: integerSchema, name: textSchema });
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
	const expected = v.object({
		id: integerSchema,
		nested: v.object({ name: textSchema, age: anySchema }),
		table: v.object({ id: integerSchema, name: textSchema }),
	});
	expectSchemaShape(t, expected).from(result);
	Expect<Equal<typeof result, typeof expected>>();
});

test('enum - select', (t) => {
	const enum_ = pgEnum('test', ['a', 'b', 'c']);

	const result = createSelectSchema(enum_);
	const expected = v.enum({ a: 'a', b: 'b', c: 'c' });
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
	const expected = v.object({
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
	const expected = v.object({
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
	const expected = v.object({
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
		c2: (schema) => v.pipe(schema, v.maxValue(1000)),
		c3: v.pipe(v.string(), v.transform(Number)),
	});
	const expected = v.object({
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

	const customTextSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(100));
	const result = createSelectSchema(table, {
		c2: (schema) => v.pipe(schema, v.maxValue(1000)),
		c3: v.pipe(v.string(), v.transform(Number)),
		c4: customTextSchema,
	});
	const expected = v.object({
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
		c2: (schema) => v.pipe(schema, v.maxValue(1000)),
		c3: v.pipe(v.string(), v.transform(Number)),
	});
	const expected = v.object({
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
		c2: (schema) => v.pipe(schema, v.maxValue(1000)),
		c3: v.pipe(v.string(), v.transform(Number)),
	});
	const expected = v.object({
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
		c2: (schema) => v.pipe(schema, v.maxValue(1000)),
		c3: v.pipe(v.string(), v.transform(Number)),
		nested: {
			c5: (schema) => v.pipe(schema, v.maxValue(1000)),
			c6: v.pipe(v.string(), v.transform(Number)),
		},
		table: {
			c2: (schema) => v.pipe(schema, v.maxValue(1000)),
			c3: v.pipe(v.string(), v.transform(Number)),
		},
	});
	const expected = v.object({
		c1: integerNullableSchema,
		c2: extendedNullableSchema,
		c3: customSchema,
		nested: v.object({
			c4: integerNullableSchema,
			c5: extendedNullableSchema,
			c6: customSchema,
		}),
		table: v.object({
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
	const expected = v.object({
		bigint1: v.pipe(v.number(), v.minValue(Number.MIN_SAFE_INTEGER), v.maxValue(Number.MAX_SAFE_INTEGER), v.integer()),
		bigint2: v.pipe(v.bigint(), v.minValue(CONSTANTS.INT64_MIN), v.maxValue(CONSTANTS.INT64_MAX)),
		bigint3: bigintStringModeSchema,
		bigserial1: v.pipe(
			v.number(),
			v.minValue(Number.MIN_SAFE_INTEGER),
			v.maxValue(Number.MAX_SAFE_INTEGER),
			v.integer(),
		),
		bigserial2: v.pipe(v.bigint(), v.minValue(CONSTANTS.INT64_MIN), v.maxValue(CONSTANTS.INT64_MAX)),
		bit: v.pipe(v.string(), v.regex(/^[01]*$/), v.length(5 as number)),
		boolean: v.boolean(),
		date1: v.date(),
		date2: v.string(),
		char1: v.pipe(v.string(), v.maxLength(10 as number)),
		char2: v.enum({ a: 'a', b: 'b', c: 'c' }),
		cidr: v.string(),
		doublePrecision: v.pipe(v.number(), v.minValue(CONSTANTS.INT48_MIN), v.maxValue(CONSTANTS.INT48_MAX)),
		geometry1: v.tuple([v.number(), v.number()]),
		geometry2: v.object({ x: v.number(), y: v.number() }),
		halfvec: v.pipe(v.array(v.number()), v.length(3 as number)),
		inet: v.string(),
		integer: v.pipe(v.number(), v.minValue(CONSTANTS.INT32_MIN), v.maxValue(CONSTANTS.INT32_MAX), v.integer()),
		interval: v.string(),
		json: jsonSchema,
		jsonb: jsonSchema,
		line1: v.object({ a: v.number(), b: v.number(), c: v.number() }),
		line2: v.tuple([v.number(), v.number(), v.number()]),
		macaddr: v.string(),
		macaddr8: v.string(),
		numeric1: v.pipe(v.number(), v.minValue(Number.MIN_SAFE_INTEGER), v.maxValue(Number.MAX_SAFE_INTEGER)),
		numeric2: v.pipe(v.bigint(), v.minValue(CONSTANTS.INT64_MIN), v.maxValue(CONSTANTS.INT64_MAX)),
		numeric3: v.string(),
		point1: v.object({ x: v.number(), y: v.number() }),
		point2: v.tuple([v.number(), v.number()]),
		real: v.pipe(v.number(), v.minValue(CONSTANTS.INT24_MIN), v.maxValue(CONSTANTS.INT24_MAX)),
		serial: v.pipe(v.number(), v.minValue(CONSTANTS.INT32_MIN), v.maxValue(CONSTANTS.INT32_MAX), v.integer()),
		smallint: v.pipe(v.number(), v.minValue(CONSTANTS.INT16_MIN), v.maxValue(CONSTANTS.INT16_MAX), v.integer()),
		smallserial: v.pipe(v.number(), v.minValue(CONSTANTS.INT16_MIN), v.maxValue(CONSTANTS.INT16_MAX), v.integer()),
		text1: v.string(),
		text2: v.enum({ a: 'a', b: 'b', c: 'c' }),
		sparsevec: v.string(),
		time: v.string(),
		timestamp1: v.date(),
		timestamp2: v.string(),
		uuid: v.pipe(v.string(), v.uuid()),
		varchar1: v.pipe(v.string(), v.maxLength(10 as number)),
		varchar2: v.enum({ a: 'a', b: 'b', c: 'c' }),
		vector: v.pipe(v.array(v.number()), v.length(3 as number)),
		array1: v.array(integerSchema),
		array2: v.array(v.array(integerSchema)),
		array3: v.array(v.array(v.pipe(v.string(), v.maxLength(10 as number)))),
	});
	// @ts-ignore - TODO: Remake type checks for new columns
	expectSchemaShape(t, expected).from(result);
	// @ts-ignore - TODO: Remake type checks for new columns
	Expect<Equal<typeof result, typeof expected>>();
});

/* Infinitely recursive type */ {
	const TopLevelCondition: v.GenericSchema<TopLevelCondition> = v.custom<TopLevelCondition>(() => true);

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
	const expected = v.object({
		tlc: TopLevelCondition,
	});

	Expect<Equal<v.InferOutput<typeof result>, v.InferOutput<typeof expected>>>();
}

/* Disallow unknown keys in table refinement - select */ {
	const table = pgTable('test', { id: integer() });
	// @ts-expect-error
	createSelectSchema(table, { unknown: v.string() });
}

/* Disallow unknown keys in table refinement - insert */ {
	const table = pgTable('test', { id: integer() });
	// @ts-expect-error
	createInsertSchema(table, { unknown: v.string() });
}

/* Disallow unknown keys in table refinement - update */ {
	const table = pgTable('test', { id: integer() });
	// @ts-expect-error
	createUpdateSchema(table, { unknown: v.string() });
}

/* Disallow unknown keys in view qb - select */ {
	const table = pgTable('test', { id: integer() });
	const view = pgView('test').as((qb) => qb.select().from(table));
	const mView = pgMaterializedView('test').as((qb) => qb.select().from(table));
	const nestedSelect = pgView('test').as((qb) => qb.select({ table }).from(table));
	// @ts-expect-error
	createSelectSchema(view, { unknown: v.string() });
	// @ts-expect-error
	createSelectSchema(mView, { unknown: v.string() });
	// @ts-expect-error
	createSelectSchema(nestedSelect, { table: { unknown: v.string() } });
}

/* Disallow unknown keys in view columns - select */ {
	const view = pgView('test', { id: integer() }).as(sql``);
	const mView = pgView('test', { id: integer() }).as(sql``);
	// @ts-expect-error
	createSelectSchema(view, { unknown: v.string() });
	// @ts-expect-error
	createSelectSchema(mView, { unknown: v.string() });
}
