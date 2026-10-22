import type { Equal } from 'type-tests/utils.ts';
import { Expect } from 'type-tests/utils.ts';
import {
	embed,
	int,
	serial,
	type SingleStoreColumn,
	singlestoreTable,
	text,
	varchar,
} from '~/singlestore-core/index.ts';
import { eq } from '~/sql/expressions/index.ts';
import type { InferSelectModel } from '~/table.ts';
import { db } from './db.ts';

const users = singlestoreTable('users_embed', {
	id: serial().primaryKey(),
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
Expect<Equal<typeof users.address.city extends SingleStoreColumn ? true : false, true>>();
Expect<Equal<typeof users.address.geo.lat extends SingleStoreColumn ? true : false, true>>();
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
	db.insert(users).values({ name: 'Ada', address: { city: 'Berlin' } });
	const ids = await db.insert(users).values({ name: 'Ada', address: { city: 'Berlin' } }).$returningId();
	Expect<Equal<typeof ids, { id: number }[]>>();
	// @ts-expect-error - `city` is required in the group
	db.insert(users).values({ name: 'Ada', address: { street: 'Main St' } });
	// @ts-expect-error - the group is required
	db.insert(users).values({ name: 'Ada' });
}

{
	db.insert(users).values({ name: 'Ada', address: { city: 'Berlin' } }).onDuplicateKeyUpdate({
		set: { address: { geo: { lat: 1 } }, note: null },
	});
	db.insert(users).values({ name: 'Ada', address: { city: 'Berlin' } }).onDuplicateKeyUpdate({
		// @ts-expect-error - not a column of the group
		set: { address: { country: 'DE' } },
	});
}

{
	db.update(users).set({ address: { geo: { lat: 1 } } });
	// @ts-expect-error - not a column of the group
	db.update(users).set({ address: { country: 'DE' } });
	// Writing `null` to a group clears every column in it.
	db.update(users).set({ note: null, address: { geo: null } });
}

{
	db.update(users).set({ name: 'x' }).orderBy((t) => t.address.city);
	db.delete(users).orderBy((t) => t.address.city);
}

{
	const other = singlestoreTable('other_embed', { id: serial().primaryKey(), userId: int() });
	const rows = await db.select().from(other).leftJoin(users, eq(other.userId, users.id));
	Expect<Equal<typeof rows, { other_embed: { id: number; userId: number | null }; users_embed: User | null }[]>>();
}

// `$returningId()` nests a primary key that lives inside an embed() group. A flat key stays flat.
{
	const grouped = singlestoreTable('embed_returning_serial', {
		name: text().notNull(),
		id: embed({ value: serial().primaryKey() }),
	});
	const ids = await db.insert(grouped).values({ name: 'Ada' }).$returningId();
	Expect<Equal<typeof ids, { id: { value: number } }[]>>();
}

{
	const grouped = singlestoreTable('embed_returning_default', {
		name: text().notNull(),
		id: embed({
			uuid: varchar({ length: 36 }).primaryKey().$defaultFn(() => 'k'),
		}),
	});
	const ids = await db.insert(grouped).values({ name: 'Ada' }).$returningId();
	Expect<Equal<typeof ids, { id: { uuid: string } }[]>>();
}

{
	const grouped = singlestoreTable('embed_returning_deep', {
		meta: embed({ id: embed({ value: serial().primaryKey() }) }),
	});
	const ids = await db.insert(grouped).values({}).$returningId();
	Expect<Equal<typeof ids, { meta: { id: { value: number } } }[]>>();
}

{
	const grouped = singlestoreTable('embed_returning_mixed', {
		id: serial().primaryKey(),
		key: embed({
			uuid: varchar({ length: 36 }).primaryKey().$defaultFn(() => 'k'),
		}),
	});
	const ids = await db.insert(grouped).values({}).$returningId();
	Expect<Equal<typeof ids, { id: number; key: { uuid: string } }[]>>();
}

// A column list can name an embed() group. The group stands for every column in it.
{
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
}
