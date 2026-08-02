// Generic helpers with no knowledge of EXIF, exiftool, or this tool's CLI.
// Anything that encodes a decision about how exif-timestamps behaves belongs
// in index.ts instead.
import path from "node:path";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Callers that print one line per item can't have a message wrapping onto more
export function toSingleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// `.JPG`, `JPG`, and ` jpg ` all normalize to `jpg`, so a user-typed extension
// and one from path.extname() can be compared directly
export function normalizeExtension(extension: string): string {
  return extension.trim().toLowerCase().replace(/^\./, "");
}

// A path counts as hidden if any segment is a dotfile or dot-directory, so a
// file nested inside `.git/` is caught the same as `.DS_Store` itself
export function isIgnoredPath(
  relativePath: string,
  // Directory names to drop outright
  ignoredNames: ReadonlySet<string>,
): boolean {
  return relativePath
    .split(path.sep)
    .some((segment) => segment.startsWith(".") || ignoredNames.has(segment));
}

// Swaps the extension while keeping the directory, so a sibling file can be
// derived from a path the caller already has
export function replaceExtension(
  filePath: string,
  // Including the leading dot, e.g. ".log"
  extension: string,
): string {
  return path.join(
    path.dirname(filePath),
    path.basename(filePath, path.extname(filePath)) + extension,
  );
}

// What a single cell is allowed to hold. Anything that needs more structure
// than this has to decide for itself how it becomes text before it gets here
export type CsvValue = string | number | boolean | null | undefined;

// Quote a value only when it would otherwise break the row, and escape any
// quotes inside it by doubling them
function escapeCsvValue(value: CsvValue): string {
  const stringValue = String(value ?? "");

  if (/[",\r\n]/.test(stringValue)) {
    return `"${stringValue.replaceAll('"', '""')}"`;
  }

  return stringValue;
}

// The header doubles as the column order, so a row's extra keys are ignored
// and a missing one becomes an empty cell. Returns complete CSV text,
// newline-terminated
export function toCsv<Row extends Record<string, CsvValue>>(
  header: (keyof Row & string)[],
  rows: Row[],
): string {
  const body = rows.map((row) => header.map((column) => escapeCsvValue(row[column])).join(","));

  return [header.join(","), ...body].join("\n") + "\n";
}
