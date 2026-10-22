import { OptionalKind, Type as t } from '@sinclair/typebox';
import type { TObject, TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
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
import type {
	CreateInsertSchema,
	CreateSchemaFactoryOptions,
	CreateSelectSchema,
	CreateUpdateSchema,
} from './schema.types.ts';

export function handleColumns(
	columns: Record<string, any>,
	refinements: Record<string, any>,
	conditions: Conditions,
	factory?: CreateSchemaFactoryOptions,
): TSchema {
	const columnSchemas: Record<string, TSchema> = {};

	for (const [key, selected] of Object.entries(columns)) {
		if (!is(selected, Column) && !is(selected, SQL) && !is(selected, SQL.Aliased) && typeof selected === 'object') {
			const columns = isTable(selected) || isView(selected) ? getColumns(selected) : selected;
			const nested = handleColumns(columns, refinements[key] ?? {}, conditions, factory);
			columnSchemas[key] = is(selected, EmbeddedColumns) ? conditions.group(nested) : nested;
			continue;
		}

		const refinement = refinements[key];
		if (refinement !== undefined && typeof refinement !== 'function') {
			columnSchemas[key] = refinement;
			continue;
		}

		const column = is(selected, Column) ? selected : undefined;
		const schema = column ? columnToSchema(column, factory?.typeboxInstance ?? t) : t.Any();
		const refined = typeof refinement === 'function' ? refinement(schema) : schema;

		if (conditions.never(column)) {
			continue;
		} else {
			columnSchemas[key] = refined;
		}

		if (column) {
			if (conditions.nullable(column)) {
				columnSchemas[key] = t.Union([columnSchemas[key]!, t.Null()]);
			}

			if (conditions.optional(column)) {
				columnSchemas[key] = t.Optional(columnSchemas[key]!);
			}
		}
	}

	return t.Object(columnSchemas) as any;
}

export function handleEnum(enum_: PgEnum<any>, factory?: CreateSchemaFactoryOptions) {
	const typebox: typeof t = factory?.typeboxInstance ?? t;
	return typebox.Enum(mapEnumValues(enum_.enumValues));
}

/**
 * `Type.Optional` is a property modifier. `Value.Check` ignores it, so an optional field still
 * rejects `undefined` unless the modifier is read off the schema.
 */
function fieldAcceptsUndefined(field: TSchema): boolean {
	return field[OptionalKind] === 'Optional' || Value.Check(field, undefined);
}

const selectConditions: Conditions = {
	never: () => false,
	optional: () => false,
	nullable: (column) => !column.notNull,
	group: (schema) => schema,
};

const insertConditions: Conditions = {
	never: (column) =>
		column?.generated?.type === 'always' || column?.generatedIdentity?.type === 'always'
		|| ('identity' in (column ?? {}) && typeof (column as any)?.identity !== 'undefined'),
	optional: (column) => !column.notNull || (column.notNull && column.hasDefault),
	nullable: (column) => !column.notNull,
	// A group can be left out when every field in it accepts undefined
	group: (schema) =>
		Object.values((schema as TObject).properties).every(fieldAcceptsUndefined) ? t.Optional(schema) : schema,
};

const updateConditions: Conditions = {
	never: (column) =>
		column?.generated?.type === 'always' || column?.generatedIdentity?.type === 'always'
		|| ('identity' in (column ?? {}) && typeof (column as any)?.identity !== 'undefined'),
	optional: () => true,
	nullable: (column) => !column.notNull,
	// Writing `null` to a group clears every column in it
	group: (schema) => t.Optional(t.Union([schema, t.Null()])),
};

export const createSelectSchema: CreateSelectSchema = (
	entity: Table | View | PgEnum<[string, ...string[]]>,
	refine?: Record<string, any>,
) => {
	if (isWithEnum(entity)) {
		return handleEnum(entity);
	}
	const columns = isTable(entity) ? getTableShape(entity) : getColumns(entity);
	return handleColumns(columns, refine ?? {}, selectConditions) as any;
};

export const createInsertSchema: CreateInsertSchema = (
	entity: Table,
	refine?: Record<string, any>,
) => {
	const columns = getTableShape(entity);
	return handleColumns(columns, refine ?? {}, insertConditions) as any;
};

export const createUpdateSchema: CreateUpdateSchema = (
	entity: Table,
	refine?: Record<string, any>,
) => {
	const columns = getTableShape(entity);
	return handleColumns(columns, refine ?? {}, updateConditions) as any;
};

export function createSchemaFactory(options?: CreateSchemaFactoryOptions) {
	const createSelectSchema: CreateSelectSchema = (
		entity: Table | View | PgEnum<[string, ...string[]]>,
		refine?: Record<string, any>,
	) => {
		if (isWithEnum(entity)) {
			return handleEnum(entity, options);
		}
		const columns = isTable(entity) ? getTableShape(entity) : getColumns(entity);
		return handleColumns(columns, refine ?? {}, selectConditions, options) as any;
	};

	const createInsertSchema: CreateInsertSchema = (
		entity: Table,
		refine?: Record<string, any>,
	) => {
		const columns = getTableShape(entity);
		return handleColumns(columns, refine ?? {}, insertConditions, options) as any;
	};

	const createUpdateSchema: CreateUpdateSchema = (
		entity: Table,
		refine?: Record<string, any>,
	) => {
		const columns = getTableShape(entity);
		return handleColumns(columns, refine ?? {}, updateConditions, options) as any;
	};

	return { createSelectSchema, createInsertSchema, createUpdateSchema };
}
