import type { RouteContext } from "@emulators/core";
import {
  createDocumentRecord,
  formatDocumentResource,
  getDocumentById,
  updateDocumentBody,
} from "../document-helpers.js";
import { googleApiError } from "../helpers.js";
import { getRecordArray, getString, parseGoogleBody, requireGoogleAuth } from "../route-helpers.js";
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

    return c.json(formatDocumentResource(document));
  });

  app.post("/v1/documents/:documentId{[^:]+}:batchUpdate", async (c) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const document = getDocumentById(gs, authEmail, c.req.param("documentId"));
    if (!document) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    const body = await parseGoogleBody(c);
    const requests = getRecordArray(body, "requests");
    let text = document.body;
    const replies: Record<string, unknown>[] = [];

    for (const request of requests) {
      const insertText = asRecord(request.insertText);
      if (insertText) {
        const value = getString(insertText, "text") ?? "";
        const location = asRecord(insertText.location);
        const endOfSegmentLocation = asRecord(insertText.endOfSegmentLocation);
        if (endOfSegmentLocation) {
          text += value;
        } else if (location) {
          const index = numberField(location, "index");
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

      const deleteContentRange = asRecord(request.deleteContentRange);
      if (deleteContentRange) {
        const range = asRecord(deleteContentRange.range);
        const startIndex = range ? numberField(range, "startIndex") : undefined;
        const endIndex = range ? numberField(range, "endIndex") : undefined;
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

      const replaceAllText = asRecord(request.replaceAllText);
      if (replaceAllText) {
        const containsText = asRecord(replaceAllText.containsText);
        const find = containsText ? getString(containsText, "text") : undefined;
        const replacement = getString(replaceAllText, "replaceText") ?? "";
        if (!find) {
          return googleApiError(c, 400, "replaceAllText requires search text.", "badRequest", "INVALID_ARGUMENT");
        }
        const matchCase = containsText?.matchCase === true;
        const flags = matchCase ? "g" : "gi";
        const pattern = new RegExp(escapeRegExp(find), flags);
        const occurrencesChanged = Array.from(text.matchAll(pattern)).length;
        text = text.replace(pattern, replacement);
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function numberField(value: Record<string, unknown>, field: string): number | undefined {
  const fieldValue = value[field];
  return typeof fieldValue === "number" && Number.isFinite(fieldValue) ? fieldValue : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
