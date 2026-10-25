import type { Column } from './column.ts';
import {
	declaredUnionNotNull,
	EmbeddedColumns,
	embeddedUnionKeyOf,
	embeddedUnionsOf,
	type EmbeddedUnionTagKey,
} from './embed.ts';
import { is } from './entity.ts';
import type { Simplify } from './utils.ts';

/** One variant of a `taggedUnion()` group, as a map of the columns its rows hold. */
export interface UnionVariantShape {
	readonly tag: string;
	/** The variant's columns, then the shared columns it declares. Columns carry their declared nullability. */
	readonly shape: Record<string, Column | EmbeddedColumns>;
}

/** A column that reads `notNull` as variant `variant` declares it, which the database does not store. */
function declaredColumn(column: Column, variant: string): Column {
	return Object.create(column, { notNull: { value: declaredUnionNotNull(column, variant), enumerable: true } });
}

function declaredGroup(group: EmbeddedColumns, variant: string): EmbeddedColumns {
	// A union nested in the variant builds its own variants.
	if (embeddedUnionKeyOf(group) !== undefined) return group;

	const result = new EmbeddedColumns();
	for (const [key, value] of Object.entries(group)) {
		result[key] = is(value, EmbeddedColumns) ? declaredGroup(value, variant) : declaredColumn(value as Column, variant);
	}
	return result;
}

/**
 * Splits a `taggedUnion()` group of a built table into its variants. Returns `undefined` for any other group.
 *
 * @internal
 */
export function unionVariantShapes(group: unknown): { key: string; variants: UnionVariantShape[] } | undefined {
	const key = embeddedUnionKeyOf(group);
	if (key === undefined) return undefined;

	const columns = group as Record<string, Column | EmbeddedColumns>;
	const { tags, shared } = embeddedUnionsOf(columns[key])!.at(-1)!.union;
	const variants = tags.map((tag): UnionVariantShape => {
		const own = columns[tag];
		const shape: Record<string, Column | EmbeddedColumns> = is(own, EmbeddedColumns)
			? { ...declaredGroup(own, tag) }
			: {};
		for (const [field, variants] of Object.entries(shared)) {
			if (variants.includes(tag)) shape[field] = declaredColumn(columns[field] as Column, tag);
		}
		return { tag, shape };
	});
	return { key, variants };
}

type UnionToIntersection<U> = (U extends any ? (arg: U) => void : never) extends (arg: infer I) => void ? I : never;

type LastOf<T> = UnionToIntersection<T extends any ? () => T : never> extends () => infer R ? R : never;

/** The members of a union as a tuple, in no guaranteed order. */
export type UnionToTuple<T, TLast = LastOf<T>> = [T] extends [never] ? []
	: [...UnionToTuple<Exclude<T, TLast>>, TLast];

/** The tag names of a `taggedUnion()` group of columns, such as `files.uploader`. */
export type UnionGroupTags<TGroup> = TGroup[EmbeddedUnionTagKey<TGroup> & keyof TGroup] extends
	{ _: { data: infer TData extends string } } ? TData : never;

/** The columns of variant `TTag` in a union group: its own, then the shared ones it declares. */
export type UnionVariantFields<TGroup, TTag extends string> = Simplify<
	& (TTag extends keyof TGroup ? TGroup[TTag] : {})
	& {
		[K in keyof TGroup as TGroup[K] extends { _: { unionShared: { [P in TTag]: boolean } } } ? K : never]: TGroup[K];
	}
>;

/** Whether a column is `NOT NULL` in the rows of variant `TTag`, as declared. */
export type UnionColumnNotNull<TColumn extends Column, TTag extends string> = TColumn['_'] extends
	{ unionShared: infer TShared } ? TShared extends { [P in TTag]: true } ? true : false
	: TColumn['_'] extends { unionMember: { notNull: infer TNotNull } } ? TNotNull
	: TColumn['_']['notNull'];
