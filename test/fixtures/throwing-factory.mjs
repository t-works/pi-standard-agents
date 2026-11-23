/**
 * Negative fixture for the PI smoke check: an extension whose default factory
 * throws must make PI exit non-zero with
 * `Failed to load extension: boom-from-factory`.
 *
 * Kept outside the `*.test.ts` glob so `npm test` never loads it.
 */
export default function throwingFactory() {
	throw new Error("boom-from-factory");
}
