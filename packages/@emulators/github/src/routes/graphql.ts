import type { Context, RouteContext } from "@emulators/core";
import { parseJsonBody } from "@emulators/core";
import type { GitHubReviewThread } from "../entities.js";
import { generateNodeId, lookupRepo } from "../helpers.js";
import { assertAuthenticatedUser, assertRepoRead, assertRepoWrite } from "../route-helpers.js";
import { getGitHubStore, type GitHubStore } from "../store.js";

function graphqlError(c: Context, message: string) {
  return c.json({ data: null, errors: [{ message }] });
}

function ensureReviewThreads(gh: GitHubStore, repoId: number, pullNumber: number): GitHubReviewThread[] {
  const rootComments = gh.comments
    .findBy("repo_id", repoId)
    .filter(
      (comment) =>
        comment.comment_type === "review" && comment.pull_number === pullNumber && comment.in_reply_to_id === null,
    )
    .sort((left, right) => left.id - right.id);
  for (const comment of rootComments) {
    const existing = gh.reviewThreads
      .findBy("repo_id", repoId)
      .find((thread) => thread.pull_number === pullNumber && thread.root_comment_id === comment.id);
    if (existing) continue;
    const thread = gh.reviewThreads.insert({
      node_id: "",
      repo_id: repoId,
      pull_number: pullNumber,
      root_comment_id: comment.id,
      is_resolved: false,
      resolved_by_id: null,
    } as Omit<GitHubReviewThread, "id" | "created_at" | "updated_at">);
    gh.reviewThreads.update(thread.id, { node_id: generateNodeId("PullRequestReviewThread", thread.id) });
  }
  return gh.reviewThreads
    .findBy("repo_id", repoId)
    .filter((thread) => thread.pull_number === pullNumber)
    .sort((left, right) => left.id - right.id);
}

export function graphqlRoutes({ app, store }: RouteContext): void {
  const gh = getGitHubStore(store);

  app.post("/graphql", async (c) => {
    const actor = assertAuthenticatedUser(gh, c.get("authUser"));
    const body = await parseJsonBody(c);
    const query = typeof body.query === "string" ? body.query : "";
    const variables =
      body.variables && typeof body.variables === "object" && !Array.isArray(body.variables)
        ? (body.variables as Record<string, unknown>)
        : {};

    if (query.includes("unresolveReviewThread")) {
      const threadId = typeof variables.threadId === "string" ? variables.threadId : "";
      const thread = gh.reviewThreads.findOneBy("node_id", threadId);
      if (!thread) return graphqlError(c, "Could not resolve to a ReviewThread with the requested id");
      const repo = gh.repos.get(thread.repo_id);
      if (!repo) return graphqlError(c, "Repository not found");
      assertRepoWrite(gh, c.get("authUser"), repo);
      const updated = gh.reviewThreads.update(thread.id, { is_resolved: false, resolved_by_id: null })!;
      return c.json({
        data: {
          unresolveReviewThread: {
            thread: { id: updated.node_id, isResolved: updated.is_resolved },
          },
        },
      });
    }

    if (query.includes("resolveReviewThread")) {
      const threadId = typeof variables.threadId === "string" ? variables.threadId : "";
      const thread = gh.reviewThreads.findOneBy("node_id", threadId);
      if (!thread) return graphqlError(c, "Could not resolve to a ReviewThread with the requested id");
      const repo = gh.repos.get(thread.repo_id);
      if (!repo) return graphqlError(c, "Repository not found");
      assertRepoWrite(gh, c.get("authUser"), repo);
      const updated = gh.reviewThreads.update(thread.id, { is_resolved: true, resolved_by_id: actor.id })!;
      return c.json({
        data: {
          resolveReviewThread: {
            thread: { id: updated.node_id, isResolved: updated.is_resolved },
          },
        },
      });
    }

    if (query.includes("reviewThreads")) {
      const owner = typeof variables.owner === "string" ? variables.owner : "";
      const repoName = typeof variables.repo === "string" ? variables.repo : "";
      const pullNumber =
        typeof variables.number === "number" ? variables.number : Number.parseInt(String(variables.number), 10);
      const repo = lookupRepo(gh, owner, repoName);
      if (!repo) return graphqlError(c, "Could not resolve to a Repository with the requested name");
      assertRepoRead(gh, c.get("authUser"), repo);
      const pull = gh.pullRequests.findBy("repo_id", repo.id).find((candidate) => candidate.number === pullNumber);
      if (!pull) return graphqlError(c, "Could not resolve to a PullRequest with the requested number");
      const first = typeof variables.first === "number" && variables.first > 0 ? Math.min(variables.first, 100) : 30;
      const all = ensureReviewThreads(gh, repo.id, pull.number);
      const after = typeof variables.after === "string" ? variables.after : null;
      const afterIndex = after ? all.findIndex((thread) => thread.node_id === after) : -1;
      const start = afterIndex >= 0 ? afterIndex + 1 : 0;
      const nodes = all.slice(start, start + first);
      return c.json({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: nodes.map((thread) => ({
                  id: thread.node_id,
                  isResolved: thread.is_resolved,
                })),
                pageInfo: {
                  hasNextPage: start + nodes.length < all.length,
                  endCursor: nodes.at(-1)?.node_id ?? null,
                },
              },
            },
          },
        },
      });
    }

    return graphqlError(c, "Unsupported GraphQL operation");
  });
}
