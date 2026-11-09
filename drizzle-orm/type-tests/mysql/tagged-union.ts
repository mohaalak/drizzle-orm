import type { Equal } from 'type-tests/utils.ts';
import { Expect } from 'type-tests/utils.ts';
import { alias, embed, int, type MySqlColumn, mysqlTable, serial, taggedUnion, text } from '~/mysql-core/index.ts';
import { drizzle } from '~/mysql2/index.ts';
import { defineRelations } from '~/relations.ts';
import { eq } from '~/sql/expressions/index.ts';
import type { InferInsertModel, InferSelectModel } from '~/table.ts';
import { db } from './db.ts';

const files = mysqlTable('files_tagged_union', {
	id: serial().primaryKey(),
	uploader: taggedUnion('kind', text(), {
		staff: { staffId: int().notNull(), note: text() },
		parent: {
			parentId: int().notNull(),
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
Expect<Equal<typeof files.uploader.kind extends MySqlColumn ? true : false, true>>();
Expect<Equal<typeof files.uploader.staff.staffId extends MySqlColumn ? true : false, true>>();
Expect<Equal<typeof files.uploader.parent.via.email.address extends MySqlColumn ? true : false, true>>();
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
	const rows = await db.select({
		uploader: files.uploader,
		staff: files.uploader.staff,
		staffId: files.uploader.staff.staffId,
	}).from(files);
	// Outside the whole union a variant's columns read as the database stores them: null in other variants' rows.
	Expect<
		Equal<typeof rows, {
			uploader: Uploader;
			staff: { staffId: number | null; note: string | null };
			staffId: number | null;
		}[]>
	>();
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
	// A union column is not a primary key, so `$returningId()` stays the key.
	const ids = await db.insert(files).values({ uploader: { kind: 'staff', staffId: 1 } }).$returningId();
	Expect<Equal<typeof ids, { id: number }[]>>();

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

	// A query passed straight to a generic function is inferred from it without exceeding the instantiation depth.
	const identity = <T>(value: T): T => value;
	const passed = identity(await rqb.query.files.findFirst({ columns: { id: true }, where: { id: 1 } }));
	Expect<Equal<typeof passed, { id: number } | undefined>>();
	const passedUnion = identity(await rqb.query.files.findFirst({ columns: { uploader: true } }));
	Expect<Equal<typeof passedUnion, { uploader: Uploader } | undefined>>();
}

{
	// A `where` on a union's tag narrows the row to the variants it admits.
	const relations = defineRelations({ files });
	const rqb = drizzle.mock({ relations });
	type Staff = Extract<Uploader, { kind: 'staff' }>;
	type Parent = Extract<Uploader, { kind: 'parent' }>;

	const staff = await rqb.query.files.findFirst({ where: { id: 1, uploader: { kind: 'staff' } } });
	Expect<Equal<typeof staff, { id: number; uploader: Staff; meta: { label: string | null } } | undefined>>();

	const viaEq = await rqb.query.files.findMany({ where: { uploader: { kind: { eq: 'system' } } } });
	Expect<Equal<typeof viaEq[number]['uploader'], { kind: 'system' }>>();

	const viaIn = await rqb.query.files.findMany({ where: { uploader: { kind: { in: ['staff', 'system'] } } } });
	Expect<Equal<typeof viaIn[number]['uploader'], Staff | { kind: 'system' }>>();

	const picked = await rqb.query.files.findFirst({
		columns: { uploader: true },
		where: { uploader: { kind: 'staff' } },
	});
	Expect<Equal<typeof picked, { uploader: Staff } | undefined>>();

	// A union nested in a variant is filtered under the variant's name, and narrows the same way.
	const viaApp = await rqb.query.files.findFirst({
		where: { uploader: { kind: 'parent', parent: { via: { channel: 'app' } } } },
	});
	Expect<
		Equal<
			NonNullable<typeof viaApp>['uploader'],
			{ kind: 'parent'; parentId: number; via: { channel: 'app'; version: string } }
		>
	>();
	const anyParent = await rqb.query.files.findFirst({ where: { uploader: { kind: 'parent' } } });
	Expect<Equal<NonNullable<typeof anyParent>['uploader'], Parent>>();

	// Filters that do not pin the tag leave the union whole.
	const notStaff = await rqb.query.files.findFirst({ where: { uploader: { kind: { ne: 'staff' } } } });
	Expect<Equal<NonNullable<typeof notStaff>['uploader'], Uploader>>();
	const byColumn = await rqb.query.files.findFirst({ where: { uploader: { staff: { staffId: 1 } } } });
	Expect<Equal<NonNullable<typeof byColumn>['uploader'], Uploader>>();
	const none = await rqb.query.files.findFirst({ where: { id: 1 } });
	Expect<Equal<typeof none, File | undefined>>();

	// A relation's `where` narrows the related rows.
	const users = mysqlTable('users_tagged_union_narrow', { id: serial().primaryKey() });
	const withFiles = defineRelations({ files, users }, (r) => ({
		users: { files: r.many.files({ from: r.users.id, to: r.files.id }) },
	}));
	const rqbWith = drizzle.mock({ relations: withFiles });
	const user = await rqbWith.query.users.findFirst({
		with: { files: { where: { uploader: { kind: 'staff' } } } },
	});
	Expect<Equal<NonNullable<typeof user>['files'][number]['uploader'], Staff>>();
}

{
	const owners = mysqlTable('owners_tagged_union', {
		id: serial().primaryKey(),
		owner: taggedUnion('kind', text(), {
			classroom: { campusId: int().notNull(), classroomId: int().notNull() },
			campus: { campusId: int().notNull() },
			staff: { campusId: int(), staffId: int().notNull() },
			nobody: {},
		}),
		region: taggedUnion('kind', text(), {
			north: { code: text().notNull() },
			south: { code: text().notNull() },
		}),
	});

	type Owner =
		| { kind: 'classroom'; campusId: number; classroomId: number }
		| { kind: 'campus'; campusId: number }
		| { kind: 'staff'; campusId: number | null; staffId: number }
		| { kind: 'nobody' };
	type Region = { kind: 'north'; code: string } | { kind: 'south'; code: string };

	// A shared column is reached on the union, and is NOT NULL only when every variant declares it so.
	Expect<Equal<typeof owners.owner.campusId['_']['notNull'], false>>();
	Expect<Equal<typeof owners.region.code['_']['notNull'], true>>();
	// @ts-expect-error - a shared column is not a column of a variant
	owners.owner.campus.campusId;

	Expect<Equal<typeof owners.$inferSelect, { id: number; owner: Owner; region: Region }>>();
	Expect<
		Equal<
			typeof owners.$inferInsert['owner'],
			| { kind: 'classroom'; campusId: number; classroomId: number }
			| { kind: 'campus'; campusId: number }
			| { kind: 'staff'; staffId: number; campusId?: number | null | undefined }
			| { kind: 'nobody' }
		>
	>();

	const rows = await db.select({ owner: owners.owner, campusId: owners.owner.campusId }).from(owners);
	Expect<Equal<typeof rows, { owner: Owner; campusId: number | null }[]>>();

	db.update(owners).set({ owner: { kind: 'campus', campusId: 1 } });
	db.insert(owners).values({ owner: { kind: 'nobody' }, region: { kind: 'north', code: 'n' } });
	// @ts-expect-error - the nobody variant does not have a campusId
	db.insert(owners).values({ owner: { kind: 'nobody', campusId: 1 }, region: { kind: 'north', code: 'n' } });
}
