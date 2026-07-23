import { createDriveItemRecord, getDriveItemById } from "./drive-helpers.js";
import type { GooglePresentation, GoogleSlide, GoogleSlideElement } from "./entities.js";
import { generateUid } from "./helpers.js";
import type { GoogleStore } from "./store.js";

export const GOOGLE_PRESENTATION_MIME_TYPE = "application/vnd.google-apps.presentation";

export interface GooglePresentationElementInput {
  id?: string;
  type?: "shape" | "image";
  shape_type?: string;
  placeholder_type?: string;
  text?: string;
  image_url?: string;
}

export interface GooglePresentationInput {
  google_id?: string;
  user_email: string;
  title: string;
  slides?: Array<{
    id?: string;
    layout?: string;
    elements?: GooglePresentationElementInput[];
  }>;
}

export function createPresentationRecord(gs: GoogleStore, input: GooglePresentationInput): GooglePresentation {
  const presentationId = input.google_id ?? generateUid("presentation");
  const existing = getPresentationById(gs, input.user_email, presentationId);
  if (existing) return existing;

  createDriveItemRecord(gs, {
    google_id: presentationId,
    user_email: input.user_email,
    name: input.title,
    mime_type: GOOGLE_PRESENTATION_MIME_TYPE,
    parent_google_ids: ["root"],
  });

  const requestedSlides = input.slides?.length ? input.slides : [{ layout: "TITLE" }];
  return gs.presentations.insert({
    google_id: presentationId,
    user_email: input.user_email,
    revision_id: "1",
    slides: requestedSlides.map((slide) => createSlideRecord(slide)),
  });
}

export function getPresentationById(
  gs: GoogleStore,
  userEmail: string,
  presentationId: string,
): GooglePresentation | undefined {
  return gs.presentations
    .findBy("user_email", userEmail)
    .find((presentation) => presentation.google_id === presentationId);
}

export function updatePresentationSlides(
  gs: GoogleStore,
  presentation: GooglePresentation,
  slides: GoogleSlide[],
): GooglePresentation {
  const revision = Number.parseInt(presentation.revision_id, 10);
  return (
    gs.presentations.update(presentation.id, {
      slides: cloneSlides(slides),
      revision_id: String(Number.isFinite(revision) ? revision + 1 : 1),
    }) ?? presentation
  );
}

export function cloneSlides(slides: GoogleSlide[]): GoogleSlide[] {
  return slides.map((slide) => ({
    ...slide,
    page_elements: slide.page_elements.map((element) => ({
      ...element,
      size: element.size ? { ...element.size } : null,
      transform: element.transform ? { ...element.transform } : null,
      text_style: { ...element.text_style },
      paragraph_style: { ...element.paragraph_style },
    })),
  }));
}

export function createSlideRecord(input?: {
  id?: string;
  layout?: string;
  elements?: GooglePresentationElementInput[];
}): GoogleSlide {
  const layout = input?.layout ?? "BLANK";
  return {
    object_id: input?.id ?? generateUid("slide"),
    layout_object_id: `layout_${layout.toLowerCase()}`,
    page_elements: (input?.elements ?? []).map((element) => createSlideElementRecord(element)),
  };
}

export function createSlideElementRecord(input?: {
  id?: string;
  type?: "shape" | "image";
  shape_type?: string;
  placeholder_type?: string;
  text?: string;
  image_url?: string;
  size?: Record<string, unknown>;
  transform?: Record<string, unknown>;
}): GoogleSlideElement {
  const elementType = input?.type ?? "shape";
  return {
    object_id: input?.id ?? generateUid(elementType),
    element_type: elementType,
    shape_type: elementType === "shape" ? (input?.shape_type ?? "TEXT_BOX") : null,
    placeholder_type: input?.placeholder_type ?? null,
    text: input?.text ?? "",
    image_url: elementType === "image" ? (input?.image_url ?? "") : null,
    size: input?.size ? { ...input.size } : null,
    transform: input?.transform ? { ...input.transform } : null,
    text_style: {},
    paragraph_style: {},
  };
}

export function formatPresentationResource(gs: GoogleStore, presentation: GooglePresentation) {
  const driveItem = getDriveItemById(gs, presentation.user_email, presentation.google_id);
  return {
    presentationId: presentation.google_id,
    title: driveItem?.name ?? "Untitled",
    revisionId: presentation.revision_id,
    slides: presentation.slides.map((slide) => ({
      objectId: slide.object_id,
      slideProperties: { layoutObjectId: slide.layout_object_id },
      pageElements: slide.page_elements.map((element) => formatPageElement(element)),
    })),
  };
}

function formatPageElement(element: GoogleSlideElement) {
  const common = {
    objectId: element.object_id,
    size: element.size ?? undefined,
    transform: element.transform ?? undefined,
  };

  if (element.element_type === "image") {
    return {
      ...common,
      image: { contentUrl: element.image_url ?? "" },
    };
  }

  const textLength = element.text.length;
  return {
    ...common,
    shape: {
      shapeType: element.shape_type ?? "TEXT_BOX",
      placeholder: element.placeholder_type ? { type: element.placeholder_type } : undefined,
      text: {
        textElements: [
          {
            startIndex: 0,
            endIndex: textLength,
            paragraphMarker: { style: element.paragraph_style },
          },
          ...(textLength > 0
            ? [
                {
                  startIndex: 0,
                  endIndex: textLength,
                  textRun: {
                    content: element.text,
                    style: element.text_style,
                  },
                },
              ]
            : []),
        ],
      },
    },
  };
}
