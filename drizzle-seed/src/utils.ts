import { type AnyColumn, getTableColumns, type Table } from 'drizzle-orm';
import type { Column, RelationWithReferences, TableUnions } from './types/tables';

/**
 * A table's columns by their keys. The table object nests the columns of an `embed()` group (`users.address.city`),
 * while this map keeps them flat under dotted keys (`'address.city'`), which is how the seed names them.
 */
export const getFlatColumns = (table: object) => getTableColumns(table as Table) as { [key: string]: AnyColumn };

/**
 * A column's own name, lowercased, for picking a generator by what the column holds. A column in an `embed()` group is
 * named by its path (`'contact.email'`).
 */
export const ownColumnName = (col: Column) => col.name.split('.').at(-1)!.toLowerCase();

export const isRelationCyclic = (
	startRel: RelationWithReferences,
) => {
	// self relation
	if (startRel.table === startRel.refTable) return false;

	// DFS
	const targetTable = startRel.table;
	const queue = [startRel];
	let path: string[] = [];
	while (queue.length !== 0) {
		const currRel = queue.shift();

		if (path.includes(currRel!.table)) {
			const idx = path.indexOf(currRel!.table);
			path = path.slice(0, idx);
		}
		path.push(currRel!.table);

		for (const rel of currRel!.refTableRels) {
			// self relation
			if (rel.table === rel.refTable) continue;

			if (rel.refTable === targetTable) return true;

			// found cycle, but not the one we are looking for
			if (path.includes(rel.refTable)) continue;
			queue.unshift(rel);
		}
	}

	return false;
};

// the integer family postgres attaches a sequence to when a column is declared serial or as an identity
const postgresSequenceBackedColumnTypes = new Set([
	'smallint',
	'integer',
	'bigint',
	'smallserial',
	'serial',
	'bigserial',
]);

/**
 * Whether writing a value into this column may leave the table's sequence behind it. Only a column the database fills
 * on its own has a sequence to fall behind - serial, identity, or an explicit `nextval` default - and every one of
 * those reports a default.
 */
export const isSequenceBackedColumn = (column: Column) =>
	(column.typeParams.dimensions ?? 0) === 0
	&& postgresSequenceBackedColumnTypes.has(column.columnType)
	&& (column.hasDefault === true || column.generatedIdentityType !== undefined);

export const equalSets = (set1: Set<any>, set2: Set<any>) => {
	return set1.size === set2.size && [...set1].every((si) => set2.has(si));
};

export const intMax = (args: (number | bigint)[]) => args.reduce((m, e) => e > m ? e : m);

const embeddedKeySeparator = '.';

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
	if (typeof value !== 'object' || value === null) return false;
	const prototype = Object.getPrototypeOf(value);

	return prototype === Object.prototype || prototype === null;
};

/**
 * Turns the refinements of an `embed()` group into the dotted keys the table's columns are known by:
 * `{ address: { city: gen } }` becomes `{ 'address.city': gen }`. A generator is a class instance, so a plain object
 * is always a group. Dotted keys given directly are kept as they are.
 */
export const flattenRefinementColumns = <T>(columns: { [key: string]: T | { [key: string]: any } }) => {
	const result: { [columnName: string]: T } = {};
	const visit = (source: { [key: string]: any }, prefix: string) => {
		for (const [key, value] of Object.entries(source)) {
			if (isPlainObject(value)) visit(value, `${prefix}${key}${embeddedKeySeparator}`);
			else result[`${prefix}${key}`] = value;
		}
	};
	visit(columns, '');

	return result;
};

/**
 * Nests a generated row's dotted keys the way the table writes them: `{ 'address.city': 'Berlin' }` becomes
 * `{ address: { city: 'Berlin' } }`. A union is written as the variant it holds, so the columns of the other variants
 * are left out and the variant's own are written beside the tag: `{ 'file.kind': 'staff', 'file.staff.staffId': 1 }`
 * becomes `{ file: { kind: 'staff', staffId: 1 } }`. A row whose keys are not dotted is returned as it is.
 */
export const nestEmbeddedRow = <T extends { [key: string]: unknown }>(row: T, unions?: TableUnions): T => {
	if (!Object.keys(row).some((key) => key.includes(embeddedKeySeparator))) return row;

	const result: { [key: string]: any } = {};
	for (const [key, value] of Object.entries(row)) {
		let segments = key.split(embeddedKeySeparator);
		const union = unions?.columns[key];
		if (union !== undefined) {
			if (!isUnionColumnFilled(row, unions!, key)) continue;
			segments = segments.filter((_, index) => !union.variantSegments.includes(index));
		}

		let target = result;
		for (const segment of segments.slice(0, -1)) {
			target = target[segment] ??= {};
		}
		target[segments.at(-1)!] = value;
	}

	return result as T;
};

/** What `taggedUnion()` records on each of its columns (see `embeddedUnionsOf` in drizzle-orm). */
type UnionMembership = {
	union: { key: string; tags: readonly string[]; shared: Readonly<Record<string, readonly string[]>> };
	path: readonly string[];
	notNull: boolean;
};

/**
 * The `taggedUnion()` groups of a table, read from the unions every column of the flat column map belongs to. A column
 * that sits in a variant, or is shared by some variants, is filled only for those variants; a union nested in a variant
 * adds a level of its own.
 */
const tableUnionsCache = new WeakMap<object, TableUnions | null>();

export const getTableUnions = (table: object): TableUnions | undefined => {
	const cached = tableUnionsCache.get(table);
	if (cached !== undefined) return cached ?? undefined;

	const result: TableUnions = { tags: {}, columns: {} };

	for (const [key, column] of Object.entries(getFlatColumns(table))) {
		const memberships = (column as { config?: { embeddedUnions?: UnionMembership[] } }).config?.embeddedUnions;
		if (memberships === undefined || memberships.length === 0) continue;

		const levels: TableUnions['columns'][string]['levels'] = [];
		const variantSegments: number[] = [];
		for (const { union, path } of memberships) {
			// the union's group, as a prefix of the column's key
			const root = key.slice(0, key.length - path.join(embeddedKeySeparator).length);
			const tag = root + union.key;
			result.tags[tag] = [...union.tags];

			if (path.length === 1 && path[0] === union.key) continue;
			const sharedBy = path.length === 1 ? union.shared[path[0]!] : undefined;
			levels.push({ tag, variants: sharedBy === undefined ? [path[0]!] : [...sharedBy] });
			if (sharedBy === undefined) variantSegments.push(root === '' ? 0 : root.split(embeddedKeySeparator).length - 1);
		}
		result.columns[key] = { declaredNotNull: memberships[0]!.notNull, levels, variantSegments };
	}

	const unions = Object.keys(result.columns).length === 0 ? undefined : result;
	tableUnionsCache.set(table, unions ?? null);

	return unions;
};

const isUnionColumnFilled = (tagValues: { [tagColumn: string]: unknown }, unions: TableUnions, column: string) =>
	unions.columns[column]!.levels.every(({ tag, variants }) => variants.includes(tagValues[tag] as string));

/**
 * Empties the columns of a generated row that its variants do not have, and checks that the variants it names exist.
 * A column missing from the row (a second pass over cyclic tables only generates some) is left alone.
 */
export const applyTableUnions = (row: { [key: string]: unknown }, unions: TableUnions, tableName: string) => {
	const tagValues: { [tagColumn: string]: unknown } = {};
	for (const tag of Object.keys(unions.tags)) tagValues[tag] = row[tag];

	const isFilled = (column: string) => isUnionColumnFilled(tagValues, unions, column);

	for (const [tag, tags] of Object.entries(unions.tags)) {
		if (!(tag in row) || !isFilled(tag)) continue;
		if (!tags.includes(tagValues[tag] as string)) {
			throw new Error(
				`The '${tag}' column in the '${tableName}' table was given '${String(tagValues[tag])}', which is not one of`
					+ ` the variants of its union: ${tags.map((name) => `'${name}'`).join(', ')}.`,
			);
		}
	}

	for (const column of Object.keys(unions.columns)) {
		if (column in row && !isFilled(column)) row[column] = null;
	}
};
