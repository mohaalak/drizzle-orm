import type { Type, type } from 'arktype';
import type { ColumnTypeData, ExtractColumnTypeData } from '~/column-builder.ts';
import type { Column } from '~/column.ts';
import type { Json } from '../utils.ts';

export type ArktypeNullable<TSchema> = Type<type.infer<TSchema> | null>;

export type ArktypeOptional<TSchema> = [Type<type.infer<TSchema>>, '?'];

export type GetArktypeType<
	TColumn extends Column,
	TType extends ColumnTypeData = ExtractColumnTypeData<TColumn['_']['dataType']>,
> = TType['constraint'] extends 'json' ? Type<Json>
	: TType['type'] extends 'custom' ? Type<any>
	: Type<TColumn['_']['data']>;

type HandleSelectColumn<
	TSchema,
	TNotNull,
> = TNotNull extends true ? TSchema
	: ArktypeNullable<TSchema>;

type HandleInsertColumn<
	TSchema,
	TColumn extends Column,
	TNotNull,
> = TNotNull extends true ? TColumn['_']['hasDefault'] extends true ? ArktypeOptional<TSchema>
	: TSchema
	: ArktypeOptional<ArktypeNullable<TSchema>>;

type HandleUpdateColumn<
	TSchema,
	TNotNull,
> = TNotNull extends true ? ArktypeOptional<TSchema>
	: ArktypeOptional<ArktypeNullable<TSchema>>;

/** @param TNotNull whether the column is `NOT NULL`; a `taggedUnion()` variant's column passes its declared nullability */
export type HandleColumn<
	TType extends 'select' | 'insert' | 'update',
	TColumn extends Column,
	TNotNull = TColumn['_']['notNull'],
> = TType extends 'select' ? HandleSelectColumn<GetArktypeType<TColumn>, TNotNull>
	: TType extends 'insert' ? HandleInsertColumn<GetArktypeType<TColumn>, TColumn, TNotNull>
	: TType extends 'update' ? HandleUpdateColumn<GetArktypeType<TColumn>, TNotNull>
	: GetArktypeType<TColumn>;
