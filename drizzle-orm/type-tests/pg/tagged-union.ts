import type { Equal } from 'type-tests/utils.ts';
import { Expect } from 'type-tests/utils.ts';
import { drizzle } from '~/node-postgres/index.ts';
import { alias, embed, integer, type PgColumn, pgTable, serial, taggedUnion, text } from '~/pg-core/index.ts';
import { defineRelations } from '~/relations.ts';
import { eq } from '~/sql/expressions/index.ts';
import type { InferInsertModel, InferSelectModel } from '~/table.ts';
import { db } from './db.ts';

const files = pgTable('files_tagged_union', {
	id: serial().primaryKey(),
	uploader: taggedUnion('kind', text(), {
		staff: { staffId: integer().notNull(), note: text() },
		parent: {
			parentId: integer().notNull(),
			via: taggedUnion('channel', text(), {
				app: { version: text().notNull() },
				email: { address: text().notNull() },
			}),
		},
		system: {},
	}),
	meta: embed({ label: text() }),
});

type Via = { channel: 'app'; version: string } | { channel: 'email'; address: string };
type Uploader =
	| { kind: 'staff'; staffId: number; note: string | null }
	| { kind: 'parent'; parentId: number; via: Via }
	| { kind: 'system' };
type File = { id: number; uploader: Uploader; meta: { label: string | null } };

// The tag and each variant's columns are reached as nested columns.
Expect<Equal<typeof files.uploader.kind extends PgColumn ? true : false, true>>();
Expect<Equal<typeof files.uploader.staff.staffId extends PgColumn ? true : false, true>>();
Expect<Equal<typeof files.uploader.parent.via.email.address extends PgColumn ? true : false, true>>();
Expect<Equal<typeof files.uploader.kind['_']['data'], 'staff' | 'parent' | 'system'>>();

Expect<Equal<typeof files.$inferSelect, File>>();
Expect<Equal<InferSelectModel<typeof files>, File>>();
Expect<
	Equal<typeof files.$inferInsert, {
		uploader:
			| { kind: 'staff'; staffId: number; note?: string | null | undefined }
			| {
				kind: 'parent';
				parentId: number;
				via: { channel: 'app'; version: string } | { channel: 'email'; address: string };
			}
			| { kind: 'system' };
		id?: number | undefined;
		meta?: { label?: string | null | undefined } | undefined;
	}>
>();
Expect<Equal<InferInsertModel<typeof files>, typeof files.$inferInsert>>();

{
	const rows = await db.select().from(files).where(eq(files.uploader.kind, 'staff'));
	Expect<Equal<typeof rows, File[]>>();
	const row = rows[0]!;
	if (row.uploader.kind === 'staff') Expect<Equal<typeof row.uploader.staffId, number>>();
}

{
	const rows = await db.select({ uploader: files.uploader, staff: files.uploader.staff }).from(files);
	Expect<Equal<typeof rows, { uploader: Uploader; staff: { staffId: number; note: string | null } }[]>>();
}

{
	const other = alias(files, 'other');
	const rows = await db.select({ uploader: files.uploader, other: other.uploader }).from(files).leftJoin(
		other,
		eq(files.id, other.id),
	);
	// A union read from a left-joined table is null when no row matched.
	Expect<Equal<typeof rows, { uploader: Uploader; other: Uploader | null }[]>>();
}

{
	const rows = await db.insert(files).values({ uploader: { kind: 'staff', staffId: 1 } }).returning();
	Expect<Equal<typeof rows, File[]>>();

	db.insert(files).values({ uploader: { kind: 'system' } });
	db.insert(files).values({ uploader: { kind: 'parent', parentId: 1, via: { channel: 'app', version: '1' } } });
	// @ts-expect-error - a staff uploader needs its staffId
	db.insert(files).values({ uploader: { kind: 'staff' } });
	// @ts-expect-error - staffId is not a column of the system variant
	db.insert(files).values({ uploader: { kind: 'system', staffId: 1 } });
	// @ts-expect-error - not a variant
	db.insert(files).values({ uploader: { kind: 'robot' } });
	// @ts-expect-error - the union is required
	db.insert(files).values({});
}

{
	db.update(files).set({ uploader: { kind: 'system' } });
	db.update(files).set({ uploader: { kind: 'staff', note: 'renamed' } });
	// @ts-expect-error - the tag picks the variant being written
	db.update(files).set({ uploader: { staffId: 1 } });
	// @ts-expect-error - a union cannot be cleared
	db.update(files).set({ uploader: null });
}

{
	const relations = defineRelations({ files });
	const rqb = drizzle.mock({ relations });

	const full = await rqb.query.files.findFirst();
	Expect<Equal<typeof full, File | undefined>>();

	const picked = await rqb.query.files.findFirst({ columns: { uploader: true } });
	Expect<Equal<typeof picked, { uploader: Uploader } | undefined>>();
}
