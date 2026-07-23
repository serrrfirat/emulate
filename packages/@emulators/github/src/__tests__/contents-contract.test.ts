import { beforeEach, describe, expect, it } from "vitest";
import {
  Hono,
  Store,
  WebhookDispatcher,
  authMiddleware,
  createApiErrorHandler,
  createErrorHandler,
  type TokenMap,
} from "@emulators/core";
import { githubPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";
const ownerToken = "owner-token";
const outsiderToken = "outsider-token";

function headers(token = ownerToken, json = false): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map([
    [ownerToken, { login: "octocat", id: 3, scopes: ["repo"] }],
    [outsiderToken, { login: "outsider", id: 4, scopes: ["repo"] }],
    ["public-scope-token", { login: "octocat", id: 3, scopes: ["public_repo"] }],
    ["contents-app-token", { login: "octocat", id: 3, scopes: ["contents:write"] }],
    ["no-scope-token", { login: "octocat", id: 3, scopes: [] }],
  ]);
  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app as never, store, webhooks, base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "octocat" }, { login: "outsider" }],
    repos: [{ owner: "octocat", name: "hello-world" }],
  });
  return app;
}

function contentRequest(
  app: Hono,
  path: string,
  body: Record<string, unknown>,
  options: { method?: "PUT" | "DELETE"; token?: string; contentLength?: number } = {},
) {
  return app.request(`${base}/repos/octocat/hello-world/contents/${path}`, {
    method: options.method ?? "PUT",
    headers: {
      ...headers(options.token ?? ownerToken, true),
      ...(options.contentLength === undefined ? {} : { "Content-Length": String(options.contentLength) }),
    },
    body: JSON.stringify(body),
  });
}

describe("GitHub Contents contract", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp();
  });

  it("requires repository write permission and an applicable token scope", async () => {
    const body = {
      message: "Create file",
      content: Buffer.from("content").toString("base64"),
    };
    expect((await contentRequest(app, "blocked.txt", body, { token: outsiderToken })).status).toBe(403);
    expect((await contentRequest(app, "blocked.txt", body, { token: "no-scope-token" })).status).toBe(403);
    expect((await contentRequest(app, "allowed.txt", body, { token: "public-scope-token" })).status).toBe(201);
    expect((await contentRequest(app, "app-allowed.txt", body, { token: "contents-app-token" })).status).toBe(201);
  });

  it("lists the root and nested directories with their actual tree SHAs", async () => {
    const source = await contentRequest(app, "src/lib.ts", {
      message: "Add source",
      content: Buffer.from("export const value = 1;\n").toString("base64"),
    });
    expect(source.status).toBe(201);
    const sourceBody = (await source.json()) as { content: { sha: string } };

    expect(
      (
        await contentRequest(app, "docs/guide.md", {
          message: "Add guide",
          content: Buffer.from("# Guide\n").toString("base64"),
        })
      ).status,
    ).toBe(201);

    const root = await app.request(`${base}/repos/octocat/hello-world/contents`, {
      headers: headers(),
    });
    expect(root.status).toBe(200);
    const rootEntries = (await root.json()) as Array<{
      type: string;
      path: string;
      sha: string;
      content?: string;
      git_url: string;
    }>;
    expect(rootEntries.map(({ type, path }) => ({ type, path }))).toEqual(
      expect.arrayContaining([
        { type: "file", path: "README.md" },
        { type: "dir", path: "docs" },
        { type: "dir", path: "src" },
      ]),
    );
    expect(rootEntries).toHaveLength(3);
    const sourceDirectory = rootEntries.find((entry) => entry.path === "src");
    expect(sourceDirectory?.sha).toEqual(expect.any(String));
    expect(sourceDirectory?.sha).not.toBe(sourceBody.content.sha);
    expect(sourceDirectory?.git_url).toBe(`${base}/repos/octocat/hello-world/git/trees/${sourceDirectory?.sha}`);
    expect(rootEntries.every((entry) => entry.content === undefined)).toBe(true);

    const sourceTree = await app.request(`${base}/repos/octocat/hello-world/git/trees/${sourceDirectory?.sha ?? ""}`, {
      headers: headers(),
    });
    expect(sourceTree.status).toBe(200);
    expect(await sourceTree.json()).toMatchObject({
      sha: sourceDirectory?.sha,
      tree: [{ path: "lib.ts", type: "blob", sha: sourceBody.content.sha }],
    });

    const nested = await app.request(`${base}/repos/octocat/hello-world/contents/src`, {
      headers: headers(),
    });
    expect(nested.status).toBe(200);
    expect(await nested.json()).toMatchObject([{ type: "file", path: "src/lib.ts", sha: sourceBody.content.sha }]);
  });

  it("validates create and update preconditions", async () => {
    const encoded = Buffer.from("new content").toString("base64");
    expect((await contentRequest(app, "missing-message.txt", { content: encoded })).status).toBe(422);
    expect((await contentRequest(app, "missing-content.txt", { message: "Missing content" })).status).toBe(422);
    expect(
      (
        await contentRequest(app, "unknown-branch.txt", {
          message: "Unknown branch",
          content: encoded,
          branch: "does-not-exist",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await contentRequest(app, "new-with-sha.txt", {
          message: "Invalid create",
          content: encoded,
          sha: "0123456789012345678901234567890123456789",
        })
      ).status,
    ).toBe(422);

    const readme = await app.request(`${base}/repos/octocat/hello-world/contents/README.md`, {
      headers: headers(),
    });
    expect(readme.status).toBe(200);
    expect(
      (
        await contentRequest(app, "README.md", {
          message: "Stale update",
          content: encoded,
          sha: "0123456789012345678901234567890123456789",
        })
      ).status,
    ).toBe(409);
  });

  it("rejects malformed base64 and oversized request bodies", async () => {
    expect(
      (
        await contentRequest(app, "invalid.txt", {
          message: "Invalid base64",
          content: "not base64",
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await contentRequest(
          app,
          "oversized.txt",
          {
            message: "Oversized body",
            content: Buffer.from("small").toString("base64"),
          },
          { contentLength: 200 * 1024 * 1024 },
        )
      ).status,
    ).toBe(413);
  });
});
