# exif-timestamps

Reads the EXIF capture time (`DateTimeOriginal`) of every file in a directory and it's subdirectories, recursively, and writes the results to a CSV. Relies on https://github.com/photostructure/exiftool-vendored.js/ for parsing the EXIF data.

## Requirements

- **Node 22 or newer.** Check what you have with:

  ```sh
  node -v
  ```

  If that prints `v22.0.0` or higher you're set. If it errors, or the number is
  lower, install or upgrade from https://nodejs.org/en/download.

## Usage

Default (will read files from the directory it's called in, and write to `timestamps.csv`):

```sh
npx https://github.com/ryan-ludwig/exif-timestamps
```

Or point to a specific directory and specify an output file:

```sh
npx https://github.com/ryan-ludwig/exif-timestamps --dir ~/Pictures/2026 --out trip.csv
```

This is not published to npm — npx installs it straight from GitHub, so the
full URL is the package name. Add `#<tag-or-branch>` to pin a specific version.

### Options

| Option                  | Default           | Description       |
| ----------------------- | ----------------- | ----------------- |
| `-d, --dir <directory>` | current directory | Directory to scan |
| `-o, --out <file>`      | `timestamps.csv`  | CSV file to write |
| `-h, --help`            |                   | Show help         |

Dotfiles, anything inside a dot-directory, and `node_modules` are skipped, as
are files with no capture date.

### Output

```csv
path,timestamp
2026-04-11/DSC00214.JPG,2026:04:11 09:32:07
2026-04-11/raw/DSC00214.ARW,2026:04:11 09:32:07
```

`path` is relative to the scanned directory, so identically named files in
different folders stay distinguishable. `timestamp` is the raw value as written
by the camera, not normalized to a timezone.
