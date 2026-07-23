import type { RouteContext } from "@emulators/core";
import type { GoogleSlide, GoogleSlideElement, GoogleSlideShapeElement, GoogleSlideStyleRun } from "../entities.js";
import { googleApiError } from "../helpers.js";
import {
  cloneSlides,
  createPresentationRecord,
  createSlideElementRecord,
  createSlideRecord,
  formatPresentationResource,
  getPresentationById,
  updatePresentationSlides,
} from "../presentation-helpers.js";
import { getFiniteNumber, getRecord, getString, parseGoogleBody, requireGoogleAuth } from "../route-helpers.js";
import { getGoogleStore } from "../store.js";

const MAX_BATCH_BODY_BYTES = 2 * 1024 * 1024;
const MAX_BATCH_REQUESTS = 1_000;
const MAX_TEXT_LENGTH = 1_000_000;

type ObjectReference =
  | { kind: "slide"; slide: GoogleSlide }
  | { kind: "element"; slide: GoogleSlide; element: GoogleSlideElement };

interface WorkingPresentation {
  presentationId: string;
  slides: GoogleSlide[];
  objects: Map<string, ObjectReference>;
  textLength: number;
}

type ApplyResult = { reply: Record<string, unknown> } | { error: string; status?: 400 | 413 };

export function presentationRoutes({ app, store }: RouteContext): void {
  const gs = getGoogleStore(store);

  app.post("/v1/presentations", async (c) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const body = await parseGoogleBody(c);
    const title = getString(body, "title")?.trim();
    if (!title) {
      return googleApiError(c, 400, "Presentation title is required.", "badRequest", "INVALID_ARGUMENT");
    }

    const presentation = createPresentationRecord(gs, {
      user_email: authEmail,
      title,
    });
    return c.json(formatPresentationResource(gs, presentation));
  });

  app.get("/v1/presentations/:presentationId/pages/:pageObjectId/thumbnail", (c) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const presentation = getPresentationById(gs, authEmail, c.req.param("presentationId"));
    if (!presentation) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }
    const slide = presentation.slides.find((candidate) => candidate.object_id === c.req.param("pageObjectId"));
    if (!slide) {
      return googleApiError(c, 404, "Requested page was not found.", "notFound", "NOT_FOUND");
    }

    const resource = formatPresentationResource(gs, presentation);
    const title = escapeXml(resource.title);
    const label = escapeXml(slide.object_id);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="white"/><text x="80" y="120" font-family="sans-serif" font-size="48">${title}</text><text x="80" y="200" font-family="sans-serif" font-size="28">${label}</text></svg>`;
    return c.json({
      contentUrl: `data:image/svg+xml,${encodeURIComponent(svg)}`,
      width: 1600,
      height: 900,
    });
  });

  app.post("/v1/presentations/:presentationId{[^:]+}:batchUpdate", async (c) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const body = await parseGoogleBody(c, MAX_BATCH_BODY_BYTES);
    if (body instanceof Response) return body;
    const presentation = getPresentationById(gs, authEmail, c.req.param("presentationId"));
    if (!presentation) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }

    const writeControl = getRecord(body, "writeControl");
    const requiredRevisionId = writeControl ? getString(writeControl, "requiredRevisionId") : undefined;
    if (requiredRevisionId && requiredRevisionId !== presentation.revision_id) {
      return googleApiError(c, 400, "The presentation revision does not match.", "badRequest", "FAILED_PRECONDITION");
    }

    const working: WorkingPresentation = {
      presentationId: presentation.google_id,
      slides: cloneSlides(presentation.slides),
      objects: new Map(),
      textLength: 0,
    };
    const indexError = indexPresentationObjects(working);
    if (indexError) {
      return googleApiError(c, 400, indexError, "badRequest", "INVALID_ARGUMENT");
    }
    if (working.textLength > MAX_TEXT_LENGTH) {
      return googleApiError(c, 413, "Presentation text is too large.", "badRequest", "RESOURCE_EXHAUSTED");
    }

    const requests = body.requests;
    if (
      !Array.isArray(requests) ||
      requests.length === 0 ||
      requests.length > MAX_BATCH_REQUESTS ||
      !requests.every(isRecord)
    ) {
      const status = Array.isArray(requests) && requests.length > MAX_BATCH_REQUESTS ? 413 : 400;
      const statusCode = status === 413 ? "RESOURCE_EXHAUSTED" : "INVALID_ARGUMENT";
      return googleApiError(
        c,
        status,
        status === 413
          ? `A batch can contain at most ${MAX_BATCH_REQUESTS} requests.`
          : "requests must be a non-empty array of request objects.",
        "badRequest",
        statusCode,
      );
    }
    const replies: Record<string, unknown>[] = [];

    for (const request of requests) {
      const result = applyPresentationRequest(working, request);
      if ("error" in result) {
        const status = result.status ?? 400;
        return googleApiError(
          c,
          status,
          result.error,
          "badRequest",
          status === 413 ? "RESOURCE_EXHAUSTED" : "INVALID_ARGUMENT",
        );
      }
      replies.push(result.reply);
    }

    const updated = updatePresentationSlides(gs, presentation, working.slides);
    return c.json({
      presentationId: updated.google_id,
      replies,
      writeControl: { requiredRevisionId: updated.revision_id },
    });
  });

  app.get("/v1/presentations/:presentationId", (c) => {
    const authEmail = requireGoogleAuth(c);
    if (authEmail instanceof Response) return authEmail;

    const presentation = getPresentationById(gs, authEmail, c.req.param("presentationId"));
    if (!presentation) {
      return googleApiError(c, 404, "Requested entity was not found.", "notFound", "NOT_FOUND");
    }
    return c.json(formatPresentationResource(gs, presentation));
  });
}

function applyPresentationRequest(presentation: WorkingPresentation, request: Record<string, unknown>): ApplyResult {
  const createSlide = getRecord(request, "createSlide");
  if (createSlide) {
    const objectId = getString(createSlide, "objectId");
    if (objectId && objectIdExists(presentation, objectId)) return { error: "Object ID already exists." };
    const layoutReference = getRecord(createSlide, "slideLayoutReference");
    const layout = getString(layoutReference ?? {}, "predefinedLayout") ?? "BLANK";
    const insertionIndex = getFiniteNumber(createSlide, "insertionIndex") ?? presentation.slides.length;
    if (!Number.isSafeInteger(insertionIndex) || insertionIndex < 0 || insertionIndex > presentation.slides.length) {
      return { error: "Invalid slide insertion index." };
    }
    const slide = createSlideRecord({ id: objectId, layout });
    if (objectIdExists(presentation, slide.object_id)) return { error: "Object ID already exists." };
    presentation.slides.splice(insertionIndex, 0, slide);
    presentation.objects.set(slide.object_id, { kind: "slide", slide });
    return { reply: { createSlide: { objectId: slide.object_id } } };
  }

  const deleteObject = getRecord(request, "deleteObject");
  if (deleteObject) {
    const objectId = getString(deleteObject, "objectId");
    if (!objectId) return { error: "deleteObject requires an objectId." };
    const reference = presentation.objects.get(objectId);
    if (reference?.kind === "slide") {
      const slideIndex = presentation.slides.indexOf(reference.slide);
      presentation.slides.splice(slideIndex, 1);
      presentation.objects.delete(reference.slide.object_id);
      for (const element of reference.slide.page_elements) {
        if (element.element_type === "shape") presentation.textLength -= element.text.length;
        presentation.objects.delete(element.object_id);
      }
      return { reply: {} };
    }
    if (reference?.kind === "element") {
      const elementIndex = reference.slide.page_elements.indexOf(reference.element);
      reference.slide.page_elements.splice(elementIndex, 1);
      if (reference.element.element_type === "shape") presentation.textLength -= reference.element.text.length;
      presentation.objects.delete(reference.element.object_id);
      return { reply: {} };
    }
    return { error: "Object was not found." };
  }

  const insertText = getRecord(request, "insertText");
  if (insertText) {
    const element = findShape(presentation, getString(insertText, "objectId"));
    if (!element) return { error: "Text shape was not found." };
    const text = getString(insertText, "text") ?? "";
    if (text.length > MAX_TEXT_LENGTH || presentation.textLength + text.length > MAX_TEXT_LENGTH) {
      return { error: "Presentation text exceeds the supported size.", status: 413 };
    }
    const insertionIndex = getFiniteNumber(insertText, "insertionIndex") ?? 0;
    if (!Number.isSafeInteger(insertionIndex) || insertionIndex < 0 || insertionIndex > element.text.length) {
      return { error: "Invalid text insertion index." };
    }
    insertElementText(element, insertionIndex, text);
    presentation.textLength += text.length;
    return { reply: {} };
  }

  const deleteText = getRecord(request, "deleteText");
  if (deleteText) {
    const element = findShape(presentation, getString(deleteText, "objectId"));
    if (!element) return { error: "Text shape was not found." };
    const range = resolveTextRange(getRecord(deleteText, "textRange"), element.text.length);
    if (!range) return { error: "Invalid text deletion range." };
    deleteElementText(element, range.start, range.end);
    presentation.textLength -= range.end - range.start;
    return { reply: {} };
  }

  const replaceAllText = getRecord(request, "replaceAllText");
  if (replaceAllText) {
    const containsText = getRecord(replaceAllText, "containsText");
    const find = getString(containsText ?? {}, "text");
    if (!find) return { error: "replaceAllText requires search text." };
    const replaceText = getString(replaceAllText, "replaceText") ?? "";
    if (find.length > MAX_TEXT_LENGTH || replaceText.length > MAX_TEXT_LENGTH) {
      return { error: "Replacement text exceeds the supported size.", status: 413 };
    }
    const pattern = new RegExp(escapeRegExp(find), containsText?.matchCase === true ? "g" : "gi");
    let occurrencesChanged = 0;
    for (const slide of presentation.slides) {
      for (const element of slide.page_elements) {
        if (element.element_type !== "shape") continue;
        const matches = Array.from(element.text.matchAll(pattern));
        occurrencesChanged += matches.length;
        const resultingLength = element.text.length + matches.length * (replaceText.length - find.length);
        if (
          resultingLength > MAX_TEXT_LENGTH ||
          presentation.textLength - element.text.length + resultingLength > MAX_TEXT_LENGTH
        ) {
          return { error: "Presentation text exceeds the supported size.", status: 413 };
        }
        presentation.textLength += resultingLength - element.text.length;
        for (const match of matches.reverse()) {
          const start = match.index;
          replaceElementText(element, start, start + match[0].length, replaceText);
        }
      }
    }
    return { reply: { replaceAllText: { occurrencesChanged } } };
  }

  const createShape = getRecord(request, "createShape");
  if (createShape) {
    const objectId = getString(createShape, "objectId");
    if (objectId && objectIdExists(presentation, objectId)) return { error: "Object ID already exists." };
    const elementProperties = getRecord(createShape, "elementProperties");
    const slide = findSlide(presentation, getString(elementProperties ?? {}, "pageObjectId"));
    if (!slide) return { error: "Target slide was not found." };
    const element = createSlideElementRecord({
      id: objectId,
      type: "shape",
      shape_type: getString(createShape, "shapeType") ?? "TEXT_BOX",
      size: getRecord(elementProperties ?? {}, "size"),
      transform: getRecord(elementProperties ?? {}, "transform"),
    });
    if (objectIdExists(presentation, element.object_id)) return { error: "Object ID already exists." };
    slide.page_elements.push(element);
    presentation.objects.set(element.object_id, { kind: "element", slide, element });
    return { reply: { createShape: { objectId: element.object_id } } };
  }

  const createImage = getRecord(request, "createImage");
  if (createImage) {
    const objectId = getString(createImage, "objectId");
    if (objectId && objectIdExists(presentation, objectId)) return { error: "Object ID already exists." };
    const imageUrl = getString(createImage, "url");
    if (!imageUrl) return { error: "createImage requires a URL." };
    const elementProperties = getRecord(createImage, "elementProperties");
    const slide = findSlide(presentation, getString(elementProperties ?? {}, "pageObjectId"));
    if (!slide) return { error: "Target slide was not found." };
    const element = createSlideElementRecord({
      id: objectId,
      type: "image",
      image_url: imageUrl,
      size: getRecord(elementProperties ?? {}, "size"),
      transform: getRecord(elementProperties ?? {}, "transform"),
    });
    if (objectIdExists(presentation, element.object_id)) return { error: "Object ID already exists." };
    slide.page_elements.push(element);
    presentation.objects.set(element.object_id, { kind: "element", slide, element });
    return { reply: { createImage: { objectId: element.object_id } } };
  }

  const updateTextStyle = getRecord(request, "updateTextStyle");
  if (updateTextStyle) {
    const element = findShape(presentation, getString(updateTextStyle, "objectId"));
    const style = getRecord(updateTextStyle, "style");
    if (!element || !style) return { error: "updateTextStyle requires a text shape and style." };
    const range = resolveTextRange(getRecord(updateTextStyle, "textRange"), element.text.length);
    if (!range) {
      return { error: "Invalid text style range." };
    }
    addStyleRun(element.text_style_runs, range.start, range.end, style);
    return { reply: {} };
  }

  const updateParagraphStyle = getRecord(request, "updateParagraphStyle");
  if (updateParagraphStyle) {
    const element = findShape(presentation, getString(updateParagraphStyle, "objectId"));
    const style = getRecord(updateParagraphStyle, "style");
    if (!element || !style) return { error: "updateParagraphStyle requires a text shape and style." };
    const range = resolveTextRange(getRecord(updateParagraphStyle, "textRange"), element.text.length);
    if (!range) {
      return { error: "Invalid paragraph style range." };
    }
    addStyleRun(element.paragraph_style_runs, range.start, range.end, style);
    return { reply: {} };
  }

  const replaceShapes = getRecord(request, "replaceAllShapesWithImage");
  if (replaceShapes) {
    const containsText = getRecord(replaceShapes, "containsText");
    const find = getString(containsText ?? {}, "text");
    const imageUrl = getString(replaceShapes, "imageUrl");
    if (!find || !imageUrl) return { error: "replaceAllShapesWithImage requires search text and an image URL." };
    const matchCase = containsText?.matchCase === true;
    const needle = matchCase ? find : find.toLowerCase();
    let occurrencesChanged = 0;
    for (const slide of presentation.slides) {
      for (let elementIndex = 0; elementIndex < slide.page_elements.length; elementIndex += 1) {
        const element = slide.page_elements[elementIndex];
        if (element.element_type !== "shape") continue;
        const haystack = matchCase ? element.text : element.text.toLowerCase();
        if (!haystack.includes(needle)) continue;
        const image: GoogleSlideElement = {
          object_id: element.object_id,
          element_type: "image",
          image_url: imageUrl,
          size: element.size,
          transform: element.transform,
        };
        slide.page_elements[elementIndex] = image;
        presentation.objects.set(image.object_id, { kind: "element", slide, element: image });
        presentation.textLength -= element.text.length;
        occurrencesChanged += 1;
      }
    }
    return { reply: { replaceAllShapesWithImage: { occurrencesChanged } } };
  }

  return { error: "Unsupported presentation update request." };
}

function findSlide(presentation: WorkingPresentation, objectId: string | undefined): GoogleSlide | undefined {
  if (!objectId) return undefined;
  const reference = presentation.objects.get(objectId);
  return reference?.kind === "slide" ? reference.slide : undefined;
}

function findShape(
  presentation: WorkingPresentation,
  objectId: string | undefined,
): GoogleSlideShapeElement | undefined {
  if (!objectId) return undefined;
  const reference = presentation.objects.get(objectId);
  return reference?.kind === "element" && reference.element.element_type === "shape" ? reference.element : undefined;
}

function objectIdExists(presentation: WorkingPresentation, objectId: string): boolean {
  return presentation.objects.has(objectId);
}

function indexPresentationObjects(presentation: WorkingPresentation): string | undefined {
  for (const slide of presentation.slides) {
    if (presentation.objects.has(slide.object_id)) return "Object ID already exists.";
    presentation.objects.set(slide.object_id, { kind: "slide", slide });
    for (const element of slide.page_elements) {
      if (presentation.objects.has(element.object_id)) return "Object ID already exists.";
      presentation.objects.set(element.object_id, { kind: "element", slide, element });
      if (element.element_type === "shape") presentation.textLength += element.text.length;
    }
  }
  return undefined;
}

function insertElementText(element: GoogleSlideShapeElement, index: number, text: string): void {
  if (text.length === 0) return;
  element.text = element.text.slice(0, index) + text + element.text.slice(index);
  shiftRunsForInsertion(element.text_style_runs, index, text.length);
  shiftRunsForInsertion(element.paragraph_style_runs, index, text.length);
}

function deleteElementText(element: GoogleSlideShapeElement, start: number, end: number): void {
  if (start === end) return;
  element.text = element.text.slice(0, start) + element.text.slice(end);
  shiftRunsForDeletion(element.text_style_runs, start, end);
  shiftRunsForDeletion(element.paragraph_style_runs, start, end);
}

function replaceElementText(element: GoogleSlideShapeElement, start: number, end: number, replacement: string): void {
  const inheritedTextStyle = resolveStyleAt(element.text_style_runs, start);
  const inheritedParagraphStyle = resolveStyleAt(element.paragraph_style_runs, start);
  deleteElementText(element, start, end);
  insertElementText(element, start, replacement);
  if (replacement.length > 0) {
    if (Object.keys(inheritedTextStyle).length > 0) {
      addStyleRun(element.text_style_runs, start, start + replacement.length, inheritedTextStyle);
    }
    if (Object.keys(inheritedParagraphStyle).length > 0) {
      addStyleRun(element.paragraph_style_runs, start, start + replacement.length, inheritedParagraphStyle);
    }
  }
}

function shiftRunsForInsertion(runs: GoogleSlideStyleRun[], index: number, length: number): void {
  for (const run of runs) {
    if (index < run.start_index) {
      run.start_index += length;
      run.end_index += length;
    } else if (index <= run.end_index) {
      run.end_index += length;
    }
  }
}

function shiftRunsForDeletion(runs: GoogleSlideStyleRun[], start: number, end: number): void {
  const deletedLength = end - start;
  const mapIndex = (index: number) => {
    if (index <= start) return index;
    if (index >= end) return index - deletedLength;
    return start;
  };
  for (const run of runs) {
    run.start_index = mapIndex(run.start_index);
    run.end_index = mapIndex(run.end_index);
  }
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    if (runs[index].end_index <= runs[index].start_index) runs.splice(index, 1);
  }
}

function addStyleRun(runs: GoogleSlideStyleRun[], start: number, end: number, style: Record<string, unknown>): void {
  if (start === end) return;
  runs.push({ start_index: start, end_index: end, style: { ...style } });
}

function resolveStyleAt(runs: GoogleSlideStyleRun[], index: number): Record<string, unknown> {
  const style: Record<string, unknown> = {};
  for (const run of runs) {
    const withinRun =
      run.start_index <= index &&
      (index < run.end_index || (index === run.end_index && run.end_index === run.start_index));
    if (withinRun) Object.assign(style, run.style);
  }
  return style;
}

function resolveTextRange(
  range: Record<string, unknown> | undefined,
  textLength: number,
): { start: number; end: number } | undefined {
  const type = getString(range ?? {}, "type") ?? "ALL";
  const start = getFiniteNumber(range ?? {}, "startIndex");
  const end = getFiniteNumber(range ?? {}, "endIndex");
  const resolved =
    type === "ALL"
      ? { start: 0, end: textLength }
      : type === "FROM_START_INDEX" && start !== undefined
        ? { start, end: textLength }
        : type === "FIXED_RANGE" && start !== undefined && end !== undefined
          ? { start, end }
          : undefined;
  if (
    !resolved ||
    !Number.isSafeInteger(resolved.start) ||
    !Number.isSafeInteger(resolved.end) ||
    resolved.start < 0 ||
    resolved.end < resolved.start ||
    resolved.end > textLength
  ) {
    return undefined;
  }
  return resolved;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (character) => {
    const entities: Record<string, string> = {
      "<": "&lt;",
      ">": "&gt;",
      "&": "&amp;",
      "'": "&apos;",
      '"': "&quot;",
    };
    return entities[character] ?? character;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
