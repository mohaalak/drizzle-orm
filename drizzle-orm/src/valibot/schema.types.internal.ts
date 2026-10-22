import type * as v from 'valibot';
import type { Column } from '~/column.ts';
import type { NestEmbedded } from '~/embed.ts';
import type { SQL } from '~/sql/sql.ts';
import type { Subquery } from '~/subquery.ts';
import type { Table } from '~/table.ts';
import type { Assume, DrizzleTypeError, Simplify } from '~/utils.ts';
import type { View } from '~/view.ts';
import type { ColumnIsGeneratedAlwaysAs } from '../utils.ts';
import type { GetValibotTypeFromColumn, HandleColumn } from './column.types.ts';

export interface Conditions {
	never: (column?: Column) => boolean;
	optional: (column: Column) => boolean;
	nullable: (column: Column) => boolean;
	/** Wraps the object schema of an `embed()` group */
	group: (schema: v.GenericSchema) => v.GenericSchema;
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

export type BuildRefine<
	TColumns extends Record<string, any>,
> = {
	[K in keyof TColumns as TColumns[K] extends Column ? K : IsNestedSelection<TColumns[K]> extends true ? K : never]?:
		TColumns[K] extends Column ? BuildRefineField<GetValibotTypeFromColumn<TColumns[K]>>
			: BuildRefine<GetNestedSelection<TColumns[K]>>;
};

type HandleRefinement<
	TType extends 'select' | 'insert' | 'update',
	TRefinement,
	TColumn extends Column,
> = TRefinement extends (schema: any) => v.GenericSchema ? (
		TColumn['_']['notNull'] extends true ? ReturnType<TRefinement>
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

export type BuildSchema<
	TType extends 'select' | 'insert' | 'update',
	TColumns extends Record<string, any>,
	TRefinements extends Record<string, any> | undefined,
> =
	// Checked against `ObjectEntries` through `infer`, so a generic nested selection is not expanded
	Simplify<
		{
			readonly [
				K in keyof TColumns as ColumnIsGeneratedAlwaysAs<TColumns[K]> extends true ? TType extends 'select' ? K
					: never
					: K
			]: TColumns[K] extends infer TColumn extends Column
				? IsRefinementDefined<TRefinements, Assume<K, string>> extends true
					? Assume<HandleRefinement<TType, TRefinements[K & keyof TRefinements], TColumn>, v.GenericSchema>
				: HandleColumn<TType, TColumn>
				: IsNestedSelection<TColumns[K]> extends true ? BuildSchema<
						TType,
						GetNestedSelection<TColumns[K]>,
						TRefinements extends object ? K extends keyof TRefinements ? TRefinements[K] : undefined
							: undefined
					> extends infer TNested extends v.GenericSchema ? BuildGroup<TType, TNested>
					: never
				: v.AnySchema;
		}
	> extends infer TEntries extends v.ObjectEntries ? v.ObjectSchema<TEntries, undefined>
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

export type NoUnknownKeys<
	TRefinement extends Record<string, any>,
	TCompare extends Record<string, any>,
> = {
	[K in keyof TRefinement]: K extends keyof TCompare
		? TRefinement[K] extends Record<string, v.GenericSchema> ? NoUnknownKeys<TRefinement[K], TCompare[K]>
		: TRefinement[K]
		: DrizzleTypeError<`Found unknown key in refinement: "${K & string}"`>;
};
