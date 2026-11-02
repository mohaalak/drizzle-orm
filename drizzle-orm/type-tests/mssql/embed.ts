import type { Equal } from 'type-tests/utils.ts';
import { Expect } from 'type-tests/utils.ts';
import { alias, embed, int, type MsSqlColumn, mssqlTable, QueryBuilder, text } from '~/mssql-core/index.ts';
import { eq } from '~/sql/expressions/index.ts';
import type { InferSelectModel } from '~/table.ts';
import { db } from './db.ts';

const users = mssqlTable('users_embed', {
	id: int().primaryKey().identity(),
	name: text().notNull(),
	address: embed({
		street: text(),
		city: text().notNull(),
		geo: embed({ lat: int(), lng: int() }),
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
Expect<Equal<typeof users.address.city extends MsSqlColumn ? true : false, true>>();
Expect<Equal<typeof users.address.geo.lat extends MsSqlColumn ? true : false, true>>();
// @ts-expect-error - the flat key is not a property of the table
users['address.city'];

Expect<Equal<typeof users.$inferSelect, User>>();
Expect<Equal<InferSelectModel<typeof users>, User>>();

// A group is required on insert when any column in it is; one whose columns are all optional may be left out.
// Identity columns are generated, so `id` is not part of the insert model.
Expect<
	Equal<typeof users.$inferInsert, {
		name: string;
		address: {
			city: string;
			street?: string | null | undefined;
			geo?: { lat?: number | null | undefined; lng?: number | null | undefined } | undefined;
		};
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
	const rows = await db.select({ city: users.address.city }).top(1).from(users);
	Expect<Equal<typeof rows, { city: string }[]>>();
}

{
	db.insert(users).values({ name: 'Ada', address: { city: 'Berlin' } });
	// @ts-expect-error - `city` is required in the group
	db.insert(users).values({ name: 'Ada', address: { street: 'Main St' } });
	// @ts-expect-error - the group is required
	db.insert(users).values({ name: 'Ada' });

	const all = await db.insert(users).output().values({ name: 'Ada', address: { city: 'Berlin' } });
	Expect<Equal<typeof all, User[]>>();
	const some = await db.insert(users).output({ city: users.address.city, lat: users.address.geo.lat }).values({
		name: 'Ada',
		address: { city: 'Berlin' },
	});
	Expect<Equal<typeof some, { city: string; lat: number | null }[]>>();

	const grouped = await db.insert(users).output({
		name: users.name,
		address: users.address,
		geo: users.address.geo,
	}).values({ name: 'Ada', address: { city: 'Berlin' } });
	Expect<Equal<typeof grouped, { name: string; address: Address; geo: Address['geo'] }[]>>();

	const partial = await db.insert(users).output({
		address: { city: users.address.city, geo: users.address.geo },
	}).values({ name: 'Ada', address: { city: 'Berlin' } });
	Expect<Equal<typeof partial, { address: { city: string; geo: Address['geo'] } }[]>>();
}

{
	db.update(users).set({ address: { geo: { lat: 1 } } });
	// @ts-expect-error - not a column of the group
	db.update(users).set({ address: { country: 'DE' } });
	// Writing `null` to a group clears every column in it.
	db.update(users).set({ note: null, address: { geo: null } });

	const all = await db.update(users).set({ name: 'x' }).output();
	Expect<Equal<typeof all, User[]>>();
	const both = await db.update(users).set({ name: 'x' }).output({
		inserted: { city: users.address.city },
		deleted: { lat: users.address.geo.lat },
	});
	Expect<Equal<typeof both, { inserted: { city: string }; deleted: { lat: number | null } }[]>>();
	const inserted = await db.update(users).set({ name: 'x' }).output({ inserted: true });
	Expect<Equal<typeof inserted, { inserted: User }[]>>();

	const grouped = await db.update(users).set({ name: 'x' }).output({
		inserted: { address: users.address, name: users.name },
		deleted: { geo: users.address.geo },
	});
	Expect<
		Equal<typeof grouped, { inserted: { address: Address; name: string }; deleted: { geo: Address['geo'] } }[]>
	>();

	const cleared = await db.update(users).set({ name: 'x' }).output({
		inserted: { address: users.address },
		deleted: true,
	});
	Expect<Equal<typeof cleared, { inserted: { address: Address }; deleted: User }[]>>();
}

{
	const all = await db.delete(users).output();
	Expect<Equal<typeof all, User[]>>();
	const some = await db.delete(users).output({ city: users.address.city });
	Expect<Equal<typeof some, { city: string }[]>>();
	const grouped = await db.delete(users).output({ name: users.name, address: users.address, geo: users.address.geo });
	Expect<Equal<typeof grouped, { name: string; address: Address; geo: Address['geo'] }[]>>();
}

{
	const other = mssqlTable('other_embed', { id: int().primaryKey().identity(), userId: int() });
	const rows = await db.select().from(other).leftJoin(users, eq(other.userId, users.id));
	Expect<Equal<typeof rows, { other_embed: { id: number; userId: number | null }; users_embed: User | null }[]>>();
}

{
	const other = alias(users, 'other');
	const rows = await db.select({ city: other.address.city, lat: other.address.geo.lat }).from(other);
	Expect<Equal<typeof rows, { city: string; lat: number | null }[]>>();
}

// `insert().select()` takes embed() groups nested, the same way `values()` does, and still takes dotted keys.
{
	const qb = new QueryBuilder();
	const src = mssqlTable('src_embed', {
		name: text().notNull(),
		city: text().notNull(),
		lat: int(),
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
	db.insert(users, 'name', 'address.city', 'address.street').select(
		qb.select({ name: src.name, address: { city: src.city } }).from(src),
	);
	db.insert(users, 'name', 'address.city').select(
		// @ts-expect-error - `address.street` is not included in the insert column selection
		qb.select({ name: src.name, address: { city: src.city, street: src.city } }).from(src),
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
