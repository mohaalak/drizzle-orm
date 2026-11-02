# Validators and seeding with embed() and taggedUnion()

## Validators

`createSelectSchema`, `createInsertSchema` and `createUpdateSchema` from `drizzle-orm/zod` (and `drizzle-orm/valibot`, `typebox`, `typebox-legacy`, `arktype`, `effect-schema`) mirror the nested types: `z.infer<typeof schema>` equals `$inferSelect` / `$inferInsert`.

- **embed() groups** become nested objects. Flat dotted keys (`'address.city'`) are rejected. On insert a group is optional when all its columns are. On update every group is `.nullable().optional()`, matching `set({ group: null })`.
- **taggedUnion()** becomes a discriminated union on the tag. It rejects an unknown tag, a missing required variant column, and another variant's column (`{ kind: 'system', staffId: 1 }`). Nested unions are discriminated too. The update schema needs the tag and makes the variant's columns optional, and rejects `null` for the union.
- **Refinements** follow the nested shape:

  ```ts
  createInsertSchema(users, {
  	address: { city: (s) => s.min(2), geo: { lat: z.string().transform(Number) } },
  });
  createSelectSchema(files, {
  	uploader: { staff: { staffId: (s) => s.max(10) } }, // variant column: under its variant
  	owner: { campusId: (s) => s.min(1) }, // shared column: on the union, applies in every variant declaring it
  });
  ```

  A union's tag column cannot be refined.
- A view that selects a whole table (`qb.select({ user: users })`) nests that table's groups under `user`.

## drizzle-seed

`seed(db, { users, files })` fills groups and unions. Each union row gets exactly one variant, spread across all variants. The other variants' columns stay `NULL`. `dryRun()` returns rows nested.

`refine` takes the nested shape. A variant column goes under its variant, and a shared column goes on the union:

```ts
await seed(db, { files, owners }).refine((f) => ({
	files: {
		columns: {
			uploader: {
				kind: f.valuesFromArray({ values: ['staff', 'system'] }), // restricts which variants are produced
				staff: { staffId: f.valuesFromArray({ values: [7, 8] }) },
			},
		},
	},
	owners: { columns: { owner: { campusId: f.default({ defaultValue: 3 }) } } },
}));
```

- A tag value that is not a variant name throws.
- Setting a column to `false` (generate nothing) is allowed only when it is nullable in its variant. A `.notNull()` variant column throws.
- Dotted keys (`'owner.campusId'`) still work but need an `as never` cast, so use the nested form.
