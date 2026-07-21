import { createDriveItemRecord } from "./drive-helpers.js";
import type { GoogleDocument } from "./entities.js";
import { generateUid } from "./helpers.js";
import type { GoogleStore } from "./store.js";

export const GOOGLE_DOCUMENT_MIME_TYPE = "application/vnd.google-apps.document";

export interface GoogleDocumentInput {
  google_id?: string;
  user_email: string;
  title: string;
  body?: string;
}

export function createDocumentRecord(gs: GoogleStore, input: GoogleDocumentInput): GoogleDocument {
  const documentId = input.google_id ?? generateUid("doc");
  const existing = getDocumentById(gs, input.user_email, documentId);
  if (existing) return existing;

  const document = gs.documents.insert({
    google_id: documentId,
    user_email: input.user_email,
    title: input.title,
    body: input.body ?? "",
    revision_id: "1",
  });

  createDriveItemRecord(gs, {
    google_id: documentId,
    user_email: input.user_email,
    name: input.title,
    mime_type: GOOGLE_DOCUMENT_MIME_TYPE,
    parent_google_ids: ["root"],
  });

  return document;
}

export function getDocumentById(gs: GoogleStore, userEmail: string, documentId: string): GoogleDocument | undefined {
  return gs.documents.findBy("user_email", userEmail).find((document) => document.google_id === documentId);
}

export function updateDocumentBody(gs: GoogleStore, document: GoogleDocument, body: string): GoogleDocument {
  const revision = Number.parseInt(document.revision_id, 10);
  return (
    gs.documents.update(document.id, {
      body,
      revision_id: String(Number.isFinite(revision) ? revision + 1 : 1),
    }) ?? document
  );
}

export function formatDocumentResource(document: GoogleDocument) {
  const startIndex = 1;
  const endIndex = startIndex + document.body.length;
  const content = document.body
    ? [
        {
          startIndex,
          endIndex,
          paragraph: {
            elements: [
              {
                startIndex,
                endIndex,
                textRun: { content: document.body },
              },
            ],
          },
        },
      ]
    : [{ startIndex, endIndex: startIndex, paragraph: { elements: [] } }];

  return {
    documentId: document.google_id,
    title: document.title,
    revisionId: document.revision_id,
    body: { content },
  };
}
