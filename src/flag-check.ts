/**
 * "Current" is derived from admission, never from a cache (D140, D150).
 *
 * A static scan catches honest mistakes; admission is the enforcement; a table
 * name in a variable is invisible here.
 *
 * `_r_superseded` is a display cache kept at write. Which rows raise it depends
 * on what arrived and in what order, so a view, writer, gate or kit read that
 * decides "current" from it can be steered by a row nobody admits. Every such
 * read derives from the compiled admission views instead, within the row's own
 * partition. The same holds for the seat and close tables: outside
 * `src/replicated.ts`, which defines admission from them, code reads their
 * `_current` and admission views, not the raw rows, and "is this session
 * closed" is `_dai_closed`, never `_dai_close_current` (D146).
 *
 * The names `_dai_close_current` and `_dai_close_heads` are refused in any
 * literal outside `src/replicated.ts`, whatever else it holds, since SQL is
 * built with `+=`, from arrays and in ternaries, none of which says SELECT
 * where the name is (D156). A `.sql` file and an inline
 * `<script type="application/sql">` are scanned as SQL text.
 *
 * The scan reads tokens, not lines, with the TypeScript scanner: the contents
 * of every string and template literal (a template's parts joined, literals
 * joined by `+` joined too, each part keeping its own line, D157) and every
 * identifier, case-insensitively, since SQLite ignores the case of a name. Comments are the scanner's, so a SQL line
 * that begins with `*` or `--` is code. The cache's own upkeep passes: its
 * column's declaration, `SET _r_superseded = 0|1`, and the statement of the
 * trigger that keeps it monotonic, whose `OLD.` and `NEW.` are the trigger's.
 *
 * One detector, two callers: `scripts/check-flag.mjs`, in the typecheck chain,
 * and the test that holds the check itself. The TypeScript module is handed in,
 * as the database engine is to the row layer, so either caller supplies its own.
 */
import type * as TS from "typescript";

export interface FlagRead {
  kind: "flag" | "raw-seat-table";
  /** 1-based line in the file. */
  line: number;
  /** That line, trimmed: what an exception names. */
  text: string;
}

const FLAG = /_r_superseded/i;
const UPKEEP = [
  /_r_superseded\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+0\s+CHECK\s*\(\s*_r_superseded\s+IN\s*\(\s*0\s*,\s*1\s*\)\s*\)/gi,
  /\bSET\s+_r_superseded\s*=\s*[01]\b/gi,
];
const TRIGGER = /CREATE\s+TRIGGER\b[\s\S]*?\bBEFORE\s+UPDATE\s+OF\s+_r_superseded\b/i;
// After FROM or JOIN, with or without a schema, or in a comma join that follows
// a FROM on the same line.
const RAW_SEAT_TABLE =
  /(?:\bFROM|\bJOIN|\bFROM\b[^;()'"`\n]*?,)\s+(?:[\w"`[\]]+\s*\.\s*)?["'`[]?_dai_(?:seat|binding|confirm|close)(?!\w)/gi;
// The close's own views, which call a session closed by a close its rule does
// not permit: named in any literal at all, whatever else it holds, since SQL
// is built in more ways than a literal that says SELECT (D156).
const CLOSE_VIEW = /_dai_close_(?:current|heads)(?!\w)/gi;

interface Literal {
  text: string;
  /** Offset in the file where the literal's first character sits. */
  start: number;
  /**
   * Where each joined part begins: its offset in `text` and in the file. A
   * literal joined by `+`, or a template's text after a substitution, keeps
   * its own position, so a read is placed on the line that holds it (D157).
   */
  parts: { at: number; start: number }[];
}

/** Every literal and every identifier in one script, from the TypeScript scanner. */
function tokensOf(ts: typeof TS, source: string, jsx: boolean): { literals: Literal[]; identifiers: { text: string; start: number }[] } {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, jsx ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard, source);
  const literals: Literal[] = [];
  const identifiers: { text: string; start: number }[] = [];
  // Open templates, innermost last, each with the brace depth its current
  // substitution started at, and the text so far.
  const templates: (Literal & { depth: number })[] = [];
  let depth = 0;
  let last: TS.SyntaxKind = ts.SyntaxKind.Unknown;
  let joinNext = false;
  const emit = (literal: Literal) => {
    const previous = literals[literals.length - 1];
    if (joinNext && previous) {
      for (const part of literal.parts) previous.parts.push({ at: previous.text.length + part.at, start: part.start });
      previous.text += literal.text;
    } else literals.push(literal);
    joinNext = false;
  };
  const regexAllowed = () =>
    ![
      ts.SyntaxKind.Identifier,
      ts.SyntaxKind.NumericLiteral,
      ts.SyntaxKind.StringLiteral,
      ts.SyntaxKind.CloseParenToken,
      ts.SyntaxKind.CloseBracketToken,
      ts.SyntaxKind.CloseBraceToken,
      ts.SyntaxKind.NoSubstitutionTemplateLiteral,
      ts.SyntaxKind.TemplateTail,
      ts.SyntaxKind.ThisKeyword,
    ].includes(last);
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if ((kind === ts.SyntaxKind.SlashToken || kind === ts.SyntaxKind.SlashEqualsToken) && regexAllowed()) {
      kind = scanner.reScanSlashToken();
    }
    if (kind === ts.SyntaxKind.OpenBraceToken) depth += 1;
    if (kind === ts.SyntaxKind.CloseBraceToken) {
      const open = templates[templates.length - 1];
      if (open && open.depth === depth) {
        kind = scanner.reScanTemplateToken(false);
        open.text += "${}";
        // The text after a substitution starts past its closing brace.
        open.parts.push({ at: open.text.length, start: scanner.getTokenStart() + 1 });
        open.text += scanner.getTokenValue();
        if (kind === ts.SyntaxKind.TemplateTail) {
          templates.pop();
          emit({ text: open.text, start: open.start, parts: open.parts });
        }
        last = kind;
        continue;
      }
      depth -= 1;
    }
    if (kind === ts.SyntaxKind.StringLiteral || kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral) {
      const start = scanner.getTokenStart();
      emit({ text: scanner.getTokenValue(), start, parts: [{ at: 0, start }] });
    } else if (kind === ts.SyntaxKind.TemplateHead) {
      const start = scanner.getTokenStart();
      templates.push({ text: scanner.getTokenValue(), start, parts: [{ at: 0, start }], depth });
    } else if (kind === ts.SyntaxKind.Identifier || kind === ts.SyntaxKind.PrivateIdentifier) {
      identifiers.push({ text: scanner.getTokenText(), start: scanner.getTokenStart() });
    } else if (kind === ts.SyntaxKind.PlusToken && (last === ts.SyntaxKind.StringLiteral || last === ts.SyntaxKind.NoSubstitutionTemplateLiteral || last === ts.SyntaxKind.TemplateTail)) {
      joinNext = true;
      last = kind;
      continue;
    }
    if (joinNext && kind !== ts.SyntaxKind.StringLiteral && kind !== ts.SyntaxKind.NoSubstitutionTemplateLiteral && kind !== ts.SyntaxKind.TemplateHead) {
      joinNext = false;
    }
    last = kind;
  }
  return { literals, identifiers };
}

interface Script {
  code: string;
  offset: number;
  jsx: boolean;
  /** SQL, scanned as one literal of text rather than tokenized as JavaScript (D156). */
  sql: boolean;
}

/**
 * The scripts in one file: the file itself, or an html file's inline scripts,
 * with their offsets. A `.sql` file and an inline `<script type="application/sql">`
 * are SQL.
 */
function scriptsOf(path: string, source: string): Script[] {
  if (/\.sql$/i.test(path)) return [{ code: source, offset: 0, jsx: false, sql: true }];
  if (/\.html?$/i.test(path)) {
    const out: Script[] = [];
    for (const match of source.matchAll(/<script\b(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const sql = /\btype\s*=\s*["']?application\/sql\b/i.test(match[1]!);
      out.push({ code: match[2]!, offset: match.index! + match[0].indexOf(">") + 1, jsx: false, sql });
    }
    return out;
  }
  return [{ code: source, offset: 0, jsx: /\.[jt]sx$/i.test(path), sql: false }];
}

/** Every read of the cache, or of a raw seat or close table, in one file. */
export function flagReadsIn(ts: typeof TS, path: string, source: string, options: { rawSeatTables: boolean }): FlagRead[] {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") lineStarts.push(i + 1);
  const lineAt = (offset: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid]! <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
  const lines = source.split("\n");
  const found: FlagRead[] = [];
  const at = (kind: FlagRead["kind"], line: number) => found.push({ kind, line, text: (lines[line - 1] ?? "").trim() });
  for (const script of scriptsOf(path, source)) {
    const { literals, identifiers } = script.sql
      ? { literals: [{ text: script.code, start: 0, parts: [{ at: 0, start: 0 }] }], identifiers: [] }
      : tokensOf(ts, script.code, script.jsx);
    for (const id of identifiers) if (FLAG.test(id.text)) at("flag", lineAt(script.offset + id.start));
    for (const literal of literals) {
      // A match's line: its part's first line plus the newlines in the part before it.
      const lineOf = (index: number) => {
        let part = literal.parts[0]!;
        for (const p of literal.parts) if (p.at <= index) part = p;
        return lineAt(script.offset + part.start) + (literal.text.slice(part.at, index).match(/\n/g)?.length ?? 0);
      };
      let text = literal.text;
      for (const upkeep of UPKEEP) text = text.replace(upkeep, (m) => " ".repeat(m.length));
      text = text
        .split(";")
        .map((statement) => (TRIGGER.test(statement) ? statement.replace(/[^\n]/g, " ") : statement))
        .join(";");
      for (const match of text.matchAll(new RegExp(FLAG.source, "gi"))) at("flag", lineOf(match.index!));
      if (options.rawSeatTables && (script.sql || /\bSELECT\b/i.test(literal.text))) {
        for (const match of literal.text.matchAll(RAW_SEAT_TABLE)) at("raw-seat-table", lineOf(match.index!));
      }
      if (options.rawSeatTables) {
        for (const match of literal.text.matchAll(CLOSE_VIEW)) at("raw-seat-table", lineOf(match.index!));
      }
    }
  }
  return found;
}

/**
 * Problems across files. An exception is keyed `"path: kind: line"`, the line
 * as it stands trimmed, and excuses one read of that kind on that line; one
 * that excuses nothing is itself a problem. `admissionOwner` is the file that
 * defines admission from the raw seat tables, and only it may read them.
 */
export function flagReadProblems(
  ts: typeof TS,
  files: readonly { path: string; source: string }[],
  exceptions: Readonly<Record<string, string>>,
  admissionOwner = "src/replicated.ts",
): string[] {
  const problems: string[] = [];
  const unused = new Map(Object.keys(exceptions).map((key) => [key, 1]));
  for (const { path, source } of files) {
    for (const read of flagReadsIn(ts, path, source, { rawSeatTables: path !== admissionOwner })) {
      const key = `${path}: ${read.kind}: ${read.text}`;
      const left = unused.get(key) ?? 0;
      if (left > 0) {
        unused.set(key, left - 1);
        continue;
      }
      problems.push(
        read.kind === "flag"
          ? `${path}:${read.line} reads the stored _r_superseded flag; derive "current" from the admission views: ${read.text}`
          : `${path}:${read.line} reads a raw seat or close table; read its _current or admission view, or _dai_closed: ${read.text}`,
      );
    }
  }
  for (const [key, left] of unused) if (left > 0) problems.push(`the exception "${key}" excuses nothing; remove it`);
  return problems;
}
