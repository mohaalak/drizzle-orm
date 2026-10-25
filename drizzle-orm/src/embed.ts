import type { ColumnBuilderBase } from './column-builder.ts';
import type { Column, Columns, GetColumnData } from './column.ts';
import { entityKind, is } from './entity.ts';
import type { BuildRelationalQueryResult, RelationalRowsMapper } from './relations.ts';
import type { SQL } from './sql/sql.ts';
import { isSQLWrapper } from './sql/sql.ts';
import type { Subquery } from './subquery.ts';
import { type InferModelFromColumns, Table } from './table.ts';
import type { Assume, DrizzleTypeError, IsNever, JoinUnion, Simplify } from './utils.ts';

/**
 * Separates the segments of an embedded column's key in the table's flat column map:
 * `address: embed({ city: text() })` is stored as the column `'address.city'`.
 */
export const EmbeddedKeySeparator = '.';

/**
 * Stands in for {@link EmbeddedKeySeparator} in the keys of columns a dialect selects inside a JSON
 * object, where a `.` in a key would be read as a path (SQL Server's `for json path`). Only a
 * dialect that uses it passes it to {@link nestEmbeddedRelationalRows}.
 */
export const EmbeddedJsonKeySeparator = '→';

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
	static [Symbol.hasInstance](value: unknown): boolean {
		return is(value, this);
	}

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

/** The columns of one `taggedUnion()` variant: column builders, `embed()` groups and nested unions. */
export type UnionVariantColumns = Record<string, ColumnBuilderBase | EmbedBuilder<any>>;

/**
 * The columns of one `taggedUnion()` variant. Its columns are named without the variant's name, and are
 * nullable in the database, since a row of another variant leaves them empty.
 */
export class UnionVariantBuilder<TColumns extends UnionVariantColumns = any> extends EmbedBuilder<TColumns> {
	static override readonly [entityKind]: string = 'UnionVariantBuilder';

	declare readonly _: {
		readonly columns: TColumns;
		readonly unionVariant: true;
	};

	constructor(columns: TColumns) {
		super(columns, { prefix: '' });
	}
}

/**
 * A `taggedUnion()` group. It is an `embed()` group holding the tag column under the union's key and one
 * {@link UnionVariantBuilder} group per variant, so it is stored, named and referenced like one.
 */
export class UnionBuilder<
	TKey extends string = string,
	TColumns extends Record<string, ColumnBuilderBase | EmbedBuilder<any>> = any,
> extends EmbedBuilder<TColumns> {
	static override readonly [entityKind]: string = 'UnionBuilder';

	declare readonly _: {
		readonly columns: TColumns;
		readonly unionKey: TKey;
	};

	constructor(
		/** @internal */
		readonly unionKey: TKey,
		columns: TColumns,
		/** @internal */
		readonly tags: readonly string[],
		/** @internal Each shared column's key, with the variants that declare it. */
		readonly shared: Readonly<Record<string, readonly string[]>>,
		config?: EmbedConfig,
	) {
		super(columns, config);
	}
}

/**
 * The tag column of a `taggedUnion()`: it holds the name of the row's variant and is always written.
 */
export type UnionTagBuilder<TBuilder extends ColumnBuilderBase, TTags extends string, TKey extends string> = {
	_: Simplify<Omit<TBuilder['_'], '$type' | 'notNull'> & { $type: TTags; notNull: true; unionTag: TKey }>;
};

type ColumnKeysOf<TFields> = {
	[K in keyof TFields & string]: TFields[K] extends EmbedBuilder<any> ? never : K;
}[keyof TFields & string];

type OtherVariantColumnKeys<TVariants, TTag extends keyof TVariants> = Exclude<keyof TVariants, TTag> extends
	infer TOther ? TOther extends keyof TVariants ? ColumnKeysOf<TVariants[TOther]> : never
	: never;

/** The keys of the columns two or more variants declare, which they share. */
export type UnionSharedKeys<TVariants> = {
	[T in keyof TVariants]: Extract<ColumnKeysOf<TVariants[T]>, OtherVariantColumnKeys<TVariants, T>>;
}[keyof TVariants];

type VariantsWith<TVariants, TField extends string> = {
	[T in keyof TVariants & string]: TField extends keyof TVariants[T] ? T : never;
}[keyof TVariants & string];

type SharedDeclaration<TVariants, TField extends string> = Assume<
	TVariants[VariantsWith<TVariants, TField>] extends infer TFields
		? TFields extends { [K in TField]: infer TBuilder } ? TBuilder : never
		: never,
	ColumnBuilderBase
>;

type DeclaredNotNull<TBuilder> = TBuilder extends { _: { notNull: true } } ? true : false;

/**
 * A column several variants of a `taggedUnion()` share. It is `NOT NULL` only when every variant
 * declares it `NOT NULL`; `unionShared` says, per variant that has it, whether that variant does.
 */
export type UnionSharedBuilder<TVariants, TField extends string> = {
	_: Simplify<
		& Omit<SharedDeclaration<TVariants, TField>['_'], 'notNull'>
		& {
			notNull: [keyof TVariants] extends [VariantsWith<TVariants, TField>] ? false extends {
					[T in VariantsWith<TVariants, TField>]: DeclaredNotNull<TVariants[T][TField & keyof TVariants[T]]>;
				}[VariantsWith<TVariants, TField>] ? false
				: true
				: false;
			unionShared: {
				[T in VariantsWith<TVariants, TField>]: DeclaredNotNull<TVariants[T][TField & keyof TVariants[T]]>;
			};
		}
	>;
};

/**
 * The columns a `taggedUnion()` group holds: its tag column, the columns variants share, and one
 * group per variant.
 */
export type UnionColumns<
	TKey extends string,
	TTag extends ColumnBuilderBase,
	TVariants extends Record<string, UnionVariantColumns>,
> = Simplify<
	& { [K in TKey]: UnionTagBuilder<TTag, keyof TVariants & string, TKey> }
	& { [F in UnionSharedKeys<TVariants> & string]: UnionSharedBuilder<TVariants, F> }
	& {
		[K in keyof TVariants & string]: UnionVariantBuilder<Omit<TVariants[K], UnionSharedKeys<TVariants>>>;
	}
>;

/**
 * A tagged union of column groups. The tag column under `key` holds which variant a row is, and only
 * that variant's columns are filled. Reading a row gives `{ [key]: variant, ...variantColumns }`.
 *
 * The columns stay flat in the database. The tag column is named like any grouped column
 * (`uploader` + `kind` → `uploader_kind`) and is `NOT NULL`. A variant's columns take the union's
 * prefix without the variant's name (`uploader_staffId`), and are always nullable.
 *
 * Variants that declare a column under the same key share it: it is one column, reached on the
 * union (`files.uploader.campusId`), and `NOT NULL` when every variant declares it `NOT NULL`. Its
 * declarations must be of the same type and name. Two columns of different keys that would get
 * the same name must be given names of their own.
 *
 * Writing a variant fills the tag column and clears the columns of every other variant, keeping
 * the shared columns it declares.
 *
 * @example
 * ```ts
 * const files = pgTable('files', {
 * 	id: serial().primaryKey(),
 * 	uploader: taggedUnion('kind', text(), {
 * 		staff: { staffId: integer().notNull() },
 * 		parent: { parentId: integer().notNull() },
 * 		system: {},
 * 	}),
 * });
 * // columns: "id", "uploader_kind", "uploader_staffId", "uploader_parentId"
 *
 * await db.insert(files).values({ uploader: { kind: 'staff', staffId: 1 } });
 * const rows = await db.select().from(files).where(eq(files.uploader.kind, 'staff'));
 * if (rows[0].uploader.kind === 'staff') rows[0].uploader.staffId; // number
 * ```
 */
export function taggedUnion<
	TKey extends string,
	TTag extends ColumnBuilderBase,
	TVariants extends Record<string, UnionVariantColumns>,
>(
	key: TKey,
	tag: TTag,
	variants: TVariants & { [K in TKey]?: never },
	config?: EmbedConfig,
): UnionBuilder<TKey, UnionColumns<TKey, TTag, TVariants>> {
	if (Object.prototype.hasOwnProperty.call(variants, key)) {
		throw new Error(`A union variant cannot be named "${key}", the key of its tag column`);
	}
	const entries = Object.entries(variants as Record<string, UnionVariantColumns>);
	const tags = entries.map(([name]) => name);

	// A column key two or more variants declare is one shared column.
	const declaredBy: Record<string, string[]> = {};
	for (const [name, fields] of entries) {
		for (const [field, value] of Object.entries(fields)) {
			if (field === key) {
				throw new Error(`Variant "${name}" cannot have a column "${key}", the key of its union's tag column`);
			}
			if (!is(value, EmbedBuilder)) (declaredBy[field] ??= []).push(name);
		}
	}
	const shared: Record<string, string[]> = {};
	for (const [field, names] of Object.entries(declaredBy)) {
		if (names.length > 1) shared[field] = names;
	}

	const columns: Record<string, ColumnBuilderBase | EmbedBuilder> = { [key]: tag };
	for (const [field, names] of Object.entries(shared)) {
		if (tags.includes(field)) {
			throw new Error(`Column "${field}" shared by variants ${names.join(', ')} cannot be named like a variant`);
		}
		columns[field] = sharedColumn(
			field,
			names.map((name) => [name, variants[name]![field] as ColumnBuilderBase]),
			tags,
		);
	}
	for (const [name, fields] of entries) {
		const own: UnionVariantColumns = {};
		for (const [field, value] of Object.entries(fields)) {
			if (!shared[field]) own[field] = value;
		}
		columns[name] = new UnionVariantBuilder(own);
	}
	return new UnionBuilder(key, columns as UnionColumns<TKey, TTag, TVariants>, tags, shared, config);
}

/** The one builder a shared column is built from: the first variant's, `NOT NULL` only if every variant's is. */
function sharedColumn(
	field: string,
	declarations: (readonly [variant: string, builder: ColumnBuilderBase])[],
	tags: readonly string[],
): ColumnBuilderBase {
	const configOf = (builder: ColumnBuilderBase) =>
		(builder as unknown as {
			config: {
				name: string;
				notNull: boolean;
				columnType: string;
				dataType: string;
				unionShared?: Record<string, boolean>;
			};
		}).config;
	const [[firstVariant, first]] = declarations as [readonly [string, ColumnBuilderBase]];
	const firstConfig = configOf(first);
	for (const [variant, builder] of declarations.slice(1)) {
		const config = configOf(builder);
		if (config.columnType !== firstConfig.columnType || config.dataType !== firstConfig.dataType) {
			throw new Error(
				`Column "${field}" is shared by variants "${firstVariant}" and "${variant}", so it must be of the same type in both`,
			);
		}
		if (config.name !== firstConfig.name) {
			throw new Error(
				`Column "${field}" is shared by variants "${firstVariant}" and "${variant}", so it must have the same name in both`,
			);
		}
	}

	// Each variant's rows keep the nullability that variant declares it with.
	firstConfig.unionShared = Object.fromEntries(
		declarations.map(([variant, builder]) => [variant, configOf(builder).notNull === true]),
	);
	firstConfig.notNull = declarations.length === tags.length
		&& declarations.every(([, builder]) => configOf(builder).notNull);
	return first;
}

/**
 * Marks the group holding a `taggedUnion()`'s columns with the key of its tag column.
 *
 * @internal
 */
export const EmbeddedUnionKey = Symbol.for('drizzle:EmbeddedUnionKey');

/** @internal */
export interface EmbeddedUnionInfo {
	/** The key of the tag column within the union's group. */
	readonly key: string;
	readonly tags: readonly string[];
	/** Each shared column's key, with the variants that declare it. */
	readonly shared: Readonly<Record<string, readonly string[]>>;
}

/**
 * A column's place in a `taggedUnion()`: its path from the union's group, `['kind']` for the tag column
 * and `['staff', 'staffId']` for a variant's column.
 *
 * @internal
 */
export interface EmbeddedUnionMembership {
	readonly union: EmbeddedUnionInfo;
	readonly path: readonly string[];
	/**
	 * Whether the column was declared `NOT NULL`. At runtime a variant's columns are all nullable, since other
	 * variants' rows leave them empty, so this is what says the column must be filled in a row of its own variant.
	 */
	readonly notNull: boolean;
}

/**
 * The unions a column belongs to, outermost first. A column of a union nested in another union's
 * variant belongs to both.
 *
 * @internal
 */
export function embeddedUnionsOf(column: unknown): readonly EmbeddedUnionMembership[] | undefined {
	return (column as { config?: { embeddedUnions?: EmbeddedUnionMembership[] } } | undefined)?.config?.embeddedUnions;
}

interface ActiveUnion {
	readonly info: EmbeddedUnionInfo;
	/** The union's dotted path, followed by the separator. */
	readonly root: string;
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
	unions: readonly ActiveUnion[] = [],
	inVariant = false,
): Record<string, TBuilder> {
	for (const [key, value] of Object.entries(columns)) {
		const path = keyPrefix + key;
		if (is(value, UnionBuilder)) {
			const info: EmbeddedUnionInfo = { key: value.unionKey, tags: value.tags, shared: value.shared };
			flattenEmbedBuilders(
				value.columns,
				casingFn,
				path + EmbeddedKeySeparator,
				namePrefix + (value.config.prefix ?? `${key}_`),
				result,
				[...unions, { info, root: path + EmbeddedKeySeparator }],
				inVariant,
			);
			continue;
		}
		if (is(value, EmbedBuilder)) {
			flattenEmbedBuilders(
				value.columns,
				casingFn,
				path + EmbeddedKeySeparator,
				namePrefix + (value.config.prefix ?? `${key}_`),
				result,
				unions,
				inVariant || is(value, UnionVariantBuilder),
			);
			continue;
		}

		// A group's columns take their name from the group's prefix, unless they set their own.
		if (keyPrefix) {
			(value as any).setName(namePrefix + key, casingFn);
		}
		if (unions.length) markUnionMember(value as ColumnBuilderBase, path, unions, inVariant);
		result[path] = value as TBuilder;
	}

	if (!keyPrefix) assertUniqueUnionColumnNames(result);
	return result;
}

function markUnionMember(builder: ColumnBuilderBase, path: string, unions: readonly ActiveUnion[], inVariant: boolean) {
	const config = (builder as unknown as { config: Record<string, any> }).config;
	// read before it is forced to false below, and kept if the builder has been flattened before
	const declaredNotNull: boolean = (config['embeddedUnions'] as EmbeddedUnionMembership[] | undefined)?.[0]?.notNull
		?? config['notNull'] === true;
	config['embeddedUnions'] = unions.map((union): EmbeddedUnionMembership => ({
		union: union.info,
		path: path.slice(union.root.length).split(EmbeddedKeySeparator),
		notNull: declaredNotNull,
	}));

	const innermost = unions.at(-1)!;
	const isTag = path === innermost.root + innermost.info.key;
	if (inVariant) {
		// Another variant's rows leave this column empty.
		if (config['primaryKey']) {
			throw new Error(`Column "${path}" is in a union variant, so it cannot be a primary key`);
		}
		// Its own variant's rows keep the nullability it was declared with.
		config['unionMember'] = { notNull: isTag || config['notNull'] === true };
		config['notNull'] = false;
		return;
	}

	if (isTag) config['notNull'] = true;
}

/**
 * Whether a `taggedUnion()` column is `NOT NULL` in the rows of its own variant: a variant's column as
 * declared, and a column variants share as variant `tag` declares it. Other columns are as stored.
 *
 * @internal
 */
export function unionColumnNotNull(column: Column, tag?: string): boolean {
	const config = (column as unknown as {
		config: { unionMember?: { notNull: boolean }; unionShared?: Record<string, boolean> };
	}).config;
	if (tag !== undefined && config.unionShared) return config.unionShared[tag] === true;
	return config.unionMember?.notNull ?? column.notNull;
}

function assertUniqueUnionColumnNames(builders: Record<string, ColumnBuilderBase>) {
	const pathByName = new Map<string, string>();
	for (const [path, builder] of Object.entries(builders)) {
		const config = (builder as unknown as { config: { name?: string; embeddedUnions?: unknown } }).config;
		if (!config.embeddedUnions || !config.name) continue;

		const other = pathByName.get(config.name);
		if (other !== undefined) {
			throw new Error(
				`Columns "${other}" and "${path}" of a union are both named "${config.name}". Give one of them its own name`,
			);
		}
		pathByName.set(config.name, path);
	}
}

/**
 * The columns of one `embed()` group, as they appear on the built table: `users.address.city`.
 */
export class EmbeddedColumns {
	static readonly [entityKind]: string = 'EmbeddedColumns';
	static [Symbol.hasInstance](value: unknown): boolean {
		return is(value, this);
	}

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
		const column = columns[key]!;
		target[segments.at(-1)!] = column;

		// The tag column marks the group it sits in as a union.
		const own = embeddedUnionsOf(column)?.at(-1);
		if (own && own.path.length === 1 && own.path[0] === own.union.key) {
			(target as Record<symbol, unknown>)[EmbeddedUnionKey] = own.union.key;
		}
	}

	return result;
}

/** @internal */
export function embeddedUnionKeyOf(group: unknown): string | undefined {
	return (group as Record<symbol, string | undefined>)[EmbeddedUnionKey];
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

/**
 * The one-row object `$returningId()` builds for a column-map key.
 *
 * A table without groups uses a plain key, and this returns `{ [key]: value }` — the same object
 * it has always returned, including when a composite primary key is reported under its first column.
 * An `embed()` group stores the column under a dotted key (`'id.value'`), which comes back nested
 * (`{ id: { value } }`).
 *
 * @internal
 */
export function nestReturningIdValue(key: string, value: unknown): Record<string, unknown> {
	if (!key.includes(EmbeddedKeySeparator)) return { [key]: value };

	const segments = key.split(EmbeddedKeySeparator);
	const root: Record<string, unknown> = {};
	let node = root;
	for (let i = 0; i < segments.length - 1; i++) {
		const next: Record<string, unknown> = {};
		node[segments[i]!] = next;
		node = next;
	}
	node[segments[segments.length - 1]!] = value;
	return root;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/**
 * A nested plain object or an {@link EmbeddedColumns} group is walked. A column, SQL value,
 * subquery, view, or any other SQL wrapper is a leaf. A table is not a leaf: its shape is.
 */
function isSelectedFieldGroup(field: unknown): boolean {
	if (is(field, EmbeddedColumns)) return true;
	if (!isPlainObject(field) || isSQLWrapper(field)) return false;
	return true;
}

/**
 * Flattens a selection's fields to dotted keys, depth-first in key order — the order
 * {@link orderSelectedFields} emits columns in the SELECT — so an `insert().select()` lines its
 * columns up with the selected values.
 *
 * `{ address: { city, geo: { lat } } }` becomes `'address.city'`, then `'address.geo.lat'`.
 *
 * @internal
 */
export function flattenSelectedFields(
	fields: Record<string, unknown>,
	prefix = '',
	result: Record<string, unknown> = {},
): Record<string, unknown> {
	for (const key of Object.keys(fields)) {
		const path = prefix === '' ? key : prefix + EmbeddedKeySeparator + key;
		const field = fields[key];
		if (is(field, Table)) {
			flattenSelectedFields(getTableShape(field), path, result);
			continue;
		}
		if (isSelectedFieldGroup(field)) {
			flattenSelectedFields(field as Record<string, unknown>, path, result);
			continue;
		}
		result[path] = field;
	}
	return result;
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
	const clear = (groupPath: string) => {
		for (const leaf of Object.keys(table[Table.Symbol.Columns])) {
			if (leaf.startsWith(groupPath)) result[leaf] = null;
		}
	};
	const visit = (shape: Record<string, Column | EmbeddedColumns>, source: Record<string, unknown>, path: string) => {
		for (const [key, entry] of Object.entries(source)) {
			const node = shape[key];
			if (!is(node, EmbeddedColumns)) {
				result[path + key] = entry;
				continue;
			}
			if (entry === undefined) continue;
			const groupPath = path + key + EmbeddedKeySeparator;
			if (entry === null) {
				// Writing `null` to a group clears every column in it.
				clear(groupPath);
				continue;
			}
			if (!isPlainObject(entry)) {
				throw new Error(
					`Embedded group "${path}${key}" in table "${
						table[Table.Symbol.Name]
					}" must be written as an object of its columns`,
				);
			}

			const unionKey = embeddedUnionKeyOf(node);
			if (unionKey === undefined) {
				visit(node, entry, groupPath);
				continue;
			}

			// A union is written as one variant: its tag, its columns, and every other variant cleared.
			const { tags, shared } = embeddedUnionsOf(node[unionKey])!.at(-1)!.union;
			const { [unionKey]: tag, ...fields } = entry;
			if (typeof tag !== 'string' || !tags.includes(tag)) {
				throw new Error(
					`Union "${path}${key}" in table "${
						table[Table.Symbol.Name]
					}" must be written with "${unionKey}" set to one of ${tags.map((name) => `"${name}"`).join(', ')}`,
				);
			}
			result[groupPath + unionKey] = tag;
			for (const other of tags) {
				if (other !== tag) clear(groupPath + other + EmbeddedKeySeparator);
			}
			const own: Record<string, unknown> = {};
			for (const [field, value] of Object.entries(fields)) {
				if (!shared[field]) own[field] = value;
				else if (shared[field]!.includes(tag)) result[groupPath + field] = value;
			}
			// A shared column the variant does not declare is cleared like the other variants' columns.
			for (const [field, declaredBy] of Object.entries(shared)) {
				if (!declaredBy.includes(tag)) result[groupPath + field] = null;
			}
			visit((node[tag] ?? new EmbeddedColumns()) as EmbeddedColumns, own, groupPath + tag + EmbeddedKeySeparator);
		}
	};
	visit(getTableShape(table), value, '');

	return result;
}

/**
 * Where a `taggedUnion()` group sits in a result row, found from where its tag column was selected.
 *
 * @internal
 */
export interface EmbeddedUnionSite {
	readonly path: readonly string[];
	readonly union: EmbeddedUnionInfo;
}

/**
 * Finds the `taggedUnion()` groups a selection reads whole enough to fold: every place a union's tag column
 * is selected under its own key, inside the group it was selected with. Deepest first, so a union
 * in another union's variant is folded before the variant is lifted out. `undefined` when there
 * are none.
 *
 * @internal
 */
export function embeddedUnionSites(
	fields: readonly { readonly path: readonly string[]; readonly column: unknown }[],
): EmbeddedUnionSite[] | undefined {
	let sites: EmbeddedUnionSite[] | undefined;
	for (const { path, column } of fields) {
		const own = embeddedUnionsOf(column)?.at(-1);
		if (!own || own.path.length !== 1 || own.path[0] !== own.union.key || path.at(-1) !== own.union.key) continue;
		(sites ??= []).push({ path: path.slice(0, -1), union: own.union });
	}

	return sites?.sort((a, b) => b.path.length - a.path.length);
}

/** @internal */
export function selectedFieldsUnionSites(
	fields: readonly { readonly path: string[]; readonly fieldType: string; readonly field: unknown }[],
): EmbeddedUnionSite[] | undefined {
	return embeddedUnionSites(
		fields.map(({ path, fieldType, field }) => ({ path, column: fieldType === 'Column' ? field : undefined })),
	);
}

/**
 * `{ kind: 'staff', staff: { staffId: 1 }, parent: { parentId: null } }` →
 * `{ kind: 'staff', staffId: 1 }`. Keys that are not a variant's group are kept.
 */
function foldUnion(value: Record<string, unknown>, { key, tags, shared }: EmbeddedUnionInfo): Record<string, unknown> {
	const tag = value[key];
	const result: Record<string, unknown> = {};
	for (const [name, entry] of Object.entries(value)) {
		if (tags.includes(name) && isPlainObject(entry)) continue;
		// A shared column belongs to the row only when its variant declares it.
		if (shared[name] && !shared[name]!.includes(tag as string)) continue;
		result[name] = entry;
	}

	const variant = typeof tag === 'string' && tags.includes(tag) ? value[tag] : undefined;
	if (isPlainObject(variant)) Object.assign(result, variant);
	return result;
}

/**
 * Folds every `taggedUnion()` group of a nested result row into the variant it holds. Returns the row,
 * or a new one when the union sits at the row's root.
 *
 * @internal
 */
export function foldEmbeddedUnions(
	row: Record<string, unknown>,
	sites: readonly EmbeddedUnionSite[],
): Record<string, unknown> {
	for (const { path, union } of sites) {
		if (path.length === 0) {
			row = foldUnion(row, union);
			continue;
		}

		let parent: unknown = row;
		for (let i = 0; i < path.length - 1 && isPlainObject(parent); i++) parent = parent[path[i]!];
		if (!isPlainObject(parent)) continue;

		const value = parent[path.at(-1)!];
		if (isPlainObject(value)) parent[path.at(-1)!] = foldUnion(value, union);
	}
	return row;
}

/**
 * Wraps a rows mapper so the `taggedUnion()` groups it nests come back folded into the variant they
 * hold. Returns the mapper untouched for selections that read no union.
 *
 * @internal
 */
export function foldEmbeddedUnionRows<TMapper extends (rows: any) => any>(
	mapper: TMapper,
	sites: readonly EmbeddedUnionSite[] | undefined,
): TMapper {
	if (!sites) return mapper;

	return Object.assign((rows: unknown) => {
		const result = mapper(rows) as Record<string, unknown>[];
		for (let i = 0; i < result.length; i++) result[i] = foldEmbeddedUnions(result[i]!, sites);
		return result;
	}, mapper);
}

interface EmbeddedRowsPlan {
	/** Columns selected under a dotted key, as the path to nest each one at. */
	readonly columns: readonly (readonly [key: string, path: readonly string[]])[];
	/** `taggedUnion()` groups to fold once the columns are nested. */
	readonly unions: readonly EmbeddedUnionSite[] | undefined;
	/** Loaded relations whose rows carry embedded columns of their own. */
	readonly relations: readonly (readonly [key: string, plan: EmbeddedRowsPlan])[];
}

/** Finds the embedded columns a relational selection reads, or `undefined` when it reads none. */
function embeddedRowsPlan(
	selection: BuildRelationalQueryResult['selection'],
	separators: readonly string[],
): EmbeddedRowsPlan | undefined {
	const columns: [string, string[]][] = [];
	const unionFields: { path: string[]; column: unknown }[] = [];
	const relations: [string, EmbeddedRowsPlan][] = [];
	for (const item of selection) {
		if (item.selection) {
			const plan = embeddedRowsPlan(item.selection, separators);
			if (plan) relations.push([item.key, plan]);
		} else if (item.fieldType === 'Column' && separators.some((separator) => item.key.includes(separator))) {
			let path = [item.key];
			for (const separator of separators) path = path.flatMap((segment) => segment.split(separator));
			columns.push([item.key, path]);
			unionFields.push({ path, column: item.field });
		}
	}

	return columns.length || relations.length
		? { columns, unions: embeddedUnionSites(unionFields), relations }
		: undefined;
}

function nestEmbeddedRows(value: unknown, plan: EmbeddedRowsPlan): unknown {
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) value[i] = nestEmbeddedRows(value[i], plan);
		return value;
	}
	if (typeof value !== 'object' || value === null) return value;

	let row = value as Record<string, unknown>;
	for (const [key, path] of plan.columns) {
		let target = row;
		for (const segment of path.slice(0, -1)) {
			target = (target[segment] ??= {}) as Record<string, unknown>;
		}
		target[path.at(-1)!] = row[key];
		delete row[key];
	}
	if (plan.unions) row = foldEmbeddedUnions(row, plan.unions);
	for (const [key, relationPlan] of plan.relations) {
		if (key in row) row[key] = nestEmbeddedRows(row[key], relationPlan);
	}
	return row;
}

/**
 * Wraps a relational rows mapper so the columns of `embed()` groups, which a relational query
 * selects under their dotted keys, come back nested: `'address.city'` → `address.city`. Returns
 * the mapper untouched for selections that read no embedded columns.
 *
 * @param separators what splits an embedded column's key into its path; a dialect that renames
 * keys inside JSON objects adds {@link EmbeddedJsonKeySeparator}
 * @internal
 */
export function nestEmbeddedRelationalRows<TMapper extends RelationalRowsMapper | undefined>(
	mapper: TMapper,
	selection: BuildRelationalQueryResult['selection'],
	separators: readonly string[] = [EmbeddedKeySeparator],
): TMapper {
	const plan = embeddedRowsPlan(selection, separators);
	if (!plan) return mapper;

	return ((rows: Parameters<RelationalRowsMapper>[0]) => {
		const result = mapper ? mapper(rows) : rows;
		return nestEmbeddedRows(result, plan);
	}) as TMapper;
}

/** @internal */
export function hasEmbeddedRows(selection: BuildRelationalQueryResult['selection']): boolean {
	return embeddedRowsPlan(selection, [EmbeddedKeySeparator]) !== undefined;
}

/**
 * Whether `key` names an `embed()` group in a flat, dotted column map: `'address'` for
 * `'address.city'`.
 *
 * @internal
 */
export function isEmbeddedGroupKey(columns: Record<string, unknown>, key: string): boolean {
	const prefix = key + EmbeddedKeySeparator;
	for (const column of Object.keys(columns)) {
		if (column.startsWith(prefix)) return true;
	}
	return false;
}

/**
 * Expands `embed()` group names in an insert column list into the dotted columns they cover.
 * `'address'` becomes every `'address.*'` column, nested groups included, in column-map order.
 * A name that is itself a column is kept, so a list of dotted columns comes back unchanged.
 * Listing a group and a column it covers throws. An unknown name throws.
 *
 * @internal
 */
export function expandInsertColumnList(table: Table, columnList: readonly string[]): string[] {
	const columns = table[Table.Symbol.Columns] as Record<string, unknown>;
	const expanded: string[] = [];
	const seenDirect = new Set<string>();
	const coveredByGroup = new Set<string>();

	for (const name of columnList) {
		if (Object.prototype.hasOwnProperty.call(columns, name)) {
			if (coveredByGroup.has(name)) {
				throw new Error(`Duplicate columns are not allowed in insert selection: "${name}"`);
			}
			seenDirect.add(name);
			expanded.push(name);
			continue;
		}

		if (!isEmbeddedGroupKey(columns, name)) {
			throw new Error(`Column "${name}" does not exist in table "${table[Table.Symbol.Name]}"`);
		}

		const prefix = name + EmbeddedKeySeparator;
		const groupColumns: string[] = [];
		for (const column of Object.keys(columns)) {
			if (column.startsWith(prefix)) groupColumns.push(column);
		}
		if (groupColumns.some((column) => seenDirect.has(column) || coveredByGroup.has(column))) {
			throw new Error(`Duplicate columns are not allowed in insert selection: "${name}"`);
		}
		for (const column of groupColumns) {
			coveredByGroup.add(column);
			expanded.push(column);
		}
	}

	return expanded;
}

/**
 * Turns a relational query's `columns` config, which may name `embed()` groups, into one keyed by
 * column: `{ address: true }` selects every column in the group, and `{ address: { city: true } }`
 * becomes `{ 'address.city': true }`. Dotted keys are kept as they are.
 *
 * @internal
 */
export function flattenEmbeddedColumnsConfig(
	columns: Record<string, unknown>,
	config: Record<string, unknown>,
	prefix = '',
	result: Record<string, boolean | undefined> = {},
): Record<string, boolean | undefined> {
	for (const [key, value] of Object.entries(config)) {
		const path = prefix + key;
		if (Object.prototype.hasOwnProperty.call(columns, path) || !isEmbeddedGroupKey(columns, path)) {
			result[path] = value as boolean | undefined;
		} else if (isPlainObject(value)) {
			flattenEmbeddedColumnsConfig(columns, value, path + EmbeddedKeySeparator, result);
		} else {
			const groupPrefix = path + EmbeddedKeySeparator;
			for (const column of Object.keys(columns)) {
				if (column.startsWith(groupPrefix)) result[column] = value as boolean | undefined;
			}
		}
	}
	return result;
}

/**
 * Turns the filter a relational query's `where` gives an `embed()` group into one on the table's
 * dotted keys: `{ city: 'Berlin', OR: [{ zip: '1' }] }` under `address` becomes
 * `{ AND: [{ 'address.city': 'Berlin' }, { OR: [{ 'address.zip': '1' }] }] }`. `RAW` is passed the
 * table, as at the top level.
 *
 * @internal
 */
export function prefixEmbeddedGroupFilter(filter: Record<string, unknown>, prefix: string): Record<string, unknown> {
	const parts: Record<string, unknown>[] = [];
	for (const [key, value] of Object.entries(filter)) {
		switch (key) {
			case 'RAW': {
				parts.push({ RAW: value });
				break;
			}
			case 'AND':
			case 'OR': {
				parts.push({
					[key]: (value as Record<string, unknown>[]).map((sub) => prefixEmbeddedGroupFilter(sub, prefix)),
				});
				break;
			}
			case 'NOT': {
				parts.push({ NOT: prefixEmbeddedGroupFilter(value as Record<string, unknown>, prefix) });
				break;
			}
			default: {
				parts.push({ [prefix + key]: value });
			}
		}
	}
	return parts.length ? { AND: parts } : {};
}

// ----------------------------------------------------------------------------- types

type DottedKey = `${string}${typeof EmbeddedKeySeparator}${string}`;

type HeadOf<TKey> = TKey extends `${infer Head}.${string}` ? Head : never;

type GroupKeys<T> = HeadOf<Extract<keyof T, DottedKey>>;

type GroupOf<T, Head extends string> = {
	[K in keyof T as K extends `${Head}.${infer Rest}` ? Rest : never]: T[K];
};

/** The names of the `embed()` groups in a flat, dotted map: `'address'` for `'address.city'`. */
export type EmbeddedGroupKeys<T> = GroupKeys<T>;

/** One `embed()` group of a flat, dotted map, keyed relative to it: `'address.geo.lat'` → `'geo.lat'`. */
export type EmbeddedGroupOf<T, Head extends string> = GroupOf<T, Head>;

type GroupPath<TKey extends string> = TKey extends `${infer Head}.${infer Rest}`
	? Rest extends DottedKey ? Head | `${Head}.${GroupPath<Rest>}`
	: Head
	: never;

/** Every `embed()` group path in a flat map: `'address'` and `'address.geo'` for `'address.geo.lat'`. */
type EmbeddedGroupPath<T> = GroupPath<Extract<keyof T, DottedKey>>;

/** A column key or an `embed()` group path an insert column list may name. */
export type InsertColumnListKey<TColumns> = (keyof TColumns & string) | EmbeddedGroupPath<TColumns>;

type ColumnsNamedBy<TColumns, TName> = TName extends string ? TName extends keyof TColumns ? TName
	: Extract<keyof TColumns & string, `${TName}.${string}`>
	: never;

/**
 * The dotted columns an insert column list names. A group path expands to every column under it.
 * Each name is expanded on its own, so a mix of columns and groups keeps every column.
 */
export type ExpandInsertColumnList<TColumns, TList extends readonly string[]> = ColumnsNamedBy<
	TColumns,
	TList[number]
>;

type NoDuplicateExpandedColumns<
	TColumns,
	TList extends readonly unknown[],
	TSeen = never,
> = TList extends readonly [infer Head, ...infer Tail] ? [
		Head extends string ? [Extract<ColumnsNamedBy<TColumns, Head>, TSeen>] extends [never] ? Head
			: DrizzleTypeError<`Duplicate columns are not allowed in insert selection: "${Head}"`>
			: Head,
		...NoDuplicateExpandedColumns<
			TColumns,
			Tail,
			TSeen | (Head extends string ? ColumnsNamedBy<TColumns, Head> : never)
		>,
	]
	: TList;

/**
 * The `...columns` argument of `db.insert(table, ...columns)`. Group names count toward the
 * required-column check, and a group that overlaps a column already named is a duplicate.
 */
export type InsertColumnListArg<
	TColumns,
	TColumnList extends readonly string[],
	TRequiredKeys extends string,
> = TColumnList extends readonly [] ? []
	: IsNever<TRequiredKeys> extends true ? TColumnList & NoDuplicateExpandedColumns<TColumns, TColumnList>
	: [TRequiredKeys] extends [ExpandInsertColumnList<TColumns, TColumnList>]
		? TColumnList & NoDuplicateExpandedColumns<TColumns, TColumnList>
	: DrizzleTypeError<
		`Column selection is missing following required columns: ${JoinUnion<
			`"${Exclude<TRequiredKeys, ExpandInsertColumnList<TColumns, TColumnList> & string>}"`,
			', '
		>}`
	>[];

/** `'all'` when the caller passed no column list; otherwise the dotted columns that list names. */
export type ResolvedInsertColumnList<
	TColumns,
	TColumnList extends readonly string[],
> = TColumnList extends readonly [] ? 'all' : ExpandInsertColumnList<TColumns, TColumnList>[];

/**
 * Flattens a relational query's `columns` config into the dotted keys of the table's column map
 * `TColumns`, mirroring {@link flattenEmbeddedColumnsConfig}: `{ address: { city: true } }` →
 * `{ 'address.city': true }`, and `{ address: false }` → every column of the group set to `false`.
 */
export type FlattenEmbeddedColumnsConfig<TColumns, TConfig, TPrefix extends string = ''> = [keyof TConfig] extends
	[never] ? {}
	: Simplify<
		UnionToIntersection<
			{
				[K in keyof TConfig & string]: `${TPrefix}${K}` extends keyof TColumns ? { [P in `${TPrefix}${K}`]: TConfig[K] }
					: TConfig[K] extends Record<string, unknown>
						? FlattenEmbeddedColumnsConfig<TColumns, TConfig[K], `${TPrefix}${K}.`>
					: { [P in keyof TColumns & `${TPrefix}${K}.${string}`]: TConfig[K] };
			}[keyof TConfig & string]
		>
	>;

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
	// Writing `null` to a group clears every column in it.
	& { [Head in GroupKeys<T>]?: NestEmbeddedPartial<GroupOf<T, Head>> | null };

/**
 * The columns of `TModel` an insert column list keeps. `'all'` keeps every key. Optionality is preserved,
 * so a required column stays required in an `insert().select()` selection.
 */
export type ListedInsertColumns<TModel, TColumnList extends string[] | 'all'> = {
	[K in keyof TModel as TColumnList extends string[] ? Extract<K, TColumnList[number]> : K]: TModel[K];
};

type InsertSelectionLeaf<TColumn, TData> = TColumn | SQL | SQL.Aliased | TData;

type InsertSelectionLeaves<TModel, TColumn> = {
	[K in keyof TModel]: InsertSelectionLeaf<TColumn, TModel[K]>;
};

/**
 * What `insert().select()` accepts for one table: the insert columns, either under their dotted keys
 * (`'address.city'`) or nested the way `embed()` groups are (`address: { city }`). A required column
 * has to appear in one of those two shapes.
 */
export type InsertSelectionShape<TModel, TColumn> =
	| (InsertSelectionLeaves<TModel, TColumn> & {})
	| NestEmbedded<InsertSelectionLeaves<TModel, TColumn>>;

/** How a dialect reports a generated or identity column an insert may not write. */
export type InsertSelectionGeneratedKind = 'override' | 'restricted' | 'none';

type HasEmbeddedGroup<T, THead extends string> = [Extract<keyof T, `${THead}.${string}`>] extends [never] ? false
	: true;

type InsertSelectionGeneratedError<
	TPath extends string,
	TTableName extends string,
	TKind extends InsertSelectionGeneratedKind,
> = TKind extends 'override' ? DrizzleTypeError<
		`Column "${TPath}" in table "${TTableName}" is a generated column. Use \`.overridingSystemValue()\` to manually insert into this column`
	>
	: TKind extends 'restricted' ? DrizzleTypeError<
			`Column "${TPath}" in table "${TTableName}" is a generated column - manual value insertion restricted`
		>
	: DrizzleTypeError<`Column "${TPath}" does not exist in table "${TTableName}"`>;

type IsInsertSelectionGroup<TValue> = [TValue] extends [Column | SQL | SQL.Aliased | Subquery] ? false
	: [TValue] extends [Record<string, any>] ? true
	: false;

type ValidateInsertSelectionEntry<
	TValue,
	TPath extends string,
	TAllowed extends Record<string, unknown>,
	TGenerated extends Record<string, unknown>,
	TColumnList extends string[] | 'all',
	TTableName extends string,
	TKind extends InsertSelectionGeneratedKind,
> = TPath extends keyof TAllowed ? TColumnList extends string[] ? TPath extends TColumnList[number] ? TValue
		: DrizzleTypeError<`Column "${TPath}" is not included in the insert column selection`>
	: TValue
	: TPath extends keyof TGenerated ? InsertSelectionGeneratedError<TPath, TTableName, TKind>
	: HasEmbeddedGroup<TAllowed, TPath> extends true ? ValidateInsertSelectionGroup<
			TValue,
			TPath,
			TAllowed,
			TGenerated,
			TColumnList,
			TTableName,
			TKind
		>
	: HasEmbeddedGroup<TGenerated, TPath> extends true ? ValidateInsertSelectionGroup<
			TValue,
			TPath,
			TAllowed,
			TGenerated,
			TColumnList,
			TTableName,
			TKind
		>
	: DrizzleTypeError<`Column "${TPath}" does not exist in table "${TTableName}"`>;

type ValidateInsertSelectionGroup<
	TValue,
	TPath extends string,
	TAllowed extends Record<string, unknown>,
	TGenerated extends Record<string, unknown>,
	TColumnList extends string[] | 'all',
	TTableName extends string,
	TKind extends InsertSelectionGeneratedKind,
> = IsInsertSelectionGroup<TValue> extends true ? ValidateNestedInsertSelection<
		TValue,
		TAllowed,
		TGenerated,
		TColumnList,
		TTableName,
		TKind,
		`${TPath}.`
	>
	: DrizzleTypeError<`Column "${TPath}" does not exist in table "${TTableName}"`>;

/**
 * Checks an `insert().select()` selection against the table's insert columns. Dotted keys and nested
 * `embed()` groups are both checked per column: an unknown key, a generated column, or a key outside
 * the insert column list becomes a {@link DrizzleTypeError} in place, named by its dotted path.
 */
export type ValidateNestedInsertSelection<
	TSelection,
	TAllowed extends Record<string, unknown>,
	TGenerated extends Record<string, unknown>,
	TColumnList extends string[] | 'all',
	TTableName extends string,
	TKind extends InsertSelectionGeneratedKind,
	TPrefix extends string = '',
> = {
	[K in keyof TSelection]: ValidateInsertSelectionEntry<
		TSelection[K],
		`${TPrefix}${K & string}`,
		TAllowed,
		TGenerated,
		TColumnList,
		TTableName,
		TKind
	>;
};

/**
 * Flattens a table definition's `embed()` groups into dotted keys, mirroring
 * {@link flattenEmbedBuilders}.
 */
export type FlattenEmbedBuilders<TColumns, TPrefix extends string = '', TInVariant extends boolean = false> = Simplify<
	UnionToIntersection<
		{
			[K in keyof TColumns & string]: TColumns[K] extends EmbedBuilder<infer TInner>
				// A group without columns, such as a union variant that carries nothing, adds no keys.
				? [keyof TInner] extends [never] ? {}
				: FlattenEmbedBuilders<
					TInner,
					`${TPrefix}${K}.`,
					TInVariant extends true ? true : TColumns[K] extends { _: { unionVariant: true } } ? true : false
				>
				: { [P in `${TPrefix}${K}`]: TInVariant extends true ? MarkUnionMember<TColumns[K]> : TColumns[K] };
		}[keyof TColumns & string]
	>
>;

type ParentPath<TKey extends string, TAcc extends string = ''> = TKey extends `${infer Head}.${infer Rest}`
	? ParentPath<Rest, TAcc extends '' ? Head : `${TAcc}.${Head}`>
	: TAcc;

type LastSegment<TKey extends string> = TKey extends `${string}.${infer Rest}` ? LastSegment<Rest> : TKey;

/** The dotted keys of the `taggedUnion()` tag columns in a flat map: `'uploader.kind'`. */
type UnionTagKeys<TColumns> = {
	[K in keyof TColumns & string]: TColumns[K] extends { _: { unionTag: LastSegment<K> } } ? K : never;
}[keyof TColumns & string];

/** The tag columns of the unions that are not inside another union's variant. */
type OuterUnionTagKeys<TColumns, TTag extends string = UnionTagKeys<TColumns>> = TTag extends string
	? ParentPath<TTag> extends `${ParentPath<Exclude<UnionTagKeys<TColumns>, TTag>>}.${string}` ? never
	: TTag
	: never;

/** One variant's columns of the union at `TPath`, keyed relative to the variant. */
type UnionVariantColumnsOf<TColumns, TPrefix extends string> = {
	[K in keyof TColumns as K extends `${TPrefix}${infer Rest}` ? Rest : never]: TColumns[K];
};

type ModelOf<
	TColumns extends Columns,
	TInferMode extends 'select' | 'insert',
	TConfig extends { override?: boolean },
	TExtra,
> = [TExtra] extends [never] ? InferModelFromColumns<TColumns, TInferMode, TConfig>
	: {
		[K in keyof InferModelFromColumns<TColumns, TInferMode, TConfig>]:
			| InferModelFromColumns<TColumns, TInferMode, TConfig>[K]
			| TExtra;
	};

/**
 * Whether a column is `NOT NULL` in the rows of its own variant: a variant's column is nullable in
 * the database, but as declared within the variant it belongs to.
 */
export type DeclaredColumnNotNull<TColumn> = TColumn extends { _: { unionMember: { notNull: infer TNotNull } } }
	? TNotNull
	: TColumn extends { _: { notNull: true } } ? true
	: false;

type ColumnValue<TColumn extends Column, TNotNull> = TNotNull extends true ? TColumn['_']['data']
	: TColumn['_']['data'] | null;

/** A column's value as its own variant reads it. */
export type EmbeddedColumnData<TColumn extends Column> = ColumnValue<TColumn, DeclaredColumnNotNull<TColumn>>;

/** Whether a shared column is `NOT NULL` in the rows of variant `TTag`. */
export type UnionSharedColumnNotNull<TColumn extends Column, TTag extends string> = TColumn['_'] extends
	{ unionShared: { [K in TTag]: true } } ? true : false;

/** A shared column's value in the rows of variant `TTag`. */
export type UnionSharedColumnData<TColumn extends Column, TTag extends string> = ColumnValue<
	TColumn,
	UnionSharedColumnNotNull<TColumn, TTag>
>;

type InsertKeyRest<TColumn extends Column, TOverride> = TColumn['_']['generated'] extends undefined
	? TColumn['_']['identity'] extends 'always' ? TOverride extends true ? 'optional' : 'excluded'
	: 'optional'
	: 'excluded';

/** Mirrors `RequiredKeyOnly` and `OptionalKeyOnly`, with the column's nullability given. */
type InsertKeyKind<TColumn extends Column, TNotNull, TOverride> = TNotNull extends true
	? TColumn['_']['hasDefault'] extends false ? 'required' : InsertKeyRest<TColumn, TOverride>
	: InsertKeyRest<TColumn, TOverride>;

/** {@link InferModelFromColumns}, with each column's nullability given by `TNotNull`. */
type ModelWith<
	TColumns extends Columns,
	TNotNull,
	TInferMode extends 'select' | 'insert',
	TOverride,
	TExtra,
> = TInferMode extends 'insert' ?
		& {
			[
				K in keyof TColumns & string as InsertKeyKind<TColumns[K], TNotNull[K & keyof TNotNull], TOverride> extends
					'required' ? K
					: never
			]:
				| ColumnValue<TColumns[K], TNotNull[K & keyof TNotNull]>
				| TExtra;
		}
		& {
			[
				K in keyof TColumns & string as InsertKeyKind<TColumns[K], TNotNull[K & keyof TNotNull], TOverride> extends
					'optional' ? K : never
			]?:
				| ColumnValue<TColumns[K], TNotNull[K & keyof TNotNull]>
				| TExtra
				| undefined;
		}
	: { [K in keyof TColumns & string]: ColumnValue<TColumns[K], TNotNull[K & keyof TNotNull]> | TExtra };

type DeclaredNotNullMap<TColumns> = { [K in keyof TColumns]: DeclaredColumnNotNull<TColumns[K]> };

/** The columns shared by the variants of the union at `TPath` that variant `TTag` declares, keyed by field. */
type UnionSharedColumnsOf<TColumns, TPath extends string, TTag extends string> = {
	[
		K in keyof TColumns as K extends `${TPath}.${infer TField}` ? TField extends `${string}.${string}` ? never
			: TColumns[K] extends { _: { unionShared: { [P in TTag]: boolean } } } ? TField
			: never
			: never
	]: TColumns[K];
};

type UnionSharedNotNull<TColumns, TTag extends string> = {
	[K in keyof TColumns]: TColumns[K] extends { _: { unionShared: { [P in TTag]: true } } } ? true : false;
};

/** Keys of the columns that belong to a union: its tag, shared and variant columns. */
type UnionMemberKeys<TColumns> = {
	[K in keyof TColumns & string]: TColumns[K] extends
		{ _: { unionTag: string } | { unionMember: unknown } | { unionShared: unknown } } ? K
		: never;
}[keyof TColumns & string];

type UnionModel<
	TColumns,
	TPath extends string,
	TKey extends string,
	TTags,
	TInferMode extends 'select' | 'insert',
	TConfig extends { override?: boolean },
	TExtra,
> = TTags extends string ? Simplify<
		& { [P in TKey]: TTags }
		& NestModel<
			Assume<UnionVariantColumnsOf<TColumns, `${TPath}.${TTags}.`>, Columns>,
			TInferMode,
			TConfig,
			TExtra
		>
		& ModelWith<
			Assume<UnionSharedColumnsOf<TColumns, TPath, TTags>, Columns>,
			UnionSharedNotNull<UnionSharedColumnsOf<TColumns, TPath, TTags>, TTags>,
			TInferMode,
			TConfig['override'],
			TExtra
		>
	>
	: never;

type ModelWithUnions<
	TColumns extends Columns,
	TInferMode extends 'select' | 'insert',
	TConfig extends { override?: boolean },
	TExtra,
	TTagKeys extends string = OuterUnionTagKeys<TColumns>,
	TRest extends Columns = Assume<Omit<TColumns, Extract<keyof TColumns, `${ParentPath<TTagKeys>}.${string}`>>, Columns>,
> =
	& ModelWith<TRest, DeclaredNotNullMap<TRest>, TInferMode, TConfig['override'], TExtra>
	& {
		[K in TTagKeys as ParentPath<K>]: UnionModel<
			TColumns,
			ParentPath<K>,
			LastSegment<K>,
			TColumns[K]['_']['data'],
			TInferMode,
			TConfig,
			TExtra
		>;
	};

/**
 * A table's row or insert value from its flat column map: `embed()` groups nested, and each
 * `taggedUnion()` a union of its variants, `{ kind: 'staff'; staffId: number } | { kind: 'system' }`.
 *
 * @param TExtra added to the type of every column's value, as an insert also takes `SQL`
 */
export type NestModel<
	TColumns extends Columns,
	TInferMode extends 'select' | 'insert' = 'select',
	TConfig extends { override?: boolean } = { override: false },
	TExtra = never,
> = [UnionMemberKeys<TColumns>] extends [never] ? NestEmbedded<ModelOf<TColumns, TInferMode, TConfig, TExtra>>
	: NestEmbedded<Simplify<ModelWithUnions<TColumns, TInferMode, TConfig, TExtra>>>;

type UnionPartial<TColumns, TPath extends string, TKey extends string, TTags, TExtra> = TTags extends string ? Simplify<
		& { [P in TKey]: TTags }
		& NestModelPartial<Assume<UnionVariantColumnsOf<TColumns, `${TPath}.${TTags}.`>, Columns>, TExtra>
		& {
			[F in keyof UnionSharedColumnsOf<TColumns, TPath, TTags>]?:
				| UnionSharedColumnData<Assume<UnionSharedColumnsOf<TColumns, TPath, TTags>[F], Column>, TTags>
				| TExtra;
		}
	>
	: never;

/**
 * An update's `set` from a flat column map: every column optional and nested as in
 * {@link NestEmbeddedPartial}. A `taggedUnion()` is given as one whole variant: its tag, and any of that
 * variant's columns.
 */
export type NestModelPartial<TColumns extends Columns, TExtra> = [UnionMemberKeys<TColumns>] extends [never]
	? NestEmbeddedPartial<{ [K in keyof TColumns & string]?: GetColumnData<TColumns[K]> | TExtra }>
	: OuterUnionTagKeys<TColumns> extends infer TTagKeys extends string ? NestEmbeddedPartial<
			& {
				[K in Exclude<keyof TColumns & string, `${ParentPath<TTagKeys>}.${string}`>]?:
					| EmbeddedColumnData<TColumns[K]>
					| TExtra;
			}
			& {
				[K in TTagKeys as ParentPath<K>]?: UnionPartial<
					TColumns,
					ParentPath<K>,
					LastSegment<K>,
					TColumns[K]['_']['data'],
					TExtra
				>;
			}
		>
	: never;

/** The markers a column builder's config carries into the built column's config. */
export type UnionColumnMarkers<T> = Pick<T, Extract<keyof T, 'unionTag' | 'unionMember' | 'unionShared'>>;

/**
 * A column of a union variant: nullable in the database, with its declared nullability kept for
 * the rows of its own variant.
 */
type MarkUnionMember<TBuilder> = TBuilder extends { _: infer TConfig } ? {
		_: Simplify<
			& Omit<TConfig, 'notNull'>
			& { notNull: false; unionMember: { notNull: TConfig extends { notNull: true } ? true : false } }
		>;
	}
	: TBuilder;

/** Whether a flat column map holds any `taggedUnion()`. */
export type HasEmbeddedUnions<TColumns> = [UnionTagKeys<TColumns>] extends [never] ? false : true;

/**
 * The key of the tag column when `T` is a `taggedUnion()` group of columns, such as `files.uploader`.
 */
export type EmbeddedUnionTagKey<T> = {
	[K in keyof T & string]: T[K] extends { _: { unionTag: K } } ? K : never;
}[keyof T & string];

type UnionToIntersection<U> = (U extends any ? (arg: U) => void : never) extends (arg: infer I) => void ? I
	: never;
