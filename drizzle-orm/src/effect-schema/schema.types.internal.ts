import type { Schema as s } from 'effect';
import type { Struct, Top as SchemaTop, UndefinedOr } from 'effect/Schema';
import type { Column } from '~/column.ts';
import type { UnionColumnNotNull, UnionGroupTags, UnionToTuple, UnionVariantFields } from '~/embed-validators.ts';
import type { EmbeddedUnionTagKey, NestEmbedded } from '~/embed.ts';
import type { SQL } from '~/sql/sql.ts';
import type { Subquery } from '~/subquery.ts';
import type { Table } from '~/table.ts';
import type { Assume, DrizzleTypeError, Simplify } from '~/utils.ts';
import type { View } from '~/view.ts';
import type { ColumnIsGeneratedAlwaysAs } from '../utils.ts';
import type { GetEffectSchemaType, HandleColumn } from './column.types.ts';

export interface Conditions {
	never: (column?: Column) => boolean;
	optional: (column: Column) => boolean;
	nullable: (column: Column) => boolean;
	/** Wraps the object schema of an `embed()` group */
	group: (schema: SchemaTop) => SchemaTop;
	/** Wraps the union of variants of a `taggedUnion()` group */
	union: (schema: SchemaTop) => SchemaTop;
}

/** A nested selection: a table, a view, or an object of fields, such as a table's `embed()` group */
type NestedSelection = Record<string, any>;

type GetNestedSelection<T> = T extends Table<any> ? NestEmbedded<T['_']['columns']>
	: T extends View ? T['_']['selectedFields']
	: T;

type IsNestedSelection<T> = T extends Column | SQL | SQL.Aliased | Subquery ? false
	: T extends NestedSelection ? true
	: false;

type BuildRefineField<T> = T extends SchemaTop ? ((schema: T) => SchemaTop) | SchemaTop
	: never;

/** A union's tag column cannot be refined: the variants are told apart by it. */
type BuildNestedRefine<TGroup, TFields = Assume<GetNestedSelection<TGroup>, Record<string, any>>> = [
	EmbeddedUnionTagKey<TGroup>,
] extends [never] ? BuildRefine<Assume<TFields, Record<string, any>>>
	: Omit<BuildRefine<Assume<TFields, Record<string, any>>>, EmbeddedUnionTagKey<TGroup>>;

export type BuildRefine<
	TColumns extends Record<string, any>,
> = {
	[K in keyof TColumns as TColumns[K] extends Column ? K : IsNestedSelection<TColumns[K]> extends true ? K : never]?:
		TColumns[K] extends Column ? BuildRefineField<GetEffectSchemaType<TColumns[K]>>
			: BuildNestedRefine<TColumns[K]>;
};

type HandleRefinement<
	TType extends 'select' | 'insert' | 'update',
	TRefinement,
	TColumn extends Column,
	TNotNull extends boolean = TColumn['_']['notNull'],
> = TRefinement extends (((schema: any) => infer R extends SchemaTop)) ? ([TNotNull] extends [true] ? R
		: (s.NullOr<R>)) extends infer TSchema extends SchemaTop ? TType extends 'update' ? s.optional<UndefinedOr<TSchema>>
		: TSchema
	: typeof s.Any
	: TRefinement;

type IsRefinementDefined<
	TRefinements extends Record<string | symbol | number, any> | undefined,
	TKey extends string | symbol | number,
> = TRefinements extends object
	? TRefinements[TKey] extends SchemaTop | s.optional<SchemaTop> | s.optionalKey<SchemaTop> | ((schema: any) => any)
		? true
	: false
	: false;

/** Whether a column is `NOT NULL` where it is built: as stored, or as the union variant `TTag` declares it. */
type ColumnNotNull<TColumn extends Column, TTag extends string | undefined> = [TTag] extends [string]
	? Assume<UnionColumnNotNull<TColumn, TTag>, boolean>
	: TColumn['_']['notNull'];

export type BuildSchema<
	TType extends 'select' | 'insert' | 'update',
	TColumns extends Record<string, any>,
	TRefinements extends Record<string, any> | undefined,
	/** The union variant the columns are built for, which gives them the nullability it declared */
	TTag extends string | undefined = undefined,
> = Struct<BuildFields<TType, TColumns, TRefinements, TTag>>;

type BuildFields<
	TType extends 'select' | 'insert' | 'update',
	TColumns extends Record<string, any>,
	TRefinements extends Record<string, any> | undefined,
	TTag extends string | undefined,
> = Simplify<
	{
		readonly [
			K in keyof TColumns as ColumnIsGeneratedAlwaysAs<TColumns[K]> extends true ? TType extends 'select' ? K
				: never
				: K
		]: TColumns[K] extends infer TColumn extends Column ? IsRefinementDefined<TRefinements, K> extends true ? Assume<
					HandleRefinement<TType, TRefinements[K & keyof TRefinements], TColumn, ColumnNotNull<TColumn, TTag>>,
					SchemaTop | s.optional<SchemaTop> | s.optionalKey<SchemaTop>
				>
			: HandleColumn<TType, TColumn, ColumnNotNull<TColumn, TTag>>
			: IsNestedSelection<TColumns[K]> extends true ? [EmbeddedUnionTagKey<TColumns[K]>] extends [never] ? BuildGroup<
						TType,
						BuildSchema<
							TType,
							GetNestedSelection<TColumns[K]>,
							TRefinements extends object ? K extends keyof TRefinements ? TRefinements[K] : undefined
								: undefined,
							TTag
						>
					>
				: BuildUnion<
					TType,
					GetNestedSelection<TColumns[K]>,
					TRefinements extends object ? K extends keyof TRefinements ? TRefinements[K] : undefined
						: undefined
				>
			: typeof s.Any;
	}
>;

/**
 * A `taggedUnion()` group: the union of a struct per variant, each holding the tag's literal, the variant's
 * columns with the nullability they declared, and the shared columns it declares. An update writes the union
 * whole, so it can be left out, but not cleared.
 */
type BuildUnion<TType extends 'select' | 'insert' | 'update', TGroup, TRefinements> = UnionGroupTags<TGroup> extends
	infer TTags extends string ? WrapUnion<
		TType,
		s.Union<
			Assume<
				UnionToTuple<TTags extends string ? BuildVariant<TType, TGroup, TTags, TTags, TRefinements> : never>,
				readonly SchemaTop[]
			>
		>
	>
	: never;

type WrapUnion<TType extends 'select' | 'insert' | 'update', TSchema extends SchemaTop> = TType extends 'update'
	? s.optional<UndefinedOr<TSchema>>
	: TSchema;

type BuildVariant<
	TType extends 'select' | 'insert' | 'update',
	TGroup,
	TTag extends string,
	TTags extends string,
	TRefinements,
> = Struct<
	Simplify<
		& { readonly [P in EmbeddedUnionTagKey<TGroup>]: s.Literal<TTag> }
		& BuildFields<
			TType,
			UnionVariantFields<TGroup, TTag>,
			TRefinements extends object ? Simplify<
					& Omit<TRefinements, TTags>
					& (TTag extends keyof TRefinements ? TRefinements[TTag] extends object ? TRefinements[TTag] : {} : {})
				>
				: undefined,
			TTag
		>
	>
>;

/**
 * Nested objects only reach insert and update schemas as tables' `embed()` groups: an insert can
 * leave out a group whose fields are all optional, and an update can also set it to `null`.
 */
type BuildGroup<TType extends 'select' | 'insert' | 'update', TSchema extends Struct<any>> = TType extends 'update'
	? s.optional<UndefinedOr<s.NullOr<TSchema>>>
	: TType extends 'insert' ? EveryFieldOptional<TSchema['fields']> extends true ? s.optional<UndefinedOr<TSchema>>
		: TSchema
	: TSchema;

/** True when every field of a struct is key-optional, so an insert can leave the group out. */
type EveryFieldOptional<TFields> = [keyof TFields] extends [never] ? true
	: {
		[K in keyof TFields]: TFields[K] extends { readonly '~type.optionality': 'optional' } ? true : false;
	}[keyof TFields] extends true ? true
	: false;

type IsUnion<T, U = T> = T extends any ? [U] extends [T] ? false : true : never;

export type NoUnknownKeys<
	TRefinement extends Record<string, any>,
	TCompare extends Record<string, any>,
> = {
	[K in keyof TRefinement]: K extends keyof TCompare
		// A `taggedUnion()` group is not one object, so the keys of its variants and shared columns are not checked.
		? true extends IsUnion<Exclude<TCompare[K], null | undefined>> ? TRefinement[K]
		: TRefinement[K] extends Record<string, SchemaTop> ? NoUnknownKeys<TRefinement[K], TCompare[K]>
		: TRefinement[K]
		: DrizzleTypeError<`Found unknown key in refinement: "${K & string}"`>;
};
