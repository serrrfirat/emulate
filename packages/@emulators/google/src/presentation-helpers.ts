import { createDriveItemRecord, getDriveItemById } from "./drive-helpers.js";
import type {
  GooglePresentation,
  GoogleSlide,
  GoogleSlideElement,
  GoogleSlideShapeElement,
  GoogleSlideStyleRun,
} from "./entities.js";
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
    page_elements: slide.page_elements.map((element) =>
      element.element_type === "shape"
        ? {
            ...element,
            size: element.size ? { ...element.size } : null,
            transform: element.transform ? { ...element.transform } : null,
            text_style_runs: cloneStyleRuns(element.text_style_runs),
            paragraph_style_runs: cloneStyleRuns(element.paragraph_style_runs),
          }
        : {
            ...element,
            size: element.size ? { ...element.size } : null,
            transform: element.transform ? { ...element.transform } : null,
          },
    ),
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
  const common = {
    object_id: input?.id ?? generateUid(elementType),
    size: input?.size ? { ...input.size } : null,
    transform: input?.transform ? { ...input.transform } : null,
  };
  if (elementType === "image") {
    return {
      ...common,
      element_type: "image",
      image_url: input?.image_url ?? "",
    };
  }
  return {
    ...common,
    element_type: "shape",
    shape_type: input?.shape_type ?? "TEXT_BOX",
    placeholder_type: input?.placeholder_type ?? null,
    text: input?.text ?? "",
    text_style_runs: [],
    paragraph_style_runs: [],
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
      image: { contentUrl: element.image_url },
    };
  }

  return {
    ...common,
    shape: {
      shapeType: element.shape_type,
      placeholder: element.placeholder_type ? { type: element.placeholder_type } : undefined,
      text: {
        textElements: formatTextElements(element),
      },
    },
  };
}

function cloneStyleRuns(runs: GoogleSlideStyleRun[]): GoogleSlideStyleRun[] {
  return runs.map((run) => ({ ...run, style: { ...run.style } }));
}

function formatTextElements(element: GoogleSlideShapeElement): Array<Record<string, unknown>> {
  if (element.text.length === 0) {
    return [{ startIndex: 0, endIndex: 0, paragraphMarker: { style: {} } }];
  }

  const boundaries = new Set([0, element.text.length]);
  for (const run of [...element.text_style_runs, ...element.paragraph_style_runs]) {
    boundaries.add(run.start_index);
    boundaries.add(run.end_index);
  }
  const positions = [...boundaries].sort((left, right) => left - right);
  const segments: Array<{
    start: number;
    end: number;
    paragraphStyle: Record<string, unknown>;
    textStyle: Record<string, unknown>;
  }> = [];

  for (let index = 0; index < positions.length - 1; index += 1) {
    const start = positions[index];
    const end = positions[index + 1];
    if (end <= start) continue;
    const paragraphStyle = resolveStyleAt(element.paragraph_style_runs, start);
    const textStyle = resolveStyleAt(element.text_style_runs, start);
    const previous = segments.at(-1);
    if (
      previous &&
      recordsEqual(previous.paragraphStyle, paragraphStyle) &&
      recordsEqual(previous.textStyle, textStyle)
    ) {
      previous.end = end;
    } else {
      segments.push({ start, end, paragraphStyle, textStyle });
    }
  }

  const result: Array<Record<string, unknown>> = [];
  for (const segment of segments) {
    result.push({
      startIndex: segment.start,
      endIndex: segment.end,
      paragraphMarker: { style: segment.paragraphStyle },
    });
    result.push({
      startIndex: segment.start,
      endIndex: segment.end,
      textRun: {
        content: element.text.slice(segment.start, segment.end),
        style: segment.textStyle,
      },
    });
  }
  return result;
}

function resolveStyleAt(runs: GoogleSlideStyleRun[], index: number): Record<string, unknown> {
  const style: Record<string, unknown> = {};
  for (const run of runs) {
    if (run.start_index <= index && index < run.end_index) {
      Object.assign(style, run.style);
    }
  }
  return style;
}

function recordsEqual(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
