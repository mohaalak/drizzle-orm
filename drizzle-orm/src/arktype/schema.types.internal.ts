import type { Type, type } from 'arktype';
import type { Column } from '~/column.ts';
import type { NestEmbedded } from '~/embed.ts';
import type { SQL } from '~/sql/sql.ts';
import type { Subquery } from '~/subquery.ts';
import type { Table } from '~/table.ts';
import type { DrizzleTypeError, Simplify } from '~/utils.ts';
import type { View } from '~/view.ts';
import type { ColumnIsGeneratedAlwaysAs } from '../utils.ts';
import type { ArktypeNullable, ArktypeOptional, GetArktypeType, HandleColumn } from './column.types.ts';

export interface Conditions {
	never: (column?: Column) => boolean;
	optional: (column: Column) => boolean;
	nullable: (column: Column) => boolean;
	/** Wraps the object schema of an `embed()` group. May return an optional-property definition. */
	group: (schema: Type) => any;
}

/** A nested selection: a table, a view, or an object of fields, such as a table's `embed()` group */
type NestedSelection = Record<string, any>;

type GetNestedSelection<T> = T extends Table<any> ? NestEmbedded<T['_']['columns']>
	: T extends View ? T['_']['selectedFields']
	: T;

type IsNestedSelection<T> = T extends Column | SQL | SQL.Aliased | Subquery ? false
	: T extends NestedSelection ? true
	: false;

type GenericSchema = type.cast<unknown> | [type.cast<unknown>, '?'];

type BuildRefineField<T> = T extends GenericSchema ? ((schema: T) => GenericSchema) | GenericSchema : never;

export type BuildRefine<
	TColumns extends Record<string, any>,
> = {
	[K in keyof TColumns as TColumns[K] extends Column ? K : IsNestedSelection<TColumns[K]> extends true ? K : never]?:
		TColumns[K] extends Column ? BuildRefineField<GetArktypeType<TColumns[K]>>
			: BuildRefine<GetNestedSelection<TColumns[K]>>;
};

type HandleRefinement<
	TType extends 'select' | 'insert' | 'update',
	TRefinement,
	TColumn extends Column,
> = TRefinement extends (schema: any) => GenericSchema ? (
		TColumn['_']['notNull'] extends true ? ReturnType<TRefinement>
			: ArktypeNullable<ReturnType<TRefinement>>
	) extends infer TSchema ? TType extends 'update' ? ArktypeOptional<TSchema>
		: TSchema
	: Type<any>
	: TRefinement;

type IsRefinementDefined<
	TRefinements extends Record<string | symbol | number, any> | undefined,
	TKey extends string | symbol | number,
> = TRefinements extends object ? TRefinements[TKey] extends GenericSchema | ((schema: any) => any) ? true
	: false
	: false;

export type BuildSchema<
	TType extends 'select' | 'insert' | 'update',
	TColumns extends Record<string, any>,
	TRefinements extends Record<string, any> | undefined,
> = type.instantiate<
	Simplify<
		{
			readonly [
				K in keyof TColumns as ColumnIsGeneratedAlwaysAs<TColumns[K]> extends true ? TType extends 'select' ? K
					: never
					: K
			]: TColumns[K] extends infer TColumn extends Column
				? IsRefinementDefined<TRefinements, K> extends true
					? HandleRefinement<TType, TRefinements[K & keyof TRefinements], TColumn>
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
				: any;
		}
	>
>;

type PropAcceptsUndefined<TProp> = TProp extends { kind: 'optional' } ? true
	: TProp extends { value: { inferIn: infer In } } ? [undefined] extends [In] ? true : false
	: false;

/**
 * True when every field of an object schema accepts `undefined`: its key is optional, or its value
 * type does. An object with no fields is included, matching `every` on an empty list.
 */
type AllFieldsAcceptUndefined<TSchema> = [TSchema] extends [{ readonly props: readonly (infer Prop)[] }]
	? [Prop] extends [never] ? true
	: [PropAcceptsUndefined<Prop>] extends [true] ? true
	: false
	: false;

/**
 * Nested objects only reach insert and update schemas as tables' `embed()` groups: an insert can
 * leave out a group whose fields are all optional, and an update can also set it to `null`.
 */
type BuildGroup<TType extends 'select' | 'insert' | 'update', TSchema> = TType extends 'update'
	? ArktypeOptional<ArktypeNullable<TSchema>>
	: TType extends 'insert' ? AllFieldsAcceptUndefined<TSchema> extends true ? [TSchema, '?']
		: TSchema
	: TSchema;

export type NoUnknownKeys<
	TRefinement extends Record<string, any>,
	TCompare extends Record<string, any>,
> = {
	[K in keyof TRefinement]: K extends keyof TCompare
		? TRefinement[K] extends Record<string, GenericSchema> ? NoUnknownKeys<TRefinement[K], TCompare[K]>
		: TRefinement[K]
		: DrizzleTypeError<`Found unknown key in refinement: "${K & string}"`>;
};
