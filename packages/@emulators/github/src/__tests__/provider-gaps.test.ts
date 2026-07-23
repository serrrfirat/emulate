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

function authHeaders(json = false): Record<string, string> {
  return {
    Authorization: "Bearer test-token",
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

function createTestApp() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokenMap: TokenMap = new Map([["test-token", { login: "octocat", id: 1, scopes: ["repo", "workflow"] }]]);
  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app as never, store, webhooks, base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "octocat", name: "Octo Cat", email: "octocat@example.com" }],
    repos: [
      { owner: "octocat", name: "hello-world" },
      { owner: "octocat", name: "other-repo" },
    ],
    workflows: [
      {
        id: 101,
        owner: "octocat",
        repo: "hello-world",
        name: "CI",
        path: ".github/workflows/ci.yml",
      },
    ],
    workflow_runs: [
      {
        id: 201,
        owner: "octocat",
        repo: "hello-world",
        workflow_id: 101,
        status: "completed",
        conclusion: "failure",
        logs: "seeded run logs\n",
      },
    ],
    jobs: [
      {
        id: 301,
        owner: "octocat",
        repo: "hello-world",
        run_id: 201,
        name: "test",
        status: "completed",
        conclusion: "failure",
        logs: "seeded job logs\n",
      },
    ],
    artifacts: [
      {
        id: 401,
        owner: "octocat",
        repo: "hello-world",
        run_id: 201,
        name: "test-results",
        size_in_bytes: 42,
      },
    ],
  });
  return app;
}

async function jsonRequest(app: Hono, path: string, method: string, body: Record<string, unknown>) {
  return app.request(`${base}${path}`, {
    method,
    headers: authHeaders(true),
    body: JSON.stringify(body),
  });
}

describe("GitHub IronClaw provider gaps", () => {
  let app: Hono;

  beforeEach(() => {
    app = createTestApp();
  });

  it("reads, creates, updates, and deletes contents through Git objects", async () => {
    const initial = await app.request(`${base}/repos/octocat/hello-world/contents/README.md?ref=main`, {
      headers: authHeaders(),
    });
    expect(initial.status).toBe(200);
    const initialBody = (await initial.json()) as { content: string; sha: string };
    expect(Buffer.from(initialBody.content, "base64").toString("utf8")).toBe("# hello-world\n");

    const created = await jsonRequest(app, "/repos/octocat/hello-world/contents/src/lib.ts", "PUT", {
      message: "Create library",
      content: Buffer.from("export const value = 1;\n").toString("base64"),
      branch: "main",
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      content: { sha: string };
      commit: { sha: string; parents: Array<{ sha: string }> };
    };
    expect(createdBody.commit.parents).toHaveLength(1);

    const fetched = await app.request(`${base}/repos/octocat/hello-world/contents/src/lib.ts?ref=main`, {
      headers: authHeaders(),
    });
    expect(fetched.status).toBe(200);
    const fetchedBody = (await fetched.json()) as { content: string };
    expect(Buffer.from(fetchedBody.content, "base64").toString("utf8")).toBe("export const value = 1;\n");

    const updated = await jsonRequest(app, "/repos/octocat/hello-world/contents/src/lib.ts", "PUT", {
      message: "Update library",
      content: Buffer.from("export const value = 2;\n").toString("base64"),
      sha: createdBody.content.sha,
    });
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()) as { content: { sha: string } };
    expect(updatedBody.content.sha).not.toBe(createdBody.content.sha);

    const deleted = await jsonRequest(app, "/repos/octocat/hello-world/contents/src/lib.ts", "DELETE", {
      message: "Delete library",
      sha: updatedBody.content.sha,
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ content: null, commit: { sha: expect.any(String) } });

    const missing = await app.request(`${base}/repos/octocat/hello-world/contents/src/lib.ts`, {
      headers: authHeaders(),
    });
    expect(missing.status).toBe(404);
  });

  it("creates classic statuses and returns the latest combined state per context", async () => {
    const branch = await app.request(`${base}/repos/octocat/hello-world/branches/main`, {
      headers: authHeaders(),
    });
    const sha = ((await branch.json()) as { commit: { sha: string } }).commit.sha;

    expect(
      (
        await jsonRequest(app, `/repos/octocat/hello-world/statuses/${sha}`, "POST", {
          state: "pending",
          context: "ci/test",
          description: "Running",
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await jsonRequest(app, `/repos/octocat/hello-world/statuses/${sha}`, "POST", {
          state: "success",
          context: "ci/test",
          description: "Passed",
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await jsonRequest(app, `/repos/octocat/hello-world/statuses/${sha}`, "POST", {
          state: "failure",
          context: "ci/lint",
        })
      ).status,
    ).toBe(201);

    const combined = await app.request(`${base}/repos/octocat/hello-world/commits/main/status`, {
      headers: authHeaders(),
    });
    expect(combined.status).toBe(200);
    expect(await combined.json()).toMatchObject({
      state: "failure",
      sha,
      total_count: 2,
      statuses: [
        { context: "ci/lint", state: "failure" },
        { context: "ci/test", state: "success" },
      ],
    });
  });

  it("supports the review reply alias and persists GraphQL thread resolution", async () => {
    const main = await app.request(`${base}/repos/octocat/hello-world/branches/main`, {
      headers: authHeaders(),
    });
    const mainSha = ((await main.json()) as { commit: { sha: string } }).commit.sha;
    const ref = await jsonRequest(app, "/repos/octocat/hello-world/git/refs", "POST", {
      ref: "refs/heads/feature",
      sha: mainSha,
    });
    expect(ref.status).toBe(201);
    const pull = await jsonRequest(app, "/repos/octocat/hello-world/pulls", "POST", {
      title: "Feature",
      head: "feature",
      base: "main",
    });
    expect(pull.status).toBe(201);

    const root = await jsonRequest(app, "/repos/octocat/hello-world/pulls/1/comments", "POST", {
      body: "Please adjust this",
      commit_id: mainSha,
      path: "README.md",
      line: 1,
      side: "RIGHT",
    });
    expect(root.status).toBe(201);
    const rootBody = (await root.json()) as { id: number };
    const reply = await jsonRequest(app, `/repos/octocat/hello-world/pulls/1/comments/${rootBody.id}/replies`, "POST", {
      body: "Updated",
    });
    expect(reply.status).toBe(201);
    expect(await reply.json()).toMatchObject({ in_reply_to_id: rootBody.id, body: "Updated" });

    const listQuery = `
      query($owner: String!, $repo: String!, $number: Int!, $first: Int!, $after: String) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            reviewThreads(first: $first, after: $after) {
              nodes { id isResolved }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }`;
    const listed = await jsonRequest(app, "/graphql", "POST", {
      query: listQuery,
      variables: { owner: "octocat", repo: "hello-world", number: 1, first: 30, after: null },
    });
    const listedBody = (await listed.json()) as {
      data: { repository: { pullRequest: { reviewThreads: { nodes: Array<{ id: string; isResolved: boolean }> } } } };
    };
    expect(listedBody.data.repository.pullRequest.reviewThreads.nodes).toHaveLength(1);
    const threadId = listedBody.data.repository.pullRequest.reviewThreads.nodes[0].id;

    const resolved = await jsonRequest(app, "/graphql", "POST", {
      query:
        "mutation($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } } }",
      variables: { threadId },
    });
    expect(await resolved.json()).toMatchObject({
      data: { resolveReviewThread: { thread: { id: threadId, isResolved: true } } },
    });

    const relisted = await jsonRequest(app, "/graphql", "POST", {
      query: listQuery,
      variables: { owner: "octocat", repo: "hello-world", number: 1, first: 30 },
    });
    expect(await relisted.json()).toMatchObject({
      data: {
        repository: {
          pullRequest: { reviewThreads: { nodes: [{ id: threadId, isResolved: true }] } },
        },
      },
    });

    const unresolved = await jsonRequest(app, "/graphql", "POST", {
      query:
        "mutation($threadId: ID!) { unresolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } } }",
      variables: { threadId },
    });
    expect(await unresolved.json()).toMatchObject({
      data: { unresolveReviewThread: { thread: { id: threadId, isResolved: false } } },
    });
  });

  it("serves seeded Actions state and scopes reruns to the requested repository", async () => {
    const workflows = await app.request(`${base}/repos/octocat/hello-world/actions/workflows`, {
      headers: authHeaders(),
    });
    expect(await workflows.json()).toMatchObject({ total_count: 1, workflows: [{ id: 101, name: "CI" }] });

    const jobs = await app.request(`${base}/repos/octocat/hello-world/actions/runs/201/jobs`, {
      headers: authHeaders(),
    });
    expect(await jobs.json()).toMatchObject({
      total_count: 1,
      jobs: [{ id: 301, name: "test", conclusion: "failure" }],
    });

    const runLogs = await app.request(`${base}/repos/octocat/hello-world/actions/runs/201/logs`, {
      headers: authHeaders(),
    });
    expect(await runLogs.text()).toBe("seeded run logs\n");
    const jobLogs = await app.request(`${base}/repos/octocat/hello-world/actions/jobs/301/logs`, {
      headers: authHeaders(),
    });
    expect(await jobLogs.text()).toBe("seeded job logs\n");

    const artifacts = await app.request(`${base}/repos/octocat/hello-world/actions/runs/201/artifacts`, {
      headers: authHeaders(),
    });
    expect(await artifacts.json()).toMatchObject({
      total_count: 1,
      artifacts: [{ id: 401, name: "test-results", size_in_bytes: 42 }],
    });

    const dispatch = await jsonRequest(app, "/repos/octocat/hello-world/actions/workflows/101/dispatches", "POST", {
      ref: "main",
      inputs: { suite: "provider-contracts" },
    });
    expect(dispatch.status).toBe(204);

    const wrongRepo = await app.request(`${base}/repos/octocat/other-repo/actions/jobs/301/rerun`, {
      method: "POST",
      headers: authHeaders(true),
      body: "{}",
    });
    expect(wrongRepo.status).toBe(404);

    const rerunFailed = await app.request(`${base}/repos/octocat/hello-world/actions/runs/201/rerun-failed-jobs`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ enable_debug_logging: true }),
    });
    expect(rerunFailed.status).toBe(201);
    const queuedJob = await app.request(`${base}/repos/octocat/hello-world/actions/jobs/301`, {
      headers: authHeaders(),
    });
    expect(await queuedJob.json()).toMatchObject({ status: "queued", conclusion: null });

    const rerunJob = await app.request(`${base}/repos/octocat/hello-world/actions/jobs/301/rerun`, {
      method: "POST",
      headers: authHeaders(true),
      body: JSON.stringify({ enable_debugger: true }),
    });
    expect(rerunJob.status).toBe(201);
    const run = await app.request(`${base}/repos/octocat/hello-world/actions/runs/201`, {
      headers: authHeaders(),
    });
    expect(await run.json()).toMatchObject({ status: "queued", conclusion: null, run_attempt: 3 });
  });
});
