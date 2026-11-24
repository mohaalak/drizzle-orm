import { sql } from 'drizzle-orm';
import {
	type AnyMySqlColumn,
	embed,
	int,
	type MySqlAsyncDatabase,
	mysqlEnum,
	mysqlTable,
	serial,
	taggedUnion,
	text,
	varchar,
} from 'drizzle-orm/mysql-core';
import { describe, expect } from 'vitest';
import { reset, seed } from '../../../src/index.ts';
import { mysqlTest as test } from '../instrumentation.ts';

const files = mysqlTable('files', {
	id: serial().primaryKey(),
	name: text().notNull(),
	uploader: taggedUnion('kind', varchar({ length: 16 }), {
		staff: { staffId: int().notNull(), note: text() },
		parent: {
			parentId: int('uploader_parent').notNull(),
			via: taggedUnion('channel', text(), {
				app: { version: text().notNull() },
				email: { address: text().notNull() },
			}),
		},
		system: {},
	}),
	meta: embed({
		owner: taggedUnion('kind', text(), {
			team: { teamId: int().notNull() },
			nobody: {},
		}),
	}),
});

const owners = mysqlTable('owners', {
	id: serial().primaryKey(),
	owner: taggedUnion('kind', varchar({ length: 16 }), {
		classroom: { campusId: int().notNull(), classroomId: int().notNull() },
		campus: { campusId: int().notNull() },
		nobody: {},
	}),
});

type Row = Record<string, unknown>;

const recreate = async (db: MySqlAsyncDatabase<any, any>, ...statements: string[]) => {
	await db.execute(sql.raw('SET FOREIGN_KEY_CHECKS = 0'));
	for (const statement of statements) await db.execute(sql.raw(statement));
	await db.execute(sql.raw('SET FOREIGN_KEY_CHECKS = 1'));
};

const prepare = (db: MySqlAsyncDatabase<any, any>) =>
	recreate(
		db,
		'drop table if exists `files`',
		'drop table if exists `owners`',
		`create table files (
			id serial primary key,
			name text not null,
			uploader_kind varchar(16) not null,
			uploader_staffId int,
			uploader_note text,
			uploader_parent int,
			uploader_via_channel text,
			uploader_via_version text,
			uploader_via_address text,
			meta_owner_kind text not null,
			meta_owner_teamId int
		)`,
		`create table owners (
			id serial primary key,
			owner_kind varchar(16) not null,
			owner_campusId int,
			owner_classroomId int
		)`,
	);

const selectAll = async (db: MySqlAsyncDatabase<any, any>, table: string) =>
	((await db.execute(sql.raw(`select * from \`${table}\``))) as unknown as [Row[]])[0];

describe.skipIf(!process.env['MYSQL_CONNECTION_STRING'])('taggedUnion() in mysql', () => {
	test.beforeEach(async ({ db }) => {
		await prepare(db);
	});

	test('seeds one valid variant per row, spread over the variants', async ({ db }) => {
		await seed(db, { files }, { count: 60 });

		const rows = await selectAll(db, 'files');
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

	test('a column shared by variants is filled only in the variants that declare it', async ({ db }) => {
		await seed(db, { owners }, { count: 60 });

		const rows = await selectAll(db, 'owners');
		expect(new Set(rows.map((row) => row['owner_kind']))).toEqual(new Set(['classroom', 'campus', 'nobody']));
		for (const row of rows) {
			const kind = row['owner_kind'];
			expect(row['owner_campusId'] === null).toBe(kind === 'nobody');
			expect(row['owner_classroomId'] === null).toBe(kind !== 'classroom');
		}
	});

	test('refines a variant column with nested keys, and leaves the other variants empty', async ({ db }) => {
		await seed(db, { files }, { count: 40 }).refine((funcs) => ({
			files: {
				columns: {
					uploader: {
						staff: { staffId: funcs.valuesFromArray({ values: [7, 8] }), note: funcs.default({ defaultValue: 'hi' }) },
					},
				},
			},
		}));

		const rows = await selectAll(db, 'files');
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

	test('refines a shared column on the union', async ({ db }) => {
		await seed(db, { owners }, { count: 30 }).refine((funcs) => ({
			owners: { columns: { owner: { campusId: funcs.default({ defaultValue: 3 }) } } },
		}));

		for (const row of await selectAll(db, 'owners')) {
			expect(row['owner_campusId']).toBe(row['owner_kind'] === 'nobody' ? null : 3);
		}
	});

	test('a values generator on the tag restricts the variants that are produced', async ({ db }) => {
		await seed(db, { files }, { count: 40 }).refine((funcs) => ({
			files: {
				columns: {
					uploader: { kind: funcs.valuesFromArray({ values: ['staff', 'system'] }) },
					meta: { owner: { kind: funcs.valuesFromArray({ values: ['nobody'] }) } },
				},
			},
		}));

		const rows = await selectAll(db, 'files');
		expect(new Set(rows.map((row) => row['uploader_kind']))).toEqual(new Set(['staff', 'system']));
		for (const row of rows) {
			expect(row['uploader_parent']).toBeNull();
			expect(row['uploader_via_channel']).toBeNull();
			expect(row['meta_owner_kind']).toBe('nobody');
			expect(row['meta_owner_teamId']).toBeNull();
		}
	});

	test('union columns can also be refined by their dotted keys', async ({ db }) => {
		await seed(db, { owners }, { count: 30 }).refine((funcs) => ({
			owners: { columns: { 'owner.campusId': funcs.default({ defaultValue: 5 }) } as never },
		}));

		for (const row of await selectAll(db, 'owners')) {
			expect(row['owner_campusId']).toBe(row['owner_kind'] === 'nobody' ? null : 5);
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

		// a nullable one can
		await seed(db, { files }, { count: 5 }).refine(() => ({
			files: { columns: { uploader: { staff: { note: false } } } },
		}));
		const rows = await selectAll(db, 'files');
		expect(rows.every((row) => row['uploader_note'] === null)).toBe(true);
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
		expect(await selectAll(db, 'owners')).toHaveLength(0);
	});

	test('a self-referencing union table is seeded, and reset', async ({ db }) => {
		// an enum tag, and a variant's foreign key to its own table that the variant declared not null
		const nodes = mysqlTable('nodes', {
			id: serial().primaryKey(),
			link: taggedUnion('kind', mysqlEnum(['child', 'root']), {
				child: {
					parentId: int().notNull().references((): AnyMySqlColumn => nodes.id),
					code: varchar({ length: 32 }).unique(),
				},
				root: {},
			}),
		});
		await recreate(
			db,
			'drop table if exists `nodes`',
			`create table nodes (
				id serial primary key,
				link_kind enum('child', 'root') not null,
				link_parentId bigint unsigned,
				link_code varchar(32) unique,
				foreign key (link_parentId) references nodes (id)
			)`,
		);

		await seed(db, { nodes }, { count: 30 });

		const rows = await selectAll(db, 'nodes');
		expect(rows).toHaveLength(30);
		expect(new Set(rows.map((row) => row['link_kind']))).toEqual(new Set(['child', 'root']));
		for (const row of rows) {
			expect(row['link_parentId'] === null).toBe(row['link_kind'] === 'root');
			expect(row['link_code'] === null).toBe(row['link_kind'] === 'root');
		}

		await reset(db, { nodes });
		expect(await selectAll(db, 'nodes')).toHaveLength(0);
	});

	test('tables referencing each other through union variants are seeded, the second pass included', async ({ db }) => {
		const a = mysqlTable('a', {
			id: int().primaryKey(),
			ref: taggedUnion('kind', varchar({ length: 16 }), {
				link: { bId: int().references((): AnyMySqlColumn => b.id) },
				none: {},
			}),
		});
		const b = mysqlTable('b', {
			id: int().primaryKey(),
			aId: int().notNull().references((): AnyMySqlColumn => a.id),
		});
		await recreate(
			db,
			'drop table if exists `a`',
			'drop table if exists `b`',
			'create table a (id int not null primary key, ref_kind varchar(16) not null, ref_bId int)',
			'create table b (id int not null primary key, aId int not null, foreign key (aId) references a (id))',
			'alter table a add foreign key (ref_bId) references b (id)',
		);

		await seed(db, { a, b }, { count: 30 });

		const rows = await selectAll(db, 'a');
		expect(rows).toHaveLength(30);
		expect(rows.some((row) => row['ref_kind'] === 'link' && row['ref_bId'] !== null)).toBe(true);
		for (const row of rows) {
			if (row['ref_kind'] === 'none') expect(row['ref_bId']).toBeNull();
		}
		expect(await selectAll(db, 'b')).toHaveLength(30);
	});
});
