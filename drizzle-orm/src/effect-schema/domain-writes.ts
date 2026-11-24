import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import { ColumnSchemaKey, type ColumnSchemaLike, getColumnSchema } from '~/column-schema.ts';
import type { Column } from '~/column.ts';
import {
	DomainEncodedColumnKey,
	EmbeddedColumns,
	type EmbeddedGroupEncoder,
	EmbeddedGroupEncoderKey,
	EncodedColumnValue,
	getTableShape,
} from '~/embed.ts';
import type { NestEmbedded } from '~/embed.ts';
import { is } from '~/entity.ts';
import { Table } from '~/table.ts';

const DomainWrites = Symbol.for('drizzle:DomainWrites');

/** Marks a column of a table with domain writes: what a write and a `where` value take for it. */
export interface DomainWriteColumn<TSchema extends ColumnSchemaLike> {
	readonly _: {
		readonly domainWrite: {
			readonly value: TSchema['Type'];
			readonly option: Option.Option<TSchema['Type']>;
		};
	};
}

/** The columns of a flat column map that carry a Column Schema, each with its domain write marker. */
export type DomainWriteColumns<TColumns> = {
	[
		K in keyof TColumns as TColumns[K] extends { _: { columnSchema: ColumnSchemaLike } } ? K : never
	]: TColumns[K] extends { _: { columnSchema: infer TSchema extends ColumnSchemaLike } } ? DomainWriteColumn<TSchema>
		: never;
};

/**
 * A table whose writes and `where` values take its Column Schemas' domain values. Its read types are
 * the table's own.
 */
export type DomainWritesTable<TTable extends Table> =
	& TTable
	& {
		readonly _: {
			readonly columns: DomainWriteColumns<TTable['_']['columns']>;
			readonly domainWrites: true;
		};
	}
	& NestEmbedded<DomainWriteColumns<TTable['_']['columns']>>;

function encodeColumn(column: Column, schema: ColumnSchemaLike): void {
	const encode = Schema.encodeSync(schema as unknown as Schema.Codec<unknown, unknown, never, never>);
	const toDriver = column.mapToDriverValue;
	const mapToDriverValue = (value: unknown): unknown => {
		let encoded: unknown;
		if (is(value, EncodedColumnValue)) {
			// Its group's Column Schema already encoded it.
			encoded = value.value;
		} else {
			const domain = Option.isOption(value) ? Option.getOrNull(value) : value;
			if (domain === null) return null;
			encoded = encode(domain);
		}
		return toDriver.isNoop ? encoded : toDriver.call(column, encoded);
	};
	(column as { mapToDriverValue: unknown }).mapToDriverValue = mapToDriverValue;
	Object.defineProperty(column, DomainEncodedColumnKey, { value: true });
}

function encodeGroups(group: Record<string, unknown>): void {
	const schema = (group as Record<symbol, ColumnSchemaLike | undefined>)[ColumnSchemaKey];
	if (schema) {
		const encode: EmbeddedGroupEncoder = Schema.encodeSync(
			schema as unknown as Schema.Codec<unknown, unknown, never, never>,
		) as EmbeddedGroupEncoder;
		Object.defineProperty(group, EmbeddedGroupEncoderKey, { value: encode });
	}
	for (const entry of Object.values(group)) {
		if (is(entry, EmbeddedColumns)) encodeGroups(entry);
	}
}

/**
 * Switches a table to domain writes: inserts, updates and `where` values take each Column Schema's
 * domain value, an `Option` of it for a nullable column, and a group's domain value for a group with
 * a Column Schema. Drizzle encodes them through the Column Schemas, and writes `NULL` for `Option.none()`.
 * A value that fails to encode throws, since a valid domain value that cannot be encoded is a bug in
 * its Column Schema.
 *
 * Reads are unchanged: they return what the driver reads, and their types stay the driver's.
 * `$inferInsert` keeps the driver's types too; use `InferInsertModel<typeof table>`.
 *
 * @example
 * ```ts
 * const users = withDomainWrites(mysqlTable('users', {
 * 	id: serial().primaryKey().schema(UserId),
 * 	deletedAt: datetime().schema(DateTime),
 * }));
 *
 * await db.update(users).set({ deletedAt: Option.none() }).where(eq(users.id, userId));
 * ```
 */
export function withDomainWrites<TTable extends Table>(table: TTable): DomainWritesTable<TTable> {
	if ((table as unknown as Record<symbol, unknown>)[DomainWrites]) return table as DomainWritesTable<TTable>;

	for (const column of Object.values(table[Table.Symbol.Columns]) as Column[]) {
		const schema = getColumnSchema(column) as ColumnSchemaLike | undefined;
		if (schema) encodeColumn(column, schema);
	}
	encodeGroups(getTableShape(table));
	Object.defineProperty(table, DomainWrites, { value: true });

	return table as DomainWritesTable<TTable>;
}
