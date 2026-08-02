#!/usr/bin/env node
import { exiftool } from "exiftool-vendored";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
//#region src/utils.ts
function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}
function toSingleLine(text) {
	return text.replace(/\s+/g, " ").trim();
}
function normalizeExtension(extension) {
	return extension.trim().toLowerCase().replace(/^\./, "");
}
function isIgnoredPath(relativePath, ignoredNames) {
	return relativePath.split(path.sep).some((segment) => segment.startsWith(".") || ignoredNames.has(segment));
}
function replaceExtension(filePath, extension) {
	return path.join(path.dirname(filePath), path.basename(filePath, path.extname(filePath)) + extension);
}
function escapeCsvValue(value) {
	const stringValue = String(value ?? "");
	if (/[",\r\n]/.test(stringValue)) return `"${stringValue.replaceAll("\"", "\"\"")}"`;
	return stringValue;
}
function toCsv(header, rows) {
	const body = rows.map((row) => header.map((column) => escapeCsvValue(row[column])).join(","));
	return [header.join(","), ...body].join("\n") + "\n";
}
//#endregion
//#region src/index.ts
const USAGE = `Usage: exif-timestamps [options]

Reads the EXIF capture time of every file in a directory, recursively, and
writes the results to a CSV.

Options:
  -d, --dir <directory>  Directory to scan (default: current directory)
  -o, --out <file>       CSV file to write (default: timestamps.csv)
  -i, --include <exts>   Only read these file extensions, comma-separated.
                         Repeatable, case-insensitive, leading dot optional
                         (default: every file)
  -h, --help             Show this help

Examples:
  exif-timestamps --include jpg,cr2,heic
  exif-timestamps -i jpg -i .CR2`;
const IGNORED_DIRECTORIES = /* @__PURE__ */ new Set(["node_modules"]);
function parseCommandLine(argv) {
	try {
		return parseArgs({
			args: argv.slice(2),
			options: {
				dir: {
					type: "string",
					short: "d",
					default: process.cwd()
				},
				out: {
					type: "string",
					short: "o",
					default: "timestamps.csv"
				},
				include: {
					type: "string",
					short: "i",
					multiple: true
				},
				help: {
					type: "boolean",
					short: "h",
					default: false
				}
			}
		});
	} catch (error) {
		console.error(errorMessage(error));
		console.error(USAGE);
		process.exit(1);
	}
}
async function resolveInputDirectory(dir) {
	const fullPath = path.resolve(dir);
	if (!(await fs.stat(fullPath).catch(() => null))?.isDirectory()) {
		console.error(`Not a directory: ${fullPath}`);
		process.exit(1);
	}
	return fullPath;
}
function parseIncludedExtensions(include) {
	if (!include) return null;
	const extensions = include.flatMap((value) => value.split(",")).map(normalizeExtension).filter((extension) => extension.length > 0);
	if (extensions.length === 0) {
		console.error("--include needs at least one file extension");
		console.error(USAGE);
		process.exit(1);
	}
	return [...new Set(extensions)];
}
async function readAllFilesRecursively(dirPath, includedExtensions) {
	const allFiles = (await fs.readdir(dirPath, {
		recursive: true,
		withFileTypes: true
	})).filter((entry) => entry.isFile()).map((entry) => path.resolve(entry.parentPath, entry.name));
	const candidates = allFiles.filter((fullPath) => !isIgnoredPath(path.relative(dirPath, fullPath), IGNORED_DIRECTORIES));
	const extensions = includedExtensions && new Set(includedExtensions);
	return {
		files: extensions ? candidates.filter((fullPath) => extensions.has(normalizeExtension(path.extname(fullPath)))) : candidates,
		ignoredCount: allFiles.length - candidates.length
	};
}
async function getExifTimestampsFromFiles(files, baseDirectory) {
	const results = await Promise.all(files.map(async (file) => {
		const relativePath = path.relative(baseDirectory, file);
		let tags;
		try {
			tags = await exiftool.read(file);
		} catch (error) {
			return { skipped: {
				path: relativePath,
				kind: "error",
				reason: `exiftool failed: ${toSingleLine(errorMessage(error))}`
			} };
		}
		const warnings = tags.errors ?? [];
		if (warnings.length > 0) console.warn("Metadata warnings:", warnings);
		const { DateTimeOriginal } = tags;
		if (!DateTimeOriginal) return { skipped: warnings.length > 0 ? {
			path: relativePath,
			kind: "error",
			reason: `no capture date (${toSingleLine(warnings.join("; "))})`
		} : {
			path: relativePath,
			kind: "no-capture-date",
			reason: "no capture date"
		} };
		return { row: {
			path: relativePath,
			timestamp: typeof DateTimeOriginal === "string" ? DateTimeOriginal : DateTimeOriginal.rawValue ?? DateTimeOriginal.toString() ?? ""
		} };
	}));
	return {
		rows: results.flatMap((result) => result.row ? [result.row] : []),
		skipped: results.flatMap((result) => result.skipped ? [result.skipped] : [])
	};
}
async function writeResultsToCsv(results, csvPath = "timestamps.csv") {
	const csv = toCsv(["path", "timestamp"], results);
	const fullPath = path.resolve(csvPath);
	await fs.writeFile(fullPath, csv, "utf8");
	return fullPath;
}
async function writeRunLog({ inputDirectory, csvPath, scannedCount, ignoredCount, includedExtensions, rows, skipped }) {
	const noCaptureDate = skipped.filter((file) => file.kind === "no-capture-date").length;
	const errors = skipped.length - noCaptureDate;
	const lines = [
		`exif-timestamps run at ${(/* @__PURE__ */ new Date()).toISOString()}`,
		"",
		`Scanned directory: ${inputDirectory}`,
		`CSV written to:    ${csvPath}`,
		"",
		`Files read:      ${scannedCount}`,
		`Rows written:    ${rows.length}`,
		`Skipped:         ${skipped.length} (${noCaptureDate} with no capture date, ${errors} with errors)`,
		`Filtered out:    ${ignoredCount} (dotfiles, dot-directories, ${[...IGNORED_DIRECTORIES].join(", ")})`
	];
	if (includedExtensions) lines.push(`Included:        ${includedExtensions.join(", ")}`);
	if (skipped.length > 0) {
		lines.push("", "Skipped files");
		for (const file of skipped) lines.push(`  ${file.path} — ${file.reason}`);
	}
	const fullPath = replaceExtension(csvPath, ".log");
	await fs.writeFile(fullPath, lines.join("\n") + "\n", "utf8");
	return fullPath;
}
const { values } = parseCommandLine(process.argv);
if (values.help) {
	console.log(USAGE);
	process.exit(0);
}
const includedExtensions = parseIncludedExtensions(values.include);
const inputDirectory = await resolveInputDirectory(values.dir);
const { files, ignoredCount } = await readAllFilesRecursively(inputDirectory, includedExtensions);
if (includedExtensions && files.length === 0) console.warn(`No files matched --include: ${includedExtensions.join(", ")}`);
const { rows, skipped } = await getExifTimestampsFromFiles(files, inputDirectory);
const csvPath = await writeResultsToCsv(rows, values.out);
console.log(`Wrote ${rows.length} rows to ${csvPath}`);
try {
	const logPath = await writeRunLog({
		inputDirectory,
		csvPath,
		scannedCount: files.length,
		ignoredCount,
		includedExtensions,
		rows,
		skipped
	});
	console.log(`Skipped ${skipped.length} files, see ${logPath}`);
} catch (error) {
	console.warn(`Could not write log: ${errorMessage(error)}`);
}
await exiftool.end();
//#endregion
export {};

//# sourceMappingURL=index.js.map