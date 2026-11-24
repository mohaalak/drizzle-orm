import type {
	BuildColumns,
	ColumnBuilderBase,
	ColumnBuilderBaseConfig,
	ColumnBuilderExtraConfig,
	ColumnBuilderRuntimeConfig,
	ColumnType,
	HasDefault,
	HasGenerated,
	IsAutoincrement,
} from '~/column-builder.ts';
import { ColumnBuilder } from '~/column-builder.ts';
import type { ColumnBaseConfig } from '~/column.ts';
import { Column } from '~/column.ts';
import type { EmbedBuilder, FlattenEmbedBuilders } from '~/embed.ts';
import { entityKind } from '~/entity.ts';
import type { SingleStoreTable } from '~/singlestore-core/table.ts';
import type { SQL } from '~/sql/sql.ts';
import type { Assume, Update } from '~/utils.ts';
import type { SingleStoreType } from '../codecs.ts';

export type SingleStoreColumns = Record<string, SingleStoreColumn<any>>;

/** A table definition: column builders, optionally grouped with `embed()`. */
export type SingleStoreTableColumnsMap = Record<string, ColumnBuilderBase | EmbedBuilder>;

type HasEmbeds<TConfigMap> = [Extract<TConfigMap[keyof TConfigMap], EmbedBuilder>] extends [never] ? false : true;

export type SingleStoreBuildColumns<
	TTableName extends string,
	TConfigMap extends SingleStoreTableColumnsMap,
> = HasEmbeds<TConfigMap> extends true ? BuildColumns<
		TTableName,
		Assume<FlattenEmbedBuilders<TConfigMap>, Record<string, ColumnBuilderBase>>,
		'singlestore'
	>
	: BuildColumns<TTableName, Assume<TConfigMap, Record<string, ColumnBuilderBase>>, 'singlestore'>;

export interface SingleStoreGeneratedColumnConfig {
	mode?: 'virtual' | 'stored';
}

export abstract class SingleStoreColumnBuilder<
	T extends ColumnBuilderBaseConfig<ColumnType> = ColumnBuilderBaseConfig<ColumnType> & {
		data: any;
	},
	TRuntimeConfig extends object = object,
	TExtraConfig extends ColumnBuilderExtraConfig = ColumnBuilderExtraConfig,
> extends ColumnBuilder<T, TRuntimeConfig, TExtraConfig> {
	static override readonly [entityKind]: string = 'SingleStoreColumnBuilder';

	unique(name?: string): this {
		this.config.isUnique = true;
		this.config.uniqueName = name;
		return this;
	}

	// TODO: Implement generated columns for SingleStore (https://docs.singlestore.com/cloud/create-a-database/using-persistent-computed-columns/)
	generatedAlwaysAs(
		as: SQL | (() => SQL),
		config?: SingleStoreGeneratedColumnConfig,
	): HasGenerated<this, { type: 'always' }> {
		this.config.generated = {
			as,
			type: 'always',
			mode: config?.mode ?? 'virtual',
		};
		return this as any;
	}

	/** @internal */
	abstract build(table: SingleStoreTable): SingleStoreColumn;
}

// To understand how to use `SingleStoreColumn` and `AnySingleStoreColumn`, see `Column` and `AnyColumn` documentation.
export abstract class SingleStoreColumn<
	T extends ColumnBaseConfig<ColumnType> = ColumnBaseConfig<ColumnType>,
	TRuntimeConfig extends object = {},
> extends Column<T, TRuntimeConfig> {
	static override readonly [entityKind]: string = 'SingleStoreColumn';

	/** @internal */
	abstract override readonly codec?: SingleStoreType;

	/** @internal */
	override readonly table: SingleStoreTable;

	constructor(
		table: SingleStoreTable,
		config: ColumnBuilderRuntimeConfig<T['data']> & TRuntimeConfig,
	) {
		super(table, config);
		this.table = table;
	}
}

export type AnySingleStoreColumn<TPartial extends Partial<ColumnBaseConfig<ColumnType>> = {}> = SingleStoreColumn<
	Required<Update<ColumnBaseConfig<ColumnType>, TPartial>>
>;

export interface SingleStoreColumnWithAutoIncrementConfig {
	autoIncrement: boolean;
}

export abstract class SingleStoreColumnBuilderWithAutoIncrement<
	T extends ColumnBuilderBaseConfig<ColumnType> = ColumnBuilderBaseConfig<ColumnType>,
	TRuntimeConfig extends object = object,
	TExtraConfig extends ColumnBuilderExtraConfig = ColumnBuilderExtraConfig,
> extends SingleStoreColumnBuilder<T, TRuntimeConfig & SingleStoreColumnWithAutoIncrementConfig, TExtraConfig> {
	static override readonly [entityKind]: string = 'SingleStoreColumnBuilderWithAutoIncrement';

	constructor(name: string, dataType: T['dataType'], columnType: string) {
		super(name, dataType, columnType);
		this.config.autoIncrement = false;
	}

	autoincrement(): IsAutoincrement<HasDefault<this>> {
		this.config.autoIncrement = true;
		this.config.hasDefault = true;
		return this as IsAutoincrement<HasDefault<this>>;
	}
}

export abstract class SingleStoreColumnWithAutoIncrement<
	T extends ColumnBaseConfig<ColumnType> = ColumnBaseConfig<ColumnType>,
	TRuntimeConfig extends object = object,
> extends SingleStoreColumn<T, SingleStoreColumnWithAutoIncrementConfig & TRuntimeConfig> {
	static override readonly [entityKind]: string = 'SingleStoreColumnWithAutoIncrement';

	readonly autoIncrement: boolean = this.config.autoIncrement;
}
