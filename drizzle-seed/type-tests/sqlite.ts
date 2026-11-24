import { drizzle as betterSqlite3Drizzle } from 'drizzle-orm/better-sqlite3';
import { drizzle as libsqlDrizzle } from 'drizzle-orm/libsql';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';
import { embed, int, integer, sqliteTable, taggedUnion, text } from 'drizzle-orm/sqlite-core';
import { reset, seed } from '../src/index.ts';

const sqliteUsers = sqliteTable('users', {
	id: int().primaryKey(),
	name: text(),
	inviteId: int('invite_id').references((): SQLiteColumn => sqliteUsers.id),
});

{
	const db = betterSqlite3Drizzle('');

	await seed(db, { users: sqliteUsers });
	await reset(db, { users: sqliteUsers });
}

{
	const db = libsqlDrizzle({
		connection: {
			url: 'libsql://testturso-oleksiikh0240.turso.io',
		},
	});

	await reset(db, { sqliteUsers });

	await seed(db, { sqliteUsers });
}

{
	const db0 = betterSqlite3Drizzle('');

	await seed(db0, { users: sqliteUsers });
	await seed(db0, { users: sqliteUsers }).refine((funcs) => ({
		users: {
			columns: {
				id: funcs.intPrimaryKey(),
			},
		},
	}));
	await reset(db0, { users: sqliteUsers });

	const db1 = betterSqlite3Drizzle('');

	await seed(db1, { users: sqliteUsers });
	await seed(db1, { users: sqliteUsers }).refine((funcs) => ({
		users: {
			columns: {
				id: funcs.intPrimaryKey(),
			},
		},
	}));
	await reset(db1, { users: sqliteUsers });
}

{
	const db0 = libsqlDrizzle('');

	await seed(db0, { users: sqliteUsers });
	await seed(db0, { users: sqliteUsers }).refine((funcs) => ({
		users: {
			columns: {
				id: funcs.intPrimaryKey(),
			},
		},
	}));
	await reset(db0, { users: sqliteUsers });

	const db1 = libsqlDrizzle('');

	await seed(db1, { users: sqliteUsers });
	await seed(db1, { users: sqliteUsers }).refine((funcs) => ({
		users: {
			columns: {
				id: funcs.intPrimaryKey(),
			},
		},
	}));
	await reset(db1, { users: sqliteUsers });
}

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// taggedUnion()
{
	const db = betterSqlite3Drizzle('');
	const files = sqliteTable('files', {
		id: integer().primaryKey(),
		uploader: taggedUnion('kind', text(), {
			staff: {
				staffId: integer().notNull(),
				campusId: integer(),
				badge: embed({ code: text() }),
			},
			parent: {
				parentId: integer().notNull(),
				campusId: integer(),
				via: taggedUnion('channel', text(), {
					app: { version: text().notNull() },
					email: { address: text().notNull() },
				}),
			},
			system: {},
		}),
	});

	// the tag, a column shared by variants, a variant's columns and a union nested in a variant are all refined
	await seed(db, { files }).refine((funcs) => ({
		files: {
			columns: {
				uploader: {
					kind: funcs.valuesFromArray({ values: ['staff', 'system'] }),
					campusId: funcs.int(),
					staff: { staffId: funcs.int(), badge: { code: funcs.string() } },
					parent: { parentId: funcs.intPrimaryKey(), via: { channel: funcs.valuesFromArray({ values: ['app'] }) } },
				},
			},
		},
	}));

	// a union's columns can be left out of a refinement, or turned off
	await seed(db, { files }).refine(() => ({
		files: { columns: { uploader: { staff: { badge: { code: false } } } } },
	}));

	await seed(db, { files }).refine((funcs) => ({
		files: {
			columns: {
				uploader: {
					// @ts-expect-error a column of another variant is not in this one
					staff: { parentId: funcs.int() },
				},
			},
		},
	}));

	await seed(db, { files }).refine((funcs) => ({
		files: {
			columns: {
				uploader: {
					// @ts-expect-error a variant cannot take a single generator
					staff: funcs.int(),
				},
			},
		},
	}));

	// dry runs hand union rows back as the variant they hold
	const data = await seed(db, { files }).dryRun();
	type _data = Expect<Equal<typeof data.files, (typeof files)['$inferInsert'][]>>;
	for (const row of data.files) {
		if (row.uploader?.kind === 'staff') row.uploader.staffId;
	}
}
