import type {
  AddedLine,
  Chunk,
  ChunkFile,
  SkipReason,
  SkippedFile,
  SplitDiff
} from "./review-types";
import { estimateTokens, type ChunkBudget } from "./token-budget";

/*
 * Reviewed module (AGENTS.md): diff splitting. Written by an agent, reviewed
 * by the author.
 */

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "deno.lock",
  "Cargo.lock",
  "Gemfile.lock",
  "composer.lock",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "go.sum",
  "pubspec.lock",
  "Podfile.lock",
  "mix.lock",
  "flake.lock",
  "packages.lock.json"
]);

/** An added line longer than this marks its file as minified or generated. */
const MAX_LINE_LENGTH = 1_000;

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

type DiffLine =
  | { kind: "context" | "added"; number: number; text: string }
  | { kind: "deleted"; text: string };

interface Hunk {
  header: string;
  lines: DiffLine[];
}

interface FileDiff {
  /** The new path; null until a header gives one. */
  path: string | null;
  deleted: boolean;
  binary: boolean;
  /** A "+++" line was seen, so a following "---" starts another file. */
  hasNewPath: boolean;
  hunks: Hunk[];
}

/** A file, one of its hunks, or a window of a hunk's lines, ready to pack. */
interface Piece {
  path: string;
  text: string;
  lines: number[];
}

/**
 * DESIGN.md §6, step 4: skip what can't be reviewed, number the lines (D13),
 * split what doesn't fit, and pack the pieces first-fit into chunks of at
 * most `budget.target` tokens.
 */
export function splitDiff(diff: string, budget: ChunkBudget): SplitDiff {
  const fits = (text: string) => estimateTokens(text) <= budget.target;
  const skipped: SkippedFile[] = [];
  const addedLines: AddedLine[] = [];
  const pieces: Piece[] = [];

  for (const file of parseDiff(diff)) {
    // A deleted file has nothing left to review
    if (file.deleted || file.path === null) continue;
    const path = file.path;
    // The no-secrets check reads added lines from every file (D11)
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "added") {
          addedLines.push({ file: path, line: line.number, text: line.text });
        }
      }
    }
    const reason = skipReason(path, file);
    if (reason) {
      skipped.push({ file: path, reason });
      continue;
    }
    pieces.push(...piecesOf(path, file.hunks, fits));
  }

  return { chunks: packFirstFit(pieces, fits), skipped, addedLines };
}

/**
 * Reads a unified diff into files and hunks, numbering added and context
 * lines from each hunk header. A hunk's lines are read by the header's
 * counts, so a deleted line that starts with "--" isn't mistaken for a
 * file header.
 */
function parseDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | undefined;
  let hunk: Hunk | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  let next = 0;

  const startFile = (path: string | null): FileDiff => {
    const started: FileDiff = {
      path,
      deleted: false,
      binary: false,
      hasNewPath: false,
      hunks: []
    };
    files.push(started);
    hunk = undefined;
    oldLeft = 0;
    newLeft = 0;
    return started;
  };

  for (const line of diff.replaceAll("\r\n", "\n").split("\n")) {
    // "\ No newline at end of file" belongs to neither side
    if (line.startsWith("\\")) continue;

    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      // A context line whose leading space was lost in a paste arrives empty
      const marker = line === "" ? " " : line[0];
      const text = line.slice(1);
      if (marker === " " && oldLeft > 0 && newLeft > 0) {
        hunk.lines.push({ kind: "context", number: next++, text });
        oldLeft--;
        newLeft--;
        continue;
      }
      if (marker === "+" && newLeft > 0) {
        hunk.lines.push({ kind: "added", number: next++, text });
        newLeft--;
        continue;
      }
      if (marker === "-" && oldLeft > 0) {
        hunk.lines.push({ kind: "deleted", text });
        oldLeft--;
        continue;
      }
      // Anything else ends the hunk early and is read as a header
      oldLeft = 0;
      newLeft = 0;
    }

    if (line.startsWith("diff --git ")) {
      file = startFile(gitHeaderPath(line.slice("diff --git ".length)));
    } else if (line.startsWith("--- ")) {
      // Diffs without "diff --git" lines start each file here
      if (!file || file.hasNewPath || file.hunks.length > 0) {
        file = startFile(null);
      }
    } else if (line.startsWith("+++ ")) {
      file ??= startFile(null);
      const path = headerPath(line.slice(4), "b/");
      file.hasNewPath = true;
      if (path === null) file.deleted = true;
      else file.path = path;
    } else if (!file) {
      continue;
    } else if (line.startsWith("deleted file mode")) {
      file.deleted = true;
    } else if (line.startsWith("rename to ")) {
      file.path = line.slice("rename to ".length);
    } else if (
      line.startsWith("Binary files ") ||
      line.startsWith("GIT binary patch")
    ) {
      file.binary = true;
      const names = /^Binary files (.+) and (.+) differ$/.exec(line);
      if (names) {
        file.path =
          headerPath(names[2], "b/") ?? headerPath(names[1], "a/") ?? file.path;
      }
    } else {
      const header = HUNK_HEADER.exec(line);
      if (header) {
        oldLeft = header[2] === undefined ? 1 : Number(header[2]);
        newLeft = header[4] === undefined ? 1 : Number(header[4]);
        next = Number(header[3]);
        hunk = { header: line, lines: [] };
        file.hunks.push(hunk);
      }
    }
  }
  return files;
}

/**
 * The path from "a/P b/P". Paths can hold spaces, so when both sides match
 * the line splits in the middle; otherwise (a rename) the new side is taken.
 */
function gitHeaderPath(rest: string): string | null {
  const half = (rest.length - "a/ b/".length) / 2;
  const path = rest.slice(2, 2 + half);
  if (Number.isInteger(half) && rest === `a/${path} b/${path}`) return path;
  const newSide = rest.lastIndexOf(" b/");
  return newSide >= 0 ? rest.slice(newSide + " b/".length) : null;
}

/** A "---" or "+++" path without its a/ or b/ prefix; null for /dev/null. */
function headerPath(raw: string, prefix: "a/" | "b/"): string | null {
  // Plain `diff -u` output adds a tab and a timestamp
  const path = raw.split("\t")[0];
  if (path === "/dev/null") return null;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function skipReason(path: string, file: FileDiff): SkipReason | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (LOCKFILES.has(name)) return "lockfile";
  if (file.binary) return "binary";
  if (/\.min\.[^.]+$/.test(name) || name.endsWith(".map")) {
    return "minified or generated";
  }
  const hasLongLine = file.hunks.some((hunk) =>
    hunk.lines.some(
      (line) => line.kind === "added" && line.text.length > MAX_LINE_LENGTH
    )
  );
  return hasLongLine ? "minified or generated" : null;
}

/**
 * "  11 +text" for added lines, "  11  text" for context lines, and the
 * number left blank for deleted ones, which can't be pointed at (D13).
 */
function renderLine(line: DiffLine, width: number): string {
  if (line.kind === "deleted") return `${" ".repeat(width)} -${line.text}`;
  const marker = line.kind === "added" ? "+" : " ";
  return `${String(line.number).padStart(width)} ${marker}${line.text}`;
}

/**
 * The whole file if it fits; otherwise each hunk; and a hunk that still
 * doesn't fit, as windows of consecutive lines. Every piece starts with the
 * file's path. Pieces with no numbered lines are left out.
 */
function piecesOf(
  path: string,
  hunks: readonly Hunk[],
  fits: (text: string) => boolean
): Piece[] {
  const title = `File: ${path}`;
  const numbers = (lines: readonly DiffLine[]) =>
    lines.flatMap((line) => (line.kind === "deleted" ? [] : [line.number]));
  // A loop, not Math.max(...lines): a huge hunk would overflow the stack
  let highest = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind !== "deleted" && line.number > highest)
        highest = line.number;
    }
  }
  const width = String(highest).length;
  const render = (hunk: Hunk, lines: readonly DiffLine[]) =>
    [hunk.header, ...lines.map((line) => renderLine(line, width))].join("\n");

  const pieces: Piece[] = [];
  const add = (text: string, lines: readonly DiffLine[]) => {
    const numbered = numbers(lines);
    if (numbered.length > 0) pieces.push({ path, text, lines: numbered });
  };

  const whole = [title, ...hunks.map((hunk) => render(hunk, hunk.lines))].join(
    "\n"
  );
  if (fits(whole)) {
    add(
      whole,
      hunks.flatMap((hunk) => hunk.lines)
    );
    return pieces;
  }

  for (const hunk of hunks) {
    const text = `${title}\n${render(hunk, hunk.lines)}`;
    if (fits(text)) {
      add(text, hunk.lines);
      continue;
    }
    // Windows of lines, each grown until the next line wouldn't fit
    const start = `${title}\n${hunk.header}`;
    let window: DiffLine[] = [];
    let windowText = start;
    for (const line of hunk.lines) {
      const grown = `${windowText}\n${renderLine(line, width)}`;
      if (window.length > 0 && !fits(grown)) {
        add(windowText, window);
        window = [line];
        windowText = `${start}\n${renderLine(line, width)}`;
      } else {
        window.push(line);
        windowText = grown;
      }
    }
    add(windowText, window);
  }
  return pieces;
}

/**
 * First-fit: each piece goes into the first chunk with room, checking every
 * open chunk, not just the last one. D6's bound (any diff up to 18k tokens
 * needs at most 2 chunks) depends on it.
 */
function packFirstFit(
  pieces: readonly Piece[],
  fits: (text: string) => boolean
): Chunk[] {
  const bins: { text: string; pieces: Piece[] }[] = [];
  for (const piece of pieces) {
    const bin = bins.find((open) => fits(`${open.text}\n${piece.text}`));
    if (bin) {
      bin.text = `${bin.text}\n${piece.text}`;
      bin.pieces.push(piece);
    } else {
      bins.push({ text: piece.text, pieces: [piece] });
    }
  }
  return bins.map(({ text, pieces: packed }) => {
    // One entry per file, in the order the file first appears
    const files: ChunkFile[] = [];
    for (const piece of packed) {
      const file = files.find((f) => f.path === piece.path);
      if (file) file.lines = file.lines.concat(piece.lines);
      else files.push({ path: piece.path, lines: [...piece.lines] });
    }
    for (const file of files) file.lines.sort((a, b) => a - b);
    return { text, files };
  });
}
