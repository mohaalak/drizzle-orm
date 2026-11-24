import { createPool, type Pool } from 'mysql2/promise';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
	alias,
	boolean,
	camelCase,
	char,
	datetime,
	embed,
	foreignKey,
	getTableConfig,
	index,
	int,
	primaryKey,
	serial,
	taggedUnion,
	text,
	varchar,
} from '~/mysql-core';
import { drizzle } from '~/mysql2';
import { defineRelations } from '~/relations';
import { asc, eq, sql } from '~/sql';

// Schemas shaped like an app migrating from TypeORM: camelCase column names, single-table inheritance as a
// top-level union, a status union with a shared column, an embed() inside a union variant, and a composite
// foreign key. These tests run against a real MySQL server: set MYSQL_CONNECTION_STRING, for example
// `mysql://root:mysql@127.0.0.1:33306/drizzle` for `docker run -e MYSQL_ROOT_PASSWORD=mysql -e MYSQL_DATABASE=drizzle -p 33306:3306 mysql:8`.
const connectionString = process.env['MYSQL_CONNECTION_STRING'];

const reviewer = camelCase.table('app_reviewer', {
	id: varchar({ length: 255 }).notNull(),
	username: varchar({ length: 255 }).notNull(),
	profile: taggedUnion('_tag', varchar('type', { length: 255 }), {
		GoogleReviewer: {
			profileUrl: varchar({ length: 255 }).notNull(),
			isLocalGuide: boolean(),
			googleId: varchar({ length: 255 }).notNull().unique(),
		},
		ThirdPartyReviewer: { website: varchar({ length: 255 }).notNull() },
	}, { prefix: '' }),
}, (t) => [primaryKey({ columns: [t.id, t.username] }), index('app_reviewer_username').on(t.username)]);

const reviews = camelCase.table('app_reviews', {
	id: varchar({ length: 255 }).primaryKey(),
	reviewerId: varchar({ length: 255 }).notNull(),
	reviewerName: varchar({ length: 255 }).notNull(),
	commentedAt: datetime().notNull(),
	commentedYear: int().generatedAlwaysAs(sql`YEAR(commentedAt)`, { mode: 'stored' }),
	llmAspectOpinion: taggedUnion('_tag', char('llmAspectOpinionStatus', { length: 25 }), {
		Initial: { statusChangedAt: datetime().notNull() },
		Completed: { statusChangedAt: datetime().notNull(), count: int().notNull() },
		Failed: { statusChangedAt: datetime().notNull(), reason: text() },
	}),
}, (t) => [
	foreignKey({ columns: [t.reviewerId, t.reviewerName], foreignColumns: [reviewer.id, reviewer.username] }),
	index('app_reviews_status').on(t.llmAspectOpinion._tag),
]);

const sessions = camelCase.table('app_sessions', {
	id: serial().primaryKey(),
	type: taggedUnion('_tag', varchar('type', { length: 25 }), {
		Permanent: {
			user: embed({
				email: varchar({ length: 255 }).notNull(),
				firstName: varchar({ length: 255 }).notNull(),
				lastName: varchar({ length: 255 }).notNull(),
			}),
		},
		Temporary: {},
	}, { prefix: '' }),
	lastVisitedAt: datetime(),
});

const business = camelCase.table('app_business', {
	id: serial().primaryKey(),
	name: varchar({ length: 255 }).notNull(),
	scrapingSummary: embed({
		inQueue: int().notNull().default(0),
		inProgress: int().notNull().default(0),
		completed: int().notNull().default(0),
	}),
});

const relations = defineRelations({ reviewer, reviews, sessions, business }, (r) => ({
	reviews: {
		reviewer: r.one.reviewer({
			from: [r.reviews.reviewerId, r.reviews.reviewerName],
			to: [r.reviewer.id, r.reviewer.username],
		}),
	},
	reviewer: {
		reviews: r.many.reviews({
			from: [r.reviewer.id, r.reviewer.username],
			to: [r.reviews.reviewerId, r.reviews.reviewerName],
		}),
	},
}));

const at = new Date('2026-03-04T05:06:07.000Z');
const google = {
	_tag: 'GoogleReviewer',
	profileUrl: 'https://maps/1',
	isLocalGuide: true,
	googleId: 'g1',
} as const;

describe('app shapes (no database)', () => {
	test('a top-level union with an empty prefix keeps the TypeORM single-table columns', () => {
		const { columns, primaryKeys } = getTableConfig(reviewer);
		expect(columns.map((column) => [column.name, column.notNull, column.isUnique])).toEqual([
			['id', true, false],
			['username', true, false],
			['type', true, false],
			['profileUrl', false, false],
			['isLocalGuide', false, false],
			['googleId', false, true],
			['website', false, false],
		]);
		expect(primaryKeys[0]!.columns.map((column) => column.name)).toEqual(['id', 'username']);
	});

	test('a union keeps an explicit tag name and camel-cases its shared and variant columns', () => {
		const { columns, foreignKeys, indexes } = getTableConfig(reviews);
		expect(columns.map((column) => [column.name, column.notNull])).toEqual([
			['id', true],
			['reviewerId', true],
			['reviewerName', true],
			['commentedAt', true],
			['commentedYear', false],
			['llmAspectOpinionStatus', true],
			['llmAspectOpinionStatusChangedAt', true],
			['llmAspectOpinionCount', false],
			['llmAspectOpinionReason', false],
		]);
		const reference = foreignKeys[0]!.reference();
		expect(reference.columns.map((column) => column.name)).toEqual(['reviewerId', 'reviewerName']);
		expect(reference.foreignColumns.map((column) => column.name)).toEqual(['id', 'username']);
		expect(indexes[0]!.config.columns.map((column) => (column as any).name)).toEqual(['llmAspectOpinionStatus']);
	});

	test('an embed() inside a variant takes its own prefix', () => {
		expect(getTableConfig(sessions).columns.map((column) => [column.name, column.notNull])).toEqual([
			['id', true],
			['type', true],
			['userEmail', false],
			['userFirstName', false],
			['userLastName', false],
			['lastVisitedAt', false],
		]);
		expect(getTableConfig(business).columns.map((column) => column.name)).toEqual([
			'id',
			'name',
			'scrapingSummaryInQueue',
			'scrapingSummaryInProgress',
			'scrapingSummaryCompleted',
		]);
	});
});

describe.skipIf(!connectionString).each([{ jit: false }, { jit: true }])('app shapes (jit: $jit)', ({ jit }) => {
	let pool: Pool;
	const connect = (client: Pool) => drizzle({ client, relations, jit });
	let db: ReturnType<typeof connect>;

	beforeAll(async () => {
		pool = createPool({ uri: connectionString! });
		db = connect(pool);

		await db.execute(sql`drop table if exists app_reviews`);
		await db.execute(sql`drop table if exists app_reviewer`);
		await db.execute(sql`drop table if exists app_sessions`);
		await db.execute(sql`drop table if exists app_business`);
		await db.execute(sql`
			create table app_reviewer (
				id varchar(255) not null,
				username varchar(255) not null,
				type varchar(255) not null,
				profileUrl varchar(255),
				isLocalGuide boolean,
				googleId varchar(255) unique,
				website varchar(255),
				primary key (id, username),
				index app_reviewer_username (username)
			)
		`);
		await db.execute(sql`
			create table app_reviews (
				id varchar(255) primary key,
				reviewerId varchar(255) not null,
				reviewerName varchar(255) not null,
				commentedAt datetime not null,
				commentedYear int generated always as (YEAR(commentedAt)) stored,
				llmAspectOpinionStatus char(25) not null,
				llmAspectOpinionStatusChangedAt datetime not null,
				llmAspectOpinionCount int,
				llmAspectOpinionReason text,
				foreign key (reviewerId, reviewerName) references app_reviewer (id, username),
				index app_reviews_status (llmAspectOpinionStatus)
			)
		`);
		await db.execute(sql`
			create table app_sessions (
				id serial primary key,
				type varchar(25) not null,
				userEmail varchar(255),
				userFirstName varchar(255),
				userLastName varchar(255),
				lastVisitedAt datetime
			)
		`);
		await db.execute(sql`
			create table app_business (
				id serial primary key,
				name varchar(255) not null,
				scrapingSummaryInQueue int not null default 0,
				scrapingSummaryInProgress int not null default 0,
				scrapingSummaryCompleted int not null default 0
			)
		`);
	});

	afterAll(async () => {
		await db.execute(sql`drop table if exists app_reviews`);
		await db.execute(sql`drop table if exists app_reviewer`);
		await db.execute(sql`drop table if exists app_sessions`);
		await db.execute(sql`drop table if exists app_business`);
		await pool.end();
	});

	beforeEach(async () => {
		await db.execute(sql`delete from app_reviews`);
		await db.execute(sql`delete from app_reviewer`);
		await db.execute(sql`delete from app_sessions`);
		await db.execute(sql`delete from app_business`);
	});

	const seedReviewers = () =>
		db.insert(reviewer).values([
			{ id: 'r1', username: 'ada', profile: google },
			{ id: 'r2', username: 'bob', profile: { _tag: 'ThirdPartyReviewer', website: 'https://bob' } },
		]);

	test('single-table inheritance reads one variant per row, and a variant column stays unique', async () => {
		await seedReviewers();
		expect(await db.select().from(reviewer).orderBy(asc(reviewer.id))).toEqual([
			{ id: 'r1', username: 'ada', profile: google },
			{ id: 'r2', username: 'bob', profile: { _tag: 'ThirdPartyReviewer', website: 'https://bob' } },
		]);
		expect(await db.select({ id: reviewer.id }).from(reviewer).where(eq(reviewer.profile._tag, 'GoogleReviewer')))
			.toEqual([{ id: 'r1' }]);

		await expect(db.insert(reviewer).values({ id: 'r3', username: 'cy', profile: google })).rejects.toThrow();
		// Other variants' rows leave the unique column NULL, which MySQL does not count as a duplicate.
		await db.insert(reviewer).values({
			id: 'r4',
			username: 'dee',
			profile: { _tag: 'ThirdPartyReviewer', website: 'x' },
		});
	});

	test('a status union writes its shared column and clears the variant left behind', async () => {
		await seedReviewers();
		await db.insert(reviews).values({
			id: 'v1',
			reviewerId: 'r1',
			reviewerName: 'ada',
			commentedAt: at,
			llmAspectOpinion: { _tag: 'Completed', statusChangedAt: at, count: 3 },
		});
		expect(await db.select({ year: reviews.commentedYear, llm: reviews.llmAspectOpinion }).from(reviews)).toEqual([
			{ year: 2026, llm: { _tag: 'Completed', statusChangedAt: at, count: 3 } },
		]);

		await db.update(reviews).set({ llmAspectOpinion: { _tag: 'Failed', statusChangedAt: at, reason: 'timeout' } });
		const [raw] = (await pool.query('select * from app_reviews'))[0] as Record<string, unknown>[];
		expect(raw).toMatchObject({
			llmAspectOpinionStatus: 'Failed',
			llmAspectOpinionCount: null,
			llmAspectOpinionReason: 'timeout',
		});
	});

	test('on duplicate key update takes a union in its set', async () => {
		await seedReviewers();
		const row = {
			id: 'v1',
			reviewerId: 'r1',
			reviewerName: 'ada',
			commentedAt: at,
			llmAspectOpinion: { _tag: 'Initial', statusChangedAt: at },
		} as const;
		await db.insert(reviews).values(row);
		await db.insert(reviews).values(row).onDuplicateKeyUpdate({
			set: { llmAspectOpinion: { _tag: 'Completed', statusChangedAt: at, count: 7 } },
		});
		expect(await db.select({ llm: reviews.llmAspectOpinion }).from(reviews)).toEqual([
			{ llm: { _tag: 'Completed', statusChangedAt: at, count: 7 } },
		]);
	});

	test('insert select copies a union from another table', async () => {
		await seedReviewers();
		await db.insert(reviews).values({
			id: 'v1',
			reviewerId: 'r1',
			reviewerName: 'ada',
			commentedAt: at,
			llmAspectOpinion: { _tag: 'Failed', statusChangedAt: at, reason: 'x' },
		});
		const source = alias(reviews, 'source');
		await db.insert(reviews).select(
			db.select({
				id: sql<string>`concat(${source.id}, '-copy')`.as('id'),
				reviewerId: source.reviewerId,
				reviewerName: source.reviewerName,
				commentedAt: source.commentedAt,
				llmAspectOpinion: source.llmAspectOpinion,
			}).from(source),
		);
		expect(await db.select({ id: reviews.id, llm: reviews.llmAspectOpinion }).from(reviews).orderBy(asc(reviews.id)))
			.toEqual([
				{ id: 'v1', llm: { _tag: 'Failed', statusChangedAt: at, reason: 'x' } },
				{ id: 'v1-copy', llm: { _tag: 'Failed', statusChangedAt: at, reason: 'x' } },
			]);
	});

	test('a left join over a composite foreign key nests the union, and a missing row is null', async () => {
		await seedReviewers();
		await db.execute(sql`set foreign_key_checks = 0`);
		await db.insert(reviews).values([
			{
				id: 'v1',
				reviewerId: 'r1',
				reviewerName: 'ada',
				commentedAt: at,
				llmAspectOpinion: { _tag: 'Initial', statusChangedAt: at },
			},
			{
				id: 'v2',
				reviewerId: 'gone',
				reviewerName: 'gone',
				commentedAt: at,
				llmAspectOpinion: { _tag: 'Initial', statusChangedAt: at },
			},
		]);
		await db.execute(sql`set foreign_key_checks = 1`);

		const rows = await db.select({ id: reviews.id, profile: reviewer.profile }).from(reviews).leftJoin(
			reviewer,
			sql`${reviews.reviewerId} = ${reviewer.id} and ${reviews.reviewerName} = ${reviewer.username}`,
		).orderBy(asc(reviews.id));
		expect(rows).toEqual([{ id: 'v1', profile: google }, { id: 'v2', profile: null }]);
	});

	test('relational queries load composite relations and take groups in columns and where', async () => {
		await seedReviewers();
		await db.insert(reviews).values({
			id: 'v1',
			reviewerId: 'r1',
			reviewerName: 'ada',
			commentedAt: at,
			llmAspectOpinion: { _tag: 'Completed', statusChangedAt: at, count: 3 },
		});

		expect(
			await db.query.reviews.findMany({
				columns: { id: true, llmAspectOpinion: true },
				where: { llmAspectOpinion: { _tag: 'Completed', Completed: { count: { gt: 1 } } } },
				with: { reviewer: { columns: { username: true, profile: true } } },
			}),
		).toEqual([{
			id: 'v1',
			llmAspectOpinion: { _tag: 'Completed', statusChangedAt: at, count: 3 },
			reviewer: { username: 'ada', profile: google },
		}]);

		expect(
			await db.query.reviewer.findFirst({
				columns: { id: true },
				where: { profile: { _tag: 'GoogleReviewer' } },
				with: { reviews: { columns: { id: true } } },
			}),
		).toEqual({ id: 'r1', reviews: [{ id: 'v1' }] });
	});

	test('an embed() inside a variant is written and read nested', async () => {
		const user = { email: 'a@b.c', firstName: 'Ada', lastName: 'L' };
		await db.insert(sessions).values([
			{ type: { _tag: 'Permanent', user } },
			{ type: { _tag: 'Temporary' } },
		]);
		expect(await db.select({ type: sessions.type }).from(sessions).orderBy(asc(sessions.id))).toEqual([
			{ type: { _tag: 'Permanent', user } },
			{ type: { _tag: 'Temporary' } },
		]);
		expect(
			await db.query.sessions.findMany({ where: { type: { Permanent: { user: { email: 'a@b.c' } } } } }),
		).toMatchObject([{ type: { _tag: 'Permanent', user } }]);
	});

	test('column defaults fill an embed() group left out of the insert', async () => {
		await db.insert(business).values({ name: 'b' });
		await db.update(business).set({ scrapingSummary: { inQueue: sql`${business.scrapingSummary.inQueue} + 1` } });
		expect(await db.select({ summary: business.scrapingSummary }).from(business)).toEqual([
			{ summary: { inQueue: 1, inProgress: 0, completed: 0 } },
		]);
	});
});
