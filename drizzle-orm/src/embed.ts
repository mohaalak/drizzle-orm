import type { ColumnBuilderBase } from './column-builder.ts';
import type { Column } from './column.ts';
import { entityKind, is } from './entity.ts';
import type { BuildRelationalQueryResult, RelationalRowsMapper } from './relations.ts';
import type { SQL } from './sql/sql.ts';
import { isSQLWrapper } from './sql/sql.ts';
import type { Subquery } from './subquery.ts';
import { Table } from './table.ts';
import type { DrizzleTypeError, IsNever, JoinUnion, Simplify } from './utils.ts';

/**
 * Separates the segments of an embedded column's key in the table's flat column map:
 * `address: embed({ city: text() })` is stored as the column `'address.city'`.
 */
export const EmbeddedKeySeparator = '.';

/**
 * Stands in for {@link EmbeddedKeySeparator} in the keys of columns a dialect selects inside a JSON
 * object, where a `.` in a key would be read as a path (SQL Server's `for json path`). Only a
 * dialect that uses it passes it to {@link nestEmbeddedRelationalRows}.
 */
export const EmbeddedJsonKeySeparator = '→';

export interface EmbedConfig {
	/**
	 * Prepended to the database name of every column in the group that does not set its own name.
	 * Defaults to the group's key followed by an underscore: `address` + `city` → `address_city`.
	 * Pass `''` to keep the columns' own names.
	 */
	prefix?: string;
}

export class EmbedBuilder<TColumns extends Record<string, ColumnBuilderBase | EmbedBuilder<any>> = any> {
	static readonly [entityKind]: string = 'EmbedBuilder';
	static [Symbol.hasInstance](value: unknown): boolean {
		return is(value, this);
	}

	declare readonly _: {
		readonly columns: TColumns;
	};

	constructor(
		/** @internal */
		readonly columns: TColumns,
		/** @internal */
		readonly config: EmbedConfig = {},
	) {}
}

/**
 * Groups columns under one key. The columns stay flat in the database, and the group is read,
 * written and referenced as a nested object.
 *
 * @example
 * ```ts
 * const users = pgTable('users', {
 * 	id: serial().primaryKey(),
 * 	address: embed({
 * 		street: text(),
 * 		city: text().notNull(),
 * 	}),
 * });
 * // columns: "id", "address_street", "address_city"
 *
 * await db.insert(users).values({ address: { street: 'Main St', city: 'Berlin' } });
 * const rows = await db.select().from(users).where(eq(users.address.city, 'Berlin'));
 * rows[0].address.city; // string
 * ```
 */
export function embed<TColumns extends Record<string, ColumnBuilderBase | EmbedBuilder<any>>>(
	columns: TColumns,
	config?: EmbedConfig,
): EmbedBuilder<TColumns> {
	return new EmbedBuilder(columns, config);
}

/**
 * Turns a table definition that may contain `embed()` groups into a flat map of builders keyed
 * by their dotted path, and names each embedded builder after its prefixed path.
 *
 * @internal
 */
export function flattenEmbedBuilders<TBuilder extends ColumnBuilderBase>(
	columns: Record<string, TBuilder | EmbedBuilder>,
	casingFn: (name: string) => string,
	keyPrefix = '',
	namePrefix = '',
	result: Record<string, TBuilder> = {},
): Record<string, TBuilder> {
	for (const [key, value] of Object.entries(columns)) {
		const path = keyPrefix + key;
		if (is(value, EmbedBuilder)) {
			flattenEmbedBuilders(
				value.columns,
				casingFn,
				path + EmbeddedKeySeparator,
				namePrefix + (value.config.prefix ?? `${key}_`),
				result,
			);
			continue;
		}

		// A group's columns take their name from the group's prefix, unless they set their own.
		if (keyPrefix) {
			(value as any).setName(namePrefix + key, casingFn);
		}
		result[path] = value as TBuilder;
	}

	return result;
}

/**
 * The columns of one `embed()` group, as they appear on the built table: `users.address.city`.
 */
export class EmbeddedColumns {
	static readonly [entityKind]: string = 'EmbeddedColumns';
	static [Symbol.hasInstance](value: unknown): boolean {
		return is(value, this);
	}

	[key: string]: Column | EmbeddedColumns;
}

/**
 * Builds the nested view of a table's columns from its flat, dotted column map. Returns the map
 * itself when the table has no embedded groups.
 *
 * @internal
 */
export function nestEmbeddedColumns<TColumns extends Record<string, Column>>(
	columns: TColumns,
): Record<string, Column | EmbeddedColumns> {
	const keys = Object.keys(columns);
	if (!keys.some((key) => key.includes(EmbeddedKeySeparator))) return columns;

	const result: Record<string, Column | EmbeddedColumns> = {};
	for (const key of keys) {
		const segments = key.split(EmbeddedKeySeparator);
		let target: Record<string, Column | EmbeddedColumns> = result;
		for (const segment of segments.slice(0, -1)) {
			target = (target[segment] ??= new EmbeddedColumns()) as EmbeddedColumns;
		}
		target[segments.at(-1)!] = columns[key]!;
	}

	return result;
}

/** @internal */
export function getTableShape(table: Table): Record<string, Column | EmbeddedColumns> {
	return table[Table.Symbol.Shape] ?? table[Table.Symbol.Columns];
}

/** @internal */
export function hasEmbeddedColumns(table: Table): boolean {
	const shape = table[Table.Symbol.Shape];
	return shape !== undefined && shape !== table[Table.Symbol.Columns];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/**
 * A nested plain object or an {@link EmbeddedColumns} group is walked. A column, SQL value,
 * subquery, view, or any other SQL wrapper is a leaf. A table is not a leaf: its shape is.
 */
function isSelectedFieldGroup(field: unknown): boolean {
	if (is(field, EmbeddedColumns)) return true;
	if (!isPlainObject(field) || isSQLWrapper(field)) return false;
	return true;
}

/**
 * Flattens a selection's fields to dotted keys, depth-first in key order — the order
 * {@link orderSelectedFields} emits columns in the SELECT — so an `insert().select()` lines its
 * columns up with the selected values.
 *
 * `{ address: { city, geo: { lat } } }` becomes `'address.city'`, then `'address.geo.lat'`.
 *
 * @internal
 */
export function flattenSelectedFields(
	fields: Record<string, unknown>,
	prefix = '',
	result: Record<string, unknown> = {},
): Record<string, unknown> {
	for (const key of Object.keys(fields)) {
		const path = prefix === '' ? key : prefix + EmbeddedKeySeparator + key;
		const field = fields[key];
		if (is(field, Table)) {
			flattenSelectedFields(getTableShape(field), path, result);
			continue;
		}
		if (isSelectedFieldGroup(field)) {
			flattenSelectedFields(field as Record<string, unknown>, path, result);
			continue;
		}
		result[path] = field;
	}
	return result;
}

/**
 * Flattens the nested values a caller writes for `embed()` groups into the dotted keys the table's
 * column map uses: `{ address: { city: 'Berlin' } }` → `{ 'address.city': 'Berlin' }`.
 * Returns the value untouched when the table has no embedded groups.
 *
 * @internal
 */
export function flattenEmbeddedValues(table: Table, value: Record<string, unknown>): Record<string, unknown> {
	if (!hasEmbeddedColumns(table)) return value;

	const result: Record<string, unknown> = {};
	const visit = (shape: Record<string, Column | EmbeddedColumns>, source: Record<string, unknown>, path: string) => {
		for (const [key, entry] of Object.entries(source)) {
			const node = shape[key];
			if (!is(node, EmbeddedColumns)) {
				result[path + key] = entry;
				continue;
			}
			if (entry === undefined) continue;
			if (entry === null) {
				// Writing `null` to a group clears every column in it.
				for (const leaf of Object.keys(table[Table.Symbol.Columns])) {
					if (leaf.startsWith(path + key + EmbeddedKeySeparator)) result[leaf] = null;
				}
				continue;
			}
			if (!isPlainObject(entry)) {
				throw new Error(
					`Embedded group "${path}${key}" in table "${
						table[Table.Symbol.Name]
					}" must be written as an object of its columns`,
				);
			}
			visit(node, entry, path + key + EmbeddedKeySeparator);
		}
	};
	visit(getTableShape(table), value, '');

	return result;
}

interface EmbeddedRowsPlan {
	/** Columns selected under a dotted key, as the path to nest each one at. */
	readonly columns: readonly (readonly [key: string, path: readonly string[]])[];
	/** Loaded relations whose rows carry embedded columns of their own. */
	readonly relations: readonly (readonly [key: string, plan: EmbeddedRowsPlan])[];
}

/** Finds the embedded columns a relational selection reads, or `undefined` when it reads none. */
function embeddedRowsPlan(
	selection: BuildRelationalQueryResult['selection'],
	separators: readonly string[],
): EmbeddedRowsPlan | undefined {
	const columns: [string, string[]][] = [];
	const relations: [string, EmbeddedRowsPlan][] = [];
	for (const item of selection) {
		if (item.selection) {
			const plan = embeddedRowsPlan(item.selection, separators);
			if (plan) relations.push([item.key, plan]);
		} else if (item.fieldType === 'Column' && separators.some((separator) => item.key.includes(separator))) {
			let path = [item.key];
			for (const separator of separators) path = path.flatMap((segment) => segment.split(separator));
			columns.push([item.key, path]);
		}
	}

	return columns.length || relations.length ? { columns, relations } : undefined;
}

function nestEmbeddedRows(value: unknown, plan: EmbeddedRowsPlan): void {
	if (Array.isArray(value)) {
		for (const row of value) nestEmbeddedRows(row, plan);
		return;
	}
	if (typeof value !== 'object' || value === null) return;

	const row = value as Record<string, unknown>;
	for (const [key, path] of plan.columns) {
		let target = row;
		for (const segment of path.slice(0, -1)) {
			target = (target[segment] ??= {}) as Record<string, unknown>;
		}
		target[path.at(-1)!] = row[key];
		delete row[key];
	}
	for (const [key, relationPlan] of plan.relations) {
		nestEmbeddedRows(row[key], relationPlan);
	}
}

/**
 * Wraps a relational rows mapper so the columns of `embed()` groups, which a relational query
 * selects under their dotted keys, come back nested: `'address.city'` → `address.city`. Returns
 * the mapper untouched for selections that read no embedded columns.
 *
 * @param separators what splits an embedded column's key into its path; a dialect that renames
 * keys inside JSON objects adds {@link EmbeddedJsonKeySeparator}
 * @internal
 */
export function nestEmbeddedRelationalRows<TMapper extends RelationalRowsMapper | undefined>(
	mapper: TMapper,
	selection: BuildRelationalQueryResult['selection'],
	separators: readonly string[] = [EmbeddedKeySeparator],
): TMapper {
	const plan = embeddedRowsPlan(selection, separators);
	if (!plan) return mapper;

	return ((rows: Parameters<RelationalRowsMapper>[0]) => {
		const result = mapper ? mapper(rows) : rows;
		nestEmbeddedRows(result, plan);
		return result;
	}) as TMapper;
}

/** @internal */
export function hasEmbeddedRows(selection: BuildRelationalQueryResult['selection']): boolean {
	return embeddedRowsPlan(selection, [EmbeddedKeySeparator]) !== undefined;
}

/**
 * Whether `key` names an `embed()` group in a flat, dotted column map: `'address'` for
 * `'address.city'`.
 *
 * @internal
 */
export function isEmbeddedGroupKey(columns: Record<string, unknown>, key: string): boolean {
	const prefix = key + EmbeddedKeySeparator;
	for (const column of Object.keys(columns)) {
		if (column.startsWith(prefix)) return true;
	}
	return false;
}

/**
 * Expands `embed()` group names in an insert column list into the dotted columns they cover.
 * `'address'` becomes every `'address.*'` column, nested groups included, in column-map order.
 * A name that is itself a column is kept, so a list of dotted columns comes back unchanged.
 * Listing a group and a column it covers throws. An unknown name throws.
 *
 * @internal
 */
export function expandInsertColumnList(table: Table, columnList: readonly string[]): string[] {
	const columns = table[Table.Symbol.Columns] as Record<string, unknown>;
	const expanded: string[] = [];
	const seenDirect = new Set<string>();
	const coveredByGroup = new Set<string>();

	for (const name of columnList) {
		if (Object.prototype.hasOwnProperty.call(columns, name)) {
			if (coveredByGroup.has(name)) {
				throw new Error(`Duplicate columns are not allowed in insert selection: "${name}"`);
			}
			seenDirect.add(name);
			expanded.push(name);
			continue;
		}

		if (!isEmbeddedGroupKey(columns, name)) {
			throw new Error(`Column "${name}" does not exist in table "${table[Table.Symbol.Name]}"`);
		}

		const prefix = name + EmbeddedKeySeparator;
		const groupColumns: string[] = [];
		for (const column of Object.keys(columns)) {
			if (column.startsWith(prefix)) groupColumns.push(column);
		}
		if (groupColumns.some((column) => seenDirect.has(column) || coveredByGroup.has(column))) {
			throw new Error(`Duplicate columns are not allowed in insert selection: "${name}"`);
		}
		for (const column of groupColumns) {
			coveredByGroup.add(column);
			expanded.push(column);
		}
	}

	return expanded;
}

/**
 * Turns a relational query's `columns` config, which may name `embed()` groups, into one keyed by
 * column: `{ address: true }` selects every column in the group, and `{ address: { city: true } }`
 * becomes `{ 'address.city': true }`. Dotted keys are kept as they are.
 *
 * @internal
 */
export function flattenEmbeddedColumnsConfig(
	columns: Record<string, unknown>,
	config: Record<string, unknown>,
	prefix = '',
	result: Record<string, boolean | undefined> = {},
): Record<string, boolean | undefined> {
	for (const [key, value] of Object.entries(config)) {
		const path = prefix + key;
		if (Object.prototype.hasOwnProperty.call(columns, path) || !isEmbeddedGroupKey(columns, path)) {
			result[path] = value as boolean | undefined;
		} else if (isPlainObject(value)) {
			flattenEmbeddedColumnsConfig(columns, value, path + EmbeddedKeySeparator, result);
		} else {
			const groupPrefix = path + EmbeddedKeySeparator;
			for (const column of Object.keys(columns)) {
				if (column.startsWith(groupPrefix)) result[column] = value as boolean | undefined;
			}
		}
	}
	return result;
}

/**
 * Turns the filter a relational query's `where` gives an `embed()` group into one on the table's
 * dotted keys: `{ city: 'Berlin', OR: [{ zip: '1' }] }` under `address` becomes
 * `{ AND: [{ 'address.city': 'Berlin' }, { OR: [{ 'address.zip': '1' }] }] }`. `RAW` is passed the
 * table, as at the top level.
 *
 * @internal
 */
export function prefixEmbeddedGroupFilter(filter: Record<string, unknown>, prefix: string): Record<string, unknown> {
	const parts: Record<string, unknown>[] = [];
	for (const [key, value] of Object.entries(filter)) {
		switch (key) {
			case 'RAW': {
				parts.push({ RAW: value });
				break;
			}
			case 'AND':
			case 'OR': {
				parts.push({
					[key]: (value as Record<string, unknown>[]).map((sub) => prefixEmbeddedGroupFilter(sub, prefix)),
				});
				break;
			}
			case 'NOT': {
				parts.push({ NOT: prefixEmbeddedGroupFilter(value as Record<string, unknown>, prefix) });
				break;
			}
			default: {
				parts.push({ [prefix + key]: value });
			}
		}
	}
	return parts.length ? { AND: parts } : {};
}

// ----------------------------------------------------------------------------- types

type DottedKey = `${string}${typeof EmbeddedKeySeparator}${string}`;

type HeadOf<TKey> = TKey extends `${infer Head}.${string}` ? Head : never;

type GroupKeys<T> = HeadOf<Extract<keyof T, DottedKey>>;

type GroupOf<T, Head extends string> = {
	[K in keyof T as K extends `${Head}.${infer Rest}` ? Rest : never]: T[K];
};

/** The names of the `embed()` groups in a flat, dotted map: `'address'` for `'address.city'`. */
export type EmbeddedGroupKeys<T> = GroupKeys<T>;

/** One `embed()` group of a flat, dotted map, keyed relative to it: `'address.geo.lat'` → `'geo.lat'`. */
export type EmbeddedGroupOf<T, Head extends string> = GroupOf<T, Head>;

type GroupPath<TKey extends string> = TKey extends `${infer Head}.${infer Rest}`
	? Rest extends DottedKey ? Head | `${Head}.${GroupPath<Rest>}`
	: Head
	: never;

/** Every `embed()` group path in a flat map: `'address'` and `'address.geo'` for `'address.geo.lat'`. */
type EmbeddedGroupPath<T> = GroupPath<Extract<keyof T, DottedKey>>;

/** A column key or an `embed()` group path an insert column list may name. */
export type InsertColumnListKey<TColumns> = (keyof TColumns & string) | EmbeddedGroupPath<TColumns>;

type ColumnsNamedBy<TColumns, TName> = TName extends string ? TName extends keyof TColumns ? TName
	: Extract<keyof TColumns & string, `${TName}.${string}`>
	: never;

/**
 * The dotted columns an insert column list names. A group path expands to every column under it.
 * Each name is expanded on its own, so a mix of columns and groups keeps every column.
 */
export type ExpandInsertColumnList<TColumns, TList extends readonly string[]> = ColumnsNamedBy<
	TColumns,
	TList[number]
>;

type NoDuplicateExpandedColumns<
	TColumns,
	TList extends readonly unknown[],
	TSeen = never,
> = TList extends readonly [infer Head, ...infer Tail] ? [
		Head extends string ? [Extract<ColumnsNamedBy<TColumns, Head>, TSeen>] extends [never] ? Head
			: DrizzleTypeError<`Duplicate columns are not allowed in insert selection: "${Head}"`>
			: Head,
		...NoDuplicateExpandedColumns<
			TColumns,
			Tail,
			TSeen | (Head extends string ? ColumnsNamedBy<TColumns, Head> : never)
		>,
	]
	: TList;

/**
 * The `...columns` argument of `db.insert(table, ...columns)`. Group names count toward the
 * required-column check, and a group that overlaps a column already named is a duplicate.
 */
export type InsertColumnListArg<
	TColumns,
	TColumnList extends readonly string[],
	TRequiredKeys extends string,
> = TColumnList extends readonly [] ? []
	: IsNever<TRequiredKeys> extends true ? TColumnList & NoDuplicateExpandedColumns<TColumns, TColumnList>
	: [TRequiredKeys] extends [ExpandInsertColumnList<TColumns, TColumnList>]
		? TColumnList & NoDuplicateExpandedColumns<TColumns, TColumnList>
	: DrizzleTypeError<
		`Column selection is missing following required columns: ${JoinUnion<
			`"${Exclude<TRequiredKeys, ExpandInsertColumnList<TColumns, TColumnList> & string>}"`,
			', '
		>}`
	>[];

/** `'all'` when the caller passed no column list; otherwise the dotted columns that list names. */
export type ResolvedInsertColumnList<
	TColumns,
	TColumnList extends readonly string[],
> = TColumnList extends readonly [] ? 'all' : ExpandInsertColumnList<TColumns, TColumnList>[];

/**
 * Flattens a relational query's `columns` config into the dotted keys of the table's column map
 * `TColumns`, mirroring {@link flattenEmbeddedColumnsConfig}: `{ address: { city: true } }` →
 * `{ 'address.city': true }`, and `{ address: false }` → every column of the group set to `false`.
 */
export type FlattenEmbeddedColumnsConfig<TColumns, TConfig, TPrefix extends string = ''> = [keyof TConfig] extends
	[never] ? {}
	: Simplify<
		UnionToIntersection<
			{
				[K in keyof TConfig & string]: `${TPrefix}${K}` extends keyof TColumns ? { [P in `${TPrefix}${K}`]: TConfig[K] }
					: TConfig[K] extends Record<string, unknown>
						? FlattenEmbeddedColumnsConfig<TColumns, TConfig[K], `${TPrefix}${K}.`>
					: { [P in keyof TColumns & `${TPrefix}${K}.${string}`]: TConfig[K] };
			}[keyof TConfig & string]
		>
	>;

/**
 * Nests the dotted keys of a flat map into objects: `{ 'address.city': string }` →
 * `{ address: { city: string } }`. A group is optional when every key in it is. Maps without
 * dotted keys come back unchanged.
 */
export type NestEmbedded<T> = [Extract<keyof T, DottedKey>] extends [never] ? T
	: Simplify<
		& { [K in keyof T as K extends DottedKey ? never : K]: T[K] }
		& {
			[Head in GroupKeys<T> as {} extends GroupOf<T, Head> ? never : Head]: NestEmbedded<GroupOf<T, Head>>;
		}
		& {
			[Head in GroupKeys<T> as {} extends GroupOf<T, Head> ? Head : never]?: NestEmbedded<GroupOf<T, Head>>;
		}
	>;

/**
 * {@link NestEmbedded} for a map whose every key is optional, such as an update's `set`. It is
 * not a conditional type, so an empty object stays assignable to it while the table is generic.
 */
export type NestEmbeddedPartial<T> =
	& { [K in keyof T as K extends DottedKey ? never : K]?: T[K] }
	// Writing `null` to a group clears every column in it.
	& { [Head in GroupKeys<T>]?: NestEmbeddedPartial<GroupOf<T, Head>> | null };

/**
 * The columns of `TModel` an insert column list keeps. `'all'` keeps every key. Optionality is preserved,
 * so a required column stays required in an `insert().select()` selection.
 */
export type ListedInsertColumns<TModel, TColumnList extends string[] | 'all'> = {
	[K in keyof TModel as TColumnList extends string[] ? Extract<K, TColumnList[number]> : K]: TModel[K];
};

type InsertSelectionLeaf<TColumn, TData> = TColumn | SQL | SQL.Aliased | TData;

type InsertSelectionLeaves<TModel, TColumn> = {
	[K in keyof TModel]: InsertSelectionLeaf<TColumn, TModel[K]>;
};

/**
 * What `insert().select()` accepts for one table: the insert columns, either under their dotted keys
 * (`'address.city'`) or nested the way `embed()` groups are (`address: { city }`). A required column
 * has to appear in one of those two shapes.
 */
export type InsertSelectionShape<TModel, TColumn> =
	| (InsertSelectionLeaves<TModel, TColumn> & {})
	| NestEmbedded<InsertSelectionLeaves<TModel, TColumn>>;

/** How a dialect reports a generated or identity column an insert may not write. */
export type InsertSelectionGeneratedKind = 'override' | 'restricted' | 'none';

type HasEmbeddedGroup<T, THead extends string> = [Extract<keyof T, `${THead}.${string}`>] extends [never] ? false
	: true;

type InsertSelectionGeneratedError<
	TPath extends string,
	TTableName extends string,
	TKind extends InsertSelectionGeneratedKind,
> = TKind extends 'override' ? DrizzleTypeError<
		`Column "${TPath}" in table "${TTableName}" is a generated column. Use \`.overridingSystemValue()\` to manually insert into this column`
	>
	: TKind extends 'restricted' ? DrizzleTypeError<
			`Column "${TPath}" in table "${TTableName}" is a generated column - manual value insertion restricted`
		>
	: DrizzleTypeError<`Column "${TPath}" does not exist in table "${TTableName}"`>;

type IsInsertSelectionGroup<TValue> = [TValue] extends [Column | SQL | SQL.Aliased | Subquery] ? false
	: [TValue] extends [Record<string, any>] ? true
	: false;

type ValidateInsertSelectionEntry<
	TValue,
	TPath extends string,
	TAllowed extends Record<string, unknown>,
	TGenerated extends Record<string, unknown>,
	TColumnList extends string[] | 'all',
	TTableName extends string,
	TKind extends InsertSelectionGeneratedKind,
> = TPath extends keyof TAllowed ? TColumnList extends string[] ? TPath extends TColumnList[number] ? TValue
		: DrizzleTypeError<`Column "${TPath}" is not included in the insert column selection`>
	: TValue
	: TPath extends keyof TGenerated ? InsertSelectionGeneratedError<TPath, TTableName, TKind>
	: HasEmbeddedGroup<TAllowed, TPath> extends true ? ValidateInsertSelectionGroup<
			TValue,
			TPath,
			TAllowed,
			TGenerated,
			TColumnList,
			TTableName,
			TKind
		>
	: HasEmbeddedGroup<TGenerated, TPath> extends true ? ValidateInsertSelectionGroup<
			TValue,
			TPath,
			TAllowed,
			TGenerated,
			TColumnList,
			TTableName,
			TKind
		>
	: DrizzleTypeError<`Column "${TPath}" does not exist in table "${TTableName}"`>;

type ValidateInsertSelectionGroup<
	TValue,
	TPath extends string,
	TAllowed extends Record<string, unknown>,
	TGenerated extends Record<string, unknown>,
	TColumnList extends string[] | 'all',
	TTableName extends string,
	TKind extends InsertSelectionGeneratedKind,
> = IsInsertSelectionGroup<TValue> extends true ? ValidateNestedInsertSelection<
		TValue,
		TAllowed,
		TGenerated,
		TColumnList,
		TTableName,
		TKind,
		`${TPath}.`
	>
	: DrizzleTypeError<`Column "${TPath}" does not exist in table "${TTableName}"`>;

/**
 * Checks an `insert().select()` selection against the table's insert columns. Dotted keys and nested
 * `embed()` groups are both checked per column: an unknown key, a generated column, or a key outside
 * the insert column list becomes a {@link DrizzleTypeError} in place, named by its dotted path.
 */
export type ValidateNestedInsertSelection<
	TSelection,
	TAllowed extends Record<string, unknown>,
	TGenerated extends Record<string, unknown>,
	TColumnList extends string[] | 'all',
	TTableName extends string,
	TKind extends InsertSelectionGeneratedKind,
	TPrefix extends string = '',
> = {
	[K in keyof TSelection]: ValidateInsertSelectionEntry<
		TSelection[K],
		`${TPrefix}${K & string}`,
		TAllowed,
		TGenerated,
		TColumnList,
		TTableName,
		TKind
	>;
};

/**
 * Flattens a table definition's `embed()` groups into dotted keys, mirroring
 * {@link flattenEmbedBuilders}.
 */
export type FlattenEmbedBuilders<TColumns, TPrefix extends string = ''> = Simplify<
	UnionToIntersection<
		{
			[K in keyof TColumns & string]: TColumns[K] extends EmbedBuilder<infer TInner>
				? FlattenEmbedBuilders<TInner, `${TPrefix}${K}.`>
				: { [P in `${TPrefix}${K}`]: TColumns[K] };
		}[keyof TColumns & string]
	>
>;

type UnionToIntersection<U> = (U extends any ? (arg: U) => void : never) extends (arg: infer I) => void ? I
	: never;
