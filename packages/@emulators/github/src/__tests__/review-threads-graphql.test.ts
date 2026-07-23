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
import { getGitHubStore, githubPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";

interface TestContext {
  app: Hono;
  store: Store;
}

function headers(token = "owner-token"): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function createTestContext(): TestContext {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map([
    ["owner-token", { login: "octocat", id: 1, scopes: ["repo"] }],
    ["pull-requests-app-token", { login: "octocat", id: 1, scopes: ["pull_requests:write"] }],
    ["limited-token", { login: "octocat", id: 1, scopes: ["user"] }],
    ["outsider-token", { login: "outsider", id: 2, scopes: ["repo"] }],
  ]);
  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app as never, store, webhooks, base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [
      { login: "octocat", name: "Octo Cat" },
      { login: "outsider", name: "Outside User" },
    ],
    repos: [{ owner: "octocat", name: "hello-world" }],
  });
  return { app, store };
}

async function jsonRequest(
  app: Hono,
  path: string,
  method: string,
  body: Record<string, unknown>,
  token = "owner-token",
) {
  return app.request(`${base}${path}`, {
    method,
    headers: headers(token),
    body: JSON.stringify(body),
  });
}

async function graphqlRequest(
  app: Hono,
  query: string,
  variables?: Record<string, unknown>,
  operationName?: string,
  token = "owner-token",
) {
  return jsonRequest(
    app,
    "/graphql",
    "POST",
    {
      query,
      ...(variables ? { variables } : {}),
      ...(operationName ? { operationName } : {}),
    },
    token,
  );
}

async function createPullWithComments(app: Hono, count: number): Promise<number[]> {
  const branch = await app.request(`${base}/repos/octocat/hello-world/branches/main`, {
    headers: headers(),
  });
  const mainSha = ((await branch.json()) as { commit: { sha: string } }).commit.sha;
  const ref = await jsonRequest(app, "/repos/octocat/hello-world/git/refs", "POST", {
    ref: "refs/heads/review-threads",
    sha: mainSha,
  });
  expect(ref.status).toBe(201);
  const pull = await jsonRequest(app, "/repos/octocat/hello-world/pulls", "POST", {
    title: "Review threads",
    head: "review-threads",
    base: "main",
  });
  expect(pull.status).toBe(201);

  const commentIds: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const response = await jsonRequest(app, "/repos/octocat/hello-world/pulls/1/comments", "POST", {
      body: `Comment ${index + 1}`,
      commit_id: mainSha,
      path: "README.md",
      line: index + 1,
      side: "RIGHT",
    });
    expect(response.status).toBe(201);
    commentIds.push(((await response.json()) as { id: number }).id);
  }
  return commentIds;
}

describe("GitHub review-thread GraphQL", () => {
  let context: TestContext;

  beforeEach(() => {
    context = createTestContext();
  });

  it("executes a selected operation with aliases and paginates using first and after", async () => {
    await createPullWithComments(context.app, 3);
    const firstPage = await graphqlRequest(
      context.app,
      `
        query Decoy {
          repository(owner: "missing", name: "missing") { pullRequest(number: 1) { reviewThreads { nodes { id } } } }
        }
        query Selected {
          target: repository(owner: "octocat", name: "hello-world") {
            change: pullRequest(number: 1) {
              threads: reviewThreads(first: 2) {
                nodes { id isResolved }
                pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
              }
            }
          }
        }
      `,
      undefined,
      "Selected",
    );
    expect(firstPage.status).toBe(200);
    const firstBody = (await firstPage.json()) as {
      data: {
        target: {
          change: {
            threads: {
              nodes: Array<{ id: string; isResolved: boolean }>;
              pageInfo: {
                hasNextPage: boolean;
                hasPreviousPage: boolean;
                startCursor: string;
                endCursor: string;
              };
            };
          };
        };
      };
    };
    const firstConnection = firstBody.data.target.change.threads;
    expect(firstConnection.nodes).toHaveLength(2);
    expect(firstConnection.nodes.every((node) => node.isResolved === false)).toBe(true);
    expect(firstConnection.pageInfo).toMatchObject({
      hasNextPage: true,
      hasPreviousPage: false,
      startCursor: firstConnection.nodes[0].id,
      endCursor: firstConnection.nodes[1].id,
    });

    const secondPage = await graphqlRequest(
      context.app,
      `
        query($owner: String!, $name: String!, $number: Int!, $after: String!) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              reviewThreads(first: 2, after: $after) {
                nodes { id }
                pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
              }
            }
          }
        }
      `,
      {
        owner: "octocat",
        name: "hello-world",
        number: 1,
        after: firstConnection.pageInfo.endCursor,
      },
    );
    expect(secondPage.status).toBe(200);
    expect(await secondPage.json()).toMatchObject({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [{ id: expect.any(String) }],
              pageInfo: {
                hasNextPage: false,
                hasPreviousPage: true,
                startCursor: expect.any(String),
                endCursor: expect.any(String),
              },
            },
          },
        },
      },
    });
  });

  it("stores only resolution metadata and removes it when a root comment is deleted", async () => {
    const [commentId] = await createPullWithComments(context.app, 1);
    const listed = await graphqlRequest(
      context.app,
      `{
        repository(owner: "octocat", name: "hello-world") {
          pullRequest(number: 1) { reviewThreads { nodes { id isResolved } } }
        }
      }`,
    );
    const listedBody = (await listed.json()) as {
      data: { repository: { pullRequest: { reviewThreads: { nodes: Array<{ id: string }> } } } };
    };
    const threadId = listedBody.data.repository.pullRequest.reviewThreads.nodes[0].id;
    expect(getGitHubStore(context.store).reviewThreadResolutions.all()).toHaveLength(0);

    const resolved = await graphqlRequest(
      context.app,
      `mutation {
        done: resolveReviewThread(input: { threadId: "${threadId}" }) {
          thread { id isResolved }
        }
      }`,
    );
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({
      data: { done: { thread: { id: threadId, isResolved: true } } },
    });
    expect(getGitHubStore(context.store).reviewThreadResolutions.all()).toHaveLength(1);

    const deleted = await context.app.request(`${base}/repos/octocat/hello-world/pulls/comments/${commentId}`, {
      method: "DELETE",
      headers: headers(),
    });
    expect(deleted.status).toBe(204);
    expect(getGitHubStore(context.store).reviewThreadResolutions.all()).toHaveLength(0);

    const relisted = await graphqlRequest(
      context.app,
      `{
        repository(owner: "octocat", name: "hello-world") {
          pullRequest(number: 1) { reviewThreads { nodes { id } } }
        }
      }`,
    );
    expect(await relisted.json()).toMatchObject({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
    });
  });

  it("removes resolution metadata when its repository is deleted", async () => {
    await createPullWithComments(context.app, 1);
    const listed = await graphqlRequest(
      context.app,
      `{
        repository(owner: "octocat", name: "hello-world") {
          pullRequest(number: 1) { reviewThreads { nodes { id } } }
        }
      }`,
    );
    const listedBody = (await listed.json()) as {
      data: { repository: { pullRequest: { reviewThreads: { nodes: Array<{ id: string }> } } } };
    };
    const threadId = listedBody.data.repository.pullRequest.reviewThreads.nodes[0].id;
    const resolved = await graphqlRequest(
      context.app,
      `mutation($threadId: ID!) {
        resolveReviewThread(input: { threadId: $threadId }) { thread { id } }
      }`,
      { threadId },
    );
    expect(resolved.status).toBe(200);
    expect(getGitHubStore(context.store).reviewThreadResolutions.all()).toHaveLength(1);

    const deleted = await context.app.request(`${base}/repos/octocat/hello-world`, {
      method: "DELETE",
      headers: headers(),
    });
    expect(deleted.status).toBe(204);
    expect(getGitHubStore(context.store).reviewThreadResolutions.all()).toHaveLength(0);
  });

  it("returns useful GraphQL errors for malformed operations and cursors", async () => {
    await createPullWithComments(context.app, 1);
    const malformed = await graphqlRequest(context.app, "query {");
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      errors: [{ message: expect.stringContaining("Syntax Error") }],
    });

    const invalidCursor = await graphqlRequest(
      context.app,
      `{
        repository(owner: "octocat", name: "hello-world") {
          pullRequest(number: 1) {
            reviewThreads(first: 1, after: "not-a-cursor") { nodes { id } }
          }
        }
      }`,
    );
    expect(invalidCursor.status).toBe(400);
    expect(await invalidCursor.json()).toMatchObject({
      errors: [{ message: "The 'after' cursor is invalid" }],
    });
  });

  it("requires both repository write access and a compatible token scope for mutations", async () => {
    await createPullWithComments(context.app, 1);
    const listed = await graphqlRequest(
      context.app,
      `{
        repository(owner: "octocat", name: "hello-world") {
          pullRequest(number: 1) { reviewThreads { nodes { id } } }
        }
      }`,
    );
    const listedBody = (await listed.json()) as {
      data: { repository: { pullRequest: { reviewThreads: { nodes: Array<{ id: string }> } } } };
    };
    const threadId = listedBody.data.repository.pullRequest.reviewThreads.nodes[0].id;
    const mutation = `
      mutation($threadId: ID!) {
        resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
      }
    `;

    const limited = await graphqlRequest(context.app, mutation, { threadId }, undefined, "limited-token");
    expect(limited.status).toBe(400);
    expect(await limited.json()).toMatchObject({
      errors: [{ message: "Forbidden" }],
    });

    const outsider = await graphqlRequest(context.app, mutation, { threadId }, undefined, "outsider-token");
    expect(outsider.status).toBe(400);
    expect(await outsider.json()).toMatchObject({
      errors: [{ message: "Forbidden" }],
    });

    const appToken = await graphqlRequest(context.app, mutation, { threadId }, undefined, "pull-requests-app-token");
    expect(appToken.status).toBe(200);
    expect(await appToken.json()).toMatchObject({
      data: { resolveReviewThread: { thread: { id: threadId, isResolved: true } } },
    });
  });
});
