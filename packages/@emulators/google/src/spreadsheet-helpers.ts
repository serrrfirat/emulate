import { createDriveItemRecord, getDriveItemById } from "./drive-helpers.js";
import type { GoogleSheet, GoogleSpreadsheet } from "./entities.js";
import { generateUid } from "./helpers.js";
import type { GoogleStore } from "./store.js";

export const GOOGLE_SPREADSHEET_MIME_TYPE = "application/vnd.google-apps.spreadsheet";
const MAX_RANGE_CELLS = 100_000;

export interface GoogleSpreadsheetInput {
  google_id?: string;
  user_email: string;
  title: string;
  sheets?: Array<{
    id?: number;
    title: string;
    row_count?: number;
    column_count?: number;
    values?: unknown[][];
  }>;
}

export interface ParsedSheetRange {
  sheet: GoogleSheet;
  startRow: number;
  startColumn: number;
  endRow?: number;
  endColumn?: number;
}

export function createSpreadsheetRecord(gs: GoogleStore, input: GoogleSpreadsheetInput): GoogleSpreadsheet {
  const spreadsheetId = input.google_id ?? generateUid("sheet");
  const existing = getSpreadsheetById(gs, input.user_email, spreadsheetId);
  if (existing) return existing;

  const requestedSheets = input.sheets?.length ? input.sheets : [{ title: "Sheet1" }];
  const usedSheetIds = new Set<number>();
  const sheets = requestedSheets.map((sheet, index) => {
    const requestedId = sheet.id;
    const sheetId =
      requestedId !== undefined && !usedSheetIds.has(requestedId) ? requestedId : nextAvailableId(usedSheetIds);
    usedSheetIds.add(sheetId);
    return {
      sheet_id: sheetId,
      title: sheet.title,
      index,
      row_count: normalizeGridSize(sheet.row_count, 1000),
      column_count: normalizeGridSize(sheet.column_count, 26),
      values: cloneValues(sheet.values ?? []),
    };
  });

  createDriveItemRecord(gs, {
    google_id: spreadsheetId,
    user_email: input.user_email,
    name: input.title,
    mime_type: GOOGLE_SPREADSHEET_MIME_TYPE,
    parent_google_ids: ["root"],
  });

  return gs.spreadsheets.insert({
    google_id: spreadsheetId,
    user_email: input.user_email,
    sheets,
  });
}

export function getSpreadsheetById(
  gs: GoogleStore,
  userEmail: string,
  spreadsheetId: string,
): GoogleSpreadsheet | undefined {
  return gs.spreadsheets.findBy("user_email", userEmail).find((spreadsheet) => spreadsheet.google_id === spreadsheetId);
}

export function formatSpreadsheetResource(gs: GoogleStore, spreadsheet: GoogleSpreadsheet) {
  const driveItem = getDriveItemById(gs, spreadsheet.user_email, spreadsheet.google_id);
  return {
    spreadsheetId: spreadsheet.google_id,
    properties: { title: driveItem?.name ?? "Untitled" },
    spreadsheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheet.google_id}/edit`,
    sheets: spreadsheet.sheets.map((sheet) => ({
      properties: {
        sheetId: sheet.sheet_id,
        title: sheet.title,
        index: sheet.index,
        sheetType: "GRID",
        gridProperties: {
          rowCount: sheet.row_count,
          columnCount: sheet.column_count,
        },
      },
    })),
  };
}

export function parseSheetRange(spreadsheet: GoogleSpreadsheet, range: string): ParsedSheetRange | undefined {
  const separator = findSheetSeparator(range);
  if (separator < 0) {
    const requestedSheet = unquoteSheetName(range);
    const wholeSheet = spreadsheet.sheets.find((candidate) => candidate.title === requestedSheet);
    if (wholeSheet) {
      return { sheet: wholeSheet, startRow: 0, startColumn: 0 };
    }
  }
  const sheetName = separator >= 0 ? unquoteSheetName(range.slice(0, separator)) : spreadsheet.sheets[0]?.title;
  const a1 = separator >= 0 ? range.slice(separator + 1) : range;
  const sheet = spreadsheet.sheets.find((candidate) => candidate.title === sheetName);
  if (!sheet) return undefined;

  const [startText, endText] = a1.split(":", 2);
  const start = parseCellReference(startText, false);
  const end = endText ? parseCellReference(endText, true) : start;
  if (!start || !end) return undefined;

  const startRow = start.row ?? 0;
  const startColumn = start.column ?? 0;
  if (
    startRow >= sheet.row_count ||
    startColumn >= sheet.column_count ||
    (end.row !== undefined && (end.row < startRow || end.row >= sheet.row_count)) ||
    (end.column !== undefined && (end.column < startColumn || end.column >= sheet.column_count)) ||
    !rangeFitsCellLimit(startRow, startColumn, end.row, end.column)
  ) {
    return undefined;
  }

  return {
    sheet,
    startRow,
    startColumn,
    endRow: end.row,
    endColumn: end.column,
  };
}

export function valuesFitRange(parsed: ParsedSheetRange, values: unknown[][]): boolean {
  const rows = values.length;
  const columns = Math.max(0, ...values.map((row) => row.length));
  if (rows === 0 || columns === 0) return true;
  const finalRow = parsed.startRow + rows - 1;
  const finalColumn = parsed.startColumn + columns - 1;
  return (
    finalRow < parsed.sheet.row_count &&
    finalColumn < parsed.sheet.column_count &&
    (parsed.endRow === undefined || finalRow <= parsed.endRow) &&
    (parsed.endColumn === undefined || finalColumn <= parsed.endColumn) &&
    rows * columns <= MAX_RANGE_CELLS
  );
}

export function readSheetValues(parsed: ParsedSheetRange): unknown[][] {
  const endRow = parsed.endRow ?? Math.max(parsed.sheet.values.length - 1, parsed.startRow - 1);
  const endColumn = parsed.endColumn ?? maxColumn(parsed.sheet.values);
  if (endRow < parsed.startRow || endColumn < parsed.startColumn) return [];

  const values: unknown[][] = [];
  for (let rowIndex = parsed.startRow; rowIndex <= endRow; rowIndex += 1) {
    const source = parsed.sheet.values[rowIndex] ?? [];
    const row = source.slice(parsed.startColumn, endColumn + 1);
    trimTrailingEmptyCells(row);
    values.push(row);
  }
  while (values.length > 0 && values.at(-1)?.length === 0) values.pop();
  return values;
}

export function writeSheetValues(
  gs: GoogleStore,
  spreadsheet: GoogleSpreadsheet,
  parsed: ParsedSheetRange,
  values: unknown[][],
): { spreadsheet: GoogleSpreadsheet; updatedRows: number; updatedColumns: number; updatedCells: number } {
  const sheets = cloneSheets(spreadsheet.sheets);
  const sheet = sheets.find((candidate) => candidate.sheet_id === parsed.sheet.sheet_id)!;
  let updatedColumns = 0;
  let updatedCells = 0;

  values.forEach((row, rowOffset) => {
    const rowIndex = parsed.startRow + rowOffset;
    sheet.values[rowIndex] ??= [];
    row.forEach((value, columnOffset) => {
      sheet.values[rowIndex][parsed.startColumn + columnOffset] = value;
      updatedCells += 1;
    });
    updatedColumns = Math.max(updatedColumns, row.length);
  });

  sheet.row_count = Math.max(sheet.row_count, parsed.startRow + values.length);
  sheet.column_count = Math.max(sheet.column_count, parsed.startColumn + updatedColumns);
  const updated = gs.spreadsheets.update(spreadsheet.id, { sheets }) ?? spreadsheet;
  return { spreadsheet: updated, updatedRows: values.length, updatedColumns, updatedCells };
}

export function clearSheetValues(
  gs: GoogleStore,
  spreadsheet: GoogleSpreadsheet,
  parsed: ParsedSheetRange,
): GoogleSpreadsheet {
  const sheets = cloneSheets(spreadsheet.sheets);
  const sheet = sheets.find((candidate) => candidate.sheet_id === parsed.sheet.sheet_id)!;
  const endRow = parsed.endRow ?? Math.max(sheet.values.length - 1, parsed.startRow);
  const endColumn = parsed.endColumn ?? maxColumn(sheet.values);

  for (let row = parsed.startRow; row <= endRow; row += 1) {
    if (!sheet.values[row]) continue;
    for (let column = parsed.startColumn; column <= endColumn; column += 1) {
      sheet.values[row][column] = undefined;
    }
    trimTrailingEmptyCells(sheet.values[row]);
  }
  while (sheet.values.length > 0 && sheet.values.at(-1)?.length === 0) sheet.values.pop();

  return gs.spreadsheets.update(spreadsheet.id, { sheets }) ?? spreadsheet;
}

export function updateSpreadsheetSheets(
  gs: GoogleStore,
  spreadsheet: GoogleSpreadsheet,
  sheets: GoogleSheet[],
): GoogleSpreadsheet {
  const normalized = sheets.map((sheet, index) => ({ ...sheet, index, values: cloneValues(sheet.values) }));
  return gs.spreadsheets.update(spreadsheet.id, { sheets: normalized }) ?? spreadsheet;
}

function findSheetSeparator(range: string): number {
  let quoted = false;
  for (let index = 0; index < range.length; index += 1) {
    if (range[index] === "'") {
      if (quoted && range[index + 1] === "'") {
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (range[index] === "!" && !quoted) {
      return index;
    }
  }
  return -1;
}

function unquoteSheetName(value: string): string {
  return value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1).replaceAll("''", "'") : value;
}

function parseCellReference(value: string, isEnd: boolean): { row?: number; column?: number } | undefined {
  const match = value.trim().match(/^([A-Za-z]*)(\d*)$/);
  if (!match || (!match[1] && !match[2])) return undefined;
  const column = match[1] ? columnToIndex(match[1]) : undefined;
  const row = match[2] ? Number.parseInt(match[2], 10) - 1 : undefined;
  if (column !== undefined && (!Number.isSafeInteger(column) || column < 0)) return undefined;
  if (row !== undefined && (!Number.isSafeInteger(row) || row < 0)) return undefined;
  return {
    row: row === undefined && !isEnd ? 0 : row,
    column: column === undefined && !isEnd ? 0 : column,
  };
}

function columnToIndex(value: string): number {
  let result = 0;
  for (const character of value.toUpperCase()) {
    result = result * 26 + character.charCodeAt(0) - 64;
  }
  return result - 1;
}

function rangeFitsCellLimit(startRow: number, startColumn: number, endRow?: number, endColumn?: number): boolean {
  if (endRow === undefined || endColumn === undefined) return true;
  return (endRow - startRow + 1) * (endColumn - startColumn + 1) <= MAX_RANGE_CELLS;
}

function normalizeGridSize(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function nextAvailableId(usedIds: Set<number>): number {
  let candidate = 0;
  while (usedIds.has(candidate)) candidate += 1;
  return candidate;
}

function maxColumn(values: unknown[][]): number {
  return Math.max(-1, ...values.map((row) => row.length - 1));
}

function cloneSheets(sheets: GoogleSheet[]): GoogleSheet[] {
  return sheets.map((sheet) => ({ ...sheet, values: cloneValues(sheet.values) }));
}

function cloneValues(values: unknown[][]): unknown[][] {
  return values.map((row) => [...row]);
}

function trimTrailingEmptyCells(row: unknown[]): void {
  while (row.length > 0 && (row.at(-1) === undefined || row.at(-1) === null || row.at(-1) === "")) row.pop();
}
