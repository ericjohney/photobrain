/**
 * The response a `Range` request header selects from a representation of
 * `size` bytes (RFC 9110 section 14): the whole body, one inclusive byte
 * slice, or nothing satisfiable.
 */
export type ByteRange =
	| { kind: "full" }
	| { kind: "partial"; start: number; end: number }
	| { kind: "unsatisfiable" };

const SINGLE_RANGE = /^bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i;

/**
 * Resolves one `bytes=a-b`, `bytes=a-`, or `bytes=-n` range against `size`.
 * The end clamps to `size - 1`; a first byte at or beyond `size`, or a zero
 * suffix (`-0`), is unsatisfiable. A missing header, multiple ranges, another
 * unit, `a > b`, or anything malformed is ignored (`full`), as RFC 9110
 * permits.
 */
export function parseByteRange(
	header: string | null | undefined,
	size: number,
): ByteRange {
	if (!header) return { kind: "full" };
	const match = SINGLE_RANGE.exec(header.trim());
	if (!match) return { kind: "full" };
	const [, first, last] = match;
	if (first === "") {
		if (last === "") return { kind: "full" };
		const suffix = Number(last);
		if (suffix === 0 || size === 0) return { kind: "unsatisfiable" };
		return {
			kind: "partial",
			start: Math.max(0, size - suffix),
			end: size - 1,
		};
	}
	const start = Number(first);
	if (last !== "" && Number(last) < start) return { kind: "full" };
	if (start >= size) return { kind: "unsatisfiable" };
	const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
	return { kind: "partial", start, end };
}
