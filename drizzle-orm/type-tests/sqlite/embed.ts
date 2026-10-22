import type { Equal } from 'type-tests/utils.ts';
import { Expect } from 'type-tests/utils.ts';
import { eq } from '~/sql/expressions/index.ts';
import { embed, index, integer, type SQLiteColumn, sqliteTable, text } from '~/sqlite-core/index.ts';
import type { InferSelectModel } from '~/table.ts';
import { d1Db, db } from './db.ts';

const users = sqliteTable('users_embed', {
	id: integer().primaryKey({ autoIncrement: true }),
	name: text().notNull(),
	address: embed({
		street: text(),
		city: text().notNull(),
		geo: embed({ lat: integer(), lng: integer() }),
	}),
	note: embed({ body: text() }),
}, (t) => [
	// Groups are reachable in the extra config, too.
	index('users_embed_city_idx').on(t.address.city, t.address.geo.lat),
]);

type Address = {
	street: string | null;
	city: string;
	geo: { lat: number | null; lng: number | null };
};
type User = { id: number; name: string; address: Address; note: { body: string | null } };

// Groups are reached as nested columns.
Expect<Equal<typeof users.address.city extends SQLiteColumn ? true : false, true>>();
Expect<Equal<typeof users.address.geo.lat extends SQLiteColumn ? true : false, true>>();
// @ts-expect-error - the flat key is not a property of the table
users['address.city'];

Expect<Equal<typeof users.$inferSelect, User>>();
Expect<Equal<InferSelectModel<typeof users>, User>>();

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
	const rows = db.select().from(users).where(eq(users.address.city, 'Berlin')).all();
	Expect<Equal<typeof rows, User[]>>();
}

{
	const rows = db.select({ address: users.address, lat: users.address.geo.lat }).from(users).all();
	Expect<Equal<typeof rows, { address: Address; lat: number | null }[]>>();
}

{
	const rows = db.insert(users).values({ name: 'Ada', address: { city: 'Berlin' } }).returning().all();
	Expect<Equal<typeof rows, User[]>>();
}

{
	// @ts-expect-error - `city` is required in the group
	db.insert(users).values({ name: 'Ada', address: { street: 'Main St' } });
	// @ts-expect-error - the group is required
	db.insert(users).values({ name: 'Ada' });
}

{
	const rows = db.insert(users).values({ name: 'Ada', address: { city: 'Berlin' } })
		.onConflictDoUpdate({ target: users.id, set: { address: { geo: null } } })
		.returning()
		.all();
	Expect<Equal<typeof rows, User[]>>();
	db.insert(users).values({ name: 'Ada', address: { city: 'Berlin' } })
		// @ts-expect-error - not a column of the group
		.onConflictDoUpdate({ target: users.id, set: { address: { country: 'DE' } } });
}

{
	const rows = db.update(users).set({ address: { geo: { lat: 1 } } }).returning().all();
	Expect<Equal<typeof rows, User[]>>();
	// @ts-expect-error - not a column of the group
	db.update(users).set({ address: { country: 'DE' } });
	// Writing `null` to a group clears every column in it.
	db.update(users).set({ note: null, address: { geo: null } });
}

{
	const rows = db.delete(users).returning().all();
	Expect<Equal<typeof rows, User[]>>();
}

{
	const other = sqliteTable('other_embed', { id: integer().primaryKey(), userId: integer() });
	const rows = db.select().from(other).leftJoin(users, eq(other.userId, users.id)).all();
	Expect<Equal<typeof rows, { other_embed: { id: number; userId: number | null }; users_embed: User | null }[]>>();
}

{
	// Async drivers resolve to the same nested rows.
	const rows = await d1Db.select().from(users);
	Expect<Equal<typeof rows, User[]>>();
}
