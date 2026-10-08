import type { Equal } from 'type-tests/utils.ts';
import { Expect } from 'type-tests/utils.ts';
import { embed, integer, type PgColumn, pgTable, serial, text } from '~/pg-core/index.ts';
import { eq } from '~/sql/expressions/index.ts';
import type { InferSelectModel } from '~/table.ts';
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
