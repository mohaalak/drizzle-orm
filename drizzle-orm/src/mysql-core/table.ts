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
import { getMySqlColumnBuilders, type MySqlColumnBuilders } from './columns/all.ts';
import type {
	MySqlBuildColumns,
	MySqlColumn,
	MySqlColumnBuilder,
	MySqlColumns,
	MySqlTableColumnsMap,
} from './columns/common.ts';
import type { ForeignKey, ForeignKeyBuilder } from './foreign-keys.ts';
import type { AnyIndexBuilder } from './indexes.ts';
import type { PrimaryKeyBuilder } from './primary-keys.ts';
import type { UniqueConstraintBuilder } from './unique-constraint.ts';

export type MySqlTableExtraConfigValue =
	| AnyIndexBuilder
	| CheckBuilder
	| ForeignKeyBuilder
	| PrimaryKeyBuilder
	| UniqueConstraintBuilder<string | undefined>;

export type MySqlTableExtraConfig = Record<
	string,
	MySqlTableExtraConfigValue
>;

export type TableConfig = TableConfigBase<MySqlColumns>;

/** @internal */
export const InlineForeignKeys = Symbol.for('drizzle:MySqlInlineForeignKeys');

export class MySqlTable<T extends TableConfig = TableConfig> extends Table<T> {
	static override readonly [entityKind]: string = 'MySqlTable';

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
		| ((self: Record<string, MySqlColumn>) => MySqlTableExtraConfig)
		| undefined = undefined;
}

export type AnyMySqlTable<TPartial extends Partial<TableConfig> = {}> = MySqlTable<
	UpdateTableConfig<TableConfig, TPartial>
>;

export type MySqlTableWithColumns<T extends TableConfig> =
	& MySqlTable<T>
	// `embed()` groups are reached as nested objects: `users.address.city`.
	& NestEmbedded<T['columns']>
	& InferTableColumnsModels<T['columns']>;

export function mysqlTableWithSchema<
	TTableName extends string,
	TSchemaName extends string | undefined,
	TColumnsMap extends MySqlTableColumnsMap,
>(
	name: TTableName,
	columns: TColumnsMap | ((columnTypes: MySqlColumnBuilders) => TColumnsMap),
	extraConfig:
		| ((
			self: NestEmbedded<MySqlBuildColumns<TTableName, TColumnsMap>>,
		) => MySqlTableExtraConfig | (MySqlTableExtraConfigValue | MySqlTableExtraConfigValue[])[])
		| undefined,
	schema: TSchemaName,
	casing: Casing | undefined,
	baseName = name,
): MySqlTableWithColumns<{
	name: TTableName;
	schema: TSchemaName;
	columns: MySqlBuildColumns<TTableName, TColumnsMap>;
	dialect: 'mysql';
	isAlias: false;
}> {
	const casingFn = getCasingFn(casing);
	const rawTable = new MySqlTable<{
		name: TTableName;
		schema: TSchemaName;
		columns: MySqlBuildColumns<TTableName, TColumnsMap>;
		dialect: 'mysql';
		isAlias: false;
	}>(name, schema, baseName);

	const definedColumns: TColumnsMap = typeof columns === 'function' ? columns(getMySqlColumnBuilders()) : columns;
	// `embed()` groups are flattened to dotted keys: `address: embed({ city })` becomes `'address.city'`.
	const parsedColumns = flattenEmbedBuilders(
		definedColumns as unknown as Record<string, MySqlColumnBuilder>,
		casingFn,
	);

	const builtColumns = Object.fromEntries(
		Object.entries(parsedColumns).map(([name, colBuilderBase]) => {
			const colBuilder = colBuilderBase as MySqlColumnBuilder;
			colBuilder.setName(name, casingFn);
			const column = colBuilder.build(rawTable).postBuild();
			rawTable[InlineForeignKeys].push(...colBuilder.buildForeignKeys(column, rawTable));
			return [name, column];
		}),
	) as unknown as MySqlBuildColumns<TTableName, TColumnsMap>;

	const shape = nestEmbeddedColumns(builtColumns as MySqlColumns);
	const table = Object.assign(rawTable, shape);

	table[Table.Symbol.Columns] = builtColumns;
	if (shape !== builtColumns) table[Table.Symbol.Shape] = shape;
	table[Table.Symbol.ExtraConfigColumns] = shape;

	if (extraConfig) {
		table[MySqlTable.Symbol.ExtraConfigBuilder] = extraConfig as unknown as (
			self: Record<string, MySqlColumn>,
		) => MySqlTableExtraConfig;
	}

	return table as any;
}

export interface MySqlTableFn<TSchemaName extends string | undefined = undefined> {
	<
		TTableName extends string,
		TColumnsMap extends MySqlTableColumnsMap,
	>(
		name: TTableName,
		columns: TColumnsMap,
		extraConfig?: (
			self: NestEmbedded<MySqlBuildColumns<TTableName, TColumnsMap>>,
		) => (MySqlTableExtraConfigValue | MySqlTableExtraConfigValue[])[],
	): MySqlTableWithColumns<{
		name: TTableName;
		schema: TSchemaName;
		columns: MySqlBuildColumns<TTableName, TColumnsMap>;
		dialect: 'mysql';
		isAlias: false;
	}>;

	<
		TTableName extends string,
		TColumnsMap extends MySqlTableColumnsMap,
	>(
		name: TTableName,
		columns: (columnTypes: MySqlColumnBuilders) => TColumnsMap,
		extraConfig?: (
			self: NestEmbedded<MySqlBuildColumns<TTableName, TColumnsMap>>,
		) => (MySqlTableExtraConfigValue | MySqlTableExtraConfigValue[])[],
	): MySqlTableWithColumns<{
		name: TTableName;
		schema: TSchemaName;
		columns: MySqlBuildColumns<TTableName, TColumnsMap>;
		dialect: 'mysql';
		isAlias: false;
	}>;
	/**
	 * @deprecated The third parameter of mysqlTable is changing and will only accept an array instead of an object
	 *
	 * @example
	 * Deprecated version:
	 * ```ts
	 * export const users = mysqlTable("users", {
	 * 	id: int(),
	 * }, (t) => ({
	 * 	idx: index('custom_name').on(t.id)
	 * }));
	 * ```
	 *
	 * New API:
	 * ```ts
	 * export const users = mysqlTable("users", {
	 * 	id: int(),
	 * }, (t) => [
	 * 	index('custom_name').on(t.id)
	 * ]);
	 * ```
	 */
	<
		TTableName extends string,
		TColumnsMap extends MySqlTableColumnsMap,
	>(
		name: TTableName,
		columns: TColumnsMap,
		extraConfig: (self: NestEmbedded<MySqlBuildColumns<TTableName, TColumnsMap>>) => MySqlTableExtraConfig,
	): MySqlTableWithColumns<{
		name: TTableName;
		schema: TSchemaName;
		columns: MySqlBuildColumns<TTableName, TColumnsMap>;
		dialect: 'mysql';
		isAlias: false;
	}>;

	/**
	 * @deprecated The third parameter of mysqlTable is changing and will only accept an array instead of an object
	 *
	 * @example
	 * Deprecated version:
	 * ```ts
	 * export const users = mysqlTable("users", {
	 * 	id: int(),
	 * }, (t) => ({
	 * 	idx: index('custom_name').on(t.id)
	 * }));
	 * ```
	 *
	 * New API:
	 * ```ts
	 * export const users = mysqlTable("users", {
	 * 	id: int(),
	 * }, (t) => [
	 * 	index('custom_name').on(t.id)
	 * ]);
	 * ```
	 */
	<
		TTableName extends string,
		TColumnsMap extends MySqlTableColumnsMap,
	>(
		name: TTableName,
		columns: (columnTypes: MySqlColumnBuilders) => TColumnsMap,
		extraConfig: (self: NestEmbedded<MySqlBuildColumns<TTableName, TColumnsMap>>) => MySqlTableExtraConfig,
	): MySqlTableWithColumns<{
		name: TTableName;
		schema: TSchemaName;
		columns: MySqlBuildColumns<TTableName, TColumnsMap>;
		dialect: 'mysql';
		isAlias: false;
	}>;
}

/** @internal */
export function mysqlTableWithCasing(casing: Casing | undefined): MySqlTableFn {
	return (name, columns, extraConfig) => mysqlTableWithSchema(name, columns, extraConfig, undefined, casing, name);
}

export const mysqlTable = mysqlTableWithCasing(undefined);

export function mysqlTableCreator(
	customizeTableName: (name: string) => string,
	casing?: Casing | undefined,
): MySqlTableFn {
	return (name, columns, extraConfig) => {
		return mysqlTableWithSchema(customizeTableName(name) as typeof name, columns, extraConfig, undefined, casing, name);
	};
}
