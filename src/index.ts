#!/usr/bin/env node
import { exiftool } from "exiftool-vendored";
import type { Tags } from "exiftool-vendored";
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  errorMessage,
  isIgnoredPath,
  normalizeExtension,
  replaceExtension,
  toCsv,
  toSingleLine,
} from "./utils.ts";

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

// Directories that are never worth handing to exiftool
const IGNORED_DIRECTORIES = new Set(["node_modules"]);

// A type alias rather than an interface, so it carries the implicit index
// signature toCsv's constraint needs
type TimestampRow = {
  // Path to the file, relative to the input directory
  path: string;
  // The file's DateTimeOriginal, as written by the camera
  timestamp: string;
};

interface SkippedFile {
  // Path to the file, relative to the input directory
  path: string;
  // Coarse bucket, for the log summary
  kind: "no-capture-date" | "error";
  // Human-readable detail for the log
  reason: string;
}

interface ScanResult {
  // Files that had a capture date
  rows: TimestampRow[];
  // Files exiftool saw but that produced no row
  skipped: SkippedFile[];
}

// Every file yields exactly one of the two; the `never`s let a truthiness
// check on either key narrow the pair apart below
type FileOutcome = { row: TimestampRow; skipped?: never } | { row?: never; skipped: SkippedFile };

function parseCommandLine(argv: string[]) {
  try {
    return parseArgs({
      args: argv.slice(2),
      options: {
        dir: { type: "string", short: "d", default: process.cwd() },
        out: { type: "string", short: "o", default: "timestamps.csv" },
        // No default: an absent --include means "every extension", which is a
        // different thing from an empty list
        include: { type: "string", short: "i", multiple: true },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    console.error(errorMessage(error));
    console.error(USAGE);
    process.exit(1);
  }
}

// Fail early on a bad --dir rather than letting readdir throw a bare ENOENT
async function resolveInputDirectory(dir: string): Promise<string> {
  const fullPath = path.resolve(dir);
  const stats = await fs.stat(fullPath).catch(() => null);

  if (!stats?.isDirectory()) {
    console.error(`Not a directory: ${fullPath}`);
    process.exit(1);
  }

  return fullPath;
}

// `--include JPG,.cr2 -i heic` becomes ["jpg", "cr2", "heic"], so the list can
// be compared against path.extname() output directly. Returns null when the
// flag was never passed, which means every extension is welcome
function parseIncludedExtensions(
  // Raw --include values, one per flag
  include: string[] | undefined,
): string[] | null {
  if (!include) {
    return null;
  }

  const extensions = include
    .flatMap((value) => value.split(","))
    .map(normalizeExtension)
    .filter((extension) => extension.length > 0);

  // Only reachable via something like `--include ""` or `--include ,`, which
  // is a typo rather than a request to scan nothing
  if (extensions.length === 0) {
    console.error("--include needs at least one file extension");
    console.error(USAGE);
    process.exit(1);
  }

  return [...new Set(extensions)];
}

// Returns the ignored count alongside the files so the log can account for the
// files the walk dropped on its own, without listing each one
async function readAllFilesRecursively(
  dirPath: string,
  // Normalized, or null for all
  includedExtensions: string[] | null,
): Promise<{ files: string[]; ignoredCount: number }> {
  const entries = await fs.readdir(dirPath, {
    recursive: true,
    withFileTypes: true,
  });
  const allFiles = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.resolve(entry.parentPath, entry.name));
  const candidates = allFiles.filter(
    (fullPath) => !isIgnoredPath(path.relative(dirPath, fullPath), IGNORED_DIRECTORIES),
  );

  // A file with no extension has an empty extname, so it never matches a
  // filter — which is the right call, since there's nothing to match on
  const extensions = includedExtensions && new Set(includedExtensions);
  const files = extensions
    ? candidates.filter((fullPath) => extensions.has(normalizeExtension(path.extname(fullPath))))
    : candidates;

  return { files, ignoredCount: allFiles.length - candidates.length };
}

async function getExifTimestampsFromFiles(
  files: string[],
  baseDirectory: string,
): Promise<ScanResult> {
  const results = await Promise.all(
    files.map(async (file): Promise<FileOutcome> => {
      // Where the file sits inside the directory that was passed in, so
      // same-named files in different folders stay distinguishable
      const relativePath = path.relative(baseDirectory, file);

      let tags: Tags;

      try {
        tags = await exiftool.read(file);
      } catch (error) {
        return {
          skipped: {
            path: relativePath,
            kind: "error",
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
                  kind: "error",
                  reason: `no capture date (${toSingleLine(warnings.join("; "))})`,
                }
              : {
                  path: relativePath,
                  kind: "no-capture-date",
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
              : (DateTimeOriginal.rawValue ?? DateTimeOriginal.toString() ?? ""),
        },
      };
    }),
  );

  // Promise.all preserves input order, so both lists follow the walk order
  return {
    rows: results.flatMap((result) => (result.row ? [result.row] : [])),
    skipped: results.flatMap((result) => (result.skipped ? [result.skipped] : [])),
  };
}

// Returns the absolute path of the file that was written
async function writeResultsToCsv(
  results: TimestampRow[],
  csvPath: string = "timestamps.csv",
): Promise<string> {
  const csv = toCsv(["path", "timestamp"], results);

  // Relative paths resolve against the directory the script was run from
  const fullPath = path.resolve(csvPath);
  await fs.writeFile(fullPath, csv, "utf8");

  return fullPath;
}

interface RunSummary {
  inputDirectory: string;
  // Absolute path of the CSV that was written
  csvPath: string;
  // Files handed to exiftool
  scannedCount: number;
  // Files dropped before exiftool saw them
  ignoredCount: number;
  // Normalized, or null for all
  includedExtensions: string[] | null;
  rows: TimestampRow[];
  skipped: SkippedFile[];
}

// Returns the absolute path of the file that was written
async function writeRunLog({
  inputDirectory,
  csvPath,
  scannedCount,
  ignoredCount,
  includedExtensions,
  rows,
  skipped,
}: RunSummary): Promise<string> {
  const noCaptureDate = skipped.filter((file) => file.kind === "no-capture-date").length;
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

  // Only meaningful when a filter was actually passed. The count of files that
  // made it through is already up there as "Files read"
  if (includedExtensions) {
    lines.push(`Included:        ${includedExtensions.join(", ")}`);
  }

  if (skipped.length > 0) {
    lines.push("", "Skipped files");
    for (const file of skipped) {
      lines.push(`  ${file.path} — ${file.reason}`);
    }
  }

  // The log sits next to the CSV under the same name, so `--out trip.csv`
  // produces `trip.log`
  const fullPath = replaceExtension(csvPath, ".log");
  await fs.writeFile(fullPath, lines.join("\n") + "\n", "utf8");

  return fullPath;
}

const { values } = parseCommandLine(process.argv);

// Bails before exiftool spins up its child process, so there's nothing to
// shut down on the way out
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const includedExtensions = parseIncludedExtensions(values.include);
const inputDirectory = await resolveInputDirectory(values.dir);
const { files, ignoredCount } = await readAllFilesRecursively(inputDirectory, includedExtensions);

// An empty run is usually a typo in the filter, so name it. The CSV still gets
// written, for the same reason a directory of unreadable files still does
if (includedExtensions && files.length === 0) {
  console.warn(`No files matched --include: ${includedExtensions.join(", ")}`);
}

const { rows, skipped } = await getExifTimestampsFromFiles(files, inputDirectory);
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
    includedExtensions,
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
