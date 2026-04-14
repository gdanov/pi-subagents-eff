/**
 * Effect Schema -> JSON Schema post-processor for the Pi tool boundary.
 *
 * Pi's tool framework registers tools using a JSON Schema describing the
 * parameters object. Effect Schema's JSONSchema generator emits anyOf
 * for unions, but Google's tool-calling API rejects anyOf. The original
 * code worked around this by typing those fields as Type.Any() (see
 * schemas.ts:8,58,72,99).
 *
 * Strategy here: generate a strict JSON Schema from Effect Schema, then
 * walk the tree and coerce a documented set of field paths to
 * `{ type: "object", additionalProperties: true }` — preserving the
 * permissive behavior at the Pi boundary while keeping the Effect
 * Schema strict for runtime decoding.
 *
 * Implementation lands at Phase 11 (entry swap).
 */
export {};
