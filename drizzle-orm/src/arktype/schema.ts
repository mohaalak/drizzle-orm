import { type Type, type } from 'arktype';
import { Column } from '~/column.ts';
import { EmbeddedColumns, getTableShape } from '~/embed.ts';
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
	const columnSchemas: Record<string, Type> = {};

	for (const [key, selected] of Object.entries(columns)) {
		if (!is(selected, Column) && !is(selected, SQL) && !is(selected, SQL.Aliased) && typeof selected === 'object') {
			const columns = isTable(selected) ? getTableShape(selected) : isView(selected) ? getColumns(selected) : selected;
			const nested = handleColumns(columns, refinements[key] ?? {}, conditions);
			columnSchemas[key] = is(selected, EmbeddedColumns) ? conditions.group(nested) : nested;
			continue;
		}

		const refinement = refinements[key];
		if (
			refinement !== undefined
			&& (typeof refinement !== 'function' || (typeof refinement === 'function' && refinement.expression !== undefined))
		) {
			columnSchemas[key] = refinement;
			continue;
		}

		const column = is(selected, Column) ? selected : undefined;
		const schema = column ? columnToSchema(column) : type.unknown;
		const refined = typeof refinement === 'function' ? refinement(schema) : schema;

		if (conditions.never(column)) {
			continue;
		} else {
			columnSchemas[key] = refined;
		}

		if (column) {
			if (conditions.nullable(column)) {
				columnSchemas[key] = columnSchemas[key]!.or(type.null);
			}

			if (conditions.optional(column)) {
				columnSchemas[key] = columnSchemas[key]!.optional() as any;
			}
		}
	}

	return type(columnSchemas);
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
		nullable: (column) => !column.notNull,
		group: (schema) => schema,
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
		optional: (column) => !column.notNull || (column.notNull && column.hasDefault),
		nullable: (column) => !column.notNull,
		// A group can be left out when every field in it accepts undefined
		group: (schema) => everyFieldAcceptsUndefined(schema) ? schema.optional() : schema,
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
		nullable: (column) => !column.notNull,
		// Writing `null` to a group clears every column in it
		group: (schema) => schema.or(type.null).optional(),
	}) as any;
}) as CreateUpdateSchema;
