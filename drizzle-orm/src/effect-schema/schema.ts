import { Result, Schema as s } from 'effect';
import type { Top as SchemaTop } from 'effect/Schema';
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

function isOptional(schema: unknown): schema is s.optional<SchemaTop> {
	if ((typeof schema !== 'object' || schema === null) && typeof schema !== 'function') return false;

	return s.isSchema(schema) && (schema as any).ast?.context?.isOptional === true;
}

function isStructField(schema: unknown): schema is s.optional<SchemaTop> | SchemaTop {
	if (s.isSchema(schema)) return true;

	return isOptional(schema);
}

/** True when a struct field can be left out: its schema accepts `undefined`. */
function acceptsUndefined(schema: SchemaTop): boolean {
	const decoder = schema as unknown as Parameters<typeof s.decodeUnknownResult>[0];
	return Result.isSuccess(s.decodeUnknownResult(decoder)(undefined));
}

function handleColumns(
	columns: Record<string, any>,
	refinements: Record<string, any>,
	conditions: Conditions,
): SchemaTop {
	const columnSchemas: Record<string, SchemaTop | s.optional<SchemaTop>> = {};
	for (const [key, selected] of Object.entries(columns)) {
		if (!is(selected, Column) && !is(selected, SQL) && !is(selected, SQL.Aliased) && typeof selected === 'object') {
			const columns = isTable(selected) || isView(selected) ? getColumns(selected) : selected;
			const nested = handleColumns(columns, refinements[key] ?? {}, conditions);
			columnSchemas[key] = is(selected, EmbeddedColumns) ? conditions.group(nested) : nested;
			continue;
		}

		const refinement = refinements[key];

		if (refinement !== undefined && !(typeof refinement === 'function' && !isStructField(refinement))) {
			columnSchemas[key] = refinement;
			continue;
		}

		const column = is(selected, Column) ? selected : undefined;
		const schema = column ? columnToSchema(column) : s.Any;
		const _refined = isStructField(refinement) || typeof refinement !== 'function' ? schema : refinement(schema);
		const refined = isOptional(_refined) ? (_refined as any).schema : _refined as SchemaTop;

		if (conditions.never(column)) {
			continue;
		} else {
			columnSchemas[key] = refined;
		}

		if (column) {
			if (conditions.nullable(column)) {
				columnSchemas[key] = s.NullOr(columnSchemas[key] as SchemaTop);
			}

			if (conditions.optional(column)) {
				columnSchemas[key] = s.optional(s.UndefinedOr(columnSchemas[key] as SchemaTop));
			}
		}
	}

	return s.Struct(columnSchemas);
}

function handleEnum(
	enum_: PgEnum<[string, ...string[]]>,
) {
	return s.Literals(enum_.enumValues);
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
	group: (schema) => {
		const fields = (schema as { readonly fields?: Readonly<Record<string, SchemaTop>> }).fields;
		return fields !== undefined && Object.values(fields).every(acceptsUndefined)
			? s.optional(s.UndefinedOr(schema))
			: schema;
	},
};

const updateConditions: Conditions = {
	never: (column) =>
		column?.generated?.type === 'always' || column?.generatedIdentity?.type === 'always'
		|| ('identity' in (column ?? {}) && typeof (column as any)?.identity !== 'undefined'),
	optional: () => true,
	nullable: (column) => !column.notNull,
	// Writing `null` to a group clears every column in it
	group: (schema) => s.optional(s.UndefinedOr(s.NullOr(schema))),
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
