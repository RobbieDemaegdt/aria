/**
 * Resolves Newtonsoft.Json `$id` / `$ref` back-references in raw JSON tool responses so repeated `Project`,
 * `Customer`, `Task`, or `Assignee` objects serialized as `{"$ref":"<id>"}` retain their `ID` and name fields.
 */
export function resolveJsonRefs<T>(root: T): T {
  if (!root || typeof root !== "object") return root;

  const byRefId = new Map<string, Record<string, unknown>>();
  const visited = new WeakSet<object>();

  const collect = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (visited.has(node)) return;
    visited.add(node);
    if (Array.isArray(node)) {
      for (const item of node) collect(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    const rawId = obj.$id;
    if ((typeof rawId === "string" && rawId.trim()) || (typeof rawId === "number" && Number.isFinite(rawId))) {
      byRefId.set(String(rawId).trim(), obj);
    }
    for (const val of Object.values(obj)) {
      collect(val);
    }
  };

  collect(root);
  if (byRefId.size === 0) return root;

  const deref = (node: unknown, ancestors: Set<object>): unknown => {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) {
      return node.map((item) => deref(item, ancestors));
    }
    const obj = node as Record<string, unknown>;
    const rawRef = obj.$ref;
    if ((typeof rawRef === "string" && rawRef.trim()) || (typeof rawRef === "number" && Number.isFinite(rawRef))) {
      const target = byRefId.get(String(rawRef).trim());
      if (target) {
        if (ancestors.has(target)) {
          return {
            ...(target.ID !== undefined ? { ID: target.ID } : {}),
            ...(target.id !== undefined ? { id: target.id } : {}),
            ...(target.Title !== undefined ? { Title: target.Title } : {}),
            ...(target.Name !== undefined ? { Name: target.Name } : {}),
          };
        }
        const nextAncestors = new Set(ancestors);
        nextAncestors.add(target);
        const resolvedTarget: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(target)) {
          if (k === "$id") continue;
          resolvedTarget[k] = deref(v, nextAncestors);
        }
        for (const [k, v] of Object.entries(obj)) {
          if (k === "$ref") continue;
          resolvedTarget[k] = deref(v, nextAncestors);
        }
        return resolvedTarget;
      }
    }
    if (ancestors.has(obj)) return obj;
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(obj);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = deref(v, nextAncestors);
    }
    return out;
  };

  return deref(root, new Set<object>()) as T;
}


/** Extracts JSON objects/arrays from an MCP tool result (`content` string, array of `{ text }` parts, or object). */
export function extractJsonPayloads(raw: unknown): unknown[] {
  if (raw === null || raw === undefined) return [];
  const tryParse = (text: string): unknown[] => {
    const trimmed = text.trim();
    if (!trimmed) return [];
    try {
      return [resolveJsonRefs(JSON.parse(trimmed))];
    } catch {
      const firstBrace = trimmed.search(/[[{]/);
      const lastBrace = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        try {
          return [resolveJsonRefs(JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)))];
        } catch {
          return [];
        }
      }
      return [];
    }
  };
  if (typeof raw === "string") return tryParse(raw);
  if (Array.isArray(raw)) {
    const out: unknown[] = [resolveJsonRefs(raw)];
    for (const item of raw) {
      if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
        out.push(...tryParse((item as { text: string }).text));
      }
    }
    return out;
  }
  if (typeof raw === "object") {
    const obj = resolveJsonRefs(raw) as Record<string, unknown>;
    const out: unknown[] = [obj];
    if (typeof obj.content === "string") out.push(...tryParse(obj.content));
    else if (Array.isArray(obj.content)) out.push(...extractJsonPayloads(obj.content));
    if (typeof obj.detailedContent === "string") out.push(...tryParse(obj.detailedContent));
    return out;
  }
  return [];
}

/** A payload's list of items: its `value`, `tasks`, `messages` or `entries` array, the payload itself if it's an array, or the payload alone. */
export function payloadItems(payload: unknown): unknown[] {
  return Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object"
      ? Array.isArray((payload as { value?: unknown }).value)
        ? ((payload as { value: unknown[] }).value)
        : Array.isArray((payload as { tasks?: unknown }).tasks)
          ? ((payload as { tasks: unknown[] }).tasks)
          : Array.isArray((payload as { messages?: unknown }).messages)
            ? ((payload as { messages: unknown[] }).messages)
            : Array.isArray((payload as { entries?: unknown }).entries)
              ? ((payload as { entries: unknown[] }).entries)
              : [payload]
      : [];
}
