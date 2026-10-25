import type { InferInsertModel } from 'drizzle-orm';
import { drizzle as nodePostgresDrizzle } from 'drizzle-orm/node-postgres';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { embed, integer, pgTable, taggedUnion, text } from 'drizzle-orm/pg-core';
import { drizzle as pgliteDrizzle } from 'drizzle-orm/pglite';
import { drizzle as postgresJsDrizzle } from 'drizzle-orm/postgres-js';
import { defineRelations } from 'drizzle-orm/relations';
import { reset, seed } from '../src/index.ts';

const pgUsers = pgTable('users', {
	id: integer().primaryKey().generatedAlwaysAsIdentity(),
	name: text(),
	inviteId: integer('invite_id').references((): PgColumn => pgUsers.id),
});

// node-postgres
{
	const db0 = nodePostgresDrizzle('');

	await seed(db0, { users: pgUsers });
	await seed(db0, { users: pgUsers }).refine((funcs) => ({
		users: {
			columns: {
				id: funcs.intPrimaryKey(),
			},
		},
	}));
	await reset(db0, { users: pgUsers });

	const db1 = nodePostgresDrizzle('');

	await seed(db1, { users: pgUsers });
	await seed(db1, { users: pgUsers }).refine((funcs) => ({
		users: {
			columns: {
				id: funcs.intPrimaryKey(),
			},
		},
	}));
	await reset(db1, { users: pgUsers });
}

// pglite
{
	const db0 = pgliteDrizzle('');

	await seed(db0, { users: pgUsers });
	await seed(db0, { users: pgUsers }).refine((funcs) => ({
		users: {
			columns: {
				id: funcs.intPrimaryKey(),
			},
		},
	}));
	await reset(db0, { users: pgUsers });

	const db1 = pgliteDrizzle('');

	await seed(db1, { users: pgUsers });
	await seed(db1, { users: pgUsers }).refine((funcs) => ({
		users: {
			columns: {
				id: funcs.intPrimaryKey(),
			},
		},
	}));
	await reset(db1, { users: pgUsers });
}

// postgres-js
{
	const db0 = postgresJsDrizzle('');

	await seed(db0, { users: pgUsers });
	await seed(db0, { users: pgUsers }).refine((funcs) => ({
		users: {
			columns: {
				id: funcs.intPrimaryKey(),
			},
		},
	}));
	await reset(db0, { users: pgUsers });

	const db1 = postgresJsDrizzle('');

	await seed(db1, { users: pgUsers });
	await seed(db1, { users: pgUsers }).refine((funcs) => ({
		users: {
			columns: {
				id: funcs.intPrimaryKey(),
			},
		},
	}));
	await reset(db1, { users: pgUsers });
}

// defineRelations (RQB v2) + dryRun
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

{
	const pgPosts = pgTable('posts', {
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		ownerId: integer('owner_id'),
		title: text(),
	});

	const schema = { users: pgUsers, posts: pgPosts };

	const relations = defineRelations(schema, (r) => ({
		users: {
			posts: r.many.posts(),
		},
		posts: {
			owner: r.one.users({ from: r.posts.ownerId, to: r.users.id }),
		},
	}));

	const db = pgliteDrizzle('', { relations });

	// relations are read off the database
	await seed(db, schema);
	// ... and can be passed explicitly
	await seed(db, schema, { count: 10, seed: 1, relations });

	const generated = await seed(db, schema, { count: 10 }).dryRun();
	type _generated = Expect<
		Equal<typeof generated, { users: InferInsertModel<typeof pgUsers>[]; posts: InferInsertModel<typeof pgPosts>[] }>
	>;

	const refined = await seed(db, schema).refine((funcs) => ({
		users: {
			count: 3,
			columns: {
				id: funcs.intPrimaryKey(),
			},
		},
	})).dryRun();
	type _refined = Expect<
		Equal<typeof refined, { users: InferInsertModel<typeof pgUsers>[]; posts: InferInsertModel<typeof pgPosts>[] }>
	>;

	// refine() is still awaitable on its own and seeds the database
	await seed(db, schema).refine((funcs) => ({
		users: {
			columns: {
				id: funcs.intPrimaryKey(),
			},
		},
	}));

	const statements = await seed(db, schema, { count: 10 }).dryRun({ output: 'sql' });
	type _statements = Expect<Equal<typeof statements, string[]>>;

	const refinedStatements = await seed(db, schema).refine(() => ({ users: { count: 2 } })).dryRun({ output: 'sql' });
	type _refinedStatements = Expect<Equal<typeof refinedStatements, string[]>>;

	// a dry run can be iterated instead of awaited
	for await (const write of seed(db, schema, { count: 10 }).dryRun()) {
		type _tableName = Expect<Equal<typeof write.tableName, 'users' | 'posts'>>;

		if (write.type === 'insert') {
			type _rows = Expect<
				Equal<typeof write.rows, InferInsertModel<typeof pgUsers>[] | InferInsertModel<typeof pgPosts>[]>
			>;
		} else {
			type _whereColumn = Expect<Equal<typeof write.whereColumn, string>>;
		}
	}

	for await (const statement of seed(db, schema, { count: 10 }).dryRun({ output: 'sql' })) {
		type _statement = Expect<Equal<typeof statement, string>>;
	}
}

// embed()
{
	const db = pgliteDrizzle('');
	const people = pgTable('people', {
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
		name: text(),
		address: embed({ city: text(), geo: embed({ lat: integer(), lng: integer() }) }),
	});

	// an embedded group is refined as a nested object, like it is read and written
	await seed(db, { people }).refine((funcs) => ({
		people: {
			columns: {
				name: funcs.fullName(),
				address: {
					city: funcs.city(),
					geo: { lat: funcs.int(), lng: false },
				},
			},
		},
	}));

	await seed(db, { people }).refine((funcs) => ({
		people: {
			columns: {
				// @ts-expect-error a column of the group does not exist
				address: { street: funcs.city() },
			},
		},
	}));

	await seed(db, { people }).refine((funcs) => ({
		people: {
			columns: {
				// @ts-expect-error a group cannot take a single generator
				address: funcs.city(),
			},
		},
	}));

	// dry runs hand embedded values back nested
	const data = await seed(db, { people }).dryRun();
	type _data = Expect<Equal<typeof data.people, (typeof people)['$inferInsert'][]>>;
	data.people[0]!.address?.geo?.lat;

	await reset(db, { people });
}

// taggedUnion()
{
	const db = pgliteDrizzle('');
	const files = pgTable('files', {
		id: integer().primaryKey().generatedAlwaysAsIdentity(),
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
