import * as v from 'valibot';
import { Column } from '~/column.ts';
import { EmbeddedColumns, getTableShape } from '~/embed.ts';
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

function handleColumns(
	columns: Record<string, any>,
	refinements: Record<string, any>,
	conditions: Conditions,
): v.GenericSchema {
	const columnSchemas: Record<string, v.GenericSchema> = {};

	for (const [key, selected] of Object.entries(columns)) {
		if (!is(selected, Column) && !is(selected, SQL) && !is(selected, SQL.Aliased) && typeof selected === 'object') {
			const columns = isTable(selected) ? getTableShape(selected) : isView(selected) ? getColumns(selected) : selected;
			const nested = handleColumns(columns, refinements[key] ?? {}, conditions);
			columnSchemas[key] = is(selected, EmbeddedColumns) ? conditions.group(nested) : nested;
			continue;
		}

		const refinement = refinements[key];
		if (refinement !== undefined && typeof refinement !== 'function') {
			columnSchemas[key] = refinement;
			continue;
		}

		const column = is(selected, Column) ? selected : undefined;
		const schema = column ? columnToSchema(column) : v.any();
		const refined = typeof refinement === 'function' ? refinement(schema) : schema;

		if (conditions.never(column)) {
			continue;
		} else {
			columnSchemas[key] = refined;
		}

		if (column) {
			if (conditions.nullable(column)) {
				columnSchemas[key] = v.nullable(columnSchemas[key]!);
			}

			if (conditions.optional(column)) {
				columnSchemas[key] = v.optional(columnSchemas[key]!);
			}
		}
	}

	return v.object(columnSchemas) as any;
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
		nullable: (column) => !column.notNull,
		group: (schema) => schema,
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
		optional: (column) => !column.notNull || (column.notNull && column.hasDefault),
		nullable: (column) => !column.notNull,
		// A group can be left out when every field in it can
		group: (schema) =>
			Object.values((schema as unknown as { entries: Record<string, v.GenericSchema> }).entries).every((field) =>
					v.safeParse(field, undefined).success
				)
				? v.optional(schema)
				: schema,
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
		nullable: (column) => !column.notNull,
		// Writing `null` to a group clears every column in it
		group: (schema) => v.optional(v.nullable(schema)),
	}) as any;
};
