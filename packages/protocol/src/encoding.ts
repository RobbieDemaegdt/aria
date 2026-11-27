/**
 * R1: text a task damaged by reading UTF-8 with another encoding and writing it back. Windows PowerShell 5.1 reads a
 * file without a byte-order mark as Windows-1252, so `→` becomes `â†’`. ARIA counts such lines when a task finishes
 * (plain code, no model) and shows them on its Done and PR cards.
 */
export interface EncodingDamage {
  /** Lines the task added that look damaged. */
  lines: number;
  /** Files those lines are in. */
  files: number;
  /** Those files' paths (cleaned: no control or format characters), at most `ENCODING_DAMAGE_MAX_PATHS`. */
  paths: string[];
  /** The commit the task started from, to compare with. */
  base: string;
}

export const ENCODING_DAMAGE_MAX_PATHS = 20;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "3 lines in 2 files look like damaged text." */
export function encodingDamageText(damage: EncodingDamage): string {
  return `${plural(damage.lines, "line")} in ${plural(damage.files, "file")} ${damage.lines === 1 ? "looks" : "look"} like damaged text.`;
}
