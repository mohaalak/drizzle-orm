import { Column } from './column.ts';
import { is } from './entity.ts';

/**
 * Holds the Column Schema of an `embed()` or `taggedUnion()` group on the group of a built table:
 * `users.address[ColumnSchemaKey]`. Read it with {@link getColumnSchema}.
 */
export const ColumnSchemaKey = Symbol.for('drizzle:ColumnSchema');

/**
 * What `.schema(...)` takes: a schema whose encoded side is the value the driver reads for the column,
 * such as an Effect Schema. Drizzle only records it, and `withDomainWrites` encodes writes with it.
 */
export interface ColumnSchemaLike<TEncoded = unknown> {
	readonly Type: unknown;
	readonly Encoded: TEncoded;
}

/** A column or group builder that carries the Column Schema `TSchema`. */
export type HasColumnSchema<T, TSchema> = T & { _: { columnSchema: TSchema } };

/** The Column Schema markers a column builder's config carries into the built column's config. */
export type ColumnSchemaMarkers<T> = Pick<T, Extract<keyof T, 'columnSchema' | 'domainWrite'>>;

/**
 * The Column Schema of a column, or of an `embed()` / `taggedUnion()` group of a built table.
 * `undefined` when it has none.
 */
export type ColumnSchemaOf<T> = T extends { readonly _: { readonly columnSchema: infer TSchema } } ? TSchema
	: T extends { readonly [ColumnSchemaKey]: infer TSchema } ? TSchema
	: undefined;

/**
 * The Column Schema given with `.schema(...)` to a column, or to an `embed()` / `taggedUnion()` group:
 * `getColumnSchema(users.id)`, `getColumnSchema(users.address)`. `undefined` when it has none.
 */
export function getColumnSchema<T>(columnOrGroup: T): ColumnSchemaOf<T> {
	if (is(columnOrGroup, Column)) {
		return (columnOrGroup as unknown as { config: { columnSchema?: unknown } }).config
			.columnSchema as ColumnSchemaOf<T>;
	}
	if (typeof columnOrGroup === 'object' && columnOrGroup !== null) {
		return (columnOrGroup as Record<symbol, unknown>)[ColumnSchemaKey] as ColumnSchemaOf<T>;
	}
	return undefined as ColumnSchemaOf<T>;
}
