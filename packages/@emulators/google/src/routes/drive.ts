import type { RouteContext } from "@emulators/core";
import type { Context } from "@emulators/core";
import {
  canEditDriveItem,
  createDrivePermissionRecord,
  createDriveItemRecord,
  deleteDrivePermissionRecord,
  formatDriveItemResource,
  getDriveItemById,
  listDriveItems,
  listDrivePermissions,
  listSharedDrives,
  parseDriveMultipartUpload,
  updateDriveItemRecord,
} from "../drive-helpers.js";
import { getDocumentById } from "../document-helpers.js";
import type { GoogleDriveItem } from "../entities.js";
import { googleApiError } from "../helpers.js";
import {
  getRecord,
  getString,
  parseDriveItemInputFromBody,
  parseGoogleBody,
  requireGoogleAuth,
} from "../route-helpers.js";
import { getSpreadsheetById } from "../spreadsheet-helpers.js";
import { getGoogleStore } from "../store.js";

export function driveRoutes({ app, store }: RouteContext): void {
  const gs = getGoogleStore(store);

  const createHandler = async (c: Context) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const contentType = c.req.header("Content-Type") ?? "";
    let requestBody: Record<string, unknown> = {};
    let media: { mimeType: string; body: Buffer } | undefined;

    if (contentType.includes("multipart/related")) {
      const rawBody = Buffer.from(await c.req.raw.arrayBuffer());
      const parsed = parseDriveMultipartUpload(contentType, rawBody);
      requestBody = parsed.requestBody;
      media = parsed.media;
    } else {
      const body = await parseGoogleBody(c);
      requestBody = getRecord(body, "requestBody") ?? body;
    }

    const item = createDriveItemRecord(gs, {
      user_email: authEmail,
      ...parseDriveItemInputFromBody(requestBody, {
        mimeType: media?.mimeType,
      }),
      description: getString(requestBody, "description") ?? null,
      size: media ? media.body.length : null,
      data: media ? media.body.toString("base64url") : null,
    });
    return c.json(formatDriveItemResource(item, listDrivePermissions(gs, item.user_email, item.google_id), authEmail));
  };

  app.get("/drive/v3/files", (c) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const url = new URL(c.req.url);
    const response = listDriveItems(gs, authEmail, {
      q: url.searchParams.get("q"),
      pageSize: url.searchParams.get("pageSize"),
      pageToken: url.searchParams.get("pageToken"),
      orderBy: url.searchParams.get("orderBy"),
      corpora: url.searchParams.get("corpora"),
      driveId: url.searchParams.get("driveId"),
    });

    return c.json({
      kind: "drive#fileList",
      files: response.files.map((item) =>
        formatDriveItemResource(item, listDrivePermissions(gs, item.user_email, item.google_id), authEmail),
      ),
      nextPageToken: response.nextPageToken,
    });
  });

  app.post("/drive/v3/files", createHandler);
  app.post("/upload/drive/v3/files", createHandler);

  app.get("/drive/v3/files/:fileId", (c) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const item = getDriveItemById(gs, authEmail, c.req.param("fileId"));
    if (!item) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    const url = new URL(c.req.url);
    if (url.searchParams.get("alt") === "media") {
      return new Response(item.data ? Buffer.from(item.data, "base64url") : Buffer.alloc(0), {
        status: 200,
        headers: {
          "Content-Type": item.mime_type,
        },
      });
    }

    return c.json(formatDriveItemResource(item, listDrivePermissions(gs, item.user_email, item.google_id), authEmail));
  });

  app.get("/drive/v3/files/:fileId/export", (c) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const item = getDriveItemById(gs, authEmail, c.req.param("fileId"));
    if (!item) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }
    const mimeType = new URL(c.req.url).searchParams.get("mimeType") ?? "text/plain";
    const exported = exportNativeDriveItem(item, mimeType);
    if (exported === undefined) {
      return googleApiError(c, 400, "File cannot be exported.", "badRequest", "INVALID_ARGUMENT");
    }
    return new Response(exported, { status: 200, headers: { "Content-Type": mimeType } });
  });

  const updateHandler = async (c: Context) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const item = getDriveItemById(gs, authEmail, c.req.param("fileId")!);
    if (!item) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }
    if (!canEditDriveItem(gs, authEmail, item)) {
      return googleApiError(c, 403, "The user does not have sufficient permissions.", "forbidden", "PERMISSION_DENIED");
    }

    const url = new URL(c.req.url);
    const body = await parseGoogleBody(c);
    const requestBody = getRecord(body, "requestBody") ?? body;
    const addParents = (url.searchParams.get("addParents") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const removeParents = (url.searchParams.get("removeParents") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    const updated = updateDriveItemRecord(gs, item, {
      addParents,
      removeParents,
      name: getString(requestBody, "name"),
      description: getString(requestBody, "description"),
      starred: typeof requestBody.starred === "boolean" ? requestBody.starred : undefined,
      trashed: typeof requestBody.trashed === "boolean" ? requestBody.trashed : undefined,
    });

    return c.json(
      formatDriveItemResource(updated, listDrivePermissions(gs, updated.user_email, updated.google_id), authEmail),
    );
  };

  app.patch("/drive/v3/files/:fileId", updateHandler);
  app.put("/drive/v3/files/:fileId", updateHandler);

  app.delete("/drive/v3/files/:fileId", (c) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const item = getDriveItemById(gs, authEmail, c.req.param("fileId"));
    if (!item) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }
    if (item.user_email !== authEmail) {
      return googleApiError(c, 403, "The user does not have sufficient permissions.", "forbidden", "PERMISSION_DENIED");
    }

    for (const permission of listDrivePermissions(gs, authEmail, item.google_id)) {
      gs.drivePermissions.delete(permission.id);
    }
    const document = getDocumentById(gs, authEmail, item.google_id);
    if (document) gs.documents.delete(document.id);
    const spreadsheet = getSpreadsheetById(gs, authEmail, item.google_id);
    if (spreadsheet) gs.spreadsheets.delete(spreadsheet.id);
    gs.driveItems.delete(item.id);
    return c.body(null, 204);
  });

  app.post("/drive/v3/files/:fileId/permissions", async (c) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const item = getDriveItemById(gs, authEmail, c.req.param("fileId"));
    if (!item) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }
    if (item.user_email !== authEmail) {
      return googleApiError(c, 403, "The user does not have sufficient permissions.", "forbidden", "PERMISSION_DENIED");
    }

    const body = await parseGoogleBody(c);
    const role = getString(body, "role");
    const permissionType = getString(body, "type");
    const emailAddress = getString(body, "emailAddress");
    const validRoles = new Set(["reader", "commenter", "writer", "organizer"]);
    if (!role || !validRoles.has(role) || permissionType !== "user" || !emailAddress) {
      return googleApiError(c, 400, "Invalid permission.", "badRequest", "INVALID_ARGUMENT");
    }

    const permission = createDrivePermissionRecord(gs, {
      user_email: authEmail,
      file_google_id: item.google_id,
      role,
      permission_type: permissionType,
      email_address: emailAddress,
      display_name: emailAddress,
    });
    return c.json(formatDrivePermission(permission));
  });

  app.get("/drive/v3/files/:fileId/permissions", (c) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const item = getDriveItemById(gs, authEmail, c.req.param("fileId"));
    if (!item) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    return c.json({
      kind: "drive#permissionList",
      permissions: listDrivePermissions(gs, item.user_email, item.google_id).map(formatDrivePermission),
    });
  });

  app.delete("/drive/v3/files/:fileId/permissions/:permissionId", (c) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const item = getDriveItemById(gs, authEmail, c.req.param("fileId"));
    if (!item) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }
    if (item.user_email !== authEmail) {
      return googleApiError(c, 403, "The user does not have sufficient permissions.", "forbidden", "PERMISSION_DENIED");
    }

    if (!deleteDrivePermissionRecord(gs, authEmail, item.google_id, c.req.param("permissionId"))) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }
    return c.body(null, 204);
  });

  app.get("/drive/v3/drives", (c) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const pageSize = new URL(c.req.url).searchParams.get("pageSize");
    return c.json({
      kind: "drive#driveList",
      drives: listSharedDrives(gs, authEmail, pageSize).map((drive) => ({
        kind: "drive#drive",
        id: drive.google_id,
        name: drive.name,
      })),
    });
  });

  function exportNativeDriveItem(item: GoogleDriveItem, exportMimeType: string): string | undefined {
    if (item.mime_type === "application/vnd.google-apps.document" && exportMimeType === "text/plain") {
      return getDocumentById(gs, item.user_email, item.google_id)?.body;
    }
    if (item.mime_type === "application/vnd.google-apps.spreadsheet" && exportMimeType === "text/csv") {
      const spreadsheet = getSpreadsheetById(gs, item.user_email, item.google_id);
      const sheet = spreadsheet?.sheets[0];
      return sheet ? sheet.values.map((row) => row.map(formatCsvCell).join(",")).join("\n") : undefined;
    }
    if (
      (item.mime_type === "application/vnd.google-apps.presentation" && exportMimeType === "text/plain") ||
      (item.mime_type === "application/vnd.google-apps.drawing" && exportMimeType === "image/svg+xml")
    ) {
      return item?.data ? Buffer.from(item.data, "base64url").toString("utf8") : undefined;
    }
    return undefined;
  }
}

function formatDrivePermission(permission: ReturnType<typeof createDrivePermissionRecord>) {
  return {
    kind: "drive#permission",
    id: permission.google_id,
    role: permission.role,
    type: permission.permission_type,
    emailAddress: permission.email_address ?? undefined,
    displayName: permission.display_name ?? undefined,
  };
}

function formatCsvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
