import { type AnyColumn, getTableColumns, type Table } from 'drizzle-orm';
import type { Column, RelationWithReferences } from './types/tables';

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
 * `{ address: { city: 'Berlin' } }`. A row whose keys are not dotted is returned as it is.
 */
export const nestEmbeddedRow = <T extends { [key: string]: unknown }>(row: T): T => {
	if (!Object.keys(row).some((key) => key.includes(embeddedKeySeparator))) return row;

	const result: { [key: string]: any } = {};
	for (const [key, value] of Object.entries(row)) {
		const segments = key.split(embeddedKeySeparator);
		let target = result;
		for (const segment of segments.slice(0, -1)) {
			target = target[segment] ??= {};
		}
		target[segments.at(-1)!] = value;
	}

	return result as T;
};
