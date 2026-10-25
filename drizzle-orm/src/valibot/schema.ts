import * as v from 'valibot';
import { Column } from '~/column.ts';
import { EmbeddedColumns, embeddedUnionKeyOf, embeddedUnionsOf, getTableShape, unionColumnNotNull } from '~/embed.ts';
import { is } from '~/entity.ts';
import type { PgEnum } from '~/pg-core/columns/enum.ts';
import { SQL } from '~/sql/sql.ts';
import { isTable, type Table } from '~/table.ts';
import { getColumns } from '~/utils.ts';
import { isView, type View } from '~/view.ts';
import { isWithEnum } from '../utils.ts';
import { columnToSchema, mapEnumValues } from './column.ts';
import type { Conditions } from './schema.types.internal.ts';
import type { CreateInsertSchema, CreateSelectSchema, CreateUpdateSchema } from './schema.types.ts';

/**
 * @param inVariant whether the columns are in a `taggedUnion()` variant, whose rows read them as declared
 * rather than as the database stores them
 */
function handleColumns(
	columns: Record<string, any>,
	refinements: Record<string, any>,
	conditions: Conditions,
	inVariant = false,
): v.ObjectSchema<v.ObjectEntries, undefined> {
	const columnSchemas: Record<string, v.GenericSchema> = {};

	for (const [key, selected] of Object.entries(columns)) {
		if (!is(selected, Column) && !is(selected, SQL) && !is(selected, SQL.Aliased) && typeof selected === 'object') {
			if (is(selected, EmbeddedColumns) && embeddedUnionKeyOf(selected) !== undefined) {
				columnSchemas[key] = conditions.union(handleUnion(selected, refinements[key] ?? {}, conditions));
				continue;
			}
			const columns = isTable(selected) ? getTableShape(selected) : isView(selected) ? getColumns(selected) : selected;
			const nested = handleColumns(columns, refinements[key] ?? {}, conditions, inVariant);
			columnSchemas[key] = is(selected, EmbeddedColumns) ? conditions.group(nested) : nested;
			continue;
		}

		const notNull = is(selected, Column) && inVariant ? unionColumnNotNull(selected) : undefined;
		const schema = handleField(selected, refinements[key], conditions, notNull);
		if (schema) columnSchemas[key] = schema;
	}

	return v.object(columnSchemas);
}

/** A selected field's schema, or `undefined` when it is left out. `notNull` overrides the column's own. */
function handleField(
	selected: unknown,
	refinement: any,
	conditions: Conditions,
	notNull?: boolean,
): v.GenericSchema | undefined {
	if (refinement !== undefined && typeof refinement !== 'function') return refinement;

	const column = is(selected, Column) ? selected : undefined;
	const schema = column ? columnToSchema(column) : v.any();
	let refined: v.GenericSchema = typeof refinement === 'function' ? refinement(schema) : schema;

	if (conditions.never(column)) return undefined;

	if (column) {
		const columnNotNull = notNull ?? column.notNull;
		if (conditions.nullable(column, columnNotNull)) refined = v.nullable(refined);
		if (conditions.optional(column, columnNotNull)) refined = v.optional(refined);
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
): v.GenericSchema {
	const key = embeddedUnionKeyOf(group)!;
	const { tags, shared } = embeddedUnionsOf(group[key])!.at(-1)!.union;

	const variants = tags.map((tag) => {
		const variant = group[tag];
		const entries: v.ObjectEntries = {
			[key]: v.literal(tag),
			...(is(variant, EmbeddedColumns) ? handleColumns(variant, refinements[tag] ?? {}, conditions, true).entries : {}),
		};
		for (const [field, declaredBy] of Object.entries(shared)) {
			if (!declaredBy.includes(tag)) continue;
			const column = group[field] as Column;
			const schema = handleField(column, refinements[field], conditions, unionColumnNotNull(column, tag));
			if (schema) entries[field] = schema;
		}
		// A field of another variant is an error, not dropped
		return v.strictObject(entries);
	});

	return v.variant(key, variants);
}

export const createSelectSchema: CreateSelectSchema = (
	entity: Table | View | PgEnum<[string, ...string[]]>,
	refine?: Record<string, any>,
) => {
	if (isWithEnum(entity)) {
		return v.enum(mapEnumValues(entity.enumValues));
	}
	const columns = isTable(entity) ? getTableShape(entity) : getColumns(entity);
	return handleColumns(columns, refine ?? {}, {
		never: () => false,
		optional: () => false,
		nullable: (_column, notNull) => !notNull,
		group: (schema) => schema,
		union: (schema) => schema,
	}) as any;
};

export const createInsertSchema: CreateInsertSchema = (
	entity: Table,
	refine?: Record<string, any>,
) => {
	const columns = getTableShape(entity);
	return handleColumns(columns, refine ?? {}, {
		never: (column) =>
			column?.generated?.type === 'always' || column?.generatedIdentity?.type === 'always'
			|| ('identity' in (column ?? {}) && typeof (column as any)?.identity !== 'undefined'),
		optional: (column, notNull) => !notNull || column.hasDefault,
		nullable: (_column, notNull) => !notNull,
		// A group can be left out when every field in it can
		group: (schema) =>
			Object.values((schema as unknown as { entries: Record<string, v.GenericSchema> }).entries).every((field) =>
					v.safeParse(field, undefined).success
				)
				? v.optional(schema)
				: schema,
		// A union is written whole, with its tag
		union: (schema) => schema,
	}) as any;
};

export const createUpdateSchema: CreateUpdateSchema = (
	entity: Table,
	refine?: Record<string, any>,
) => {
	const columns = getTableShape(entity);
	return handleColumns(columns, refine ?? {}, {
		never: (column) =>
			column?.generated?.type === 'always' || column?.generatedIdentity?.type === 'always'
			|| ('identity' in (column ?? {}) && typeof (column as any)?.identity !== 'undefined'),
		optional: () => true,
		nullable: (_column, notNull) => !notNull,
		// Writing `null` to a group clears every column in it
		group: (schema) => v.optional(v.nullable(schema)),
		// A union can be left out, but not cleared
		union: (schema) => v.optional(schema),
	}) as any;
};
