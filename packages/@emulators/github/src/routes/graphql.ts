import { buildSchema, graphql, GraphQLError } from "graphql";
import type { Context, RouteContext } from "@emulators/core";
import type { GitHubComment } from "../entities.js";
import { generateNodeId, lookupRepo } from "../helpers.js";
import { assertAuthenticatedUser, assertRepoRead, assertRepoWrite } from "../route-helpers.js";
import { getGitHubStore, type GitHubStore } from "../store.js";

const schema = buildSchema(`
  type Query {
    repository(owner: String!, name: String!): Repository
  }

  type Mutation {
    resolveReviewThread(input: ResolveReviewThreadInput!): ResolveReviewThreadPayload
    unresolveReviewThread(input: UnresolveReviewThreadInput!): UnresolveReviewThreadPayload
  }

  type Repository {
    pullRequest(number: Int!): PullRequest
  }

  type PullRequest {
    reviewThreads(first: Int, after: String): PullRequestReviewThreadConnection!
  }

  type PullRequestReviewThread {
    id: ID!
    isResolved: Boolean!
  }

  type PullRequestReviewThreadConnection {
    nodes: [PullRequestReviewThread!]!
    pageInfo: PageInfo!
  }

  type PageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
  }

  input ResolveReviewThreadInput {
    threadId: ID!
  }

  input UnresolveReviewThreadInput {
    threadId: ID!
  }

  type ResolveReviewThreadPayload {
    thread: PullRequestReviewThread
  }

  type UnresolveReviewThreadPayload {
    thread: PullRequestReviewThread
  }
`);

interface GitHubGraphQLContext {
  c: Context;
  gh: GitHubStore;
}

interface ReviewThread {
  id: string;
  isResolved: boolean;
}

function threadId(rootCommentId: number): string {
  return generateNodeId("PullRequestReviewThread", rootCommentId);
}

function rootCommentIdFromThreadId(id: string): number | null {
  try {
    const decoded = Buffer.from(id, "base64").toString("utf8");
    const match = /^0:PullRequestReviewThread([1-9]\d*)$/.exec(decoded);
    if (!match) return null;
    const commentId = Number(match[1]);
    return Number.isSafeInteger(commentId) ? commentId : null;
  } catch {
    return null;
  }
}

function isRootReviewComment(comment: GitHubComment | undefined): comment is GitHubComment {
  return Boolean(comment && comment.comment_type === "review" && comment.in_reply_to_id === null);
}

function asThread(gh: GitHubStore, comment: GitHubComment): ReviewThread {
  return {
    id: threadId(comment.id),
    isResolved: Boolean(gh.reviewThreadResolutions.findOneBy("root_comment_id", comment.id)),
  };
}

function findThreadRoot(gh: GitHubStore, id: string): GitHubComment | null {
  const commentId = rootCommentIdFromThreadId(id);
  if (commentId === null) return null;
  const comment = gh.comments.get(commentId);
  return isRootReviewComment(comment) ? comment : null;
}

function reviewThreads(gh: GitHubStore, repoId: number, pullNumber: number, first = 30, after?: string | null) {
  if (!Number.isInteger(first) || first < 1 || first > 100) {
    throw new GraphQLError("Argument 'first' must be between 1 and 100");
  }

  const roots = gh.comments
    .findBy("repo_id", repoId)
    .filter(
      (comment) =>
        comment.comment_type === "review" && comment.pull_number === pullNumber && comment.in_reply_to_id === null,
    )
    .sort((left, right) => left.id - right.id);

  let start = 0;
  if (after) {
    const index = roots.findIndex((comment) => threadId(comment.id) === after);
    if (index < 0) throw new GraphQLError("The 'after' cursor is invalid");
    start = index + 1;
  }

  const page = roots.slice(start, start + first);
  return {
    nodes: page.map((comment) => asThread(gh, comment)),
    pageInfo: {
      hasNextPage: start + page.length < roots.length,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? threadId(page[0].id) : null,
      endCursor: page.length > 0 ? threadId(page[page.length - 1].id) : null,
    },
  };
}

function resolveThread(context: GitHubGraphQLContext, input: { threadId: string }, resolved: boolean): ReviewThread {
  const root = findThreadRoot(context.gh, input.threadId);
  if (!root) throw new GraphQLError("Could not resolve to a ReviewThread with the requested id");
  const repo = context.gh.repos.get(root.repo_id);
  if (!repo) throw new GraphQLError("Repository not found");

  const actor = assertRepoWrite(context.gh, context.c.get("authUser"), repo, "pull_requests");
  const existing = context.gh.reviewThreadResolutions.findOneBy("root_comment_id", root.id);
  if (resolved && !existing) {
    context.gh.reviewThreadResolutions.insert({
      root_comment_id: root.id,
      resolved_by_id: actor.id,
    });
  } else if (!resolved && existing) {
    context.gh.reviewThreadResolutions.delete(existing.id);
  }
  return asThread(context.gh, root);
}

function createRoot(context: GitHubGraphQLContext) {
  return {
    repository({ owner, name }: { owner: string; name: string }) {
      const repo = lookupRepo(context.gh, owner, name);
      if (!repo) throw new GraphQLError("Could not resolve to a Repository with the requested name");
      assertRepoRead(context.gh, context.c.get("authUser"), repo);
      return {
        pullRequest({ number }: { number: number }) {
          const pull = context.gh.pullRequests
            .findBy("repo_id", repo.id)
            .find((candidate) => candidate.number === number);
          if (!pull) throw new GraphQLError("Could not resolve to a PullRequest with the requested number");
          return {
            reviewThreads({ first, after }: { first?: number; after?: string | null }) {
              return reviewThreads(context.gh, repo.id, pull.number, first, after);
            },
          };
        },
      };
    },
    resolveReviewThread({ input }: { input: { threadId: string } }) {
      return { thread: resolveThread(context, input, true) };
    },
    unresolveReviewThread({ input }: { input: { threadId: string } }) {
      return { thread: resolveThread(context, input, false) };
    },
  };
}

async function runGraphQL(
  query: string,
  opts: {
    variables?: Record<string, unknown>;
    operationName?: string;
    context: GitHubGraphQLContext;
  },
) {
  if (!query) return { errors: [{ message: "GraphQL query is required" }] };
  return graphql({
    schema,
    source: query,
    rootValue: createRoot(opts.context),
    contextValue: opts.context,
    variableValues: opts.variables,
    operationName: opts.operationName,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function graphqlRoutes({ app, store }: RouteContext): void {
  const gh = getGitHubStore(store);

  app.post("/graphql", async (c) => {
    assertAuthenticatedUser(gh, c.get("authUser"));
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const result = await runGraphQL(typeof body.query === "string" ? body.query : "", {
      variables: isRecord(body.variables) ? body.variables : undefined,
      operationName: typeof body.operationName === "string" ? body.operationName : undefined,
      context: { c, gh },
    });
    return c.json(result, result.errors ? 400 : 200);
  });
}
