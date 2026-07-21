import type { Context, RouteContext } from "@emulators/core";
import { googleApiError } from "../helpers.js";
import { getRecord, getRecordArray, getString, parseGoogleBody, requireGoogleAuth } from "../route-helpers.js";
import {
  clearSheetValues,
  createSpreadsheetRecord,
  formatSpreadsheetResource,
  getSpreadsheetById,
  parseSheetRange,
  readSheetValues,
  updateSpreadsheetSheets,
  writeSheetValues,
} from "../spreadsheet-helpers.js";
import { getGoogleStore } from "../store.js";

export function spreadsheetRoutes({ app, store }: RouteContext): void {
  const gs = getGoogleStore(store);

  app.post("/v4/spreadsheets", async (c) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;
    const body = await parseGoogleBody(c);
    const properties = getRecord(body, "properties");
    const title = properties ? getString(properties, "title")?.trim() : undefined;
    if (!title) {
      return googleApiError(c, 400, "Spreadsheet title is required.", "badRequest", "INVALID_ARGUMENT");
    }

    const sheets = getRecordArray(body, "sheets").map((sheet, index) => {
      const sheetProperties = getRecord(sheet, "properties") ?? {};
      const gridProperties = getRecord(sheetProperties, "gridProperties") ?? {};
      return {
        id: getFiniteNumber(sheetProperties, "sheetId") ?? index,
        title: getString(sheetProperties, "title") ?? `Sheet${index + 1}`,
        row_count: getFiniteNumber(gridProperties, "rowCount"),
        column_count: getFiniteNumber(gridProperties, "columnCount"),
      };
    });

    return c.json(
      formatSpreadsheetResource(
        createSpreadsheetRecord(gs, {
          user_email: authEmail,
          title,
          sheets: sheets.length > 0 ? sheets : undefined,
        }),
      ),
    );
  });

  app.get("/v4/spreadsheets/:spreadsheetId/values:batchGet", (c) => {
    const resolved = resolveSpreadsheet(c, gs);
    if (resolved instanceof Response) return resolved;
    const url = new URL(c.req.url);
    const ranges = url.searchParams.getAll("ranges");
    const requestedRanges = ranges.length > 0 ? ranges : [resolved.spreadsheet.sheets[0]?.title ?? "Sheet1"];
    const valueRanges = [];
    for (const range of requestedRanges) {
      const parsed = parseSheetRange(resolved.spreadsheet, range);
      if (!parsed) return invalidRange(c, range);
      valueRanges.push(formatValueRange(range, readSheetValues(parsed)));
    }
    return c.json({ spreadsheetId: resolved.spreadsheet.google_id, valueRanges });
  });

  app.get("/v4/spreadsheets/:spreadsheetId/values/:range{.+}", (c) => {
    const resolved = resolveSpreadsheet(c, gs);
    if (resolved instanceof Response) return resolved;
    const range = c.req.param("range");
    const parsed = parseSheetRange(resolved.spreadsheet, range);
    if (!parsed) return invalidRange(c, range);
    return c.json(formatValueRange(range, readSheetValues(parsed)));
  });

  app.put("/v4/spreadsheets/:spreadsheetId/values/:range{.+}", async (c) => {
    const resolved = resolveSpreadsheet(c, gs);
    if (resolved instanceof Response) return resolved;
    const range = c.req.param("range");
    const parsed = parseSheetRange(resolved.spreadsheet, range);
    if (!parsed) return invalidRange(c, range);
    const body = await parseGoogleBody(c);
    const values = getValues(body);
    const result = writeSheetValues(gs, resolved.spreadsheet, parsed, values);
    return c.json({
      spreadsheetId: result.spreadsheet.google_id,
      updatedRange: range,
      updatedRows: result.updatedRows,
      updatedColumns: result.updatedColumns,
      updatedCells: result.updatedCells,
    });
  });

  app.post("/v4/spreadsheets/:spreadsheetId/values/:operation{.+}", async (c) => {
    const resolved = resolveSpreadsheet(c, gs);
    if (resolved instanceof Response) return resolved;
    const operation = c.req.param("operation");
    const action = operation.endsWith(":append") ? "append" : operation.endsWith(":clear") ? "clear" : undefined;
    if (!action) {
      return googleApiError(c, 400, "Unsupported values operation.", "badRequest", "INVALID_ARGUMENT");
    }
    const range = operation.slice(0, -(action.length + 1));
    const parsed = parseSheetRange(resolved.spreadsheet, range);
    if (!parsed) return invalidRange(c, range);

    if (action === "clear") {
      clearSheetValues(gs, resolved.spreadsheet, parsed);
      return c.json({ spreadsheetId: resolved.spreadsheet.google_id, clearedRange: range });
    }

    const existing = readSheetValues(parsed);
    const appendRow = parsed.startRow + existing.length;
    const result = writeSheetValues(
      gs,
      resolved.spreadsheet,
      { ...parsed, startRow: appendRow },
      getValues(await parseGoogleBody(c)),
    );
    return c.json({
      spreadsheetId: result.spreadsheet.google_id,
      tableRange: range,
      updates: {
        spreadsheetId: result.spreadsheet.google_id,
        updatedRange: range,
        updatedRows: result.updatedRows,
        updatedColumns: result.updatedColumns,
        updatedCells: result.updatedCells,
      },
    });
  });

  app.post("/v4/spreadsheets/:spreadsheetId{[^:]+}:batchUpdate", async (c) => {
    const resolved = resolveSpreadsheet(c, gs);
    if (resolved instanceof Response) return resolved;
    const body = await parseGoogleBody(c);
    let spreadsheet = resolved.spreadsheet;
    let sheets = spreadsheet.sheets.map((sheet) => ({ ...sheet, values: sheet.values.map((row) => [...row]) }));
    const replies: Record<string, unknown>[] = [];

    for (const request of getRecordArray(body, "requests")) {
      const addSheet = getRecord(request, "addSheet");
      if (addSheet) {
        const properties = getRecord(addSheet, "properties") ?? {};
        const grid = getRecord(properties, "gridProperties") ?? {};
        const sheetId = getFiniteNumber(properties, "sheetId") ?? nextSheetId(sheets.map((sheet) => sheet.sheet_id));
        if (sheets.some((sheet) => sheet.sheet_id === sheetId)) {
          return googleApiError(c, 400, "Sheet ID already exists.", "badRequest", "INVALID_ARGUMENT");
        }
        const title = getString(properties, "title") ?? `Sheet${sheets.length + 1}`;
        sheets.push({
          sheet_id: sheetId,
          title,
          index: sheets.length,
          row_count: getFiniteNumber(grid, "rowCount") ?? 1000,
          column_count: getFiniteNumber(grid, "columnCount") ?? 26,
          values: [],
        });
        replies.push({ addSheet: { properties: { sheetId, title, index: sheets.length - 1 } } });
        continue;
      }

      const deleteSheet = getRecord(request, "deleteSheet");
      if (deleteSheet) {
        const sheetId = getFiniteNumber(deleteSheet, "sheetId");
        if (sheetId === undefined || sheets.length === 1 || !sheets.some((sheet) => sheet.sheet_id === sheetId)) {
          return googleApiError(c, 400, "Invalid sheet deletion.", "badRequest", "INVALID_ARGUMENT");
        }
        sheets = sheets.filter((sheet) => sheet.sheet_id !== sheetId);
        replies.push({});
        continue;
      }

      const updateProperties = getRecord(request, "updateSheetProperties");
      if (updateProperties) {
        const properties = getRecord(updateProperties, "properties") ?? {};
        const sheetId = getFiniteNumber(properties, "sheetId");
        const sheet = sheets.find((candidate) => candidate.sheet_id === sheetId);
        if (!sheet) return googleApiError(c, 400, "Sheet was not found.", "badRequest", "INVALID_ARGUMENT");
        const title = getString(properties, "title");
        if (title) sheet.title = title;
        replies.push({ updateSheetProperties: { properties: { sheetId: sheet.sheet_id, title: sheet.title } } });
        continue;
      }

      if (request.repeatCell || request.updateCells) {
        replies.push({});
        continue;
      }

      return googleApiError(c, 400, "Unsupported spreadsheet update request.", "badRequest", "INVALID_ARGUMENT");
    }

    spreadsheet = updateSpreadsheetSheets(gs, spreadsheet, sheets);
    return c.json({ spreadsheetId: spreadsheet.google_id, replies });
  });

  app.get("/v4/spreadsheets/:spreadsheetId", (c) => {
    const resolved = resolveSpreadsheet(c, gs);
    if (resolved instanceof Response) return resolved;
    return c.json(formatSpreadsheetResource(resolved.spreadsheet));
  });
}

function resolveSpreadsheet(c: Context, gs: ReturnType<typeof getGoogleStore>) {
  const authEmail = requireGoogleAuth(c);
  if (authEmail instanceof Response) return authEmail;
  const spreadsheet = getSpreadsheetById(gs, authEmail, c.req.param("spreadsheetId"));
  if (!spreadsheet) return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
  return { spreadsheet };
}

function getValues(body: Record<string, unknown>): unknown[][] {
  return Array.isArray(body.values) ? body.values.map((row) => (Array.isArray(row) ? row : [row])) : [];
}

function getFiniteNumber(value: Record<string, unknown>, key: string): number | undefined {
  const candidate = value[key];
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
}

function formatValueRange(range: string, values: unknown[][]) {
  return { range, majorDimension: "ROWS", values };
}

function invalidRange(c: Context, range: string) {
  return googleApiError(c, 400, `Unable to parse range: ${range}`, "badRequest", "INVALID_ARGUMENT");
}

function nextSheetId(sheetIds: number[]): number {
  return Math.max(-1, ...sheetIds) + 1;
}
