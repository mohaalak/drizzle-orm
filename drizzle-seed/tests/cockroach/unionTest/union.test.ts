import { sql } from 'drizzle-orm';
import { type AnyCockroachColumn, cockroachTable, embed, int4, taggedUnion, text } from 'drizzle-orm/cockroach-core';
import { describe, expect } from 'vitest';
import { seed } from '../../../src/index.ts';
import { cockroachTest as test } from '../instrumentation.ts';

const files = cockroachTable('union_files', {
	id: int4().primaryKey(),
	name: text().notNull(),
	uploader: taggedUnion('kind', text(), {
		staff: { staffId: int4().notNull(), note: text() },
		parent: {
			parentId: int4('uploader_parent').notNull(),
			via: taggedUnion('channel', text(), {
				app: { version: text().notNull() },
				email: { address: text().notNull() },
			}),
		},
		system: {},
	}),
	meta: embed({
		owner: taggedUnion('kind', text(), {
			team: { teamId: int4().notNull() },
			nobody: {},
		}),
	}),
});

const owners = cockroachTable('union_owners', {
	id: int4().primaryKey(),
	owner: taggedUnion('kind', text(), {
		classroom: { campusId: int4().notNull(), classroomId: int4().notNull() },
		campus: { campusId: int4().notNull() },
		nobody: {},
	}),
});

type Row = Record<string, unknown>;

// the tests need a real database: set COCKROACH_CONNECTION_STRING (`bash compose/dockers.sh up cockroach`), without it they are skipped
describe.skipIf(!process.env['COCKROACH_CONNECTION_STRING'])('seeds taggedUnion() groups', () => {
	test.beforeEach(async ({ db }) => {
		await db.execute(sql`drop table if exists union_files`);
		await db.execute(sql`drop table if exists union_owners`);
		await db.execute(sql.raw(`
			create table union_files (
				id int4 primary key,
				name text not null,
				uploader_kind text not null,
				"uploader_staffId" int4,
				uploader_note text,
				uploader_parent int4,
				uploader_via_channel text,
				uploader_via_version text,
				uploader_via_address text,
				meta_owner_kind text not null,
				"meta_owner_teamId" int4
			)
		`));
		await db.execute(sql.raw(`
			create table union_owners (
				id int4 primary key,
				owner_kind text not null,
				"owner_campusId" int4,
				"owner_classroomId" int4
			)
		`));
	});

	test.afterEach(async ({ db }) => {
		await db.execute(sql`drop table if exists union_files`);
		await db.execute(sql`drop table if exists union_owners`);
	});

	test('seeds one valid variant per row, spread over the variants', async ({ db, client }) => {
		await seed(db, { files }, { count: 60 });

		const rows = await client.query('select * from union_files', []) as Row[];
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

	test('rows read back as the variant they hold', async ({ db }) => {
		await seed(db, { files }, { count: 30 });

		for (const row of await db.select().from(files)) {
			if (row.uploader.kind === 'staff') expect(typeof row.uploader.staffId).toBe('number');
			if (row.uploader.kind === 'parent') {
				expect(typeof row.uploader.parentId).toBe('number');
				expect(['app', 'email']).toContain(row.uploader.via.channel);
			}
		}
	});

	test('a column shared by variants is filled only in the variants that declare it', async ({ db, client }) => {
		await seed(db, { owners }, { count: 60 });

		const rows = await client.query('select * from union_owners', []) as Row[];
		expect(new Set(rows.map((row) => row['owner_kind']))).toEqual(new Set(['classroom', 'campus', 'nobody']));
		for (const row of rows) {
			const kind = row['owner_kind'];
			expect(row['owner_campusId'] === null).toBe(kind === 'nobody');
			expect(row['owner_classroomId'] === null).toBe(kind !== 'classroom');
		}
	});

	test('refines a variant column with nested keys, and leaves the other variants empty', async ({ db, client }) => {
		await seed(db, { files }, { count: 40 }).refine((funcs) => ({
			files: {
				columns: {
					uploader: {
						staff: { staffId: funcs.valuesFromArray({ values: [7, 8] }), note: funcs.default({ defaultValue: 'hi' }) },
					},
				},
			},
		}));

		const rows = await client.query('select * from union_files', []) as Row[];
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

	test('refines a shared column on the union', async ({ db, client }) => {
		await seed(db, { owners }, { count: 30 }).refine((funcs) => ({
			owners: { columns: { owner: { campusId: funcs.default({ defaultValue: 3 }) } } },
		}));

		for (const row of await client.query('select * from union_owners', []) as Row[]) {
			expect(row['owner_campusId']).toBe(row['owner_kind'] === 'nobody' ? null : 3);
		}
	});

	test('a values generator on the tag restricts the variants that are produced', async ({ db, client }) => {
		await seed(db, { files }, { count: 40 }).refine((funcs) => ({
			files: {
				columns: {
					uploader: { kind: funcs.valuesFromArray({ values: ['staff', 'system'] }) },
					meta: { owner: { kind: funcs.valuesFromArray({ values: ['nobody'] }) } },
				},
			},
		}));

		const rows = await client.query('select * from union_files', []) as Row[];
		expect(new Set(rows.map((row) => row['uploader_kind']))).toEqual(new Set(['staff', 'system']));
		for (const row of rows) {
			expect(row['uploader_parent']).toBeNull();
			expect(row['uploader_via_channel']).toBeNull();
			expect(row['meta_owner_kind']).toBe('nobody');
			expect(row['meta_owner_teamId']).toBeNull();
		}
	});

	test('a tag given a value that is no variant is rejected', async ({ db }) => {
		await expect(
			seed(db, { owners }, { count: 5 }).refine((funcs) => ({
				owners: { columns: { owner: { kind: funcs.valuesFromArray({ values: ['galaxy'] }) } } },
			})),
		).rejects.toThrow("'owner.kind' column in the 'owners' table was given 'galaxy'");
	});

	test('a variant column declared not null cannot be refined to false', async ({ db }) => {
		await expect(
			seed(db, { files }, { count: 5 }).refine(() => ({
				files: { columns: { uploader: { staff: { staffId: false } } } },
			})),
		).rejects.toThrow("'uploader.staff.staffId' column in the 'files' table");
	});

	test('dryRun hands union rows back nested, one variant each', async ({ db }) => {
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

	test('a self-referencing union table is seeded', async ({ db, client }) => {
		const nodes = cockroachTable('union_nodes', {
			id: int4().primaryKey(),
			link: taggedUnion('kind', text(), {
				child: { parentId: int4().references((): AnyCockroachColumn => nodes.id) },
				root: {},
			}),
		});
		await db.execute(sql.raw(`
			create table union_nodes (
				id int4 primary key,
				link_kind text not null,
				"link_parentId" int4 references union_nodes (id)
			)
		`));

		try {
			await seed(db, { nodes }, { count: 30 });

			const rows = await client.query('select * from union_nodes', []) as Row[];
			expect(rows).toHaveLength(30);
			for (const row of rows) {
				if (row['link_kind'] === 'root') expect(row['link_parentId']).toBeNull();
			}
		} finally {
			await db.execute(sql`drop table if exists union_nodes`);
		}
	});

	test('tables referencing each other through union variants are seeded, the second pass included', async ({ db, client }) => {
		const a = cockroachTable('union_a', {
			id: int4().primaryKey(),
			ref: taggedUnion('kind', text(), {
				link: { bId: int4().references((): AnyCockroachColumn => b.id) },
				none: {},
			}),
		});
		const b = cockroachTable('union_b', {
			id: int4().primaryKey(),
			aId: int4().notNull().references((): AnyCockroachColumn => a.id),
		});
		await db.execute(sql.raw(`create table union_a (id int4 primary key, ref_kind text not null, "ref_bId" int4)`));
		await db.execute(
			sql.raw(`create table union_b (id int4 primary key, "aId" int4 not null references union_a (id))`),
		);
		await db.execute(
			sql.raw(`alter table union_a add constraint union_a_ref_b foreign key ("ref_bId") references union_b (id)`),
		);

		try {
			await seed(db, { a, b }, { count: 30 });

			const rows = await client.query('select * from union_a', []) as Row[];
			expect(rows).toHaveLength(30);
			expect(rows.some((row) => row['ref_kind'] === 'link' && row['ref_bId'] !== null)).toBe(true);
			for (const row of rows) {
				if (row['ref_kind'] === 'none') expect(row['ref_bId']).toBeNull();
			}
		} finally {
			await db.execute(sql`alter table union_a drop constraint union_a_ref_b`);
			await db.execute(sql`drop table if exists union_b`);
			await db.execute(sql`drop table if exists union_a`);
		}
	});
});
