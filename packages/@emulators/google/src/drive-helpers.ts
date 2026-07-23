import { generateUid, normalizeLimit, parseOffset } from "./helpers.js";
import type { GoogleDriveItem, GoogleDrivePermission, GoogleSharedDrive } from "./entities.js";
import type { GoogleStore } from "./store.js";

export const GOOGLE_DRIVE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

export interface GoogleDriveItemInput {
  google_id?: string;
  user_email: string;
  name: string;
  mime_type: string;
  description?: string | null;
  parent_google_ids?: string[];
  web_view_link?: string | null;
  size?: number | null;
  starred?: boolean;
  trashed?: boolean;
  drive_google_id?: string | null;
  owners?: NonNullable<GoogleDriveItem["owners"]>;
  data?: string | null;
}

export interface DriveListOptions {
  q?: string | null;
  pageSize?: string | null;
  pageToken?: string | null;
  orderBy?: string | null;
  corpora?: string | null;
  driveId?: string | null;
}

export interface ParsedDriveUpload {
  requestBody: Record<string, unknown>;
  media:
    | {
        mimeType: string;
        body: Buffer;
      }
    | undefined;
}

type DriveAccessLevel = "owner" | "shared-drive" | "writer" | "reader" | "none";

interface DriveAccessIndex {
  permissionRoles: Map<string, string>;
  sharedDriveIds: Set<string>;
}

export function createDriveItemRecord(gs: GoogleStore, input: GoogleDriveItemInput): GoogleDriveItem {
  const itemId = input.google_id ?? generateUid("drv");
  const existing = gs.driveItems.findBy("user_email", input.user_email).find((item) => item.google_id === itemId);
  if (existing) return existing;

  const item = gs.driveItems.insert({
    google_id: itemId,
    user_email: input.user_email,
    name: input.name,
    mime_type: input.mime_type,
    description: input.description ?? null,
    parent_google_ids: normalizeParentIds(input.parent_google_ids),
    web_view_link: input.web_view_link ?? buildDriveWebViewLink(itemId, input.mime_type),
    size: input.size ?? null,
    starred: input.starred ?? false,
    trashed: input.trashed ?? false,
    drive_google_id: input.drive_google_id ?? null,
    owners: input.owners ?? [{ email_address: input.user_email, display_name: null }],
    data: input.data ?? null,
  });

  return item;
}

export function getDriveItemById(gs: GoogleStore, userEmail: string, fileId: string): GoogleDriveItem | undefined {
  const accessIndex = buildDriveAccessIndex(gs, userEmail);
  return gs.driveItems
    .findBy("google_id", fileId)
    .find((item) => item.google_id === fileId && driveAccessLevel(userEmail, item, accessIndex) !== "none");
}

export function listDriveItems(
  gs: GoogleStore,
  userEmail: string,
  options: DriveListOptions,
): { files: GoogleDriveItem[]; nextPageToken?: string } {
  const accessIndex = buildDriveAccessIndex(gs, userEmail);
  const accessByItem = new Map<number, DriveAccessLevel>();
  let items = gs.driveItems.all().filter((item) => {
    const access = driveAccessLevel(userEmail, item, accessIndex);
    accessByItem.set(item.id, access);
    return access !== "none";
  });
  const parsed = parseDriveQuery(options.q ?? null);

  if (options.corpora === "drive" && options.driveId) {
    items = items.filter((item) => item.drive_google_id === options.driveId);
  }

  if (parsed.parentId) {
    items = items.filter((item) => item.parent_google_ids.includes(parsed.parentId!));
  }

  if (parsed.requireNotTrashed) {
    items = items.filter((item) => !item.trashed);
  }

  if (parsed.mimeTypes.length > 0) {
    items = items.filter((item) => parsed.mimeTypes.includes(item.mime_type));
  }

  if (parsed.excludeMimeTypes.length > 0) {
    items = items.filter((item) => !parsed.excludeMimeTypes.includes(item.mime_type));
  }

  if (parsed.name) {
    items = items.filter((item) => item.name === parsed.name);
  }

  if (parsed.nameContains) {
    const needle = parsed.nameContains.toLowerCase();
    items = items.filter((item) => item.name.toLowerCase().includes(needle));
  }

  if (parsed.requireStarred) {
    items = items.filter((item) => item.starred ?? false);
  }

  if (parsed.requireShared) {
    items = items.filter((item) => {
      const access = accessByItem.get(item.id);
      return access === "reader" || access === "writer";
    });
  }

  if (options.orderBy?.includes("name")) {
    items = items.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    items = items.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  const offset = parseOffset(options.pageToken);
  const limit = normalizeLimit(options.pageSize, 100, 1000);

  return {
    files: items.slice(offset, offset + limit),
    nextPageToken: offset + limit < items.length ? String(offset + limit) : undefined,
  };
}

export function updateDriveItemRecord(
  gs: GoogleStore,
  item: GoogleDriveItem,
  input: {
    addParents?: string[];
    removeParents?: string[];
    name?: string;
    description?: string | null;
    starred?: boolean;
    trashed?: boolean;
  },
): GoogleDriveItem {
  const nextParents = new Set(item.parent_google_ids);
  for (const parentId of input.addParents ?? []) {
    nextParents.add(parentId);
  }
  for (const parentId of input.removeParents ?? []) {
    nextParents.delete(parentId);
  }

  return (
    gs.driveItems.update(item.id, {
      name: input.name ?? item.name,
      description: input.description === undefined ? item.description : input.description,
      parent_google_ids: normalizeParentIds(Array.from(nextParents)),
      starred: input.starred ?? item.starred ?? false,
      trashed: input.trashed ?? item.trashed,
      web_view_link: buildDriveWebViewLink(item.google_id, item.mime_type),
    }) ?? item
  );
}

export function formatDriveItemResource(
  item: GoogleDriveItem,
  permissions: GoogleDrivePermission[],
  viewerEmail: string,
) {
  const owners = item.owners ?? [{ email_address: item.user_email, display_name: null }];
  return {
    kind: "drive#file",
    id: item.google_id,
    name: item.name,
    mimeType: item.mime_type,
    description: item.description ?? undefined,
    parents: item.parent_google_ids,
    webViewLink: item.web_view_link ?? undefined,
    createdTime: item.created_at,
    modifiedTime: item.updated_at,
    size: item.size != null ? String(item.size) : undefined,
    shared: permissions.length > 0 || item.drive_google_id != null,
    starred: item.starred ?? false,
    trashed: item.trashed || undefined,
    ownedByMe: owners.some((owner) => owner.email_address === viewerEmail),
    driveId: item.drive_google_id ?? undefined,
    owners: owners.map((owner) => ({
      emailAddress: owner.email_address,
      displayName: owner.display_name ?? undefined,
    })),
  };
}

export function listDrivePermissions(gs: GoogleStore, userEmail: string, fileId: string): GoogleDrivePermission[] {
  return gs.drivePermissions
    .findBy("user_email", userEmail)
    .filter((permission) => permission.file_google_id === fileId);
}

export function indexDrivePermissions(gs: GoogleStore, items: GoogleDriveItem[]): Map<number, GoogleDrivePermission[]> {
  const itemIdsByKey = new Map(items.map((item) => [driveItemKey(item.user_email, item.google_id), item.id]));
  const permissionsByItemId = new Map<number, GoogleDrivePermission[]>();

  for (const permission of gs.drivePermissions.all()) {
    const itemId = itemIdsByKey.get(driveItemKey(permission.user_email, permission.file_google_id));
    if (itemId === undefined) continue;
    const permissions = permissionsByItemId.get(itemId) ?? [];
    permissions.push(permission);
    permissionsByItemId.set(itemId, permissions);
  }

  return permissionsByItemId;
}

export function canEditDriveItem(gs: GoogleStore, userEmail: string, item: GoogleDriveItem): boolean {
  const access = driveAccessLevel(userEmail, item, buildDriveAccessIndex(gs, userEmail));
  return access === "owner" || access === "shared-drive" || access === "writer";
}

function buildDriveAccessIndex(gs: GoogleStore, userEmail: string): DriveAccessIndex {
  const permissionRoles = new Map<string, string>();
  for (const permission of gs.drivePermissions.all()) {
    if (permission.email_address === userEmail) {
      permissionRoles.set(driveItemKey(permission.user_email, permission.file_google_id), permission.role);
    }
  }
  const sharedDriveIds = new Set(
    gs.sharedDrives
      .all()
      .filter((drive) => drive.member_emails.includes(userEmail))
      .map((drive) => drive.google_id),
  );
  return { permissionRoles, sharedDriveIds };
}

function driveAccessLevel(userEmail: string, item: GoogleDriveItem, accessIndex: DriveAccessIndex): DriveAccessLevel {
  if (item.user_email === userEmail) return "owner";
  if (item.drive_google_id && accessIndex.sharedDriveIds.has(item.drive_google_id)) return "shared-drive";

  const role = accessIndex.permissionRoles.get(driveItemKey(item.user_email, item.google_id));
  if (role === "writer" || role === "organizer") return "writer";
  if (role === "reader" || role === "commenter") return "reader";
  return "none";
}

function driveItemKey(ownerEmail: string, fileId: string): string {
  return `${ownerEmail}\0${fileId}`;
}

export function createDrivePermissionRecord(
  gs: GoogleStore,
  input: {
    user_email: string;
    file_google_id: string;
    role: string;
    permission_type: string;
    email_address?: string | null;
    display_name?: string | null;
  },
): GoogleDrivePermission {
  const existing = listDrivePermissions(gs, input.user_email, input.file_google_id).find(
    (permission) =>
      permission.permission_type === input.permission_type &&
      permission.email_address === (input.email_address ?? null),
  );
  if (existing) {
    return (
      gs.drivePermissions.update(existing.id, {
        role: input.role,
        display_name: input.display_name ?? existing.display_name,
      }) ?? existing
    );
  }

  return gs.drivePermissions.insert({
    google_id: generateUid("perm"),
    user_email: input.user_email,
    file_google_id: input.file_google_id,
    role: input.role,
    permission_type: input.permission_type,
    email_address: input.email_address ?? null,
    display_name: input.display_name ?? null,
  });
}

export function deleteDrivePermissionRecord(
  gs: GoogleStore,
  userEmail: string,
  fileId: string,
  permissionId: string,
): boolean {
  const permission = listDrivePermissions(gs, userEmail, fileId).find(
    (candidate) => candidate.google_id === permissionId,
  );
  return permission ? gs.drivePermissions.delete(permission.id) : false;
}

export function listSharedDrives(gs: GoogleStore, userEmail: string, pageSize: string | null): GoogleSharedDrive[] {
  const limit = normalizeLimit(pageSize, 25, 100);
  return gs.sharedDrives
    .all()
    .filter((drive) => drive.member_emails.includes(userEmail))
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, limit);
}

export function parseDriveMultipartUpload(contentType: string, rawBody: Buffer): ParsedDriveUpload {
  const boundaryMatch = contentType.match(/boundary="?([^";]+)"?/i);
  const boundary = boundaryMatch?.[1];
  if (!boundary) {
    return {
      requestBody: {},
      media: undefined,
    };
  }

  const raw = rawBody.toString("latin1");
  const parts = raw
    .split(`--${boundary}`)
    .slice(1)
    .filter((part) => part !== "--" && part !== "--\r\n" && part !== "--\n");

  let requestBody: Record<string, unknown> = {};
  let media: ParsedDriveUpload["media"];

  for (const part of parts) {
    const normalized = stripMultipartBoundaryPadding(part);
    const headerSeparator = normalized.includes("\r\n\r\n") ? "\r\n\r\n" : "\n\n";
    const separatorIndex = normalized.indexOf(headerSeparator);
    if (separatorIndex < 0) continue;

    const headers = normalized.slice(0, separatorIndex).toLowerCase();
    const bodyText = normalized.slice(separatorIndex + headerSeparator.length);

    if (headers.includes("application/json")) {
      try {
        const parsed = JSON.parse(bodyText);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          requestBody = parsed;
        }
      } catch {
        requestBody = {};
      }
      continue;
    }

    const mimeTypeMatch = headers.match(/content-type:\s*([^\r\n;]+)/i);
    media = {
      mimeType: mimeTypeMatch?.[1]?.trim() ?? "application/octet-stream",
      body: Buffer.from(bodyText, "latin1"),
    };
  }

  return {
    requestBody,
    media,
  };
}

export function seedDefaultDriveItems(gs: GoogleStore, userEmail: string): void {
  if (gs.driveItems.findBy("user_email", userEmail).length > 0) return;

  const contractsFolder = createDriveItemRecord(gs, {
    google_id: "drv_contracts",
    user_email: userEmail,
    name: "Contracts",
    mime_type: GOOGLE_DRIVE_FOLDER_MIME_TYPE,
    parent_google_ids: ["root"],
  });

  createDriveItemRecord(gs, {
    google_id: "drv_pdf_guide",
    user_email: userEmail,
    name: "Welcome Guide.pdf",
    mime_type: "application/pdf",
    parent_google_ids: [contractsFolder.google_id],
    size: Buffer.byteLength("sample-pdf-data", "utf8"),
    data: Buffer.from("sample-pdf-data", "utf8").toString("base64url"),
  });
}

function parseDriveQuery(query: string | null): {
  parentId: string | null;
  mimeTypes: string[];
  excludeMimeTypes: string[];
  requireNotTrashed: boolean;
  requireStarred: boolean;
  requireShared: boolean;
  name: string | null;
  nameContains: string | null;
} {
  const source = query ?? "";
  const parentMatch = source.match(/'([^']+)' in parents/i);
  const mimeTypes = Array.from(source.matchAll(/mimeType = '([^']+)'/g)).map((match) => match[1]);
  const excludeMimeTypes = Array.from(source.matchAll(/mimeType != '([^']+)'/g)).map((match) => match[1]);
  const nameMatch = source.match(/name = '((?:\\'|[^'])+)'/i);
  const nameContainsMatch = source.match(/name contains '((?:\\'|[^'])+)'/i);

  return {
    parentId: parentMatch?.[1] ?? null,
    mimeTypes,
    excludeMimeTypes,
    requireNotTrashed: source.includes("trashed = false"),
    requireStarred: /starred\s*=\s*true/i.test(source),
    requireShared: /sharedWithMe\s*=\s*true/i.test(source),
    name: nameMatch?.[1]?.replaceAll("\\'", "'") ?? null,
    nameContains: nameContainsMatch?.[1]?.replaceAll("\\'", "'") ?? null,
  };
}

function buildDriveWebViewLink(itemId: string, mimeType: string): string {
  if (mimeType === GOOGLE_DRIVE_FOLDER_MIME_TYPE) {
    return `https://drive.google.com/drive/folders/${itemId}`;
  }

  return `https://drive.google.com/file/d/${itemId}/view`;
}

function normalizeParentIds(parentIds: string[] | undefined): string[] {
  const normalized = [...new Set((parentIds ?? ["root"]).filter(Boolean))];
  return normalized.length > 0 ? normalized : ["root"];
}

function stripMultipartBoundaryPadding(part: string): string {
  let normalized = part;

  if (normalized.startsWith("\r\n")) {
    normalized = normalized.slice(2);
  } else if (normalized.startsWith("\n")) {
    normalized = normalized.slice(1);
  }

  if (normalized.endsWith("\r\n")) {
    normalized = normalized.slice(0, -2);
  } else if (normalized.endsWith("\n")) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}
