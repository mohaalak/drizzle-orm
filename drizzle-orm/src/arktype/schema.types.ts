import type { Type } from 'arktype';
import type { CockroachEnum } from '~/cockroach-core/columns/enum.ts';
import type { NestEmbedded } from '~/embed.ts';
import type { PgEnum } from '~/pg-core/columns/enum.ts';
import type { InferInsertColumns, InferInsertModel, InferSelectModel, Table } from '~/table.ts';
import type { View } from '~/view.ts';
import type { BuildRefine, BuildSchema, NoUnknownKeys } from './schema.types.internal.ts';

export interface CreateSelectSchema {
	<TTable extends Table>(
		table: TTable,
	): BuildSchema<'select', NestEmbedded<TTable['_']['columns']>, undefined>;
	<
		TTable extends Table,
		TRefine extends BuildRefine<NestEmbedded<TTable['_']['columns']>>,
	>(
		table: TTable,
		refine?: NoUnknownKeys<TRefine, InferSelectModel<TTable>>,
	): BuildSchema<'select', NestEmbedded<TTable['_']['columns']>, TRefine>;

	<TView extends View>(view: TView): BuildSchema<'select', TView['_']['selectedFields'], undefined>;
	<
		TView extends View,
		TRefine extends BuildRefine<TView['_']['selectedFields']>,
	>(
		view: TView,
		refine: NoUnknownKeys<TRefine, TView['$inferSelect']>,
	): BuildSchema<'select', TView['_']['selectedFields'], TRefine>;

	<TEnum extends PgEnum<any> | CockroachEnum<any>>(enum_: TEnum): Type<TEnum['enumValues'][number]>;
}

export interface CreateInsertSchema {
	<TTable extends Table>(
		table: TTable,
	): BuildSchema<'insert', NestEmbedded<TTable['_']['columns']>, undefined>;
	<
		TTable extends Table,
		TRefine extends BuildRefine<NestEmbedded<Pick<TTable['_']['columns'], keyof InferInsertColumns<TTable>>>>,
	>(
		table: TTable,
		refine?: NoUnknownKeys<TRefine, InferInsertModel<TTable>>,
	): BuildSchema<'insert', NestEmbedded<TTable['_']['columns']>, TRefine>;
}

export interface CreateUpdateSchema {
	<TTable extends Table>(
		table: TTable,
	): BuildSchema<'update', NestEmbedded<TTable['_']['columns']>, undefined>;
	<
		TTable extends Table,
		TRefine extends BuildRefine<NestEmbedded<Pick<TTable['_']['columns'], keyof InferInsertColumns<TTable>>>>,
	>(
		table: TTable,
		refine?: TRefine,
	): BuildSchema<'update', NestEmbedded<TTable['_']['columns']>, TRefine>;
}
