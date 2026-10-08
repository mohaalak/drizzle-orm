import type { ColumnBuilderBase } from './column-builder.ts';
import type { Column } from './column.ts';
import { entityKind, is } from './entity.ts';
import { Table } from './table.ts';
import type { Simplify } from './utils.ts';

/**
 * Separates the segments of an embedded column's key in the table's flat column map:
 * `address: embed({ city: text() })` is stored as the column `'address.city'`.
 */
export const EmbeddedKeySeparator = '.';

export interface EmbedConfig {
	/**
	 * Prepended to the database name of every column in the group that does not set its own name.
	 * Defaults to the group's key followed by an underscore: `address` + `city` → `address_city`.
	 * Pass `''` to keep the columns' own names.
	 */
	prefix?: string;
}

export class EmbedBuilder<TColumns extends Record<string, ColumnBuilderBase | EmbedBuilder<any>> = any> {
	static readonly [entityKind]: string = 'EmbedBuilder';

	declare readonly _: {
		readonly columns: TColumns;
	};

	constructor(
		/** @internal */
		readonly columns: TColumns,
		/** @internal */
		readonly config: EmbedConfig = {},
	) {}
}

/**
 * Groups columns under one key. The columns stay flat in the database, and the group is read,
 * written and referenced as a nested object.
 *
 * @example
 * ```ts
 * const users = pgTable('users', {
 * 	id: serial().primaryKey(),
 * 	address: embed({
 * 		street: text(),
 * 		city: text().notNull(),
 * 	}),
 * });
 * // columns: "id", "address_street", "address_city"
 *
 * await db.insert(users).values({ address: { street: 'Main St', city: 'Berlin' } });
 * const rows = await db.select().from(users).where(eq(users.address.city, 'Berlin'));
 * rows[0].address.city; // string
 * ```
 */
export function embed<TColumns extends Record<string, ColumnBuilderBase | EmbedBuilder<any>>>(
	columns: TColumns,
	config?: EmbedConfig,
): EmbedBuilder<TColumns> {
	return new EmbedBuilder(columns, config);
}

/**
 * Turns a table definition that may contain `embed()` groups into a flat map of builders keyed
 * by their dotted path, and names each embedded builder after its prefixed path.
 *
 * @internal
 */
export function flattenEmbedBuilders<TBuilder extends ColumnBuilderBase>(
	columns: Record<string, TBuilder | EmbedBuilder>,
	casingFn: (name: string) => string,
	keyPrefix = '',
	namePrefix = '',
	result: Record<string, TBuilder> = {},
): Record<string, TBuilder> {
	for (const [key, value] of Object.entries(columns)) {
		const path = keyPrefix + key;
		if (is(value, EmbedBuilder)) {
			flattenEmbedBuilders(
				value.columns,
				casingFn,
				path + EmbeddedKeySeparator,
				namePrefix + (value.config.prefix ?? `${key}_`),
				result,
			);
			continue;
		}

		// A group's columns take their name from the group's prefix, unless they set their own.
		if (keyPrefix) {
			(value as any).setName(namePrefix + key, casingFn);
		}
		result[path] = value as TBuilder;
	}

	return result;
}

/**
 * The columns of one `embed()` group, as they appear on the built table: `users.address.city`.
 */
export class EmbeddedColumns {
	static readonly [entityKind]: string = 'EmbeddedColumns';

	[key: string]: Column | EmbeddedColumns;
}

/**
 * Builds the nested view of a table's columns from its flat, dotted column map. Returns the map
 * itself when the table has no embedded groups.
 *
 * @internal
 */
export function nestEmbeddedColumns<TColumns extends Record<string, Column>>(
	columns: TColumns,
): Record<string, Column | EmbeddedColumns> {
	const keys = Object.keys(columns);
	if (!keys.some((key) => key.includes(EmbeddedKeySeparator))) return columns;

	const result: Record<string, Column | EmbeddedColumns> = {};
	for (const key of keys) {
		const segments = key.split(EmbeddedKeySeparator);
		let target: Record<string, Column | EmbeddedColumns> = result;
		for (const segment of segments.slice(0, -1)) {
			target = (target[segment] ??= new EmbeddedColumns()) as EmbeddedColumns;
		}
		target[segments.at(-1)!] = columns[key]!;
	}

	return result;
}

/** @internal */
export function getTableShape(table: Table): Record<string, Column | EmbeddedColumns> {
	return table[Table.Symbol.Shape] ?? table[Table.Symbol.Columns];
}

/** @internal */
export function hasEmbeddedColumns(table: Table): boolean {
	const shape = table[Table.Symbol.Shape];
	return shape !== undefined && shape !== table[Table.Symbol.Columns];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/**
 * Flattens the nested values a caller writes for `embed()` groups into the dotted keys the table's
 * column map uses: `{ address: { city: 'Berlin' } }` → `{ 'address.city': 'Berlin' }`.
 * Returns the value untouched when the table has no embedded groups.
 *
 * @internal
 */
export function flattenEmbeddedValues(table: Table, value: Record<string, unknown>): Record<string, unknown> {
	if (!hasEmbeddedColumns(table)) return value;

	const result: Record<string, unknown> = {};
	const visit = (shape: Record<string, Column | EmbeddedColumns>, source: Record<string, unknown>, path: string) => {
		for (const [key, entry] of Object.entries(source)) {
			const node = shape[key];
			if (!is(node, EmbeddedColumns)) {
				result[path + key] = entry;
				continue;
			}
			if (entry === undefined) continue;
			if (entry === null) {
				// Writing `null` to a group clears every column in it.
				for (const leaf of Object.keys(table[Table.Symbol.Columns])) {
					if (leaf.startsWith(path + key + EmbeddedKeySeparator)) result[leaf] = null;
				}
				continue;
			}
			if (!isPlainObject(entry)) {
				throw new Error(
					`Embedded group "${path}${key}" in table "${
						table[Table.Symbol.Name]
					}" must be written as an object of its columns`,
				);
			}
			visit(node, entry, path + key + EmbeddedKeySeparator);
		}
	};
	visit(getTableShape(table), value, '');

	return result;
}

// ----------------------------------------------------------------------------- types

type DottedKey = `${string}${typeof EmbeddedKeySeparator}${string}`;

type HeadOf<TKey> = TKey extends `${infer Head}.${string}` ? Head : never;

type GroupKeys<T> = HeadOf<Extract<keyof T, DottedKey>>;

type GroupOf<T, Head extends string> = {
	[K in keyof T as K extends `${Head}.${infer Rest}` ? Rest : never]: T[K];
};

/**
 * Nests the dotted keys of a flat map into objects: `{ 'address.city': string }` →
 * `{ address: { city: string } }`. A group is optional when every key in it is. Maps without
 * dotted keys come back unchanged.
 */
export type NestEmbedded<T> = [Extract<keyof T, DottedKey>] extends [never] ? T
	: Simplify<
		& { [K in keyof T as K extends DottedKey ? never : K]: T[K] }
		& {
			[Head in GroupKeys<T> as {} extends GroupOf<T, Head> ? never : Head]: NestEmbedded<GroupOf<T, Head>>;
		}
		& {
			[Head in GroupKeys<T> as {} extends GroupOf<T, Head> ? Head : never]?: NestEmbedded<GroupOf<T, Head>>;
		}
	>;

/**
 * {@link NestEmbedded} for a map whose every key is optional, such as an update's `set`. It is
 * not a conditional type, so an empty object stays assignable to it while the table is generic.
 */
export type NestEmbeddedPartial<T> =
	& { [K in keyof T as K extends DottedKey ? never : K]?: T[K] }
	& { [Head in GroupKeys<T>]?: NestEmbeddedPartial<GroupOf<T, Head>> };

/**
 * Flattens a table definition's `embed()` groups into dotted keys, mirroring
 * {@link flattenEmbedBuilders}.
 */
export type FlattenEmbedBuilders<TColumns, TPrefix extends string = ''> = Simplify<
	UnionToIntersection<
		{
			[K in keyof TColumns & string]: TColumns[K] extends EmbedBuilder<infer TInner>
				? FlattenEmbedBuilders<TInner, `${TPrefix}${K}.`>
				: { [P in `${TPrefix}${K}`]: TColumns[K] };
		}[keyof TColumns & string]
	>
>;

type UnionToIntersection<U> = (U extends any ? (arg: U) => void : never) extends (arg: infer I) => void ? I
	: never;
