import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { type AnyPgColumn, embed, integer, pgTable, serial, taggedUnion, text } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/pglite';
import { expect, test } from 'vitest';
import { seed } from '../../../src/index.ts';

const files = pgTable('files', {
	id: serial().primaryKey(),
	name: text().notNull(),
	uploader: taggedUnion('kind', text(), {
		staff: { staffId: integer().notNull(), note: text() },
		parent: {
			parentId: integer('uploader_parent').notNull(),
			via: taggedUnion('channel', text(), {
				app: { version: text().notNull() },
				email: { address: text().notNull() },
			}),
		},
		system: {},
	}),
	meta: embed({
		owner: taggedUnion('kind', text(), {
			team: { teamId: integer().notNull() },
			nobody: {},
		}),
	}),
});

const owners = pgTable('owners', {
	id: serial().primaryKey(),
	owner: taggedUnion('kind', text(), {
		classroom: { campusId: integer().notNull(), classroomId: integer().notNull() },
		campus: { campusId: integer().notNull() },
		nobody: {},
	}),
});

const prepare = async () => {
	const db = drizzle({ client: new PGlite() });
	await db.execute(sql`
		create table files (
			id serial primary key,
			name text not null,
			uploader_kind text not null,
			"uploader_staffId" integer,
			uploader_note text,
			uploader_parent integer,
			uploader_via_channel text,
			uploader_via_version text,
			uploader_via_address text,
			meta_owner_kind text not null,
			"meta_owner_teamId" integer
		)
	`);
	await db.execute(sql`
		create table owners (
			id serial primary key,
			owner_kind text not null,
			"owner_campusId" integer,
			"owner_classroomId" integer
		)
	`);
	return db;
};

type Row = Record<string, unknown>;

test('seeds one valid variant per row, spread over the variants', async () => {
	const db = await prepare();
	await seed(db, { files }, { count: 60 });

	const rows = (await db.execute(sql`select * from files`)).rows as Row[];
	expect(rows).toHaveLength(60);

	const seen = new Set<string>();
	for (const row of rows) {
		const kind = row['uploader_kind'] as string;
		seen.add(kind);

		// every column the variant does not have is empty, and the ones it declared not null are filled
		expect(row['uploader_staffId'] === null).toBe(kind !== 'staff');
		expect(row['uploader_note'] === null || kind === 'staff').toBe(true);
		expect(row['uploader_parent'] === null).toBe(kind !== 'parent');

		// the union nested in the parent variant
		const channel = row['uploader_via_channel'] as string | null;
		if (kind === 'parent') {
			expect(['app', 'email']).toContain(channel);
			expect(row['uploader_via_version'] === null).toBe(channel !== 'app');
			expect(row['uploader_via_address'] === null).toBe(channel !== 'email');
		} else {
			expect(channel).toBeNull();
			expect(row['uploader_via_version']).toBeNull();
			expect(row['uploader_via_address']).toBeNull();
		}

		// a union inside an embed group
		const owner = row['meta_owner_kind'] as string;
		expect(['team', 'nobody']).toContain(owner);
		expect(row['meta_owner_teamId'] === null).toBe(owner === 'nobody');
	}
	expect(seen).toEqual(new Set(['staff', 'parent', 'system']));
});

test('rows read back as the variant they hold', async () => {
	const db = await prepare();
	await seed(db, { files }, { count: 30 });

	for (const row of await db.select().from(files)) {
		if (row.uploader.kind === 'staff') expect(typeof row.uploader.staffId).toBe('number');
		if (row.uploader.kind === 'parent') {
			expect(typeof row.uploader.parentId).toBe('number');
			expect(['app', 'email']).toContain(row.uploader.via.channel);
		}
	}
});

test('a column shared by variants is filled only in the variants that declare it', async () => {
	const db = await prepare();
	await seed(db, { owners }, { count: 60 });

	const rows = (await db.execute(sql`select * from owners`)).rows as Row[];
	expect(new Set(rows.map((row) => row['owner_kind']))).toEqual(new Set(['classroom', 'campus', 'nobody']));
	for (const row of rows) {
		const kind = row['owner_kind'];
		expect(row['owner_campusId'] === null).toBe(kind === 'nobody');
		expect(row['owner_classroomId'] === null).toBe(kind !== 'classroom');
	}
});

test('refines a variant column with nested keys, and leaves the other variants empty', async () => {
	const db = await prepare();
	await seed(db, { files }, { count: 40 }).refine((funcs) => ({
		files: {
			columns: {
				uploader: {
					staff: { staffId: funcs.valuesFromArray({ values: [7, 8] }), note: funcs.default({ defaultValue: 'hi' }) },
				},
			},
		},
	}));

	const rows = (await db.execute(sql`select * from files`)).rows as Row[];
	const staff = rows.filter((row) => row['uploader_kind'] === 'staff');
	expect(staff.length).toBeGreaterThan(0);
	for (const row of staff) {
		expect([7, 8]).toContain(row['uploader_staffId']);
		expect(row['uploader_note']).toBe('hi');
	}
	for (const row of rows) {
		if (row['uploader_kind'] !== 'staff') {
			expect(row['uploader_staffId']).toBeNull();
			expect(row['uploader_note']).toBeNull();
		}
	}
});

test('refines a shared column on the union', async () => {
	const db = await prepare();
	await seed(db, { owners }, { count: 30 }).refine((funcs) => ({
		owners: { columns: { owner: { campusId: funcs.default({ defaultValue: 3 }) } } },
	}));

	for (const row of (await db.execute(sql`select * from owners`)).rows as Row[]) {
		expect(row['owner_campusId']).toBe(row['owner_kind'] === 'nobody' ? null : 3);
	}
});

test('a values generator on the tag restricts the variants that are produced', async () => {
	const db = await prepare();
	await seed(db, { files }, { count: 40 }).refine((funcs) => ({
		files: {
			columns: {
				uploader: { kind: funcs.valuesFromArray({ values: ['staff', 'system'] }) },
				meta: { owner: { kind: funcs.valuesFromArray({ values: ['nobody'] }) } },
			},
		},
	}));

	const rows = (await db.execute(sql`select * from files`)).rows as Row[];
	expect(new Set(rows.map((row) => row['uploader_kind']))).toEqual(new Set(['staff', 'system']));
	for (const row of rows) {
		expect(row['uploader_parent']).toBeNull();
		expect(row['uploader_via_channel']).toBeNull();
		expect(row['meta_owner_kind']).toBe('nobody');
		expect(row['meta_owner_teamId']).toBeNull();
	}
});

test('union columns can also be refined by their dotted keys', async () => {
	const db = await prepare();
	await seed(db, { owners }, { count: 30 }).refine((funcs) => ({
		owners: { columns: { 'owner.campusId': funcs.default({ defaultValue: 5 }) } as never },
	}));

	for (const row of (await db.execute(sql`select * from owners`)).rows as Row[]) {
		expect(row['owner_campusId']).toBe(row['owner_kind'] === 'nobody' ? null : 5);
	}
});

test('a tag given a value that is no variant is rejected', async () => {
	const db = await prepare();
	await expect(
		seed(db, { owners }, { count: 5 }).refine((funcs) => ({
			owners: { columns: { owner: { kind: funcs.valuesFromArray({ values: ['galaxy'] }) } } },
		})),
	).rejects.toThrow("'owner.kind' column in the 'owners' table was given 'galaxy'");
});

test('a variant column declared not null cannot be refined to false', async () => {
	const db = await prepare();
	await expect(
		seed(db, { files }, { count: 5 }).refine(() => ({
			files: { columns: { uploader: { staff: { staffId: false } } } },
		})),
	).rejects.toThrow("'uploader.staff.staffId' column in the 'files' table");

	// a nullable one can
	await seed(db, { files }, { count: 5 }).refine(() => ({
		files: { columns: { uploader: { staff: { note: false } } } },
	}));
	const rows = (await db.execute(sql`select * from files`)).rows as Row[];
	expect(rows.every((row) => row['uploader_note'] === null)).toBe(true);
});

test('dryRun hands union rows back nested, one variant each', async () => {
	const db = await prepare();
	const data = await seed(db, { owners }, { count: 30 }).dryRun();

	for (const row of data.owners) {
		if (row.owner.kind === 'nobody') {
			expect(row.owner).toEqual({ kind: 'nobody' });
		} else if (row.owner.kind === 'campus') {
			expect(Object.keys(row.owner).sort()).toEqual(['campusId', 'kind']);
			expect(typeof row.owner.campusId).toBe('number');
		} else {
			expect(Object.keys(row.owner).sort()).toEqual(['campusId', 'classroomId', 'kind']);
			expect(typeof row.owner.classroomId).toBe('number');
		}
	}
});

test('a self-referencing union table is seeded', async () => {
	const nodes = pgTable('nodes', {
		id: serial().primaryKey(),
		link: taggedUnion('kind', text(), {
			child: { parentId: integer().references((): AnyPgColumn => nodes.id) },
			root: {},
		}),
	});
	const db = drizzle({ client: new PGlite() });
	await db.execute(sql`
		create table nodes (
			id serial primary key,
			link_kind text not null,
			"link_parentId" integer references nodes (id)
		)
	`);

	await seed(db, { nodes }, { count: 30 });

	const rows = (await db.execute(sql`select * from nodes`)).rows as Row[];
	expect(rows).toHaveLength(30);
	for (const row of rows) {
		if (row['link_kind'] === 'root') expect(row['link_parentId']).toBeNull();
	}
});

test('tables referencing each other through union variants are seeded, the second pass included', async () => {
	const a = pgTable('a', {
		id: serial().primaryKey(),
		ref: taggedUnion('kind', text(), {
			link: { bId: integer().references((): AnyPgColumn => b.id) },
			none: {},
		}),
	});
	const b = pgTable('b', {
		id: serial().primaryKey(),
		aId: integer().notNull().references((): AnyPgColumn => a.id),
	});
	const db = drizzle({ client: new PGlite() });
	await db.execute(sql`create table a (id serial primary key, ref_kind text not null, "ref_bId" integer)`);
	await db.execute(sql`create table b (id serial primary key, "aId" integer not null references a (id))`);
	await db.execute(sql`alter table a add foreign key ("ref_bId") references b (id)`);

	await seed(db, { a, b }, { count: 30 });

	const rows = (await db.execute(sql`select * from a`)).rows as Row[];
	expect(rows).toHaveLength(30);
	expect(rows.some((row) => row['ref_kind'] === 'link' && row['ref_bId'] !== null)).toBe(true);
	for (const row of rows) {
		if (row['ref_kind'] === 'none') expect(row['ref_bId']).toBeNull();
	}
});
