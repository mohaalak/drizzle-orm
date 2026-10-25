import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { alias, embed, getTableConfig, integer, pgTable, serial, taggedUnion, text, varchar } from '~/pg-core';
import { drizzle } from '~/pglite';
import { defineRelations } from '~/relations';
import { asc, eq, sql } from '~/sql';

const files = pgTable('files', {
	id: serial().primaryKey(),
	name: text().notNull(),
	uploader: taggedUnion('kind', varchar({ length: 16 }), {
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

const notes = pgTable('file_notes', {
	id: serial().primaryKey(),
	fileId: integer('file_id').notNull(),
	body: text().notNull(),
});

const relations = defineRelations({ files, notes }, (r) => ({
	files: { notes: r.many.notes({ from: r.files.id, to: r.notes.fileId }) },
	notes: { file: r.one.files({ from: r.notes.fileId, to: r.files.id }) },
}));

const client = drizzle('memory://').$client;

beforeAll(async () => {
	const db = drizzle({ client });
	await db.execute(sql`
		create table files (
			id serial primary key,
			name text not null,
			uploader_kind varchar(16) not null,
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
	await db.execute(sql`create table file_notes (id serial primary key, file_id integer not null, body text not null)`);
});

const nobody = { owner: { kind: 'nobody' as const } };

describe.each([{ jit: false }, { jit: true }])('taggedUnion (jit: $jit)', ({ jit }) => {
	const db = drizzle({ client, relations, jit });

	beforeEach(async () => {
		await db.execute(sql`truncate files, file_notes restart identity`);
	});

	test('flattens to one tag column and nullable variant columns', () => {
		const { columns } = getTableConfig(files);
		expect(columns.map((column) => [column.name, column.notNull])).toEqual([
			['id', true],
			['name', true],
			['uploader_kind', true],
			['uploader_staffId', false],
			['uploader_note', false],
			['uploader_parent', false],
			['uploader_via_channel', false],
			['uploader_via_version', false],
			['uploader_via_address', false],
			['meta_owner_kind', true],
			['meta_owner_teamId', false],
		]);
	});

	test('exposes the tag and variant columns by variant', () => {
		expect(files.uploader.kind.name).toBe('uploader_kind');
		expect(files.uploader.staff.staffId.name).toBe('uploader_staffId');
		expect(files.uploader.parent.via.email.address.name).toBe('uploader_via_address');
		expect(files.meta.owner.team.teamId.name).toBe('meta_owner_teamId');
	});

	test('insert writes the variant and returns it folded', async () => {
		const rows = await db.insert(files).values([
			{ name: 'a', uploader: { kind: 'staff', staffId: 7 }, meta: nobody },
			{
				name: 'b',
				uploader: { kind: 'parent', parentId: 3, via: { channel: 'email', address: 'p@x.io' } },
				meta: { owner: { kind: 'team', teamId: 2 } },
			},
			{ name: 'c', uploader: { kind: 'system' }, meta: nobody },
		]).returning();

		expect(rows).toEqual([
			{ id: 1, name: 'a', uploader: { kind: 'staff', staffId: 7, note: null }, meta: { owner: { kind: 'nobody' } } },
			{
				id: 2,
				name: 'b',
				uploader: { kind: 'parent', parentId: 3, via: { channel: 'email', address: 'p@x.io' } },
				meta: { owner: { kind: 'team', teamId: 2 } },
			},
			{ id: 3, name: 'c', uploader: { kind: 'system' }, meta: { owner: { kind: 'nobody' } } },
		]);
	});

	test('select reads unions whole, filters by tag, and picks a variant column', async () => {
		await db.insert(files).values([
			{ name: 'a', uploader: { kind: 'staff', staffId: 7, note: 'hi' }, meta: nobody },
			{ name: 'b', uploader: { kind: 'system' }, meta: nobody },
		]);

		expect(await db.select({ uploader: files.uploader }).from(files).where(eq(files.uploader.kind, 'staff')))
			.toEqual([{ uploader: { kind: 'staff', staffId: 7, note: 'hi' } }]);
		expect(await db.select({ id: files.uploader.staff.staffId }).from(files).orderBy(asc(files.id)))
			.toEqual([{ id: 7 }, { id: null }]);
		// Without its tag a variant's group reads like any group.
		expect(await db.select({ staff: files.uploader.staff }).from(files).orderBy(asc(files.id)))
			.toEqual([{ staff: { staffId: 7, note: 'hi' } }, { staff: { staffId: null, note: null } }]);
	});

	test('switching variants clears the columns of the one left behind', async () => {
		await db.insert(files).values({ name: 'a', uploader: { kind: 'staff', staffId: 7, note: 'hi' }, meta: nobody });
		await db.update(files).set({ uploader: { kind: 'parent', parentId: 1, via: { channel: 'app', version: '2' } } });

		const [raw] = (await db.execute<Record<string, unknown>>(sql`select * from files`)).rows;
		expect(raw).toMatchObject({
			uploader_kind: 'parent',
			uploader_staffId: null,
			uploader_note: null,
			uploader_parent: 1,
		});
		expect((await db.select().from(files))[0]!.uploader).toEqual({
			kind: 'parent',
			parentId: 1,
			via: { channel: 'app', version: '2' },
		});
	});

	test('rejects a value without a known tag', () => {
		expect(() => db.insert(files).values({ name: 'a', uploader: { kind: 'robot' } as any, meta: nobody }))
			.toThrowError(
				'Union "uploader" in table "files" must be written with "kind" set to one of "staff", "parent", "system"',
			);
	});

	test('a missing joined row reads as null', async () => {
		await db.insert(notes).values({ fileId: 99, body: 'orphan' });
		expect(await db.select().from(notes).leftJoin(files, eq(notes.fileId, files.id))).toEqual([
			{ file_notes: { id: 1, fileId: 99, body: 'orphan' }, files: null },
		]);
	});

	test('aliases fold unions too', async () => {
		await db.insert(files).values({ name: 'a', uploader: { kind: 'staff', staffId: 7 }, meta: nobody });
		const f = alias(files, 'f');
		expect(await db.select({ uploader: f.uploader }).from(f).where(eq(f.uploader.staff.staffId, 7)))
			.toEqual([{ uploader: { kind: 'staff', staffId: 7, note: null } }]);
	});

	test('relational queries fold unions in rows and loaded relations', async () => {
		await db.insert(files).values({ name: 'a', uploader: { kind: 'staff', staffId: 7 }, meta: nobody });
		await db.insert(notes).values({ fileId: 1, body: 'n' });

		expect(await db.query.files.findFirst({ columns: { id: true, uploader: true } })).toEqual({
			id: 1,
			uploader: { kind: 'staff', staffId: 7, note: null },
		});
		expect(await db.query.notes.findFirst({ with: { file: { columns: { uploader: true } } } })).toEqual({
			id: 1,
			fileId: 1,
			body: 'n',
			file: { uploader: { kind: 'staff', staffId: 7, note: null } },
		});
		expect(await db.query.files.findMany({ where: { uploader: { kind: 'system' } } })).toEqual([]);
	});

	test('variants cannot give two columns the same name', () => {
		expect(() =>
			pgTable('clash', {
				owner: taggedUnion('kind', text(), { a: { id: integer() }, b: { id: integer() } }),
			})
		).toThrowError('Columns "owner.a.id" and "owner.b.id" of a union are both named "owner_id"');
	});

	test('a variant cannot be named after the tag key', () => {
		expect(() => taggedUnion('kind', text(), { kind: {} } as any)).toThrowError(
			'A union variant cannot be named "kind", the key of its tag column',
		);
	});
});
