import type { z } from 'zod/v4';
import type { CockroachEnum } from '~/cockroach-core/columns/enum.ts';
import type { NestEmbedded } from '~/embed.ts';
import type { PgEnum } from '~/pg-core/columns/enum.ts';
import type { InferInsertColumns, InferInsertModel, InferSelectModel, Table } from '~/table.ts';
import type { View } from '~/view.ts';
import type { BuildRefine, BuildSchema, NoUnknownKeys } from './schema.types.internal.ts';

export interface CreateSelectSchema<
	TCoerce extends CoerceOptions,
> {
	<TTable extends Table>(
		table: TTable,
	): BuildSchema<'select', NestEmbedded<TTable['_']['columns']>, undefined, TCoerce>;
	<
		TTable extends Table,
		TRefine extends BuildRefine<NestEmbedded<TTable['_']['columns']>, TCoerce>,
	>(
		table: TTable,
		refine?: NoUnknownKeys<TRefine, InferSelectModel<TTable>>,
	): BuildSchema<'select', NestEmbedded<TTable['_']['columns']>, TRefine, TCoerce>;

	<TView extends View>(view: TView): BuildSchema<'select', TView['_']['selectedFields'], undefined, TCoerce>;
	<
		TView extends View,
		TRefine extends BuildRefine<TView['_']['selectedFields'], TCoerce>,
	>(
		view: TView,
		refine: NoUnknownKeys<TRefine, TView['$inferSelect']>,
	): BuildSchema<'select', TView['_']['selectedFields'], TRefine, TCoerce>;

	<TEnum extends PgEnum<any> | CockroachEnum<any>>(enum_: TEnum): z.ZodEnum<{ [K in TEnum['enumValues'][number]]: K }>;
}

export interface CreateInsertSchema<
	TCoerce extends CoerceOptions,
> {
	<TTable extends Table>(
		table: TTable,
	): BuildSchema<'insert', NestEmbedded<TTable['_']['columns']>, undefined, TCoerce>;
	<
		TTable extends Table,
		TRefine extends BuildRefine<NestEmbedded<Pick<TTable['_']['columns'], keyof InferInsertColumns<TTable>>>, TCoerce>,
	>(
		table: TTable,
		refine?: NoUnknownKeys<TRefine, InferInsertModel<TTable>>,
	): BuildSchema<'insert', NestEmbedded<TTable['_']['columns']>, TRefine, TCoerce>;
}

export interface CreateUpdateSchema<
	TCoerce extends CoerceOptions,
> {
	<TTable extends Table>(
		table: TTable,
	): BuildSchema<'update', NestEmbedded<TTable['_']['columns']>, undefined, TCoerce>;
	<
		TTable extends Table,
		TRefine extends BuildRefine<NestEmbedded<Pick<TTable['_']['columns'], keyof InferInsertColumns<TTable>>>, TCoerce>,
	>(
		table: TTable,
		refine?: TRefine,
	): BuildSchema<'update', NestEmbedded<TTable['_']['columns']>, TRefine, TCoerce>;
}

export interface CreateSchemaFactoryOptions<
	TCoerce extends CoerceOptions,
> {
	zodInstance?: any;
	coerce?: TCoerce;
}

export type CoerceOptions =
	| Partial<Record<'bigint' | 'boolean' | 'date' | 'number' | 'string', true>>
	| true
	| undefined;

export type FactoryOptions = CreateSchemaFactoryOptions<CoerceOptions>;
