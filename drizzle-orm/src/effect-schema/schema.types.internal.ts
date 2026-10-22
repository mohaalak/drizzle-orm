import type { Schema as s } from 'effect';
import type { Struct, Top as SchemaTop, UndefinedOr } from 'effect/Schema';
import type { Column } from '~/column.ts';
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
}

/** A nested selection: a table, a view, or an object of fields, such as a table's `embed()` group */
type NestedSelection = Record<string, any>;

type GetNestedSelection<T> = T extends Table<any> ? T['_']['columns']
	: T extends View ? T['_']['selectedFields']
	: T;

type IsNestedSelection<T> = T extends Column | SQL | SQL.Aliased | Subquery ? false
	: T extends NestedSelection ? true
	: false;

type BuildRefineField<T> = T extends SchemaTop ? ((schema: T) => SchemaTop) | SchemaTop
	: never;

export type BuildRefine<
	TColumns extends Record<string, any>,
> = {
	[K in keyof TColumns as TColumns[K] extends Column ? K : IsNestedSelection<TColumns[K]> extends true ? K : never]?:
		TColumns[K] extends Column ? BuildRefineField<GetEffectSchemaType<TColumns[K]>>
			: BuildRefine<GetNestedSelection<TColumns[K]>>;
};

type HandleRefinement<
	TType extends 'select' | 'insert' | 'update',
	TRefinement,
	TColumn extends Column,
> = TRefinement extends (((schema: any) => infer R extends SchemaTop)) ? (TColumn['_']['notNull'] extends true ? R
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

export type BuildSchema<
	TType extends 'select' | 'insert' | 'update',
	TColumns extends Record<string, any>,
	TRefinements extends Record<string, any> | undefined,
> = Struct<
	Simplify<
		{
			readonly [
				K in keyof TColumns as ColumnIsGeneratedAlwaysAs<TColumns[K]> extends true ? TType extends 'select' ? K
					: never
					: K
			]: TColumns[K] extends infer TColumn extends Column ? IsRefinementDefined<TRefinements, K> extends true ? Assume<
						HandleRefinement<TType, TRefinements[K & keyof TRefinements], TColumn>,
						SchemaTop | s.optional<SchemaTop> | s.optionalKey<SchemaTop>
					>
				: HandleColumn<TType, TColumn>
				: IsNestedSelection<TColumns[K]> extends true ? BuildGroup<
						TType,
						BuildSchema<
							TType,
							GetNestedSelection<TColumns[K]>,
							TRefinements extends object ? K extends keyof TRefinements ? TRefinements[K] : undefined
								: undefined
						>
					>
				: typeof s.Any;
		}
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

export type NoUnknownKeys<
	TRefinement extends Record<string, any>,
	TCompare extends Record<string, any>,
> = {
	[K in keyof TRefinement]: K extends keyof TCompare
		? TRefinement[K] extends Record<string, SchemaTop> ? NoUnknownKeys<TRefinement[K], TCompare[K]>
		: TRefinement[K]
		: DrizzleTypeError<`Found unknown key in refinement: "${K & string}"`>;
};
