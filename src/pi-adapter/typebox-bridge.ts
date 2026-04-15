import { Schema } from "effect";

const GOOGLE_ANYOF_FIELDS = new Set(["skill", "skills", "output", "reads"]);

function isGoogleAnyOfField(path: string): boolean {
	for (const field of GOOGLE_ANYOF_FIELDS) {
		if (path.endsWith(field) || path.endsWith(`${field}s`)) return true;
	}
	return false;
}

function walkAndCoerceAnyOf(node: unknown, path: string = ""): unknown {
	if (node === null || node === undefined) return node;
	if (typeof node !== "object") return node;

	if (Array.isArray(node)) {
		return node.map((item, i) => walkAndCoerceAnyOf(item, `${path}[${i}]`));
	}

	const obj = node as Record<string, unknown>;

	if ("anyOf" in obj && Array.isArray(obj.anyOf)) {
		if (isGoogleAnyOfField(path)) {
			return { type: "object", additionalProperties: true };
		}
	}

	if ("oneOf" in obj && Array.isArray(obj.oneOf)) {
		if (isGoogleAnyOfField(path)) {
			return { type: "object", additionalProperties: true };
		}
	}

	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		result[key] = walkAndCoerceAnyOf(value, path ? `${path}.${key}` : key);
	}
	return result;
}

export function effectSchemaToJsonSchema(schema: Schema.Schema<unknown>): {
	readonly dialect: string;
	readonly schema: unknown;
	readonly definitions?: Record<string, unknown>;
} {
	const raw = Schema.toJsonSchemaDocument(schema);
	const processed = walkAndCoerceAnyOf(raw.schema);
	return {
		...raw,
		schema: processed,
	};
}
