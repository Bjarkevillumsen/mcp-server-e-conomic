/**
 * Some MCP clients stringify object-typed tool arguments when the input schema
 * doesn't advertise `type: "object"` (see the `body` fields in tools/economic.ts).
 * Recover the intended object/array so it isn't sent to e-conomic as a JSON
 * string literal (which e-conomic rejects: "Expected a JSON with an object as
 * the root element").
 */
export function normalizeJsonBody<T>(value: T): T {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) {
    return value;
  }

  try {
    return JSON.parse(trimmed) as T;
  } catch {
    return value;
  }
}
