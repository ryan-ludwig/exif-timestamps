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

/**
 * @param {string} dirPath
 * @returns {Promise<string[]>}
 */
async function readAllFilesRecursively(dirPath) {
  const entries = await fs.readdir(dirPath, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.resolve(entry.parentPath, entry.name))
    .filter((fullPath) => !isIgnored(path.relative(dirPath, fullPath)));
}

/**
 * @param {string[]} files
 * @param {string} baseDirectory
 * @returns {Promise<TimestampRow[]>}
 */
async function getExifTimestampsFromFiles(files, baseDirectory) {
  const results = await Promise.all(
    files.map(async (file) => {
      const tags = await exiftool.read(file);

      if ((tags.errors?.length ?? 0) > 0) {
        console.warn("Metadata warnings:", tags.errors);
      }

      const { DateTimeOriginal } = tags;

      // Skip files that have no capture date
      if (!DateTimeOriginal) {
        return null;
      }

      // // Camera info
      // console.log(tags.Make, tags.Model, tags.LensModel);
      // console.log(tags.ISO, tags.FNumber, tags.ExposureTime);
      // console.log(tags.GPSLatitude, tags.GPSLongitude);

      return {
        // Where the file sits inside the directory that was passed in, so
        // same-named files in different folders stay distinguishable
        path: path.relative(baseDirectory, file),
        // DateTimeOriginal is usually an ExifDateTime object, but exiftool
        // hands back a plain string when it can't parse the value. Both
        // rawValue and toString() can come back empty on a malformed date,
        // hence the last fallback
        timestamp:
          typeof DateTimeOriginal === "string"
            ? DateTimeOriginal
            : (DateTimeOriginal.rawValue ?? DateTimeOriginal.toString() ?? ""),
      };
    }),
  );

  // Only include results with data in them
  return results.filter((result) => result !== null);
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
const files = await readAllFilesRecursively(inputDirectory);
const exifTimes = await getExifTimestampsFromFiles(files, inputDirectory);
const csvPath = await writeResultsToCsv(exifTimes, values.out);

console.log(`Wrote ${exifTimes.length} rows to ${csvPath}`);

// exiftool runs a long-lived child process, so it has to be shut down
// explicitly or node will never exit
await exiftool.end();
