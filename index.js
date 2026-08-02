#!/usr/bin/env node
// @ts-check
import { exiftool } from "exiftool-vendored";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";

const USAGE = `Usage: exif-timestamps [options]

Reads the EXIF capture time of every file in a directory, recursively, and
writes the results to a CSV.

Options:
  -d, --dir <directory>  Directory to scan (default: current directory)
  -o, --out <file>       CSV file to write (default: timestamps.csv)
  -h, --help             Show this help
  -v, --version          Show the version number`;

// Directories that are never worth handing to exiftool
const IGNORED_DIRECTORIES = new Set(["node_modules"]);

/**
 * @typedef {object} TimestampRow
 * @property {string} path Path to the file, relative to the input directory
 * @property {string} timestamp The file's DateTimeOriginal, as written by the camera
 */

/**
 * @typedef {object} SkippedFile
 * @property {string} path Path to the file, relative to the input directory
 * @property {"no-capture-date" | "error"} kind Coarse bucket, for the log summary
 * @property {string} reason Human-readable detail for the log
 */

/**
 * @typedef {object} ScanResult
 * @property {TimestampRow[]} rows Files that had a capture date
 * @property {SkippedFile[]} skipped Files exiftool saw but that produced no row
 */

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// exiftool's messages can span several lines; the log keeps one line per file
/**
 * @param {string} text
 * @returns {string}
 */
function toSingleLine(text) {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * @param {string[]} argv
 */
function parseCommandLine(argv) {
  try {
    return parseArgs({
      args: argv.slice(2),
      options: {
        dir: { type: "string", short: "d", default: process.cwd() },
        out: { type: "string", short: "o", default: "timestamps.csv" },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    process.exit(1);
  }
}

// Fail early on a bad --dir rather than letting readdir throw a bare ENOENT
/**
 * @param {string} dir
 * @returns {Promise<string>}
 */
async function resolveInputDirectory(dir) {
  const fullPath = path.resolve(dir);
  const stats = await fs.stat(fullPath).catch(() => null);

  if (!stats?.isDirectory()) {
    console.error(`Not a directory: ${fullPath}`);
    process.exit(1);
  }

  return fullPath;
}

// Dotfiles like .DS_Store, anything inside a dot-directory, and the ignore
// list above all get dropped
/**
 * @param {string} relativePath
 * @returns {boolean}
 */
function isIgnored(relativePath) {
  return relativePath
    .split(path.sep)
    .some(
      (segment) => segment.startsWith(".") || IGNORED_DIRECTORIES.has(segment),
    );
}

// Returns the ignored count alongside the files so the log can account for
// every file the walk saw, without listing each one
/**
 * @param {string} dirPath
 * @returns {Promise<{ files: string[], ignoredCount: number }>}
 */
async function readAllFilesRecursively(dirPath) {
  const entries = await fs.readdir(dirPath, {
    recursive: true,
    withFileTypes: true,
  });
  const allFiles = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.resolve(entry.parentPath, entry.name));
  const files = allFiles.filter(
    (fullPath) => !isIgnored(path.relative(dirPath, fullPath)),
  );

  return { files, ignoredCount: allFiles.length - files.length };
}

/**
 * @param {string[]} files
 * @param {string} baseDirectory
 * @returns {Promise<ScanResult>}
 */
async function getExifTimestampsFromFiles(files, baseDirectory) {
  // Every file yields exactly one of the two; the `never`s let a truthiness
  // check on either key narrow the pair apart below
  /** @type {({ row: TimestampRow, skipped?: never } | { row?: never, skipped: SkippedFile })[]} */
  const results = await Promise.all(
    files.map(async (file) => {
      // Where the file sits inside the directory that was passed in, so
      // same-named files in different folders stay distinguishable
      const relativePath = path.relative(baseDirectory, file);

      /** @type {import("exiftool-vendored").Tags} */
      let tags;

      try {
        tags = await exiftool.read(file);
      } catch (error) {
        return {
          skipped: {
            path: relativePath,
            kind: /** @type {const} */ ("error"),
            reason: `exiftool failed: ${toSingleLine(errorMessage(error))}`,
          },
        };
      }

      const warnings = tags.errors ?? [];

      if (warnings.length > 0) {
        console.warn("Metadata warnings:", warnings);
      }

      const { DateTimeOriginal } = tags;

      // Skip files that have no capture date. exiftool reports an unreadable
      // file as a warning rather than throwing, so a file that hit any warning
      // on the way to having no date is logged as an error, not a plain miss
      if (!DateTimeOriginal) {
        return {
          skipped:
            warnings.length > 0
              ? {
                  path: relativePath,
                  kind: /** @type {const} */ ("error"),
                  reason: `no capture date (${toSingleLine(warnings.join("; "))})`,
                }
              : {
                  path: relativePath,
                  kind: /** @type {const} */ ("no-capture-date"),
                  reason: "no capture date",
                },
        };
      }

      // // Camera info
      // console.log(tags.Make, tags.Model, tags.LensModel);
      // console.log(tags.ISO, tags.FNumber, tags.ExposureTime);
      // console.log(tags.GPSLatitude, tags.GPSLongitude);

      return {
        row: {
          path: relativePath,
          // DateTimeOriginal is usually an ExifDateTime object, but exiftool
          // hands back a plain string when it can't parse the value. Both
          // rawValue and toString() can come back empty on a malformed date,
          // hence the last fallback
          timestamp:
            typeof DateTimeOriginal === "string"
              ? DateTimeOriginal
              : (DateTimeOriginal.rawValue ??
                DateTimeOriginal.toString() ??
                ""),
        },
      };
    }),
  );

  // Promise.all preserves input order, so both lists follow the walk order
  return {
    rows: results.flatMap((result) => (result.row ? [result.row] : [])),
    skipped: results.flatMap((result) =>
      result.skipped ? [result.skipped] : [],
    ),
  };
}

/**
 * @param {TimestampRow[]} results
 * @param {string} [csvPath]
 * @returns {Promise<string>} Absolute path of the file that was written
 */
async function writeResultsToCsv(results, csvPath = "timestamps.csv") {
  // Quote a value only when it would otherwise break the row, and escape any
  // quotes inside it by doubling them
  /**
   * @param {unknown} value
   * @returns {string}
   */
  const escapeCsvValue = (value) => {
    const stringValue = String(value ?? "");

    if (/[",\r\n]/.test(stringValue)) {
      return `"${stringValue.replaceAll('"', '""')}"`;
    }

    return stringValue;
  };

  /** @type {(keyof TimestampRow)[]} */
  const header = ["path", "timestamp"];

  const rows = results.map((result) =>
    header.map((column) => escapeCsvValue(result[column])).join(","),
  );

  const csv = [header.join(","), ...rows].join("\n") + "\n";

  // Relative paths resolve against the directory the script was run from
  const fullPath = path.resolve(csvPath);
  await fs.writeFile(fullPath, csv, "utf8");

  return fullPath;
}

/**
 * @param {object} summary
 * @param {string} summary.inputDirectory
 * @param {string} summary.csvPath Absolute path of the CSV that was written
 * @param {number} summary.scannedCount Files handed to exiftool
 * @param {number} summary.ignoredCount Files dropped before exiftool saw them
 * @param {TimestampRow[]} summary.rows
 * @param {SkippedFile[]} summary.skipped
 * @returns {Promise<string>} Absolute path of the file that was written
 */
async function writeRunLog({
  inputDirectory,
  csvPath,
  scannedCount,
  ignoredCount,
  rows,
  skipped,
}) {
  const noCaptureDate = skipped.filter(
    (file) => file.kind === "no-capture-date",
  ).length;
  const errors = skipped.length - noCaptureDate;

  const lines = [
    `exif-timestamps run at ${new Date().toISOString()}`,
    "",
    `Scanned directory: ${inputDirectory}`,
    `CSV written to:    ${csvPath}`,
    "",
    `Files read:      ${scannedCount}`,
    `Rows written:    ${rows.length}`,
    `Skipped:         ${skipped.length} (${noCaptureDate} with no capture date, ${errors} with errors)`,
    `Filtered out:    ${ignoredCount} (dotfiles, dot-directories, ${[...IGNORED_DIRECTORIES].join(", ")})`,
  ];

  if (skipped.length > 0) {
    lines.push("", "Skipped files");
    for (const file of skipped) {
      lines.push(`  ${file.path} — ${file.reason}`);
    }
  }

  // The log sits next to the CSV under the same name, so `--out trip.csv`
  // produces `trip.log`
  const fullPath = path.join(
    path.dirname(csvPath),
    `${path.basename(csvPath, path.extname(csvPath))}.log`,
  );
  await fs.writeFile(fullPath, lines.join("\n") + "\n", "utf8");

  return fullPath;
}

const { values } = parseCommandLine(process.argv);

// Both bail before exiftool spins up its child process, so there's nothing
// to shut down on the way out
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

if (values.version) {
  // Read lazily so a problem here can only ever break --version
  /** @type {{ version: string }} */
  const pkg = createRequire(import.meta.url)("./package.json");
  console.log(pkg.version);
  process.exit(0);
}

const inputDirectory = await resolveInputDirectory(values.dir);
const { files, ignoredCount } = await readAllFilesRecursively(inputDirectory);
const { rows, skipped } = await getExifTimestampsFromFiles(
  files,
  inputDirectory,
);
const csvPath = await writeResultsToCsv(rows, values.out);

console.log(`Wrote ${rows.length} rows to ${csvPath}`);

// The CSV is the point of the run, so a log that can't be written is worth a
// warning but not a failure. fs errors name the path they failed on, so the
// message stays specific even though the path is derived out of reach here
try {
  const logPath = await writeRunLog({
    inputDirectory,
    csvPath,
    scannedCount: files.length,
    ignoredCount,
    rows,
    skipped,
  });
  console.log(`Skipped ${skipped.length} files, see ${logPath}`);
} catch (error) {
  console.warn(`Could not write log: ${errorMessage(error)}`);
}

// exiftool runs a long-lived child process, so it has to be shut down
// explicitly or node will never exit
await exiftool.end();
