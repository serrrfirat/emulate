import type { RouteContext } from "@emulators/core";
import { ApiError, parseJsonBody } from "@emulators/core";
import type { GitHubCommitStatus, GitHubRepo } from "../entities.js";
import { formatRepo, formatUser, generateNodeId, lookupRepo } from "../helpers.js";
import { assertRepoRead, assertRepoWrite, notFoundResponse } from "../route-helpers.js";
import { getGitHubStore, type GitHubStore } from "../store.js";

function resolveSha(gh: GitHubStore, repo: GitHubRepo, ref: string): string | undefined {
  if (gh.commits.findBy("repo_id", repo.id).some((commit) => commit.sha === ref)) return ref;
  const branchName = ref.replace(/^refs\/heads\//, "");
  const branch = gh.branches.findBy("repo_id", repo.id).find((candidate) => candidate.name === branchName);
  if (branch) return branch.sha;
  const fullRef = ref.startsWith("refs/") ? ref : `refs/${ref}`;
  return gh.refs.findBy("repo_id", repo.id).find((candidate) => candidate.ref === fullRef)?.sha;
}

function formatStatus(status: GitHubCommitStatus, repo: GitHubRepo, gh: GitHubStore, baseUrl: string) {
  const creator = gh.users.get(status.creator_id);
  const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
  return {
    id: status.id,
    node_id: generateNodeId("Status", status.id),
    url: `${repoUrl}/statuses/${status.sha}`,
    avatar_url: creator?.avatar_url ?? null,
    state: status.state,
    description: status.description,
    target_url: status.target_url,
    context: status.context,
    created_at: status.created_at,
    updated_at: status.updated_at,
    creator: creator ? formatUser(creator, baseUrl) : null,
  };
}

function combinedState(statuses: GitHubCommitStatus[]): "failure" | "pending" | "success" {
  if (statuses.some((status) => status.state === "error" || status.state === "failure")) return "failure";
  if (statuses.length === 0 || statuses.some((status) => status.state === "pending")) return "pending";
  return "success";
}

export function statusesRoutes({ app, store, baseUrl }: RouteContext): void {
  const gh = getGitHubStore(store);

  app.post("/repos/:owner/:repo/statuses/:sha", async (c) => {
    const repo = lookupRepo(gh, c.req.param("owner")!, c.req.param("repo")!);
    if (!repo) throw notFoundResponse();
    const actor = assertRepoWrite(gh, c.get("authUser"), repo, "statuses");
    const sha = resolveSha(gh, repo, c.req.param("sha")!);
    if (!sha) throw notFoundResponse();
    const body = await parseJsonBody(c);
    if (body.state !== "error" && body.state !== "failure" && body.state !== "pending" && body.state !== "success") {
      throw new ApiError(422, "state must be error, failure, pending, or success");
    }
    const context = typeof body.context === "string" && body.context.trim() ? body.context : "default";
    const status = gh.commitStatuses.insert({
      repo_id: repo.id,
      sha,
      state: body.state,
      target_url: typeof body.target_url === "string" ? body.target_url : null,
      description: typeof body.description === "string" ? body.description : null,
      context,
      creator_id: actor.id,
    } as Omit<GitHubCommitStatus, "id" | "created_at" | "updated_at">);
    return c.json(formatStatus(status, repo, gh, baseUrl), 201);
  });

  app.get("/repos/:owner/:repo/commits/:ref/status", (c) => {
    const repo = lookupRepo(gh, c.req.param("owner")!, c.req.param("repo")!);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);
    const sha = resolveSha(gh, repo, decodeURIComponent(c.req.param("ref")!));
    if (!sha) throw notFoundResponse();
    const byContext = new Map<string, GitHubCommitStatus>();
    for (const status of gh.commitStatuses.findBy("repo_id", repo.id).filter((candidate) => candidate.sha === sha)) {
      const existing = byContext.get(status.context);
      if (!existing || existing.id < status.id) byContext.set(status.context, status);
    }
    const statuses = [...byContext.values()].sort((left, right) => right.id - left.id);
    const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
    return c.json({
      state: combinedState(statuses),
      statuses: statuses.map((status) => formatStatus(status, repo, gh, baseUrl)),
      sha,
      total_count: statuses.length,
      repository: formatRepo(repo, gh, baseUrl),
      commit_url: `${repoUrl}/commits/${sha}`,
      url: `${repoUrl}/commits/${sha}/status`,
    });
  });
}
