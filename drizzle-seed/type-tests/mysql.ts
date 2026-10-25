import type { MySqlColumn } from 'drizzle-orm/mysql-core';
import { embed, int, mysqlTable, serial, taggedUnion, text, varchar } from 'drizzle-orm/mysql-core';
import { drizzle as mysql2Drizzle } from 'drizzle-orm/mysql2';
import { drizzle as planetscaleDrizzle } from 'drizzle-orm/planetscale-serverless';
import { reset, seed } from '../src/index.ts';

const mysqlUsers = mysqlTable('users', {
	id: int().primaryKey().autoincrement(),
	name: text(),
	inviteId: int('invite_id').references((): MySqlColumn => mysqlUsers.id),
});

// mysql2
{
	const db0 = mysql2Drizzle('');

	await seed(db0, { users: mysqlUsers });
	await seed(db0, { users: mysqlUsers }).refine((funcs) => ({
		users: {
			columns: {
				id: funcs.intPrimaryKey(),
			},
		},
	}));
	await reset(db0, { users: mysqlUsers });

	const db1 = mysql2Drizzle('');

	await seed(db1, { users: mysqlUsers });
	await seed(db1, { users: mysqlUsers }).refine((funcs) => ({
		users: {
			columns: {
				id: funcs.intPrimaryKey(),
			},
		},
	}));
	await reset(db1, { users: mysqlUsers });

	const db2 = mysql2Drizzle('');

	await seed(db2, { users: mysqlUsers });
	await seed(db2, { users: mysqlUsers }).refine((funcs) => ({
		users: {
			columns: {
				id: funcs.intPrimaryKey(),
			},
		},
	}));
	await reset(db2, { users: mysqlUsers });
}

// planetscale
{
	const db0 = planetscaleDrizzle('');

	await seed(db0, { users: mysqlUsers });
	await seed(db0, { users: mysqlUsers }).refine((funcs) => ({
		users: {
			columns: {
				id: funcs.intPrimaryKey(),
			},
		},
	}));
	await reset(db0, { users: mysqlUsers });

	const db1 = planetscaleDrizzle('');

	await seed(db1, { users: mysqlUsers });
	await seed(db1, { users: mysqlUsers }).refine((funcs) => ({
		users: {
			columns: {
				id: funcs.intPrimaryKey(),
			},
		},
	}));
	await reset(db1, { users: mysqlUsers });
}

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// taggedUnion()
{
	const db = mysql2Drizzle('');
	const files = mysqlTable('files', {
		id: serial().primaryKey(),
		uploader: taggedUnion('kind', varchar({ length: 16 }), {
			staff: {
				staffId: int().notNull(),
				campusId: int(),
				badge: embed({ code: text() }),
			},
			parent: {
				parentId: int().notNull(),
				campusId: int(),
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
