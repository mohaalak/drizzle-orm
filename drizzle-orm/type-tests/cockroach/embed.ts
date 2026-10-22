import type { Equal } from 'type-tests/utils.ts';
import { Expect } from 'type-tests/utils.ts';
import { type CockroachColumn, cockroachTable, embed, int4, text } from '~/cockroach-core/index.ts';
import { eq } from '~/sql/expressions/index.ts';
import type { InferInsertModel, InferSelectModel } from '~/table.ts';
import { db } from './db.ts';

const users = cockroachTable('users_embed', {
	id: int4().primaryKey().generatedByDefaultAsIdentity(),
	name: text().notNull(),
	address: embed({
		street: text(),
		city: text().notNull(),
		geo: embed({ lat: int4(), lng: int4() }),
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
Expect<Equal<typeof users.address.city extends CockroachColumn ? true : false, true>>();
Expect<Equal<typeof users.address.geo.lat extends CockroachColumn ? true : false, true>>();
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
	const other = cockroachTable('other_embed', {
		id: int4().primaryKey().generatedByDefaultAsIdentity(),
		userId: int4(),
	});
	const rows = await db.select().from(other).leftJoin(users, eq(other.userId, users.id));
	Expect<Equal<typeof rows, { other_embed: { id: number; userId: number | null }; users_embed: User | null }[]>>();
}

{
	db.insert(users).values({ name: 'Ada', address: { city: 'Berlin' } }).onConflictDoUpdate({
		target: users.id,
		set: { address: { geo: { lat: 1 } }, note: null },
	});
	db.insert(users).values({ name: 'Ada', address: { city: 'Berlin' } }).onConflictDoUpdate({
		target: users.id,
		// @ts-expect-error - not a column of the group
		set: { address: { country: 'DE' } },
	});
}

{
	// `delete` and `insert` returning take flat selections: columns inside a group, not the group itself.
	const rows = await db.delete(users).returning({ city: users.address.city, lat: users.address.geo.lat });
	Expect<Equal<typeof rows, { city: string; lat: number | null }[]>>();
	const all = await db.delete(users).returning();
	Expect<Equal<typeof all, User[]>>();
}

{
	const other = cockroachTable('other_embed', { id: int4().primaryKey(), city: text() });
	db.update(users).set({ name: 'x' }).from(other).where(eq(users.address.city, other.city));
	const rows = await db.update(users).set({ name: 'x' }).from(other).returning({ city: users.address.city });
	Expect<Equal<typeof rows, { city: string }[]>>();
	db.update(users).set({ name: 'x' }).from(other).returning();
}
