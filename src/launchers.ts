/**
 * Desktop launchers that open a container in App Mode.
 *
 * Double-clicking a `.dai.html` opens it in a normal tab, with the browser's
 * chrome around it. These scripts sit beside the container and open it in a
 * chromeless Chromium app window instead, which is what makes a document feel
 * like an application rather than a page.
 *
 * Pure string generation, like the rest of the core: a caller writes the files
 * or offers them as downloads.
 */

/** Chromium-family browsers, in the order a launcher will try them. */
const WINDOWS_BROWSERS = [
  { name: "Microsoft Edge", path: "%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe" },
  { name: "Microsoft Edge", path: "%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe" },
  { name: "Google Chrome", path: "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe" },
  { name: "Google Chrome", path: "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe" },
  { name: "Google Chrome", path: "%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe" },
];

const MAC_BROWSERS = ["Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium"];

/**
 * Escapes a filename for literal use inside a batch script.
 *
 * `%` starts a variable expansion, so it must be doubled; a name containing one
 * would otherwise silently expand to nothing or to unrelated environment data.
 * Windows forbids the remaining shell-significant characters in filenames.
 */
export function escapeForBatch(filename: string): string {
  return filename.replace(/%/g, "%%");
}

/**
 * Escapes a filename for interpolation into a double-quoted shell string.
 *
 * The launcher assigns the name inside double quotes, because the surrounding
 * expression has to expand `$dir`. Only the characters the shell still
 * interprets there need escaping. Single quotes are already literal in this
 * context and must be left alone: the close-escape-reopen form used for
 * single-quoted strings would be inserted verbatim and corrupt the name.
 */
export function escapeForShell(filename: string): string {
  return filename.replace(/(["$`\\])/g, "\\$1");
}

/**
 * A Windows `.bat` launcher.
 *
 * `%~dp0` is the launcher's own directory with a trailing separator, so the
 * pair travels together: moving or renaming the folder does not break the link.
 */
export function windowsLauncher(filename: string): string {
  const safe = escapeForBatch(filename);

  const attempts = WINDOWS_BROWSERS.map(
    ({ name, path }) =>
      `if exist "${path}" (\r\n` +
      `  rem ${name}\r\n` +
      `  start "" "${path}" --app="file:///%DAI_FILE%"\r\n` +
      `  exit /b 0\r\n` +
      `)\r\n`,
  ).join("");

  // CRLF throughout: cmd.exe mis-parses a batch file with bare LF endings.
  return (
    `@echo off\r\n` +
    `rem DAI App Mode launcher. Keep this file beside the container.\r\n` +
    `setlocal\r\n` +
    `set "DAI_FILE=%~dp0${safe}"\r\n` +
    `\r\n` +
    `if not exist "%DAI_FILE%" (\r\n` +
    `  echo Container not found next to this launcher:\r\n` +
    `  echo   %DAI_FILE%\r\n` +
    `  pause\r\n` +
    `  exit /b 1\r\n` +
    `)\r\n` +
    `\r\n` +
    attempts +
    `\r\n` +
    `rem No Chromium browser found. Open it windowed rather than not at all.\r\n` +
    `start "" "%DAI_FILE%"\r\n`
  );
}

/**
 * A macOS `.command` launcher. Must be marked executable by the writer.
 *
 * The path is percent-encoded at run time because the launcher cannot know
 * where it will live: a `file://` URL built from a directory containing a
 * space, `%`, `#` or `?` would otherwise be truncated or misread.
 */
export function macLauncher(filename: string): string {
  const safe = escapeForShell(filename);

  const attempts = MAC_BROWSERS.map(
    (name) =>
      `if [ -d "/Applications/${name}.app" ]; then\n` +
      `  open -na "${name}" --args --app="$url"\n` +
      `  exit 0\n` +
      `fi\n`,
  ).join("");

  return (
    `#!/bin/sh\n` +
    `# DAI App Mode launcher. Keep this file beside the container.\n` +
    `set -eu\n` +
    `\n` +
    `dir="$(cd "$(dirname "$0")" && pwd)"\n` +
    `file="$dir/${safe}"\n` +
    `\n` +
    `if [ ! -f "$file" ]; then\n` +
    `  echo "Container not found next to this launcher:" >&2\n` +
    `  echo "  $file" >&2\n` +
    `  exit 1\n` +
    `fi\n` +
    `\n` +
    `# Percent-encode the characters that would break a file:// URL. The '%'\n` +
    `# substitution must come first, or it would re-encode its own output.\n` +
    `encoded=$(printf '%s' "$file" | sed -e 's/%/%25/g' -e 's/ /%20/g' \\\n` +
    `  -e 's/#/%23/g' -e 's/?/%3F/g')\n` +
    `url="file://$encoded"\n` +
    `\n` +
    attempts +
    `\n` +
    `# No Chromium browser found. Open it windowed rather than not at all.\n` +
    `open "$file"\n`
  );
}

export interface Launchers {
  /** Windows batch launcher, CRLF-terminated. */
  bat: string;
  /** macOS shell launcher. Write it with the executable bit set. */
  command: string;
}

/** Both launchers for a container filename, e.g. `notes.dai.html`. */
export function buildLaunchers(filename: string): Launchers {
  return { bat: windowsLauncher(filename), command: macLauncher(filename) };
}
