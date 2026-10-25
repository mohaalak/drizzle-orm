/* eslint-disable @typescript-eslint/no-explicit-any */

import type { AnyColumn } from 'drizzle-orm';
import type {
	CockroachTable,
	ForeignKey as CockroachFK,
	UniqueConstraint as CockroachUniCon,
} from 'drizzle-orm/cockroach-core';
import type { ForeignKey as MsSqlFK, MsSqlTable, UniqueConstraint as MsSqlUniCon } from 'drizzle-orm/mssql-core';
import type { ForeignKey as MySqlFK, MySqlTable, UniqueConstraint as MySqlUniCon } from 'drizzle-orm/mysql-core';
import type { ForeignKey as PgFK, PgTable, UniqueConstraint as PgUniCon } from 'drizzle-orm/pg-core';
import type { SingleStoreTable, UniqueConstraint as SingleStoreUniCon } from 'drizzle-orm/singlestore-core';
import type { ForeignKey as SQLiteFK, SQLiteTable, UniqueConstraint as SQLiteUniCon } from 'drizzle-orm/sqlite-core';

export type Column = {
	name: string;
	dataType: string;
	columnType: string;
	typeParams: {
		precision?: number;
		scale?: number;
		length?: number;
		dimensions?: number;
		vectorValueType?: 'I8' | 'I16' | 'I32' | 'I64' | 'F32' | 'F64';
	};
	size?: number;
	default?: any;
	hasDefault: boolean;
	enumValues?: string[];
	isUnique: boolean;
	notNull: boolean;
	primary: boolean;
	generatedIdentityType?: 'always' | 'byDefault' | undefined;
	identity?: boolean;
	baseColumn?: Omit<Column, 'generatedIdentityType'>;
};

/**
 * The `taggedUnion()` groups of a table. A row holds one variant of each union: its tag column names the variant, and
 * a column is filled only when every union it belongs to holds a variant that has it.
 */
export type TableUnions = {
	/** the variant names each tag column (by its key) can take */
	tags: { [tagColumn: string]: string[] };
	/** every column that belongs to a union, by its key */
	columns: {
		[column: string]: {
			/** whether the column was declared not null, which the table itself no longer says for a variant's column */
			declaredNotNull: boolean;
			/**
			 * The tag columns that decide whether the column is filled, outermost first, each with the variants that
			 * have it. A union's own tag column is only conditional on the unions it is nested in.
			 */
			levels: { tag: string; variants: string[] }[];
			/**
			 * The segments of the column's key that name a variant (`uploader.staff.staffId`): a union is written as the
			 * variant it holds, `{ kind: 'staff', staffId: 1 }`, without them.
			 */
			variantSegments: number[];
		};
	};
};

export type Table = {
	name: string;
	columns: Column[];
	uniqueConstraints: string[][];
	/** columns marked primary one by one, which is all `Column.primary` ever reflects */
	primaryKeys: string[];
	/** column tuples declared primary at table level, which never mark their columns as primary */
	compositePrimaryKeys: string[][];
	unions?: TableUnions;
};

export type Relation = {
	// name: string;
	type?: 'one' | 'many';
	table: string;
	// schema: string;
	columns: string[];
	refTable: string;
	// refSchema: string;
	refColumns: string[];
};

export type RelationWithReferences = Relation & { isCyclic?: boolean; refTableRels: RelationWithReferences[] };

export type Prettify<T> =
	& {
		[K in keyof T]: T[K];
	}
	& {};

export type DrizzleTable = PgTable | MySqlTable | SQLiteTable | CockroachTable | MsSqlTable | SingleStoreTable;
export type DrizzleForeignKey = PgFK | MySqlFK | SQLiteFK | CockroachFK | MsSqlFK;
export type DrizzleUniqueConstraint =
	| PgUniCon
	| MySqlUniCon
	| SQLiteUniCon
	| CockroachUniCon
	| MsSqlUniCon
	| SingleStoreUniCon;

/**
 * A relational config as built by `defineRelations`. Declared structurally rather than as drizzle's `AnyRelations` so
 * that a config built over a schema whose types TypeScript had to widen still fits - a single `references(() => ...)`
 * back at its own table is enough to widen one - which is exactly what `drizzle({ relations })` accepts too.
 */
export type SeedRelations = {
	[tsTableName: string]: { table: any; name: string; relations: any } | undefined;
};

export type DrizzlePrimaryKey = {
	readonly columns: AnyColumn[];
	readonly name?: string;
};

export type TableConfigT = {
	name: string;
	schema?: string;
	columns: AnyColumn[];
	uniqueConstraints: DrizzleUniqueConstraint[];
	foreignKeys?: DrizzleForeignKey[];
	primaryKeys?: DrizzlePrimaryKey[];
};
