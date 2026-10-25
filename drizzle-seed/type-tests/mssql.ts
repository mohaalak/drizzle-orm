import type { MsSqlColumn } from 'drizzle-orm/mssql-core';
import { embed, int, mssqlTable, taggedUnion, text } from 'drizzle-orm/mssql-core';
import { drizzle } from 'drizzle-orm/node-mssql';
import { reset, seed } from '../src/index.ts';

const mssqlUsers = mssqlTable('users', {
	id: int().primaryKey(),
	name: text(),
	inviteId: int('invite_id').references((): MsSqlColumn => mssqlUsers.id),
});

{
	const db0 = drizzle('');

	await seed(db0, { users: mssqlUsers });
	await seed(db0, { users: mssqlUsers }).refine((funcs) => ({
		users: {
			columns: {
				id: funcs.intPrimaryKey(),
			},
		},
	}));
	await reset(db0, { users: mssqlUsers });

	const db1 = drizzle('');

	await seed(db1, { users: mssqlUsers });
	await seed(db1, { users: mssqlUsers }).refine((funcs) => ({
		users: {
			columns: {
				id: funcs.intPrimaryKey(),
			},
		},
	}));
	await reset(db1, { users: mssqlUsers });
}

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// taggedUnion()
{
	const db = drizzle('');
	const files = mssqlTable('files', {
		id: int().primaryKey(),
		uploader: taggedUnion('kind', text(), {
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
