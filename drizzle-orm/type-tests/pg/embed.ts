import type { Equal } from 'type-tests/utils.ts';
import { Expect } from 'type-tests/utils.ts';
import { drizzle } from '~/node-postgres/index.ts';
import { embed, integer, type PgColumn, pgTable, QueryBuilder, serial, text } from '~/pg-core/index.ts';
import { defineRelations } from '~/relations.ts';
import { eq } from '~/sql/expressions/index.ts';
import type { InferInsertModel, InferSelectModel } from '~/table.ts';
import { db } from './db.ts';

const users = pgTable('users_embed', {
	id: serial().primaryKey(),
	name: text().notNull(),
	address: embed({
		street: text(),
		city: text().notNull(),
		geo: embed({ lat: integer(), lng: integer() }),
	}),
	note: embed({ body: text() }),
});

type Address = {
	street: string | null;
	city: string;
	geo: { lat: number | null; lng: number | null };
};
type User = { id: number; name: string; address: Address; note: { body: string | null } };

// Groups are reached as nested columns.
Expect<Equal<typeof users.address.city extends PgColumn ? true : false, true>>();
Expect<Equal<typeof users.address.geo.lat extends PgColumn ? true : false, true>>();
// @ts-expect-error - the flat key is not a property of the table
users['address.city'];

Expect<Equal<typeof users.$inferSelect, User>>();
Expect<Equal<InferSelectModel<typeof users>, User>>();
Expect<Equal<InferInsertModel<typeof users>, typeof users.$inferInsert>>();

// A group is required on insert when any column in it is; one whose columns are all optional may be left out.
Expect<
	Equal<typeof users.$inferInsert, {
		name: string;
		address: {
			city: string;
			street?: string | null | undefined;
			geo?: { lat?: number | null | undefined; lng?: number | null | undefined } | undefined;
		};
		id?: number | undefined;
		note?: { body?: string | null | undefined } | undefined;
	}>
>();

{
	const rows = await db.select().from(users).where(eq(users.address.city, 'Berlin'));
	Expect<Equal<typeof rows, User[]>>();
}

{
	const rows = await db.select({ address: users.address, lat: users.address.geo.lat }).from(users);
	Expect<Equal<typeof rows, { address: Address; lat: number | null }[]>>();
}

{
	const rows = await db.insert(users).values({ name: 'Ada', address: { city: 'Berlin' } }).returning();
	Expect<Equal<typeof rows, User[]>>();
}

{
	// @ts-expect-error - `city` is required in the group
	db.insert(users).values({ name: 'Ada', address: { street: 'Main St' } });
	// @ts-expect-error - the group is required
	db.insert(users).values({ name: 'Ada' });
}

{
	const rows = await db.update(users).set({ address: { geo: { lat: 1 } } }).returning();
	Expect<Equal<typeof rows, User[]>>();
	// @ts-expect-error - not a column of the group
	db.update(users).set({ address: { country: 'DE' } });
	// Writing `null` to a group clears every column in it.
	db.update(users).set({ note: null, address: { geo: null } });
}

{
	const other = pgTable('other_embed', { id: serial().primaryKey(), userId: integer() });
	const rows = await db.select().from(other).leftJoin(users, eq(other.userId, users.id));
	Expect<Equal<typeof rows, { other_embed: { id: number; userId: number | null }; users_embed: User | null }[]>>();
}

// Insert and delete `returning` take whole groups, as update `returning` does.
{
	const inserted = await db.insert(users).values({ name: 'n', address: { city: 'c' } }).returning({
		address: users.address,
	});
	Expect<Equal<typeof inserted, { address: Address }[]>>();

	const deleted = await db.delete(users).returning({ geo: users.address.geo });
	Expect<Equal<typeof deleted, { geo: Address['geo'] }[]>>();
}

// Relational queries: `columns`, `where` and `orderBy` take groups nested, or their columns by dotted keys.
{
	const rqb = drizzle.mock({ relations: defineRelations({ users }) });

	const whole = await rqb.query.users.findMany({ columns: { id: true, address: true } });
	Expect<Equal<typeof whole, { id: number; address: Address }[]>>();

	const part = await rqb.query.users.findMany({ columns: { address: { city: true, geo: { lat: true } } } });
	Expect<Equal<typeof part, { address: { city: string; geo: { lat: number | null } } }[]>>();

	const dotted = await rqb.query.users.findMany({ columns: { 'address.city': true } });
	Expect<Equal<typeof dotted, { address: { city: string } }[]>>();

	const excluded = await rqb.query.users.findMany({ columns: { address: false, name: false } });
	Expect<Equal<typeof excluded, { id: number; note: { body: string | null } }[]>>();

	const excludedPart = await rqb.query.users.findMany({ columns: { address: { geo: false }, note: false } });
	Expect<
		Equal<typeof excludedPart, { id: number; name: string; address: { street: string | null; city: string } }[]>
	>();

	await rqb.query.users.findMany({
		where: { address: { city: 'Berlin', geo: { lat: { gt: 1 } }, OR: [{ street: { isNull: true } }] } },
		orderBy: { address: { geo: { lat: 'desc' } }, id: 'asc' },
	});

	// @ts-expect-error - not a column of the group
	await rqb.query.users.findMany({ columns: { address: { country: true } } });
	// @ts-expect-error - the filter of a column is checked against its type
	await rqb.query.users.findMany({ where: { address: { city: 1 } } });
	// @ts-expect-error - not a column of the group
	await rqb.query.users.findMany({ orderBy: { address: { country: 'asc' } } });
}

// `insert().select()` takes embed() groups nested, the same way `values()` does, and still takes dotted keys.
{
	const qb = new QueryBuilder();
	const src = pgTable('src_embed', {
		name: text().notNull(),
		city: text().notNull(),
		lat: integer(),
	});

	db.insert(users).select(
		qb.select({ name: src.name, address: { city: src.city, geo: { lat: src.lat } } }).from(src),
	);
	db.insert(users).select((qb) => qb.select({ name: src.name, address: { city: src.city } }).from(src));
	db.insert(users).select(qb.select({ name: src.name, 'address.city': src.city }).from(src));
	db.insert(users).select(qb.select({ name: users.name, address: users.address }).from(users));

	db.insert(users).select(
		// @ts-expect-error - not a column of the group
		qb.select({ name: src.name, address: { city: src.city, country: src.city } }).from(src),
	);

	db.insert(users, 'name', 'address.city').select(
		qb.select({ name: src.name, address: { city: src.city } }).from(src),
	);
	db.insert(users, 'name', 'address.city').select(
		qb.select({ name: src.name, 'address.city': src.city }).from(src),
	);
	// A listed optional column may be left out of the selection.
	db.insert(users, 'name', 'address.city', 'address.street').select(
		qb.select({ name: src.name, address: { city: src.city } }).from(src),
	);
	db.insert(users, 'name', 'address.city').select(
		// @ts-expect-error - `address.street` is not included in the insert column selection
		qb.select({ name: src.name, address: { city: src.city, street: src.city } }).from(src),
	);

	const identified = pgTable('identified_embed', {
		name: text().notNull(),
		address: embed({
			city: text().notNull(),
			seq: integer().generatedAlwaysAsIdentity(),
		}),
	});
	db.insert(identified).select(
		// @ts-expect-error - `address.seq` is a generated column
		qb.select({ name: identified.name, address: { city: identified.address.city, seq: identified.address.seq } })
			.from(identified),
	);
	db.insert(identified).overridingSystemValue().select(
		qb.select({ name: identified.name, address: { city: identified.address.city, seq: identified.address.seq } })
			.from(identified),
	);
}

// A column list can name an embed() group. The group stands for every column in it.
{
	const qb = new QueryBuilder();

	db.insert(users, 'name', 'address').values({ name: 'Ada', address: { city: 'Berlin', geo: { lat: 1 } } });
	db.insert(users, 'name', 'address.city', 'address.geo').values({
		name: 'Ada',
		address: { city: 'Berlin', geo: { lat: 1 } },
	});
	db.insert(users, 'name', 'address.city', 'note').values({
		name: 'Ada',
		address: { city: 'Berlin' },
		note: { body: 'hi' },
	});

	// @ts-expect-error - missing required column "address.city"
	db.insert(users, 'name', 'address.street');
	// @ts-expect-error - missing required column "address.city"
	db.insert(users, 'name', 'address.geo');
	// @ts-expect-error - `address` repeats `address.city`
	db.insert(users, 'name', 'address', 'address.city');
	// @ts-expect-error - `address` repeats `address.geo`
	db.insert(users, 'name', 'address', 'address.geo');
	// @ts-expect-error - not a column or an embed() group
	db.insert(users, 'name', 'address', 'nope');

	// @ts-expect-error - `city` is required in the group
	db.insert(users, 'name', 'address').values({ name: 'Ada', address: { street: 'Main' } });
	// @ts-expect-error - `note` is not included in the column selection
	db.insert(users, 'name', 'address').values({ name: 'Ada', address: { city: 'Berlin' }, note: { body: 'x' } });
	// @ts-expect-error - `street` is not included in the column selection
	db.insert(users, 'name', 'address.city', 'address.geo').values({
		name: 'Ada',
		address: { city: 'Berlin', street: 'Main', geo: { lat: 1 } },
	});

	db.insert(users, 'name', 'address').select(
		qb.select({ name: users.name, address: { city: users.address.city, geo: { lat: users.address.geo.lat } } })
			.from(users),
	);
	db.insert(users, 'name', 'address').select(
		qb.select({ name: users.name, address: users.address }).from(users),
	);
	db.insert(users, 'name', 'address.city', 'address.geo').select(
		qb.select({ name: users.name, address: { city: users.address.city, geo: { lat: users.address.geo.lat } } })
			.from(users),
	);
	db.insert(users, 'name', 'address').select(
		// @ts-expect-error - `note` is not included in the insert column selection
		qb.select({ name: users.name, address: { city: users.address.city }, note: { body: users.note.body } }).from(
			users,
		),
	);
	db.insert(users, 'name', 'address.city', 'address.geo').select(
		// @ts-expect-error - `address.street` is not included in the insert column selection
		qb.select({
			name: users.name,
			address: { city: users.address.city, street: users.address.street },
		}).from(users),
	);
}
