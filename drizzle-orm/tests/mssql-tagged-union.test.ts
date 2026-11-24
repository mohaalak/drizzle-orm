import mssql from 'mssql';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { alias, embed, getTableConfig, int, mssqlTable, taggedUnion, varchar } from '~/mssql-core';
import { drizzle } from '~/node-mssql';
import { getMsSqlConnectionParams } from '~/node-mssql/driver';
import { defineRelations } from '~/relations';
import { asc, eq, sql } from '~/sql';

// The tests that run queries need a real SQL Server database: set MSSQL_CONNECTION_STRING, for example the one in
// drizzle-kit/.env.example for `bash compose/dockers.sh up mssql`. The rest only build SQL.
const connectionString = process.env['MSSQL_CONNECTION_STRING'];

const files = mssqlTable('tu_files', {
	id: int().primaryKey().identity(),
	name: varchar({ length: 100 }).notNull(),
	uploader: taggedUnion('kind', varchar({ length: 16 }), {
		staff: { staffId: int().notNull(), note: varchar({ length: 100 }) },
		parent: {
			parentId: int('uploader_parent').notNull(),
			via: taggedUnion('channel', varchar({ length: 16 }), {
				app: { version: varchar({ length: 16 }).notNull() },
				email: { address: varchar({ length: 100 }).notNull() },
			}),
		},
		system: {},
	}),
	meta: embed({
		owner: taggedUnion('kind', varchar({ length: 16 }), {
			team: { teamId: int().notNull() },
			nobody: {},
		}),
	}),
});

const owners = mssqlTable('tu_owners', {
	id: int().primaryKey().identity(),
	owner: taggedUnion('kind', varchar({ length: 16 }), {
		classroom: { campusId: int().notNull(), classroomId: int().notNull() },
		campus: { campusId: int().notNull() },
		nobody: {},
	}),
	region: taggedUnion('kind', varchar({ length: 16 }), {
		north: { code: varchar({ length: 16 }).notNull() },
		south: { code: varchar({ length: 16 }).notNull() },
	}),
});

const notes = mssqlTable('tu_file_notes', {
	id: int().primaryKey().identity(),
	fileId: int('file_id').notNull(),
	body: varchar({ length: 100 }).notNull(),
});

const relations = defineRelations({ files, notes, owners }, (r) => ({
	files: { notes: r.many.notes({ from: r.files.id, to: r.notes.fileId }) },
	notes: { file: r.one.files({ from: r.notes.fileId, to: r.files.id }) },
}));

const mock = drizzle.mock({ relations });
const nobody = { owner: { kind: 'nobody' as const } };

describe('taggedUnion (query building)', () => {
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

	test('insert sets the tag and clears the other variants', () => {
		expect(mock.insert(files).values({ name: 'a', uploader: { kind: 'staff', staffId: 7 }, meta: nobody }).toSQL())
			.toStrictEqual({
				sql:
					'insert into [tu_files] ([name], [uploader_kind], [uploader_staffId], [uploader_note], [uploader_parent], [uploader_via_channel], [uploader_via_version], [uploader_via_address], [meta_owner_kind], [meta_owner_teamId]) values (@par0, @par1, @par2, default, @par3, @par4, @par5, @par6, @par7, @par8)',
				params: ['a', 'staff', 7, null, null, null, null, 'nobody', null],
			});
	});

	test('update writes one whole variant', () => {
		expect(mock.update(files).set({ uploader: { kind: 'system' } }).where(eq(files.id, 1)).toSQL()).toStrictEqual({
			sql:
				'update [tu_files] set [uploader_kind] = @par0, [uploader_staffId] = @par1, [uploader_note] = @par2, [uploader_parent] = @par3, [uploader_via_channel] = @par4, [uploader_via_version] = @par5, [uploader_via_address] = @par6 where [tu_files].[id] = @par7',
			params: ['system', null, null, null, null, null, null, 1],
		});
	});

	test('relational queries select union columns by a key SQL Server will not nest', () => {
		const { sql: query } = mock.query.notes.findFirst({ with: { file: { columns: { uploader: true } } } }).toSQL();
		// `for json path` reads a `.` in an alias as a path: nested rows rename it and nest the rows afterwards
		expect(query).toContain('[d1].[uploader_kind] as [uploader→kind]');
		expect(query).toContain('[d1].[uploader_via_channel] as [uploader→parent→via→channel]');
	});

	test('rejects a value without a known tag', () => {
		expect(() => mock.insert(files).values({ name: 'a', uploader: { kind: 'robot' } as any, meta: nobody }))
			.toThrowError(
				'Union "uploader" in table "tu_files" must be written with "kind" set to one of "staff", "parent", "system"',
			);
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
			mssqlTable('clash', {
				owner: taggedUnion('kind', varchar({ length: 16 }), { a: { x: int('ref') }, b: { y: int('ref') } }),
			})
		).toThrowError('Columns "owner.a.x" and "owner.b.y" of a union are both named "ref"');
	});
});

describe.skipIf(!connectionString).each([{ jit: false }, { jit: true }])('taggedUnion (jit: $jit)', ({ jit }) => {
	let client: mssql.ConnectionPool;
	let db: ReturnType<typeof drizzle<typeof relations, mssql.ConnectionPool>>;

	beforeAll(async () => {
		client = await new mssql.ConnectionPool(getMsSqlConnectionParams(connectionString!) as mssql.config).connect();
		db = drizzle({ client, relations, jit });

		await db.execute(sql`drop table if exists tu_files`);
		await db.execute(sql`drop table if exists tu_owners`);
		await db.execute(sql`drop table if exists tu_file_notes`);
		await db.execute(sql`
			create table tu_files (
				id int identity primary key,
				name varchar(100) not null,
				uploader_kind varchar(16) not null,
				uploader_staffId int,
				uploader_note varchar(100),
				uploader_parent int,
				uploader_via_channel varchar(16),
				uploader_via_version varchar(16),
				uploader_via_address varchar(100),
				meta_owner_kind varchar(16) not null,
				meta_owner_teamId int
			)
		`);
		await db.execute(sql`
			create table tu_owners (
				id int identity primary key,
				owner_kind varchar(16) not null,
				owner_campusId int,
				owner_classroomId int,
				region_kind varchar(16) not null,
				region_code varchar(16) not null
			)
		`);
		await db.execute(
			sql`create table tu_file_notes (id int identity primary key, file_id int not null, body varchar(100) not null)`,
		);
	});

	beforeEach(async () => {
		await db.execute(sql`truncate table tu_files`);
		await db.execute(sql`truncate table tu_file_notes`);
		await db.execute(sql`truncate table tu_owners`);
	});

	afterAll(async () => {
		await db.execute(sql`drop table if exists tu_files`);
		await db.execute(sql`drop table if exists tu_owners`);
		await db.execute(sql`drop table if exists tu_file_notes`);
		await client.close();
	});

	test('insert writes the variant and outputs it folded', async () => {
		const rows = await db.insert(files).output().values([
			{ name: 'a', uploader: { kind: 'staff', staffId: 7 }, meta: nobody },
			{
				name: 'b',
				uploader: { kind: 'parent', parentId: 3, via: { channel: 'email', address: 'p@x.io' } },
				meta: { owner: { kind: 'team', teamId: 2 } },
			},
			{ name: 'c', uploader: { kind: 'system' }, meta: nobody },
		]);

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
		const [changed] = await db.update(files)
			.set({ uploader: { kind: 'parent', parentId: 1, via: { channel: 'app', version: '2' } } })
			.output({ deleted: { uploader: files.uploader }, inserted: { uploader: files.uploader } });
		expect(changed).toEqual({
			deleted: { uploader: { kind: 'staff', staffId: 7, note: 'hi' } },
			inserted: { uploader: { kind: 'parent', parentId: 1, via: { channel: 'app', version: '2' } } },
		});

		const [raw] = await db.execute<Record<string, unknown>>(sql`select * from tu_files`, 'objects');
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

	test('delete outputs unions folded', async () => {
		await db.insert(files).values({ name: 'a', uploader: { kind: 'staff', staffId: 7 }, meta: nobody });
		expect(await db.delete(files).output({ uploader: files.uploader, meta: files.meta })).toEqual([
			{ uploader: { kind: 'staff', staffId: 7, note: null }, meta: { owner: { kind: 'nobody' } } },
		]);
	});

	test('a missing joined row reads as null', async () => {
		await db.insert(notes).values({ fileId: 99, body: 'orphan' });
		expect(await db.select().from(notes).leftJoin(files, eq(notes.fileId, files.id))).toEqual([
			{ tu_file_notes: { id: 1, fileId: 99, body: 'orphan' }, tu_files: null },
		]);
	});

	test('aliases fold unions too', async () => {
		await db.insert(files).values({ name: 'a', uploader: { kind: 'staff', staffId: 7 }, meta: nobody });
		const f = alias(files, 'f');
		expect(await db.select({ uploader: f.uploader }).from(f).where(eq(f.uploader.staff.staffId, 7)))
			.toEqual([{ uploader: { kind: 'staff', staffId: 7, note: null } }]);
	});

	test('relational queries fold unions in rows and loaded relations', async () => {
		await db.insert(files).values([
			{
				name: 'a',
				uploader: { kind: 'parent', parentId: 3, via: { channel: 'email', address: 'p@x.io' } },
				meta: { owner: { kind: 'team', teamId: 2 } },
			},
		]);
		await db.insert(notes).values([{ fileId: 1, body: 'n' }, { fileId: 1, body: 'm' }]);

		expect(await db.query.files.findFirst({ columns: { id: true, uploader: true } })).toEqual({
			id: 1,
			uploader: { kind: 'parent', parentId: 3, via: { channel: 'email', address: 'p@x.io' } },
		});
		// A loaded relation's columns come back from `for json path` keyed `uploader→parent→via→channel`.
		expect(await db.query.notes.findFirst({ with: { file: { columns: { uploader: true, meta: true } } } })).toEqual({
			id: 1,
			fileId: 1,
			body: 'n',
			file: {
				uploader: { kind: 'parent', parentId: 3, via: { channel: 'email', address: 'p@x.io' } },
				meta: { owner: { kind: 'team', teamId: 2 } },
			},
		});
		expect(
			await db.query.notes.findMany({
				columns: { body: true },
				with: { file: { columns: { name: true }, with: { notes: { columns: { id: true } } } } },
				orderBy: { id: 'asc' },
			}),
		).toEqual([
			{ body: 'n', file: { name: 'a', notes: [{ id: 1 }, { id: 2 }] } },
			{ body: 'm', file: { name: 'a', notes: [{ id: 1 }, { id: 2 }] } },
		]);
		expect(
			await db.query.files.findFirst({
				columns: { meta: true },
				with: { notes: { columns: { body: true }, orderBy: { id: 'asc' } } },
			}),
		).toEqual({ meta: { owner: { kind: 'team', teamId: 2 } }, notes: [{ body: 'n' }, { body: 'm' }] });
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
		const [raw] = await db.execute<Record<string, unknown>>(sql`select * from tu_owners`, 'objects');
		expect(raw).toMatchObject({ owner_kind: 'nobody', owner_campusId: null, owner_classroomId: null });
		expect(await db.select({ owner: owners.owner }).from(owners)).toEqual([{ owner: { kind: 'nobody' } }]);
		expect(await db.query.owners.findFirst({ columns: { owner: true } })).toEqual({ owner: { kind: 'nobody' } });
	});
});
