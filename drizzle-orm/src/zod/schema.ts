import { z } from 'zod/v4';
import { Column } from '~/column.ts';
import { EmbeddedColumns, embeddedUnionKeyOf, embeddedUnionsOf, getTableShape, unionColumnNotNull } from '~/embed.ts';
import { is } from '~/entity.ts';
import type { PgEnum } from '~/pg-core/columns/enum.ts';
import { SQL } from '~/sql/sql.ts';
import { isTable, type Table } from '~/table.ts';
import { getColumns } from '~/utils.ts';
import { isView, type View } from '~/view.ts';
import { isWithEnum } from '../utils.ts';
import { columnToSchema } from './column.ts';
import type { Conditions } from './schema.types.internal.ts';
import type {
	CoerceOptions,
	CreateInsertSchema,
	CreateSchemaFactoryOptions,
	CreateSelectSchema,
	CreateUpdateSchema,
	FactoryOptions,
} from './schema.types.ts';

/**
 * @param inVariant whether the columns are in a `taggedUnion()` variant, whose rows read them as declared
 * rather than as the database stores them
 */
function handleColumns(
	columns: Record<string, any>,
	refinements: Record<string, any>,
	conditions: Conditions,
	factory?: FactoryOptions,
	inVariant = false,
): z.ZodObject {
	const columnSchemas: Record<string, z.ZodType> = {};

	for (const [key, selected] of Object.entries(columns)) {
		if (!is(selected, Column) && !is(selected, SQL) && !is(selected, SQL.Aliased) && typeof selected === 'object') {
			if (is(selected, EmbeddedColumns) && embeddedUnionKeyOf(selected) !== undefined) {
				columnSchemas[key] = conditions.union(handleUnion(selected, refinements[key] ?? {}, conditions, factory));
				continue;
			}
			const columns = isTable(selected) ? getTableShape(selected) : isView(selected) ? getColumns(selected) : selected;
			const nested = handleColumns(columns, refinements[key] ?? {}, conditions, factory, inVariant);
			columnSchemas[key] = is(selected, EmbeddedColumns) ? conditions.group(nested) : nested;
			continue;
		}

		const notNull = is(selected, Column) && inVariant ? unionColumnNotNull(selected) : undefined;
		const schema = handleField(selected, refinements[key], conditions, factory, notNull);
		if (schema) columnSchemas[key] = schema;
	}

	return z.object(columnSchemas);
}

/** A selected field's schema, or `undefined` when it is left out. `notNull` overrides the column's own. */
function handleField(
	selected: unknown,
	refinement: any,
	conditions: Conditions,
	factory?: FactoryOptions,
	notNull?: boolean,
): z.ZodType | undefined {
	if (refinement !== undefined && typeof refinement !== 'function') return refinement;

	const column = is(selected, Column) ? selected : undefined;
	const schema = column ? columnToSchema(column, factory) : z.any();
	let refined: z.ZodType = typeof refinement === 'function' ? refinement(schema) : schema;

	if (conditions.never(column)) return undefined;

	if (column) {
		const columnNotNull = notNull ?? column.notNull;
		if (conditions.nullable(column, columnNotNull)) refined = refined.nullable();
		if (conditions.optional(column, columnNotNull)) refined = refined.optional();
	}
	return refined;
}

/**
 * A `taggedUnion()` group: one strict object per variant, holding its tag, its columns as declared and the
 * shared columns it declares. Refinements follow the group's columns; its tag column is not refined.
 */
function handleUnion(
	group: EmbeddedColumns,
	refinements: Record<string, any>,
	conditions: Conditions,
	factory?: FactoryOptions,
): z.ZodType {
	const key = embeddedUnionKeyOf(group)!;
	const { tags, shared } = embeddedUnionsOf(group[key])!.at(-1)!.union;

	const variants = tags.map((tag) => {
		const variant = group[tag];
		const shape: Record<string, z.ZodType> = {
			[key]: z.literal(tag),
			...(is(variant, EmbeddedColumns)
				? handleColumns(variant, refinements[tag] ?? {}, conditions, factory, true).shape
				: {}),
		};
		for (const [field, declaredBy] of Object.entries(shared)) {
			if (!declaredBy.includes(tag)) continue;
			const column = group[field] as Column;
			const schema = handleField(column, refinements[field], conditions, factory, unionColumnNotNull(column, tag));
			if (schema) shape[field] = schema;
		}
		// A field of another variant is an error, not dropped
		return z.strictObject(shape);
	});

	return z.discriminatedUnion(key, variants as [z.ZodObject, ...z.ZodObject[]]);
}

function handleEnum(
	enum_: PgEnum<any>,
	factory?: FactoryOptions,
) {
	const zod: typeof z = factory?.zodInstance ?? z;
	return zod.enum(enum_.enumValues);
}

const selectConditions: Conditions = {
	never: () => false,
	optional: () => false,
	nullable: (_column, notNull) => !notNull,
	group: (schema) => schema,
	union: (schema) => schema,
};

const insertConditions: Conditions = {
	never: (column) =>
		column?.generated?.type === 'always' || column?.generatedIdentity?.type === 'always'
		|| ('identity' in (column ?? {}) && typeof (column as any)?.identity !== 'undefined'),
	optional: (column, notNull) => !notNull || column.hasDefault,
	nullable: (_column, notNull) => !notNull,
	// A group can be left out when every field in it can
	group: (schema) =>
		Object.values((schema as z.ZodObject).shape).every((field) => field.safeParse(undefined).success)
			? schema.optional()
			: schema,
	// A union is written whole, with its tag
	union: (schema) => schema,
};

const updateConditions: Conditions = {
	never: (column) =>
		column?.generated?.type === 'always' || column?.generatedIdentity?.type === 'always'
		|| ('identity' in (column ?? {}) && typeof (column as any)?.identity !== 'undefined'),
	optional: () => true,
	nullable: (_column, notNull) => !notNull,
	// Writing `null` to a group clears every column in it
	group: (schema) => schema.nullable().optional(),
	// A union can be left out, but not cleared
	union: (schema) => schema.optional(),
};

export const createSelectSchema: CreateSelectSchema<undefined> = (
	entity: Table | View | PgEnum<[string, ...string[]]>,
	refine?: Record<string, any>,
) => {
	if (isWithEnum(entity)) {
		return handleEnum(entity);
	}
	const columns = isTable(entity) ? getTableShape(entity) : getColumns(entity);
	return handleColumns(columns, refine ?? {}, selectConditions) as any;
};

export const createInsertSchema: CreateInsertSchema<undefined> = (
	entity: Table,
	refine?: Record<string, any>,
) => {
	const columns = getTableShape(entity);
	return handleColumns(columns, refine ?? {}, insertConditions) as any;
};

export const createUpdateSchema: CreateUpdateSchema<undefined> = (
	entity: Table,
	refine?: Record<string, any>,
) => {
	const columns = getTableShape(entity);
	return handleColumns(columns, refine ?? {}, updateConditions) as any;
};

export function createSchemaFactory<
	TCoerce extends CoerceOptions,
>(options?: CreateSchemaFactoryOptions<TCoerce>) {
	const createSelectSchema: CreateSelectSchema<TCoerce> = (
		entity: Table | View | PgEnum<[string, ...string[]]>,
		refine?: Record<string, any>,
	) => {
		if (isWithEnum(entity)) {
			return handleEnum(entity, options);
		}
		const columns = isTable(entity) ? getTableShape(entity) : getColumns(entity);
		return handleColumns(columns, refine ?? {}, selectConditions, options) as any;
	};

	const createInsertSchema: CreateInsertSchema<TCoerce> = (
		entity: Table,
		refine?: Record<string, any>,
	) => {
		const columns = getTableShape(entity);
		return handleColumns(columns, refine ?? {}, insertConditions, options) as any;
	};

	const createUpdateSchema: CreateUpdateSchema<TCoerce> = (
		entity: Table,
		refine?: Record<string, any>,
	) => {
		const columns = getTableShape(entity);
		return handleColumns(columns, refine ?? {}, updateConditions, options) as any;
	};

	return { createSelectSchema, createInsertSchema, createUpdateSchema };
}
