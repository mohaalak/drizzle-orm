import type { z } from 'zod/v4';
import type { Column } from '~/column.ts';
import type { DeclaredColumnNotNull, EmbeddedUnionTagKey, NestEmbedded, UnionSharedColumnNotNull } from '~/embed.ts';
import type { SQL } from '~/sql/sql.ts';
import type { Subquery } from '~/subquery.ts';
import type { Table } from '~/table.ts';
import type { Assume, DrizzleTypeError, Simplify } from '~/utils.ts';
import type { View } from '~/view.ts';
import type { ColumnIsGeneratedAlwaysAs } from '../utils.ts';
import type { GetZodType, HandleColumn } from './column.types.ts';
import type { CoerceOptions } from './schema.types.ts';

export interface Conditions {
	never: (column?: Column) => boolean;
	optional: (column: Column, notNull: boolean) => boolean;
	nullable: (column: Column, notNull: boolean) => boolean;
	/** Wraps the object schema of an `embed()` group */
	group: (schema: z.ZodType) => z.ZodType;
	/** Wraps the schema of a `taggedUnion()` group */
	union: (schema: z.ZodType) => z.ZodType;
}

/** A nested selection: a table, a view, or an object of fields, such as a table's `embed()` group */
type NestedSelection = Record<string, any>;

type GetNestedSelection<T> = T extends Table<any> ? NestEmbedded<T['_']['columns']>
	: T extends View ? T['_']['selectedFields']
	: T;

type IsNestedSelection<T> = T extends Column | SQL | SQL.Aliased | Subquery ? false
	: T extends NestedSelection ? true
	: false;

type BuildRefineField<T> = T extends z.ZodType ? ((schema: T) => z.ZodType) | z.ZodType : never;

/**
 * Refinements follow the table's columns: a `taggedUnion()` variant's columns are refined under the variant's
 * name, and a shared column on the union. A union's tag column cannot be refined.
 */
export type BuildRefine<
	TColumns extends Record<string, any>,
	TCoerce extends CoerceOptions,
> = {
	[
		K in keyof TColumns as TColumns[K] extends { _: { unionTag: K } } ? never
			: TColumns[K] extends Column ? K
			: IsNestedSelection<TColumns[K]> extends true ? K
			: never
	]?: TColumns[K] extends Column ? BuildRefineField<GetZodType<TColumns[K], TCoerce>>
		: BuildRefine<GetNestedSelection<TColumns[K]>, TCoerce>;
};

type HandleRefinement<
	TType extends 'select' | 'insert' | 'update',
	TRefinement,
	TNotNull,
> = TRefinement extends (schema: any) => z.ZodType ? (TNotNull extends true ? ReturnType<TRefinement>
		: z.ZodNullable<ReturnType<TRefinement>>) extends infer TSchema extends z.ZodType
		? TType extends 'update' ? z.ZodOptional<TSchema> : TSchema
	: z.ZodType
	: TRefinement;

type IsRefinementDefined<
	TRefinements extends Record<string | symbol | number, any> | undefined,
	TKey extends string | symbol | number,
> = TRefinements extends object ? TRefinements[TKey] extends z.ZodType | ((schema: any) => any) ? true
	: false
	: false;

type RefinementsOf<TRefinements, K> = TRefinements extends object ? K extends keyof TRefinements ? TRefinements[K]
	: undefined
	: undefined;

/** A column's schema, given whether it is `NOT NULL` where it is read */
type BuildField<
	TType extends 'select' | 'insert' | 'update',
	TColumn extends Column,
	TNotNull,
	TRefinements extends Record<string, any> | undefined,
	K,
	TCoerce extends CoerceOptions,
> = IsRefinementDefined<TRefinements, Assume<K, string>> extends true
	? Assume<HandleRefinement<TType, TRefinements[K & keyof TRefinements], TNotNull>, z.ZodType>
	: HandleColumn<TType, TColumn, TCoerce, TNotNull>;

/**
 * @param TInVariant whether the columns are in a `taggedUnion()` variant, whose rows read them as declared
 * rather than as the database stores them
 */
export type BuildSchema<
	TType extends 'select' | 'insert' | 'update',
	TColumns extends Record<string, any>,
	TRefinements extends Record<string, any> | undefined,
	TCoerce extends CoerceOptions,
	TInVariant extends boolean = false,
> = z.ZodObject<
	Simplify<
		{
			[
				K in keyof TColumns as ColumnIsGeneratedAlwaysAs<TColumns[K]> extends true ? TType extends 'select' ? K
					: never
					: K
			]: TColumns[K] extends infer TColumn extends Column ? BuildField<
					TType,
					TColumn,
					TInVariant extends true ? DeclaredColumnNotNull<TColumn> : TColumn['_']['notNull'],
					TRefinements,
					K,
					TCoerce
				>
				: IsNestedSelection<TColumns[K]> extends true ? [EmbeddedUnionTagKey<TColumns[K]>] extends [never] ? BuildGroup<
							TType,
							BuildSchema<
								TType,
								GetNestedSelection<TColumns[K]>,
								RefinementsOf<TRefinements, K>,
								TCoerce,
								TInVariant
							>
						>
					: BuildUnion<TType, TColumns[K], EmbeddedUnionTagKey<TColumns[K]>, RefinementsOf<TRefinements, K>, TCoerce>
				: z.ZodAny;
		}
	>,
	{ out: {}; in: {} }
>;

/** The columns variants share that variant `TTag` declares */
type UnionSharedKeys<TGroup, TTag extends string> = {
	[K in keyof TGroup]: TGroup[K] extends { _: { unionShared: { [P in TTag]: boolean } } } ? K : never;
}[keyof TGroup];

/** One variant of a `taggedUnion()` group: its tag, its columns and the shared columns it declares */
type BuildUnionVariant<
	TType extends 'select' | 'insert' | 'update',
	TGroup extends Record<string, any>,
	TKey extends string,
	TTag,
	TRefinements extends Record<string, any> | undefined,
	TCoerce extends CoerceOptions,
> = TTag extends string ? z.ZodObject<
		Simplify<
			& { [K in TKey]: z.ZodLiteral<TTag> }
			& (TTag extends keyof TGroup
				? BuildSchema<TType, TGroup[TTag], RefinementsOf<TRefinements, TTag>, TCoerce, true>['shape']
				: {})
			& {
				[
					K in UnionSharedKeys<TGroup, TTag> as ColumnIsGeneratedAlwaysAs<TGroup[K]> extends true
						? TType extends 'select' ? K : never
						: K
				]: BuildField<
					TType,
					TGroup[K],
					UnionSharedColumnNotNull<TGroup[K], TTag>,
					TRefinements,
					K,
					TCoerce
				>;
			}
		>,
		{ out: {}; in: {} }
	>
	: never;

/**
 * A `taggedUnion()` group: a discriminated union of its variants. It is always written whole, so an
 * insert requires it, and an update may only leave it out.
 */
type BuildUnion<
	TType extends 'select' | 'insert' | 'update',
	TGroup extends Record<string, any>,
	TKey extends string,
	TRefinements extends Record<string, any> | undefined,
	TCoerce extends CoerceOptions,
> = z.ZodDiscriminatedUnion<
	BuildUnionVariant<TType, TGroup, TKey, TGroup[TKey]['_']['data'], TRefinements, TCoerce>[]
> extends infer TSchema extends z.ZodType ? TType extends 'update' ? z.ZodOptional<TSchema> : TSchema
	: never;

/**
 * Nested objects only reach insert and update schemas as tables' `embed()` groups: an insert can
 * leave out a group whose fields are all optional, and an update can also set it to `null`.
 */
type BuildGroup<TType extends 'select' | 'insert' | 'update', TSchema extends z.ZodObject> = TType extends 'update'
	? z.ZodOptional<z.ZodNullable<TSchema>>
	: TType extends 'insert'
		? TSchema['shape'][keyof TSchema['shape']] extends z.ZodOptional<any> ? z.ZodOptional<TSchema> : TSchema
	: TSchema;

/** The keys of any member of `T`, such as any variant of a `taggedUnion()` */
type KeysOf<T> = T extends any ? keyof T : never;

type ValueOf<T, K> = T extends any ? K extends keyof T ? T[K] : never : never;

export type NoUnknownKeys<
	TRefinement extends Record<string, any>,
	TCompare extends Record<string, any>,
> = {
	[K in keyof TRefinement]: K extends KeysOf<TCompare>
		? TRefinement[K] extends Record<string, z.ZodType> ? NoUnknownKeys<TRefinement[K], ValueOf<TCompare, K>>
		: TRefinement[K]
		: DrizzleTypeError<`Found unknown key in refinement: "${K & string}"`>;
};
