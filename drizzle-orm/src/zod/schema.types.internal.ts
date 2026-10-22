import type { z } from 'zod/v4';
import type { Column } from '~/column.ts';
import type { NestEmbedded } from '~/embed.ts';
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
	optional: (column: Column) => boolean;
	nullable: (column: Column) => boolean;
	/** Wraps the object schema of an `embed()` group */
	group: (schema: z.ZodType) => z.ZodType;
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

export type BuildRefine<
	TColumns extends Record<string, any>,
	TCoerce extends CoerceOptions,
> = {
	[K in keyof TColumns as TColumns[K] extends Column ? K : IsNestedSelection<TColumns[K]> extends true ? K : never]?:
		TColumns[K] extends Column ? BuildRefineField<GetZodType<TColumns[K], TCoerce>>
			: BuildRefine<GetNestedSelection<TColumns[K]>, TCoerce>;
};

type HandleRefinement<
	TType extends 'select' | 'insert' | 'update',
	TRefinement,
	TColumn extends Column,
> = TRefinement extends (schema: any) => z.ZodType ? (TColumn['_']['notNull'] extends true ? ReturnType<TRefinement>
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

export type BuildSchema<
	TType extends 'select' | 'insert' | 'update',
	TColumns extends Record<string, any>,
	TRefinements extends Record<string, any> | undefined,
	TCoerce extends CoerceOptions,
> = z.ZodObject<
	Simplify<
		{
			[
				K in keyof TColumns as ColumnIsGeneratedAlwaysAs<TColumns[K]> extends true ? TType extends 'select' ? K
					: never
					: K
			]: TColumns[K] extends infer TColumn extends Column
				? IsRefinementDefined<TRefinements, K> extends true
					? Assume<HandleRefinement<TType, TRefinements[K & keyof TRefinements], TColumn>, z.ZodType>
				: HandleColumn<TType, TColumn, TCoerce>
				: IsNestedSelection<TColumns[K]> extends true ? BuildGroup<
						TType,
						BuildSchema<
							TType,
							GetNestedSelection<TColumns[K]>,
							TRefinements extends object ? K extends keyof TRefinements ? TRefinements[K] : undefined : undefined,
							TCoerce
						>
					>
				: z.ZodAny;
		}
	>,
	{ out: {}; in: {} }
>;

/**
 * Nested objects only reach insert and update schemas as tables' `embed()` groups: an insert can
 * leave out a group whose fields are all optional, and an update can also set it to `null`.
 */
type BuildGroup<TType extends 'select' | 'insert' | 'update', TSchema extends z.ZodObject> = TType extends 'update'
	? z.ZodOptional<z.ZodNullable<TSchema>>
	: TType extends 'insert'
		? TSchema['shape'][keyof TSchema['shape']] extends z.ZodOptional<any> ? z.ZodOptional<TSchema> : TSchema
	: TSchema;

export type NoUnknownKeys<
	TRefinement extends Record<string, any>,
	TCompare extends Record<string, any>,
> = {
	[K in keyof TRefinement]: K extends keyof TCompare
		? TRefinement[K] extends Record<string, z.ZodType> ? NoUnknownKeys<TRefinement[K], TCompare[K]>
		: TRefinement[K]
		: DrizzleTypeError<`Found unknown key in refinement: "${K & string}"`>;
};
