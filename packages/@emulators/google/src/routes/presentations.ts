import type { RouteContext } from "@emulators/core";
import type { GoogleSlide, GoogleSlideElement } from "../entities.js";
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
import {
  getFiniteNumber,
  getRecord,
  getRecordArray,
  getString,
  parseGoogleBody,
  requireGoogleAuth,
} from "../route-helpers.js";
import { getGoogleStore } from "../store.js";

interface WorkingPresentation {
  presentationId: string;
  slides: GoogleSlide[];
}

type ApplyResult = { reply: Record<string, unknown> } | { error: string };

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

    const body = await parseGoogleBody(c);
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
    };
    const replies: Record<string, unknown>[] = [];

    for (const request of getRecordArray(body, "requests")) {
      const result = applyPresentationRequest(working, request);
      if ("error" in result) {
        return googleApiError(c, 400, result.error, "badRequest", "INVALID_ARGUMENT");
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
    presentation.slides.splice(insertionIndex, 0, slide);
    return { reply: { createSlide: { objectId: slide.object_id } } };
  }

  const deleteObject = getRecord(request, "deleteObject");
  if (deleteObject) {
    const objectId = getString(deleteObject, "objectId");
    if (!objectId) return { error: "deleteObject requires an objectId." };
    const slideIndex = presentation.slides.findIndex((slide) => slide.object_id === objectId);
    if (slideIndex >= 0) {
      presentation.slides.splice(slideIndex, 1);
      return { reply: {} };
    }
    for (const slide of presentation.slides) {
      const elementIndex = slide.page_elements.findIndex((element) => element.object_id === objectId);
      if (elementIndex >= 0) {
        slide.page_elements.splice(elementIndex, 1);
        return { reply: {} };
      }
    }
    return { error: "Object was not found." };
  }

  const insertText = getRecord(request, "insertText");
  if (insertText) {
    const element = findShape(presentation, getString(insertText, "objectId"));
    if (!element) return { error: "Text shape was not found." };
    const text = getString(insertText, "text") ?? "";
    const insertionIndex = getFiniteNumber(insertText, "insertionIndex") ?? 0;
    if (!Number.isSafeInteger(insertionIndex) || insertionIndex < 0 || insertionIndex > element.text.length) {
      return { error: "Invalid text insertion index." };
    }
    element.text = element.text.slice(0, insertionIndex) + text + element.text.slice(insertionIndex);
    return { reply: {} };
  }

  const deleteText = getRecord(request, "deleteText");
  if (deleteText) {
    const element = findShape(presentation, getString(deleteText, "objectId"));
    if (!element) return { error: "Text shape was not found." };
    const range = resolveTextRange(getRecord(deleteText, "textRange"), element.text.length);
    if (!range) return { error: "Invalid text deletion range." };
    element.text = element.text.slice(0, range.start) + element.text.slice(range.end);
    return { reply: {} };
  }

  const replaceAllText = getRecord(request, "replaceAllText");
  if (replaceAllText) {
    const containsText = getRecord(replaceAllText, "containsText");
    const find = getString(containsText ?? {}, "text");
    if (!find) return { error: "replaceAllText requires search text." };
    const replaceText = getString(replaceAllText, "replaceText") ?? "";
    const pattern = new RegExp(escapeRegExp(find), containsText?.matchCase === true ? "g" : "gi");
    let occurrencesChanged = 0;
    for (const slide of presentation.slides) {
      for (const element of slide.page_elements) {
        if (element.element_type !== "shape") continue;
        occurrencesChanged += Array.from(element.text.matchAll(pattern)).length;
        element.text = element.text.replace(pattern, () => replaceText);
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
    slide.page_elements.push(element);
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
    slide.page_elements.push(element);
    return { reply: { createImage: { objectId: element.object_id } } };
  }

  const updateTextStyle = getRecord(request, "updateTextStyle");
  if (updateTextStyle) {
    const element = findShape(presentation, getString(updateTextStyle, "objectId"));
    const style = getRecord(updateTextStyle, "style");
    if (!element || !style) return { error: "updateTextStyle requires a text shape and style." };
    if (!resolveTextRange(getRecord(updateTextStyle, "textRange"), element.text.length)) {
      return { error: "Invalid text style range." };
    }
    element.text_style = { ...element.text_style, ...style };
    return { reply: {} };
  }

  const updateParagraphStyle = getRecord(request, "updateParagraphStyle");
  if (updateParagraphStyle) {
    const element = findShape(presentation, getString(updateParagraphStyle, "objectId"));
    const style = getRecord(updateParagraphStyle, "style");
    if (!element || !style) return { error: "updateParagraphStyle requires a text shape and style." };
    if (!resolveTextRange(getRecord(updateParagraphStyle, "textRange"), element.text.length)) {
      return { error: "Invalid paragraph style range." };
    }
    element.paragraph_style = { ...element.paragraph_style, ...style };
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
      for (const element of slide.page_elements) {
        if (element.element_type !== "shape") continue;
        const haystack = matchCase ? element.text : element.text.toLowerCase();
        if (!haystack.includes(needle)) continue;
        element.element_type = "image";
        element.shape_type = null;
        element.placeholder_type = null;
        element.text = "";
        element.image_url = imageUrl;
        element.text_style = {};
        element.paragraph_style = {};
        occurrencesChanged += 1;
      }
    }
    return { reply: { replaceAllShapesWithImage: { occurrencesChanged } } };
  }

  return { error: "Unsupported presentation update request." };
}

function findSlide(presentation: WorkingPresentation, objectId: string | undefined): GoogleSlide | undefined {
  return objectId ? presentation.slides.find((slide) => slide.object_id === objectId) : undefined;
}

function findShape(presentation: WorkingPresentation, objectId: string | undefined): GoogleSlideElement | undefined {
  if (!objectId) return undefined;
  for (const slide of presentation.slides) {
    const element = slide.page_elements.find((candidate) => candidate.object_id === objectId);
    if (element?.element_type === "shape") return element;
  }
  return undefined;
}

function objectIdExists(presentation: WorkingPresentation, objectId: string): boolean {
  return presentation.slides.some(
    (slide) => slide.object_id === objectId || slide.page_elements.some((element) => element.object_id === objectId),
  );
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
