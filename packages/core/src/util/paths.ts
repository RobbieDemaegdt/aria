import path from "node:path";

/**
 * How ARIA compares folders: resolved and case-insensitive, like Windows (Windows first, PLAN.md §0.4). JavaScript's
 * lowercasing covers non-ASCII letters too ("Café" and "CAFÉ"), which SQLite's NOCASE doesn't.
 */
export const pathKey = (p: string): string => path.resolve(p).toLowerCase();

export const samePath = (a: string, b: string): boolean => pathKey(a) === pathKey(b);
