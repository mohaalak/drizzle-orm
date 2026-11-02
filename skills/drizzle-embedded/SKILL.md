---
name: drizzle-embedded
description: Grouped columns in Drizzle tables via `embed()` and `taggedUnion()` (our drizzle-orm fork). Load when a schema uses or should use either — value objects like an address, or a polymorphic reference like "uploaded by staff OR parent OR system" — and when writing queries, inserts, updates, relational queries, validators (zod etc.) or drizzle-seed code against such a table.
---

# embed() and taggedUnion()

Both come from our fork of drizzle-orm (installed as `drizzle-orm`), exported from every dialect core: `drizzle-orm/pg-core`, `mysql-core`, `sqlite-core`, `singlestore-core`, `mssql-core`, `cockroach-core`. Upstream drizzle does not have them; code using them only runs against the fork.

The one idea behind both: **columns stay flat in the database; TypeScript sees a nested object.** Every read, write, filter and reference uses the nested shape.

## embed(): a group of columns

```ts
import { embed, integer, pgTable, serial, text } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
	id: serial().primaryKey(),
	address: embed({
		street: text(),
		city: text().notNull(),
		geo: embed({ lat: integer(), lng: integer() }), // groups nest
	}),
	billing: embed({ zip: text('billing_zip_code') }, { prefix: 'bill_' }),
});
// columns: id, address_street, address_city, address_geo_lat, address_geo_lng, billing_zip_code
```

- **Naming**: a column's DB name is the group's prefix + its key. The prefix defaults to `<groupKey>_`; `{ prefix: '' }` drops it. A column given an explicit name (`text('billing_zip_code')`) keeps that name exactly. Table casing (`snakeCase.table`, `casing: 'snake_case'`) applies to the prefixed name: `homeAddress.zipCode` → `home_address_zip_code`. Without casing it is `homeAddress_zipCode`, which Postgres needs quoted — prefer snake_case casing.
  - A `prefix` is concatenated as written, and casing finds word boundaries only at `_` or a capital letter: `{ prefix: 'llmAspectOpinion' }` + `count` → `llmAspectOpinioncount`, under any casing. For camelCase columns (`llmAspectOpinionCount`, what TypeORM embeddeds produce) keep the default prefix and use `camelCase.table` (from `drizzle-orm/<dialect>-core`).
- **Referencing**: `users.address.city` and `users.address.geo.lat` are ordinary columns: use them in `eq()`, `orderBy`, indexes (`index().on(t.address.city)`), joins, aliases.
- **Reading**: `select()` returns `{ address: { street, city, geo: { lat, lng } } }`. A group whose columns are all NULL reads as an object of nulls, not `null`. A left-joined table with no match reads as `null` as a whole. Partial selects take a whole group (`{ address: users.address }`) or one column (`{ lat: users.address.geo.lat }`).
- **Inserting**: pass nested values. A group is required when any column in it is required; a group whose columns are all optional may be left out.
- **Updating**: a nested `set` writes only the columns given — `set({ address: { city: 'Rome' } })` leaves `street` alone. `null` clears every column in a group: `set({ billing: null, address: { geo: null } })`.
- **Returning**: `returning()` on insert, update and delete takes whole groups or single columns, like `select`.
- **Insert column lists** may name a group: `db.insert(users, 'name', 'address')` covers every `address.*` column. Dotted keys (`'address.city'`) also work. Naming a group and a column inside it is an error.
- **`insert().select()`** takes nested selections: `qb.select({ name: src.name, address: { city: src.city } })`.
- **Relational queries** (`db.query.*`) take groups nested in `columns`, `where` and `orderBy`:

  ```ts
  db.query.users.findMany({
  	columns: { id: true, address: { city: true, geo: { lat: true } } }, // or { address: true } / { address: false }
  	where: { address: { city: 'Berlin', geo: { lat: { gt: 1 } } } },
  	orderBy: { address: { geo: { lat: 'desc' } } },
  });
  ```

  A relation cannot have the same name as a group of its table — `defineRelations` throws.

## taggedUnion(): one of several variants

Use it for a column group that holds exactly one of several shapes, chosen by a tag column — the classic polymorphic reference.

```ts
import { integer, pgTable, serial, taggedUnion, text } from 'drizzle-orm/pg-core';

export const files = pgTable('files', {
	id: serial().primaryKey(),
	uploader: taggedUnion('kind', text(), {
		staff: { staffId: integer().notNull(), note: text() },
		parent: { parentId: integer().notNull() },
		system: {}, // a variant may have no columns
	}),
});
// columns: uploader_kind (NOT NULL), uploader_staffId, uploader_note, uploader_parentId (all nullable)
```

Signature: `taggedUnion(tagKey, tagColumnBuilder, variants, config?)`; `config` is the same `{ prefix }` as `embed()`.

- **Type**: `files.$inferSelect['uploader']` is a discriminated union — `{ kind: 'staff'; staffId: number; note: string | null } | { kind: 'parent'; parentId: number } | { kind: 'system' }`. Narrow on the tag: `if (row.uploader.kind === 'staff') row.uploader.staffId // number`.
- **Naming**: variant columns take the union's prefix **without** the variant name: `uploader_staffId`, not `uploader_staff_staffId`. Two columns whose names collide must be given explicit names.
- **Storage**: the tag column is always `NOT NULL`. Every variant column is nullable in the database, because other variants' rows leave it empty. The `.notNull()` you write on a variant column holds only in TypeScript and at runtime write time. **The database does not enforce it**; add a `CHECK` constraint yourself if you need that guarantee.
- **Shared columns**: variants declaring a column under the same key share one DB column, referenced on the union itself (`owners.owner.campusId`, not `owners.owner.campus.campusId`). It is `NOT NULL` only when every variant declares it `.notNull()`. Its declarations must agree on type and name, or table definition throws.
- **Nesting**: a variant may contain `embed()` groups and further `taggedUnion()`s; an `embed()` may contain a union.
- **Referencing**: `files.uploader.kind` (tag, typed as the variant names), `files.uploader.staff.staffId` (variant column), `files.uploader.campusId` (shared column).
- **Writing**: always pass the tag. Writing a variant sets the tag, writes the given columns, and clears every column of the other variants (and shared columns the variant doesn't declare). An unknown tag throws. A union cannot be set to `null`.
- **Switching variants in an update**: `set({ uploader: { kind: 'parent', parentId: 1 } })` clears the staff columns. The update type does not force the new variant's required columns — when the row changes variant, pass every required column of the new variant, or it reads back with `null` where the type promises a value.
- **Reading a variant column alone**: outside the whole union, a variant's columns read as stored, so `select({ staffId: files.uploader.staff.staffId })` is `number | null`.
- **Relational queries**: `where`, `columns` and `orderBy` follow the column map, not the folded row: the tag and shared columns sit on the union, a variant's own columns under its variant — `where: { uploader: { kind: 'staff', staff: { staffId: 7 } } }`, not `{ uploader: { staffId: 7 } }` (that throws `Unknown relational filter field`). Unions come back folded in rows and loaded relations.
- **Restrictions**: a variant cannot be named after the tag key, cannot contain a column with the tag key, and a variant column cannot be a primary key.

## Migrations

drizzle-kit is the stock upstream package; it reads the table's flat columns, so `generate` and `push` see `address_city`, `uploader_kind`, etc. as plain columns. After changing a grouped schema, read the generated SQL before applying it. `drizzle-kit pull` never produces `embed()` or `taggedUnion()` — regroup pulled columns by hand.

To adopt drizzle on a database whose schema already exists (for example one migrated by another ORM), baseline it: write the schema, run `drizzle-kit generate` into an empty migrations folder, then run `migrate(db, { migrationsFolder, init: true })` once against each existing database. `init` records that one migration as applied without running it. It writes nothing and returns `{ exitCode: 'databaseMigrations' }` when the database already has drizzle migrations recorded, or `{ exitCode: 'localMigrations' }` when the folder holds more than one migration. Fresh databases run the baseline normally with a plain `migrate()`. `init` is public only in our fork; upstream marks it `@internal`.

## Installing and releasing the fork

Apps install the fork from GitHub Packages under an alias, so imports stay `drizzle-orm`:

```jsonc
// package.json
"drizzle-orm": "npm:@mohaalak/drizzle-orm@1.0.0-rc.5.pxp.1"
```
```ini
# .npmrc — the token needs read:packages
@mohaalak:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Releases are built and published by `.github/workflows/publish-github-packages.yaml` on `mohaalak/drizzle-orm`. It renames only the packed manifest; the source package stays `drizzle-orm`. To release after merging upstream into `feat/embedded-columns`:

1. Run `pnpm build:orm` and the fork's tests (`drizzle-orm/tests/*embed*`, `*tagged-union*`, `mysql-migrate-init`).
2. Pick the version `<upstream version>.pxp.<n>`. Examples: `1.0.0-rc.5.pxp.2` for a second fork release on rc.5, and `1.0.0-rc.6.pxp.1` after merging rc.6. Separate `pxp` with a dot, not a hyphen: `rc.5-pxp.1` sorts above every later upstream rc, and `rc.10-pxp.1` sorts below `rc.9-pxp.1`. Upstream's stable `1.0.0` needs `1.0.1-pxp.1`, because `1.0.0-pxp.1` sorts below `1.0.0` and fails drizzle-kit's `>=1.0.0` peer range.
3. Push the branch and tag:
   ```sh
   git push origin feat/embedded-columns
   git tag pxp-v1.0.0-rc.6.pxp.1 && git push origin pxp-v1.0.0-rc.6.pxp.1
   ```
   You can also run the workflow manually (Actions → "Publish to GitHub Packages") with a `version` input.
4. Bump the alias version in apps. A version can't be republished; to redo a release, bump `<n>`.

## Validators and seeding

For `createSelectSchema` / `createInsertSchema` / `createUpdateSchema` (zod, valibot, typebox, arktype, effect-schema) and for `drizzle-seed` against these tables, read [tooling.md](tooling.md).
