import { type Casing, getCasingFn } from '~/casing.ts';
import { flattenEmbedBuilders, type NestEmbedded, nestEmbeddedColumns } from '~/embed.ts';
import { entityKind } from '~/entity.ts';
import {
	type InferTableColumnsModels,
	Table,
	type TableConfig as TableConfigBase,
	type UpdateTableConfig,
} from '~/table.ts';
import type { CheckBuilder } from './checks.ts';
import { getSQLiteColumnBuilders, type SQLiteColumnBuilders } from './columns/all.ts';
import type {
	SQLiteBuildColumns,
	SQLiteColumn,
	SQLiteColumnBuilder,
	SQLiteColumns,
	SQLiteTableColumnsMap,
} from './columns/common.ts';
import type { ForeignKey, ForeignKeyBuilder } from './foreign-keys.ts';
import type { IndexBuilder } from './indexes.ts';
import type { PrimaryKeyBuilder } from './primary-keys.ts';
import type { UniqueConstraintBuilder } from './unique-constraint.ts';

export type SQLiteTableExtraConfigValue =
	| IndexBuilder
	| CheckBuilder
	| ForeignKeyBuilder
	| PrimaryKeyBuilder
	| UniqueConstraintBuilder;

export type SQLiteTableExtraConfig = Record<
	string,
	SQLiteTableExtraConfigValue
>;

export type TableConfig = TableConfigBase<SQLiteColumns>;

/** @internal */
export const InlineForeignKeys = Symbol.for('drizzle:SQLiteInlineForeignKeys');

export class SQLiteTable<T extends TableConfig = TableConfig> extends Table<T> {
	static override readonly [entityKind]: string = 'SQLiteTable';

	/** @internal */
	static override readonly Symbol = Object.assign({}, Table.Symbol, {
		InlineForeignKeys: InlineForeignKeys as typeof InlineForeignKeys,
	});

	/** @internal */
	override [Table.Symbol.Columns]!: NonNullable<T['columns']>;

	/** @internal */
	[InlineForeignKeys]: ForeignKey[] = [];

	/** @internal */
	override [Table.Symbol.ExtraConfigBuilder]:
		| ((self: Record<string, SQLiteColumn>) => SQLiteTableExtraConfig)
		| undefined = undefined;
}

export type AnySQLiteTable<TPartial extends Partial<TableConfig> = {}> = SQLiteTable<
	UpdateTableConfig<TableConfig, TPartial>
>;

export type SQLiteTableWithColumns<T extends TableConfig> =
	& SQLiteTable<T>
	// `embed()` groups are reached as nested objects: `users.address.city`.
	& NestEmbedded<T['columns']>
	& InferTableColumnsModels<T['columns']>;

export interface SQLiteTableFn<TSchema extends string | undefined = undefined> {
	<
		TTableName extends string,
		TColumnsMap extends SQLiteTableColumnsMap,
	>(
		name: TTableName,
		columns: TColumnsMap,
		extraConfig?: (
			self: NestEmbedded<SQLiteBuildColumns<TTableName, TColumnsMap>>,
		) => (SQLiteTableExtraConfigValue | SQLiteTableExtraConfigValue[])[],
	): SQLiteTableWithColumns<{
		name: TTableName;
		schema: TSchema;
		columns: SQLiteBuildColumns<TTableName, TColumnsMap>;
		dialect: 'sqlite';
		isAlias: false;
	}>;

	<
		TTableName extends string,
		TColumnsMap extends SQLiteTableColumnsMap,
	>(
		name: TTableName,
		columns: (columnTypes: SQLiteColumnBuilders) => TColumnsMap,
		extraConfig?: (
			self: NestEmbedded<SQLiteBuildColumns<TTableName, TColumnsMap>>,
		) => (SQLiteTableExtraConfigValue | SQLiteTableExtraConfigValue[])[],
	): SQLiteTableWithColumns<{
		name: TTableName;
		schema: TSchema;
		columns: SQLiteBuildColumns<TTableName, TColumnsMap>;
		dialect: 'sqlite';
		isAlias: false;
	}>;
	/**
	 * @deprecated The third parameter of sqliteTable is changing and will only accept an array instead of an object
	 *
	 * @example
	 * Deprecated version:
	 * ```ts
	 * export const users = sqliteTable("users", {
	 * 	id: int(),
	 * }, (t) => ({
	 * 	idx: index('custom_name').on(t.id)
	 * }));
	 * ```
	 *
	 * New API:
	 * ```ts
	 * export const users = sqliteTable("users", {
	 * 	id: int(),
	 * }, (t) => [
	 * 	index('custom_name').on(t.id)
	 * ]);
	 * ```
	 */
	<
		TTableName extends string,
		TColumnsMap extends SQLiteTableColumnsMap,
	>(
		name: TTableName,
		columns: TColumnsMap,
		extraConfig?: (self: NestEmbedded<SQLiteBuildColumns<TTableName, TColumnsMap>>) => SQLiteTableExtraConfig,
	): SQLiteTableWithColumns<{
		name: TTableName;
		schema: TSchema;
		columns: SQLiteBuildColumns<TTableName, TColumnsMap>;
		dialect: 'sqlite';
		isAlias: false;
	}>;

	/**
	 * @deprecated The third parameter of sqliteTable is changing and will only accept an array instead of an object
	 *
	 * @example
	 * Deprecated version:
	 * ```ts
	 * export const users = sqliteTable("users", {
	 * 	id: int(),
	 * }, (t) => ({
	 * 	idx: index('custom_name').on(t.id)
	 * }));
	 * ```
	 *
	 * New API:
	 * ```ts
	 * export const users = sqliteTable("users", {
	 * 	id: int(),
	 * }, (t) => [
	 * 	index('custom_name').on(t.id)
	 * ]);
	 * ```
	 */
	<
		TTableName extends string,
		TColumnsMap extends SQLiteTableColumnsMap,
	>(
		name: TTableName,
		columns: (columnTypes: SQLiteColumnBuilders) => TColumnsMap,
		extraConfig?: (self: NestEmbedded<SQLiteBuildColumns<TTableName, TColumnsMap>>) => SQLiteTableExtraConfig,
	): SQLiteTableWithColumns<{
		name: TTableName;
		schema: TSchema;
		columns: SQLiteBuildColumns<TTableName, TColumnsMap>;
		dialect: 'sqlite';
		isAlias: false;
	}>;
}

/** @internal */
export function sqliteTableBase<
	TTableName extends string,
	TColumnsMap extends SQLiteTableColumnsMap,
	TSchema extends string | undefined,
>(
	name: TTableName,
	columns: TColumnsMap | ((columnTypes: SQLiteColumnBuilders) => TColumnsMap),
	extraConfig:
		| ((
			self: NestEmbedded<SQLiteBuildColumns<TTableName, TColumnsMap>>,
		) => SQLiteTableExtraConfig | (SQLiteTableExtraConfigValue | SQLiteTableExtraConfigValue[])[])
		| undefined,
	schema: TSchema | undefined,
	casing: Casing | undefined,
	baseName = name,
): SQLiteTableWithColumns<{
	name: TTableName;
	schema: TSchema;
	columns: SQLiteBuildColumns<TTableName, TColumnsMap>;
	dialect: 'sqlite';
	isAlias: false;
}> {
	const casingFn = getCasingFn(casing);
	const rawTable = new SQLiteTable<{
		name: TTableName;
		schema: TSchema;
		columns: SQLiteBuildColumns<TTableName, TColumnsMap>;
		dialect: 'sqlite';
		isAlias: false;
	}>(name, schema, baseName);

	const definedColumns: TColumnsMap = typeof columns === 'function' ? columns(getSQLiteColumnBuilders()) : columns;
	// `embed()` groups are flattened to dotted keys: `address: embed({ city })` becomes `'address.city'`.
	const parsedColumns = flattenEmbedBuilders(
		definedColumns as unknown as Record<string, SQLiteColumnBuilder>,
		casingFn,
	);

	const builtColumns = Object.fromEntries(
		Object.entries(parsedColumns).map(([name, colBuilderBase]) => {
			const colBuilder = colBuilderBase as SQLiteColumnBuilder;
			colBuilder.setName(name, casingFn);
			const column = colBuilder.build(rawTable).postBuild();
			rawTable[InlineForeignKeys].push(...colBuilder.buildForeignKeys(column, rawTable));
			return [name, column];
		}),
	) as unknown as SQLiteBuildColumns<TTableName, TColumnsMap>;

	const shape = nestEmbeddedColumns(builtColumns as SQLiteColumns);
	const table = Object.assign(rawTable, shape);

	table[Table.Symbol.Columns] = builtColumns;
	if (shape !== builtColumns) table[Table.Symbol.Shape] = shape;
	table[Table.Symbol.ExtraConfigColumns] = shape;

	if (extraConfig) {
		table[SQLiteTable.Symbol.ExtraConfigBuilder] = extraConfig as (
			self: Record<string, SQLiteColumn>,
		) => SQLiteTableExtraConfig;
	}

	return table as any;
}

/** @internal */
export function sqliteTableWithCasing(casing: Casing | undefined): SQLiteTableFn {
	return (name, columns, extraConfig) => sqliteTableBase(name, columns, extraConfig, undefined, casing);
}

export const sqliteTable = sqliteTableWithCasing(undefined);

export function sqliteTableCreator(
	customizeTableName: (name: string) => string,
	casing?: Casing | undefined,
): SQLiteTableFn {
	return (name, columns, extraConfig) => {
		return sqliteTableBase(customizeTableName(name) as typeof name, columns, extraConfig, undefined, casing, name);
	};
}
