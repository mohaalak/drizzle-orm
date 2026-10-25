import type * as v from 'valibot';
import type { Column } from '~/column.ts';
import type { DeclaredColumnNotNull, EmbeddedUnionTagKey, NestEmbedded, UnionSharedColumnNotNull } from '~/embed.ts';
import type { SQL } from '~/sql/sql.ts';
import type { Subquery } from '~/subquery.ts';
import type { Table } from '~/table.ts';
import type { Assume, DrizzleTypeError, Simplify } from '~/utils.ts';
import type { View } from '~/view.ts';
import type { ColumnIsGeneratedAlwaysAs } from '../utils.ts';
import type { GetValibotTypeFromColumn, HandleColumn } from './column.types.ts';

export interface Conditions {
	never: (column?: Column) => boolean;
	optional: (column: Column, notNull: boolean) => boolean;
	nullable: (column: Column, notNull: boolean) => boolean;
	/** Wraps the object schema of an `embed()` group */
	group: (schema: v.GenericSchema) => v.GenericSchema;
	/** Wraps the schema of a `taggedUnion()` group */
	union: (schema: v.GenericSchema) => v.GenericSchema;
}

/** A nested selection: a table, a view, or an object of fields, such as a table's `embed()` group */
type NestedSelection = Record<string, any>;

type GetNestedSelection<T> = T extends Table<any> ? NestEmbedded<T['_']['columns']>
	: T extends View ? T['_']['selectedFields']
	: T;

type IsNestedSelection<T> = T extends Column | SQL | SQL.Aliased | Subquery ? false
	: T extends NestedSelection ? true
	: false;

type BuildRefineField<T> = T extends v.GenericSchema ? ((schema: T) => v.GenericSchema) | v.GenericSchema : never;

/**
 * Refinements follow the table's columns: a `taggedUnion()` variant's columns are refined under the variant's
 * name, and a shared column on the union. A union's tag column cannot be refined.
 */
export type BuildRefine<
	TColumns extends Record<string, any>,
> = {
	[
		K in keyof TColumns as TColumns[K] extends { _: { unionTag: K } } ? never
			: TColumns[K] extends Column ? K
			: IsNestedSelection<TColumns[K]> extends true ? K
			: never
	]?: TColumns[K] extends Column ? BuildRefineField<GetValibotTypeFromColumn<TColumns[K]>>
		: BuildRefine<GetNestedSelection<TColumns[K]>>;
};

type HandleRefinement<
	TType extends 'select' | 'insert' | 'update',
	TRefinement,
	TNotNull,
> = TRefinement extends (schema: any) => v.GenericSchema ? (
		TNotNull extends true ? ReturnType<TRefinement>
			: v.NullableSchema<ReturnType<TRefinement>, undefined>
	) extends infer TSchema ? TType extends 'update' ? v.OptionalSchema<Assume<TSchema, v.GenericSchema>, undefined>
		: TSchema
	: v.AnySchema
	: TRefinement;

type IsRefinementDefined<
	TRefinements extends Record<string | symbol | number, any> | undefined,
	TKey extends string | symbol | number,
> = TRefinements extends object ? TRefinements[TKey] extends v.GenericSchema | ((schema: any) => any) ? true
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
> = IsRefinementDefined<TRefinements, Assume<K, string>> extends true
	? Assume<HandleRefinement<TType, TRefinements[K & keyof TRefinements], TNotNull>, v.GenericSchema>
	: HandleColumn<TType, TColumn, TNotNull>;

/**
 * @param TInVariant whether the columns are in a `taggedUnion()` variant, whose rows read them as declared
 * rather than as the database stores them
 */
export type BuildSchema<
	TType extends 'select' | 'insert' | 'update',
	TColumns extends Record<string, any>,
	TRefinements extends Record<string, any> | undefined,
	TInVariant extends boolean = false,
> = v.ObjectSchema<BuildEntries<TType, TColumns, TRefinements, TInVariant>, undefined>;

type BuildEntries<
	TType extends 'select' | 'insert' | 'update',
	TColumns extends Record<string, any>,
	TRefinements extends Record<string, any> | undefined,
	TInVariant extends boolean,
> =
	// Checked against `ObjectEntries` through `infer`, so a generic nested selection is not expanded
	Simplify<
		{
			readonly [
				K in keyof TColumns as ColumnIsGeneratedAlwaysAs<TColumns[K]> extends true ? TType extends 'select' ? K
					: never
					: K
			]: TColumns[K] extends infer TColumn extends Column ? BuildField<
					TType,
					TColumn,
					TInVariant extends true ? DeclaredColumnNotNull<TColumn> : TColumn['_']['notNull'],
					TRefinements,
					K
				>
				: IsNestedSelection<TColumns[K]> extends true
					? [EmbeddedUnionTagKey<TColumns[K]>] extends [never] ? BuildSchema<
							TType,
							GetNestedSelection<TColumns[K]>,
							RefinementsOf<TRefinements, K>,
							TInVariant
						> extends infer TNested extends v.GenericSchema ? BuildGroup<TType, TNested>
						: never
					: BuildUnion<TType, TColumns[K], EmbeddedUnionTagKey<TColumns[K]>, RefinementsOf<TRefinements, K>>
				: v.AnySchema;
		}
	> extends infer TEntries extends v.ObjectEntries ? TEntries
		: never;

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
> = TTag extends string ? Simplify<
		& { readonly [K in TKey]: v.LiteralSchema<TTag, undefined> }
		& (TTag extends keyof TGroup ? BuildEntries<TType, TGroup[TTag], RefinementsOf<TRefinements, TTag>, true>
			: {})
		& {
			readonly [
				K in UnionSharedKeys<TGroup, TTag> as ColumnIsGeneratedAlwaysAs<TGroup[K]> extends true
					? TType extends 'select' ? K : never
					: K
			]: BuildField<TType, TGroup[K], UnionSharedColumnNotNull<TGroup[K], TTag>, TRefinements, K>;
		}
	> extends infer TEntries extends v.ObjectEntries ? v.StrictObjectSchema<TEntries, undefined>
	: never
	: never;

/**
 * A `taggedUnion()` group: a variant schema of its variants. It is always written whole, so an insert
 * requires it, and an update may only leave it out.
 */
type BuildUnion<
	TType extends 'select' | 'insert' | 'update',
	TGroup extends Record<string, any>,
	TKey extends string,
	TRefinements extends Record<string, any> | undefined,
> = BuildUnionVariant<TType, TGroup, TKey, TGroup[TKey]['_']['data'], TRefinements>[] extends
	infer TOptions extends v.VariantOptions<TKey>
	? TType extends 'update' ? v.OptionalSchema<v.VariantSchema<TKey, TOptions, undefined>, undefined>
	: v.VariantSchema<TKey, TOptions, undefined>
	: never;

/**
 * Nested objects only reach insert and update schemas as tables' `embed()` groups: an insert can
 * leave out a group whose fields are all optional, and an update can also set it to `null`.
 */
type BuildGroup<
	TType extends 'select' | 'insert' | 'update',
	TSchema extends v.GenericSchema,
> = TType extends 'update' ? v.OptionalSchema<v.NullableSchema<TSchema, undefined>, undefined>
	: TType extends 'insert'
		? TSchema extends v.ObjectSchema<infer TEntries, any>
			? TEntries[keyof TEntries] extends v.OptionalSchema<any, any> ? v.OptionalSchema<TSchema, undefined>
			: TSchema
		: TSchema
	: TSchema;

/** The keys of any member of `T`, such as any variant of a `taggedUnion()` */
type KeysOf<T> = T extends any ? keyof T : never;

type ValueOf<T, K> = T extends any ? K extends keyof T ? T[K] : never : never;

export type NoUnknownKeys<
	TRefinement extends Record<string, any>,
	TCompare extends Record<string, any>,
> = {
	[K in keyof TRefinement]: K extends KeysOf<TCompare>
		? TRefinement[K] extends Record<string, v.GenericSchema> ? NoUnknownKeys<TRefinement[K], ValueOf<TCompare, K>>
		: TRefinement[K]
		: DrizzleTypeError<`Found unknown key in refinement: "${K & string}"`>;
};
