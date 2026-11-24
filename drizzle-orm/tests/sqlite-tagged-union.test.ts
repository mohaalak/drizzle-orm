import { SqliteClient } from '@effect/sql-sqlite-node';
import { createClient } from '@libsql/client';
import Database from 'better-sqlite3';
import * as Effect from 'effect/Effect';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { drizzle } from '~/better-sqlite3';
import * as EffectSQLite from '~/effect-sqlite-node';
import { drizzle as drizzleLibsql } from '~/libsql';
import { defineRelations } from '~/relations';
import { asc, eq, sql } from '~/sql';
import { alias, embed, getTableConfig, integer, sqliteTable, taggedUnion, text } from '~/sqlite-core';

const files = sqliteTable('files', {
	id: integer().primaryKey({ autoIncrement: true }),
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

const owners = sqliteTable('owners', {
	id: integer().primaryKey({ autoIncrement: true }),
	owner: taggedUnion('kind', text(), {
		classroom: { campusId: integer().notNull(), classroomId: integer().notNull() },
		campus: { campusId: integer().notNull() },
		nobody: {},
	}),
	region: taggedUnion('kind', text(), {
		north: { code: text().notNull() },
		south: { code: text().notNull() },
	}),
});

const notes = sqliteTable('file_notes', {
	id: integer().primaryKey({ autoIncrement: true }),
	fileId: integer('file_id').notNull(),
	body: text().notNull(),
});

const relations = defineRelations({ files, notes, owners }, (r) => ({
	files: { notes: r.many.notes({ from: r.files.id, to: r.notes.fileId }) },
	notes: { file: r.one.files({ from: r.notes.fileId, to: r.files.id }) },
}));

const createTables = [
	`create table files (
		id integer primary key autoincrement,
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
	)`,
	`create table owners (
		id integer primary key autoincrement,
		owner_kind text not null,
		"owner_campusId" integer,
		"owner_classroomId" integer,
		region_kind text not null,
		region_code text not null
	)`,
	`create table file_notes (id integer primary key autoincrement, file_id integer not null, body text not null)`,
];

const nobody = { owner: { kind: 'nobody' as const } };

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

test('rejects a value without a known tag', () => {
	const db = drizzle({ client: new Database(':memory:') });
	expect(() => db.insert(files).values({ name: 'a', uploader: { kind: 'robot' } as any, meta: nobody }))
		.toThrowError(
			'Union "uploader" in table "files" must be written with "kind" set to one of "staff", "parent", "system"',
		);
});

test('columns of different keys cannot be given the same name', () => {
	expect(() =>
		sqliteTable('clash', {
			owner: taggedUnion('kind', text(), { a: { x: integer('ref') }, b: { y: integer('ref') } }),
		})
	).toThrowError('Columns "owner.a.x" and "owner.b.y" of a union are both named "ref"');
});

test('a variant cannot be named after the tag key', () => {
	expect(() => taggedUnion('kind', text(), { kind: {} } as any)).toThrowError(
		'A union variant cannot be named "kind", the key of its tag column',
	);
});

test('shared columns must agree on type and name', () => {
	expect(() => taggedUnion('kind', text(), { a: { ref: integer() }, b: { ref: text() } })).toThrowError(
		'Column "ref" is shared by variants "a" and "b", so it must be of the same type in both',
	);
	expect(() => taggedUnion('kind', text(), { a: { ref: integer('x') }, b: { ref: integer('y') } })).toThrowError(
		'Column "ref" is shared by variants "a" and "b", so it must have the same name in both',
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

describe.each([{ jit: false }, { jit: true }])('taggedUnion (jit: $jit)', ({ jit }) => {
	const client = new Database(':memory:');
	const db = drizzle({ client, relations, jit });

	beforeAll(() => {
		for (const statement of createTables) db.run(sql.raw(statement));
	});

	beforeEach(() => {
		for (const table of ['files', 'file_notes', 'owners']) db.run(sql.raw(`delete from ${table}`));
		db.run(sql`delete from sqlite_sequence`);
	});

	test('insert writes the variant and returns it folded', () => {
		const rows = db.insert(files).values([
			{ name: 'a', uploader: { kind: 'staff', staffId: 7 }, meta: nobody },
			{
				name: 'b',
				uploader: { kind: 'parent', parentId: 3, via: { channel: 'email', address: 'p@x.io' } },
				meta: { owner: { kind: 'team', teamId: 2 } },
			},
			{ name: 'c', uploader: { kind: 'system' }, meta: nobody },
		]).returning().all();

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

	test('select reads unions whole, filters by tag, and picks a variant column', () => {
		db.insert(files).values([
			{ name: 'a', uploader: { kind: 'staff', staffId: 7, note: 'hi' }, meta: nobody },
			{ name: 'b', uploader: { kind: 'system' }, meta: nobody },
		]).run();

		expect(db.select({ uploader: files.uploader }).from(files).where(eq(files.uploader.kind, 'staff')).all())
			.toEqual([{ uploader: { kind: 'staff', staffId: 7, note: 'hi' } }]);
		expect(db.select({ id: files.uploader.staff.staffId }).from(files).orderBy(asc(files.id)).all())
			.toEqual([{ id: 7 }, { id: null }]);
		// Without its tag a variant's group reads like any group.
		expect(db.select({ staff: files.uploader.staff }).from(files).orderBy(asc(files.id)).all())
			.toEqual([{ staff: { staffId: 7, note: 'hi' } }, { staff: { staffId: null, note: null } }]);
	});

	test('switching variants clears the columns of the one left behind', () => {
		db.insert(files).values({ name: 'a', uploader: { kind: 'staff', staffId: 7, note: 'hi' }, meta: nobody }).run();
		db.update(files).set({ uploader: { kind: 'parent', parentId: 1, via: { channel: 'app', version: '2' } } }).run();

		const raw = client.prepare('select * from files').get();
		expect(raw).toMatchObject({
			uploader_kind: 'parent',
			uploader_staffId: null,
			uploader_note: null,
			uploader_parent: 1,
		});
		expect(db.select().from(files).all()[0]!.uploader).toEqual({
			kind: 'parent',
			parentId: 1,
			via: { channel: 'app', version: '2' },
		});
	});

	test('update and delete return folded rows', () => {
		db.insert(files).values({ name: 'a', uploader: { kind: 'staff', staffId: 7 }, meta: nobody }).run();
		expect(db.update(files).set({ uploader: { kind: 'system' } }).returning({ uploader: files.uploader }).all())
			.toEqual([{ uploader: { kind: 'system' } }]);
		expect(db.delete(files).returning({ uploader: files.uploader }).all()).toEqual([{ uploader: { kind: 'system' } }]);
	});

	test('onConflictDoUpdate writes a variant', () => {
		db.insert(files).values({ id: 1, name: 'a', uploader: { kind: 'staff', staffId: 7 }, meta: nobody }).run();
		const [row] = db.insert(files).values({ id: 1, name: 'a', uploader: { kind: 'system' }, meta: nobody })
			.onConflictDoUpdate({
				target: files.id,
				set: { uploader: { kind: 'parent', parentId: 2, via: { channel: 'app', version: '1' } } },
			})
			.returning({ uploader: files.uploader }).all();
		expect(row).toEqual({ uploader: { kind: 'parent', parentId: 2, via: { channel: 'app', version: '1' } } });
	});

	test('a missing joined row reads as null', () => {
		db.insert(notes).values({ fileId: 99, body: 'orphan' }).run();
		expect(db.select().from(notes).leftJoin(files, eq(notes.fileId, files.id)).all()).toEqual([
			{ file_notes: { id: 1, fileId: 99, body: 'orphan' }, files: null },
		]);
	});

	test('aliases fold unions too', () => {
		db.insert(files).values({ name: 'a', uploader: { kind: 'staff', staffId: 7 }, meta: nobody }).run();
		const f = alias(files, 'f');
		expect(db.select({ uploader: f.uploader }).from(f).where(eq(f.uploader.staff.staffId, 7)).all())
			.toEqual([{ uploader: { kind: 'staff', staffId: 7, note: null } }]);
	});

	test('relational queries fold unions in rows and loaded relations', async () => {
		db.insert(files).values({ name: 'a', uploader: { kind: 'staff', staffId: 7 }, meta: nobody }).run();
		db.insert(notes).values({ fileId: 1, body: 'n' }).run();

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
		db.insert(owners).values({ owner: { kind: 'classroom', campusId: 1, classroomId: 2 }, region: north }).run();
		db.update(owners).set({ owner: { kind: 'campus', campusId: 3 } }).run();
		expect(db.select().from(owners).all()[0]).toEqual({
			id: 1,
			owner: { kind: 'campus', campusId: 3 },
			region: north,
		});

		db.update(owners).set({ owner: { kind: 'nobody' } }).run();
		expect(client.prepare('select * from owners').get()).toMatchObject({
			owner_kind: 'nobody',
			owner_campusId: null,
			owner_classroomId: null,
		});
		expect(db.select({ owner: owners.owner }).from(owners).all()).toEqual([{ owner: { kind: 'nobody' } }]);
		expect(await db.query.owners.findFirst({ columns: { owner: true } })).toEqual({ owner: { kind: 'nobody' } });
	});
});

describe('taggedUnion with an async driver', () => {
	const db = drizzleLibsql({ client: createClient({ url: ':memory:' }), relations });

	beforeAll(async () => {
		for (const statement of createTables) await db.run(sql.raw(statement));
	});

	test('folds unions in builders and relational queries', async () => {
		const [inserted] = await db.insert(files).values({
			name: 'a',
			uploader: { kind: 'parent', parentId: 3, via: { channel: 'email', address: 'p@x.io' } },
			meta: nobody,
		}).returning();
		expect(inserted).toEqual({
			id: 1,
			name: 'a',
			uploader: { kind: 'parent', parentId: 3, via: { channel: 'email', address: 'p@x.io' } },
			meta: { owner: { kind: 'nobody' } },
		});

		await db.update(files).set({ uploader: { kind: 'staff', staffId: 5 } });
		expect(await db.select({ uploader: files.uploader }).from(files).where(eq(files.uploader.kind, 'staff')))
			.toEqual([{ uploader: { kind: 'staff', staffId: 5, note: null } }]);

		await db.insert(notes).values({ fileId: 1, body: 'n' });
		expect(await db.query.notes.findFirst({ with: { file: { columns: { uploader: true } } } })).toEqual({
			id: 1,
			fileId: 1,
			body: 'n',
			file: { uploader: { kind: 'staff', staffId: 5, note: null } },
		});
		expect(await db.query.files.findFirst({ columns: { uploader: true } })).toEqual({
			uploader: { kind: 'staff', staffId: 5, note: null },
		});
	});
});

describe('taggedUnion with the effect driver', () => {
	const program = Effect.gen(function*() {
		const effectDb = yield* EffectSQLite.make({ relations });
		for (const statement of createTables) yield* effectDb.run(sql.raw(statement));

		const [inserted] = yield* effectDb.insert(files).values({
			name: 'a',
			uploader: { kind: 'staff', staffId: 7 },
			meta: nobody,
		}).returning();
		yield* effectDb.insert(notes).values({ fileId: 1, body: 'n' });
		const [updated] = yield* effectDb.update(files).set({ uploader: { kind: 'system' } }).returning({
			uploader: files.uploader,
		});
		const selected = yield* effectDb.select({ uploader: files.uploader }).from(files);
		const note = yield* effectDb.query.notes.findFirst({ with: { file: { columns: { uploader: true } } } });
		return { inserted, updated, selected, note };
	}).pipe(
		Effect.provide(EffectSQLite.DefaultServices),
		Effect.provide(SqliteClient.layer({ filename: ':memory:' })),
		Effect.scoped,
	);

	test('folds unions in builders and relational queries', async () => {
		const { inserted, updated, selected, note } = await Effect.runPromise(program);

		expect(inserted).toEqual({
			id: 1,
			name: 'a',
			uploader: { kind: 'staff', staffId: 7, note: null },
			meta: { owner: { kind: 'nobody' } },
		});
		expect(updated).toEqual({ uploader: { kind: 'system' } });
		expect(selected).toEqual([{ uploader: { kind: 'system' } }]);
		expect(note).toEqual({ id: 1, fileId: 1, body: 'n', file: { uploader: { kind: 'system' } } });
	});
});
