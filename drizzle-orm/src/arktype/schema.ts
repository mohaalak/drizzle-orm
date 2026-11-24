import { type Type, type } from 'arktype';
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
import type { CreateInsertSchema, CreateSelectSchema, CreateUpdateSchema } from './schema.types.ts';

/**
 * Arktype keeps "may be omitted" on the object key (`kind: 'optional'`), so a field accepts
 * `undefined` when that key is optional or when the value type itself does.
 */
function everyFieldAcceptsUndefined(schema: Type): boolean {
	const props = (schema as { props?: readonly { kind: string; value: Type }[] }).props;
	if (!props) return false;
	return props.every((prop) => prop.kind === 'optional' || prop.value.allows(undefined));
}

function handleColumns(
	columns: Record<string, any>,
	refinements: Record<string, any>,
	conditions: Conditions,
): Type {
	return type(columnDefinitions(columns, refinements, conditions));
}

/**
 * The object definition of the selected fields.
 *
 * @param inVariant whether the columns are in a `taggedUnion()` variant, whose rows read them as declared
 * rather than as the database stores them
 */
function columnDefinitions(
	columns: Record<string, any>,
	refinements: Record<string, any>,
	conditions: Conditions,
	inVariant = false,
): Record<string, any> {
	const columnSchemas: Record<string, any> = {};

	for (const [key, selected] of Object.entries(columns)) {
		if (!is(selected, Column) && !is(selected, SQL) && !is(selected, SQL.Aliased) && typeof selected === 'object') {
			if (is(selected, EmbeddedColumns) && embeddedUnionKeyOf(selected) !== undefined) {
				columnSchemas[key] = conditions.union(handleUnion(selected, refinements[key] ?? {}, conditions));
				continue;
			}
			const columns = isTable(selected) ? getTableShape(selected) : isView(selected) ? getColumns(selected) : selected;
			const nested = type(columnDefinitions(columns, refinements[key] ?? {}, conditions, inVariant));
			columnSchemas[key] = is(selected, EmbeddedColumns) ? conditions.group(nested) : nested;
			continue;
		}

		const notNull = is(selected, Column) && inVariant ? unionColumnNotNull(selected) : undefined;
		const schema = handleField(selected, refinements[key], conditions, notNull);
		if (schema) columnSchemas[key] = schema;
	}

	return columnSchemas;
}

/** A selected field's schema, or `undefined` when it is left out. `notNull` overrides the column's own. */
function handleField(
	selected: unknown,
	refinement: any,
	conditions: Conditions,
	notNull?: boolean,
): Type | undefined {
	if (
		refinement !== undefined
		&& (typeof refinement !== 'function' || (typeof refinement === 'function' && refinement.expression !== undefined))
	) {
		return refinement;
	}

	const column = is(selected, Column) ? selected : undefined;
	const schema = column ? columnToSchema(column) : type.unknown;
	let refined: Type = typeof refinement === 'function' ? refinement(schema) : schema;

	if (conditions.never(column)) return undefined;

	if (column) {
		const columnNotNull = notNull ?? column.notNull;
		if (conditions.nullable(column, columnNotNull)) refined = refined.or(type.null);
		if (conditions.optional(column, columnNotNull)) refined = refined.optional() as any;
	}
	return refined;
}

/**
 * A `taggedUnion()` group: one object per variant that rejects undeclared keys, holding its tag, its columns
 * as declared and the shared columns it declares. Refinements follow the group's columns; its tag column is
 * not refined.
 */
function handleUnion(
	group: EmbeddedColumns,
	refinements: Record<string, any>,
	conditions: Conditions,
): Type {
	const key = embeddedUnionKeyOf(group)!;
	const { tags, shared } = embeddedUnionsOf(group[key])!.at(-1)!.union;

	const variants = tags.map((tag) => {
		const variant = group[tag];
		const definition: Record<string, any> = {
			[key]: type.unit(tag),
			...(is(variant, EmbeddedColumns) ? columnDefinitions(variant, refinements[tag] ?? {}, conditions, true) : {}),
		};
		for (const [field, declaredBy] of Object.entries(shared)) {
			if (!declaredBy.includes(tag)) continue;
			const column = group[field] as Column;
			const schema = handleField(column, refinements[field], conditions, unionColumnNotNull(column, tag));
			if (schema) definition[field] = schema;
		}
		// A field of another variant is an error, not dropped
		return type(definition).onUndeclaredKey('reject');
	});

	return type.or(...variants);
}

export const createSelectSchema = ((
	entity: Table | View | PgEnum<[string, ...string[]]>,
	refine?: Record<string, any>,
) => {
	if (isWithEnum(entity)) {
		return type.enumerated(...entity.enumValues);
	}
	const columns = isTable(entity) ? getTableShape(entity) : getColumns(entity);
	return handleColumns(columns, refine ?? {}, {
		never: () => false,
		optional: () => false,
		nullable: (_column, notNull) => !notNull,
		group: (schema) => schema,
		union: (schema) => schema,
	}) as any;
}) as CreateSelectSchema;

export const createInsertSchema = ((
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
		// A group can be left out when every field in it accepts undefined
		group: (schema) => everyFieldAcceptsUndefined(schema) ? schema.optional() : schema,
		// A union is written whole, with its tag
		union: (schema) => schema,
	}) as any;
}) as CreateInsertSchema;

export const createUpdateSchema = ((
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
		group: (schema) => schema.or(type.null).optional(),
		// A union can be left out, but not cleared
		union: (schema) => schema.optional(),
	}) as any;
}) as CreateUpdateSchema;
