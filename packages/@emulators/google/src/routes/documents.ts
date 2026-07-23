import type { RouteContext } from "@emulators/core";
import {
  createDocumentRecord,
  formatDocumentResource,
  getDocumentById,
  updateDocumentBody,
} from "../document-helpers.js";
import { googleApiError } from "../helpers.js";
import {
  getFiniteNumber,
  getRecord,
  getRecordArray,
  getString,
  parseGoogleBody,
  requireGoogleAuth,
} from "../route-helpers.js";
import { getGoogleStore } from "../store.js";

export function documentRoutes({ app, store }: RouteContext): void {
  const gs = getGoogleStore(store);

  app.post("/v1/documents", async (c) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const body = await parseGoogleBody(c);
    const title = getString(body, "title")?.trim();
    if (!title) {
      return googleApiError(c, 400, "Document title is required.", "badRequest", "INVALID_ARGUMENT");
    }

    return c.json(
      formatDocumentResource(
        gs,
        createDocumentRecord(gs, {
          user_email: authEmail,
          title,
        }),
      ),
    );
  });

  app.get("/v1/documents/:documentId", (c) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const document = getDocumentById(gs, authEmail, c.req.param("documentId"));
    if (!document) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    return c.json(formatDocumentResource(gs, document));
  });

  app.post("/v1/documents/:documentId{[^:]+}:batchUpdate", async (c) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const body = await parseGoogleBody(c);
    const document = getDocumentById(gs, authEmail, c.req.param("documentId"));
    if (!document) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    const writeControl = getRecord(body, "writeControl");
    const requiredRevisionId = writeControl ? getString(writeControl, "requiredRevisionId") : undefined;
    if (requiredRevisionId && requiredRevisionId !== document.revision_id) {
      return googleApiError(c, 400, "The document revision does not match.", "badRequest", "FAILED_PRECONDITION");
    }

    const requests = getRecordArray(body, "requests");
    let text = document.body;
    const replies: Record<string, unknown>[] = [];

    for (const request of requests) {
      const insertText = getRecord(request, "insertText");
      if (insertText) {
        const value = getString(insertText, "text") ?? "";
        const location = getRecord(insertText, "location");
        const endOfSegmentLocation = getRecord(insertText, "endOfSegmentLocation");
        if (endOfSegmentLocation) {
          text += value;
        } else if (location) {
          const index = getFiniteNumber(location, "index");
          if (index === undefined || index < 1 || index > text.length + 1) {
            return googleApiError(c, 400, "Invalid insertText location.", "badRequest", "INVALID_ARGUMENT");
          }
          const offset = index - 1;
          text = text.slice(0, offset) + value + text.slice(offset);
        } else {
          return googleApiError(c, 400, "insertText requires a location.", "badRequest", "INVALID_ARGUMENT");
        }
        replies.push({});
        continue;
      }

      const deleteContentRange = getRecord(request, "deleteContentRange");
      if (deleteContentRange) {
        const range = getRecord(deleteContentRange, "range");
        const startIndex = range ? getFiniteNumber(range, "startIndex") : undefined;
        const endIndex = range ? getFiniteNumber(range, "endIndex") : undefined;
        if (
          startIndex === undefined ||
          endIndex === undefined ||
          startIndex < 1 ||
          endIndex < startIndex ||
          endIndex > text.length + 1
        ) {
          return googleApiError(c, 400, "Invalid deleteContentRange.", "badRequest", "INVALID_ARGUMENT");
        }
        text = text.slice(0, startIndex - 1) + text.slice(endIndex - 1);
        replies.push({});
        continue;
      }

      const replaceAllText = getRecord(request, "replaceAllText");
      if (replaceAllText) {
        const containsText = getRecord(replaceAllText, "containsText");
        const find = containsText ? getString(containsText, "text") : undefined;
        const replacement = getString(replaceAllText, "replaceText") ?? "";
        if (!find) {
          return googleApiError(c, 400, "replaceAllText requires search text.", "badRequest", "INVALID_ARGUMENT");
        }
        const matchCase = containsText?.matchCase === true;
        const flags = matchCase ? "g" : "gi";
        const pattern = new RegExp(escapeRegExp(find), flags);
        const occurrencesChanged = Array.from(text.matchAll(pattern)).length;
        text = text.replace(pattern, () => replacement);
        replies.push({ replaceAllText: { occurrencesChanged } });
        continue;
      }

      if (
        request.updateTextStyle ||
        request.updateParagraphStyle ||
        request.createParagraphBullets ||
        request.insertTable
      ) {
        replies.push({});
        continue;
      }

      return googleApiError(c, 400, "Unsupported document update request.", "badRequest", "INVALID_ARGUMENT");
    }

    const updated = updateDocumentBody(gs, document, text);
    return c.json({
      documentId: updated.google_id,
      replies,
      writeControl: { requiredRevisionId: updated.revision_id },
    });
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
