import { type Connection, createConnection } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { defineRelations } from '~/relations';
import { drizzle, type SingleStoreDriverDatabase } from '~/singlestore';
import {
	alias,
	embed,
	getTableConfig,
	int,
	serial,
	singlestoreTable,
	taggedUnion,
	text,
	varchar,
} from '~/singlestore-core';
import { asc, eq, sql } from '~/sql';

// Tests that execute queries run against a real SingleStore server: set SINGLESTORE_CONNECTION_STRING,
// for example `mysql://root:singlestore@127.0.0.1:33307/` from drizzle-kit/.env.example.
// The `drizzle` database is created when missing. The `toSQL()`-free schema tests need no database.
const connectionString = process.env['SINGLESTORE_CONNECTION_STRING'];

const files = singlestoreTable('files', {
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

const owners = singlestoreTable('owners', {
	id: serial().primaryKey(),
	owner: taggedUnion('kind', text(), {
		classroom: { campusId: int().notNull(), classroomId: int().notNull() },
		campus: { campusId: int().notNull() },
		nobody: {},
	}),
	region: taggedUnion('kind', text(), {
		north: { code: text().notNull() },
		south: { code: text().notNull() },
	}),
});

const notes = singlestoreTable('file_notes', {
	id: serial().primaryKey(),
	fileId: int('file_id').notNull(),
	body: text().notNull(),
});

const relations = defineRelations({ files, notes, owners }, (r) => ({
	files: { notes: r.many.notes({ from: r.files.id, to: r.notes.fileId }) },
	notes: { file: r.one.files({ from: r.notes.fileId, to: r.files.id }) },
}));

const nobody = { owner: { kind: 'nobody' as const } };

async function connect(): Promise<Connection> {
	const connection = await createConnection({ uri: connectionString!, supportBigNumbers: true });
	await connection.query('create database if not exists drizzle');
	await connection.changeUser({ database: 'drizzle' });
	return connection;
}

describe('taggedUnion (no database)', () => {
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

	test('variants share a column declared under the same key', () => {
		expect(getTableConfig(owners).columns.map((column) => [column.name, column.notNull])).toEqual([
			['id', true],
			['owner_kind', true],
			['owner_campusId', false],
			['owner_classroomId', false],
			['region_kind', true],
			['region_code', true],
		]);
		expect(owners.owner.campusId.name).toBe('owner_campusId');
	});

	test('columns of different keys cannot be given the same name', () => {
		expect(() =>
			singlestoreTable('clash', {
				owner: taggedUnion('kind', text(), { a: { x: int('ref') }, b: { y: int('ref') } }),
			})
		).toThrowError('Columns "owner.a.x" and "owner.b.y" of a union are both named "ref"');
	});

	test('a variant cannot be named after the tag key', () => {
		expect(() => taggedUnion('kind', text(), { kind: {} } as any)).toThrowError(
			'A union variant cannot be named "kind", the key of its tag column',
		);
	});

	test('shared columns must agree on type and name', () => {
		expect(() => taggedUnion('kind', text(), { a: { ref: int() }, b: { ref: text() } })).toThrowError(
			'Column "ref" is shared by variants "a" and "b", so it must be of the same type in both',
		);
		expect(() => taggedUnion('kind', text(), { a: { ref: int('x') }, b: { ref: int('y') } })).toThrowError(
			'Column "ref" is shared by variants "a" and "b", so it must have the same name in both',
		);
	});
});

describe.skipIf(!connectionString).each([
	{ jit: false },
	{ jit: true },
])('taggedUnion (jit: $jit)', ({ jit }) => {
	let client: Connection;
	let db: SingleStoreDriverDatabase<typeof relations>;

	beforeAll(async () => {
		client = await connect();
		db = drizzle({ client, relations, jit });
	});

	afterAll(async () => {
		await db.execute(sql`drop table if exists file_notes`);
		await db.execute(sql`drop table if exists files`);
		await db.execute(sql`drop table if exists owners`);
		await client.end();
	});

	// SingleStore never resets AUTO_INCREMENT, including on TRUNCATE, so drop and
	// recreate. Otherwise serial ids keep climbing and the assertions below, which
	// expect them to start at 1, fail.
	beforeEach(async () => {
		await db.execute(sql`drop table if exists file_notes`);
		await db.execute(sql`drop table if exists files`);
		await db.execute(sql`drop table if exists owners`);
		await db.execute(sql`
			create table files (
				id serial primary key,
				name text not null,
				uploader_kind varchar(16) not null,
				\`uploader_staffId\` int,
				uploader_note text,
				uploader_parent int,
				uploader_via_channel text,
				uploader_via_version text,
				uploader_via_address text,
				meta_owner_kind text not null,
				\`meta_owner_teamId\` int
			)
		`);
		await db.execute(sql`
			create table owners (
				id serial primary key,
				owner_kind text not null,
				\`owner_campusId\` int,
				\`owner_classroomId\` int,
				region_kind text not null,
				region_code text not null
			)
		`);
		await db.execute(sql`create table file_notes (id serial primary key, file_id int not null, body text not null)`);
	});

	test('insert writes the variant and reads it folded', async () => {
		expect(
			await db.insert(files).values([
				{ name: 'a', uploader: { kind: 'staff', staffId: 7 }, meta: nobody },
				{
					name: 'b',
					uploader: { kind: 'parent', parentId: 3, via: { channel: 'email', address: 'p@x.io' } },
					meta: { owner: { kind: 'team', teamId: 2 } },
				},
				{ name: 'c', uploader: { kind: 'system' }, meta: nobody },
			]).$returningId(),
		).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);

		expect(await db.select().from(files).orderBy(asc(files.id))).toEqual([
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

		const [raw] = await db.execute<Record<string, unknown>>(sql`select * from files`, 'objects');
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

	test('a shared column is kept by the variants that declare it and cleared by the rest', async () => {
		const north = { kind: 'north', code: 'n' } as const;
		await db.insert(owners).values({ owner: { kind: 'classroom', campusId: 1, classroomId: 2 }, region: north });
		await db.update(owners).set({ owner: { kind: 'campus', campusId: 3 } });
		expect((await db.select().from(owners))[0]).toEqual({
			id: 1,
			owner: { kind: 'campus', campusId: 3 },
			region: north,
		});

		await db.update(owners).set({ owner: { kind: 'nobody' } });
		const [raw] = await db.execute<Record<string, unknown>>(sql`select * from owners`, 'objects');
		expect(raw).toMatchObject({ owner_kind: 'nobody', owner_campusId: null, owner_classroomId: null });
		expect(await db.select({ owner: owners.owner }).from(owners)).toEqual([{ owner: { kind: 'nobody' } }]);
		expect(await db.query.owners.findFirst({ columns: { owner: true } })).toEqual({ owner: { kind: 'nobody' } });
	});
});
