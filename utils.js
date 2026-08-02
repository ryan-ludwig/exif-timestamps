// @ts-check
// Generic helpers with no knowledge of EXIF, exiftool, or this tool's CLI.
// Anything that encodes a decision about how exif-timestamps behaves belongs
// in index.js instead.
import path from "node:path";

/**
 * @param {unknown} error
 * @returns {string}
 */
export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// Callers that print one line per item can't have a message wrapping onto more
/**
 * @param {string} text
 * @returns {string}
 */
export function toSingleLine(text) {
  return text.replace(/\s+/g, " ").trim();
}

// `.JPG`, `JPG`, and ` jpg ` all normalize to `jpg`, so a user-typed extension
// and one from path.extname() can be compared directly
/**
 * @param {string} extension
 * @returns {string}
 */
export function normalizeExtension(extension) {
  return extension.trim().toLowerCase().replace(/^\./, "");
}

// A path counts as hidden if any segment is a dotfile or dot-directory, so a
// file nested inside `.git/` is caught the same as `.DS_Store` itself
/**
 * @param {string} relativePath
 * @param {ReadonlySet<string>} ignoredNames Directory names to drop outright
 * @returns {boolean}
 */
export function isIgnoredPath(relativePath, ignoredNames) {
  return relativePath
    .split(path.sep)
    .some((segment) => segment.startsWith(".") || ignoredNames.has(segment));
}

// Swaps the extension while keeping the directory, so a sibling file can be
// derived from a path the caller already has
/**
 * @param {string} filePath
 * @param {string} extension Including the leading dot, e.g. ".log"
 * @returns {string}
 */
export function replaceExtension(filePath, extension) {
  return path.join(
    path.dirname(filePath),
    path.basename(filePath, path.extname(filePath)) + extension,
  );
}

// Quote a value only when it would otherwise break the row, and escape any
// quotes inside it by doubling them
/**
 * @param {unknown} value
 * @returns {string}
 */
function escapeCsvValue(value) {
  const stringValue = String(value ?? "");

  if (/[",\r\n]/.test(stringValue)) {
    return `"${stringValue.replaceAll('"', '""')}"`;
  }

  return stringValue;
}

// The header doubles as the column order, so a row's extra keys are ignored
// and a missing one becomes an empty cell
/**
 * @template {Record<string, unknown>} Row
 * @param {(keyof Row & string)[]} header
 * @param {Row[]} rows
 * @returns {string} Complete CSV text, newline-terminated
 */
export function toCsv(header, rows) {
  const body = rows.map((row) =>
    header.map((column) => escapeCsvValue(row[column])).join(","),
  );

  return [header.join(","), ...body].join("\n") + "\n";
}
