import type { RouteContext } from "@emulators/core";
import { ApiError, parseJsonBody } from "@emulators/core";
import type { GitHubBlob, GitHubCommit, GitHubRepo, GitHubTree, GitHubUser } from "../entities.js";
import { generateNodeId, generateSha, lookupRepo, timestamp } from "../helpers.js";
import { assertRepoRead, assertRepoWrite, notFoundResponse } from "../route-helpers.js";
import { getGitHubStore, type GitHubStore } from "../store.js";

interface FlatTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
}

function findCommit(gh: GitHubStore, repoId: number, sha: string): GitHubCommit | undefined {
  return gh.commits.findBy("repo_id", repoId).find((commit) => commit.sha === sha);
}

function findTree(gh: GitHubStore, repoId: number, sha: string): GitHubTree | undefined {
  return gh.trees.findBy("repo_id", repoId).find((tree) => tree.sha === sha);
}

function findBlob(gh: GitHubStore, repoId: number, sha: string): GitHubBlob | undefined {
  return gh.blobs.findBy("repo_id", repoId).find((blob) => blob.sha === sha);
}

function resolveCommit(
  gh: GitHubStore,
  repo: GitHubRepo,
  refName: string | undefined,
): { commit: GitHubCommit; branch: string | null } | undefined {
  const requested = refName ?? repo.default_branch;
  const branchName = requested.replace(/^refs\/heads\//, "");
  const branch = gh.branches.findBy("repo_id", repo.id).find((candidate) => candidate.name === branchName);
  if (branch) {
    const commit = findCommit(gh, repo.id, branch.sha);
    return commit ? { commit, branch: branch.name } : undefined;
  }
  const fullRef = requested.startsWith("refs/") ? requested : `refs/${requested}`;
  const ref = gh.refs.findBy("repo_id", repo.id).find((candidate) => candidate.ref === fullRef);
  if (ref) {
    const commit = findCommit(gh, repo.id, ref.sha);
    return commit ? { commit, branch: ref.ref.startsWith("refs/heads/") ? ref.ref.slice(11) : null } : undefined;
  }
  const commit = findCommit(gh, repo.id, requested);
  return commit ? { commit, branch: null } : undefined;
}

function flattenTree(
  gh: GitHubStore,
  repoId: number,
  tree: GitHubTree,
  prefix = "",
  visiting = new Set<string>(),
): FlatTreeEntry[] {
  if (visiting.has(tree.sha)) return [];
  visiting.add(tree.sha);
  const entries: FlatTreeEntry[] = [];
  for (const entry of tree.tree) {
    const path = prefix ? `${prefix}/${entry.path}` : entry.path;
    if (entry.type === "tree") {
      const child = findTree(gh, repoId, entry.sha);
      if (child) {
        entries.push(...flattenTree(gh, repoId, child, path, visiting));
        continue;
      }
    }
    entries.push({ ...entry, path });
  }
  visiting.delete(tree.sha);
  return entries;
}

function contentUrls(baseUrl: string, repo: GitHubRepo, path: string, ref: string, sha: string) {
  const encodedPath = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
  return {
    url: `${repoUrl}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
    html_url: `${baseUrl}/${repo.full_name}/blob/${encodeURIComponent(ref)}/${encodedPath}`,
    git_url: `${repoUrl}/git/blobs/${sha}`,
    download_url: `${baseUrl}/${repo.full_name}/raw/${encodeURIComponent(ref)}/${encodedPath}`,
  };
}

function formatFile(
  gh: GitHubStore,
  repo: GitHubRepo,
  entry: FlatTreeEntry,
  ref: string,
  baseUrl: string,
  includeContent: boolean,
) {
  const blob = findBlob(gh, repo.id, entry.sha);
  if (!blob) throw notFoundResponse();
  const content = blob.encoding === "base64" ? blob.content : Buffer.from(blob.content, "utf8").toString("base64");
  return {
    type: "file",
    encoding: includeContent ? "base64" : undefined,
    size: blob.size,
    name: entry.path.split("/").pop() ?? entry.path,
    path: entry.path,
    content: includeContent ? content : undefined,
    sha: entry.sha,
    ...contentUrls(baseUrl, repo, entry.path, ref, entry.sha),
    _links: {
      self: contentUrls(baseUrl, repo, entry.path, ref, entry.sha).url,
      git: contentUrls(baseUrl, repo, entry.path, ref, entry.sha).git_url,
      html: contentUrls(baseUrl, repo, entry.path, ref, entry.sha).html_url,
    },
  };
}

function formatDirectory(repo: GitHubRepo, path: string, ref: string, sha: string, baseUrl: string) {
  const urls = contentUrls(baseUrl, repo, path, ref, sha);
  return {
    type: "dir",
    size: 0,
    name: path.split("/").pop() ?? path,
    path,
    sha,
    ...urls,
    download_url: null,
    _links: { self: urls.url, git: urls.git_url, html: urls.html_url },
  };
}

function identity(raw: unknown, actor: GitHubUser, now: string): { name: string; email: string; date: string } {
  if (!raw || typeof raw !== "object") {
    return {
      name: actor.name ?? actor.login,
      email: actor.email ?? `${actor.login}@users.noreply.github.com`,
      date: now,
    };
  }
  const value = raw as Record<string, unknown>;
  return {
    name: typeof value.name === "string" ? value.name : (actor.name ?? actor.login),
    email: typeof value.email === "string" ? value.email : (actor.email ?? `${actor.login}@users.noreply.github.com`),
    date: typeof value.date === "string" ? value.date : now,
  };
}

function formatContentCommit(commit: GitHubCommit, repo: GitHubRepo, baseUrl: string) {
  const repoUrl = `${baseUrl}/repos/${repo.full_name}`;
  return {
    sha: commit.sha,
    node_id: commit.node_id,
    url: `${repoUrl}/git/commits/${commit.sha}`,
    html_url: `${baseUrl}/${repo.full_name}/commit/${commit.sha}`,
    author: {
      name: commit.author_name,
      email: commit.author_email,
      date: commit.author_date,
    },
    committer: {
      name: commit.committer_name,
      email: commit.committer_email,
      date: commit.committer_date,
    },
    message: commit.message,
    tree: { sha: commit.tree_sha, url: `${repoUrl}/git/trees/${commit.tree_sha}` },
    parents: commit.parent_shas.map((sha) => ({ sha, url: `${repoUrl}/git/commits/${sha}` })),
  };
}

function advanceBranch(gh: GitHubStore, repo: GitHubRepo, branchName: string, sha: string): void {
  const branch = gh.branches.findBy("repo_id", repo.id).find((candidate) => candidate.name === branchName);
  if (!branch) throw new ApiError(422, `Branch ${branchName} not found`);
  gh.branches.update(branch.id, { sha });
  const fullRef = `refs/heads/${branchName}`;
  const ref = gh.refs.findBy("repo_id", repo.id).find((candidate) => candidate.ref === fullRef);
  if (ref) {
    gh.refs.update(ref.id, { sha });
  }
}

function createContentCommit(
  gh: GitHubStore,
  repo: GitHubRepo,
  actor: GitHubUser,
  parent: GitHubCommit,
  treeEntries: FlatTreeEntry[],
  body: Record<string, unknown>,
): GitHubCommit {
  const tree = gh.trees.insert({
    repo_id: repo.id,
    sha: generateSha(),
    node_id: "",
    tree: treeEntries,
    truncated: false,
  } as Omit<GitHubTree, "id" | "created_at" | "updated_at">);
  gh.trees.update(tree.id, { node_id: generateNodeId("Tree", tree.id) });

  const now = timestamp();
  const author = identity(body.author, actor, now);
  const committer = identity(body.committer, actor, now);
  const commit = gh.commits.insert({
    repo_id: repo.id,
    sha: generateSha(),
    node_id: "",
    message: body.message as string,
    author_name: author.name,
    author_email: author.email,
    author_date: author.date,
    committer_name: committer.name,
    committer_email: committer.email,
    committer_date: committer.date,
    tree_sha: tree.sha,
    parent_shas: [parent.sha],
    user_id: actor.id,
  } as Omit<GitHubCommit, "id" | "created_at" | "updated_at">);
  gh.commits.update(commit.id, { node_id: generateNodeId("Commit", commit.id) });
  return gh.commits.get(commit.id)!;
}

export function contentsRoutes({ app, store, baseUrl }: RouteContext): void {
  const gh = getGitHubStore(store);

  app.get("/repos/:owner/:repo/contents/:path{.+}", (c) => {
    const repo = lookupRepo(gh, c.req.param("owner")!, c.req.param("repo")!);
    if (!repo) throw notFoundResponse();
    assertRepoRead(gh, c.get("authUser"), repo);
    const path = decodeURIComponent(c.req.param("path")!).replace(/^\/+|\/+$/g, "");
    const resolved = resolveCommit(gh, repo, c.req.query("ref"));
    if (!resolved) throw notFoundResponse();
    const tree = findTree(gh, repo.id, resolved.commit.tree_sha);
    if (!tree) throw notFoundResponse();
    const entries = flattenTree(gh, repo.id, tree);
    const file = entries.find((entry) => entry.path === path && entry.type === "blob");
    const ref = c.req.query("ref") ?? resolved.branch ?? resolved.commit.sha;
    if (file) return c.json(formatFile(gh, repo, file, ref, baseUrl, true));

    const prefix = `${path}/`;
    const childMap = new Map<string, FlatTreeEntry>();
    for (const entry of entries) {
      if (!entry.path.startsWith(prefix)) continue;
      const remainder = entry.path.slice(prefix.length);
      const [name] = remainder.split("/");
      if (!name) continue;
      if (remainder.includes("/")) {
        const childPath = `${path}/${name}`;
        childMap.set(childPath, { path: childPath, mode: "040000", type: "tree", sha: entry.sha });
      } else {
        childMap.set(entry.path, entry);
      }
    }
    if (childMap.size === 0) throw notFoundResponse();
    return c.json(
      [...childMap.values()]
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((entry) =>
          entry.type === "blob"
            ? formatFile(gh, repo, entry, ref, baseUrl, false)
            : formatDirectory(repo, entry.path, ref, entry.sha, baseUrl),
        ),
    );
  });

  app.put("/repos/:owner/:repo/contents/:path{.+}", async (c) => {
    const repo = lookupRepo(gh, c.req.param("owner")!, c.req.param("repo")!);
    if (!repo) throw notFoundResponse();
    const actor = assertRepoWrite(gh, c.get("authUser"), repo);
    const path = decodeURIComponent(c.req.param("path")!).replace(/^\/+|\/+$/g, "");
    const body = await parseJsonBody(c);
    if (typeof body.message !== "string" || !body.message.trim()) throw new ApiError(422, "message is required");
    if (typeof body.content !== "string") throw new ApiError(422, "content is required");
    const branchName =
      typeof body.branch === "string" ? body.branch.replace(/^refs\/heads\//, "") : repo.default_branch;
    const resolved = resolveCommit(gh, repo, branchName);
    if (!resolved?.branch) throw new ApiError(422, `Branch ${branchName} not found`);
    const currentTree = findTree(gh, repo.id, resolved.commit.tree_sha);
    if (!currentTree) throw new ApiError(422, "Current tree not found");
    const entries = flattenTree(gh, repo.id, currentTree);
    const existing = entries.find((entry) => entry.path === path && entry.type === "blob");
    if (existing && body.sha !== existing.sha) throw new ApiError(409, "sha does not match");
    if (!existing && body.sha !== undefined) throw new ApiError(422, "sha was provided for a missing file");

    let decoded: Buffer;
    try {
      decoded = Buffer.from(body.content, "base64");
    } catch {
      throw new ApiError(422, "content must be base64 encoded");
    }
    const blob = gh.blobs.insert({
      repo_id: repo.id,
      sha: generateSha(),
      node_id: "",
      content: body.content,
      encoding: "base64",
      size: decoded.length,
    } as Omit<GitHubBlob, "id" | "created_at" | "updated_at">);
    gh.blobs.update(blob.id, { node_id: generateNodeId("Blob", blob.id) });
    const nextEntries = entries.filter((entry) => entry.path !== path);
    nextEntries.push({ path, mode: "100644", type: "blob", sha: blob.sha, size: blob.size });
    nextEntries.sort((left, right) => left.path.localeCompare(right.path));
    const commit = createContentCommit(gh, repo, actor, resolved.commit, nextEntries, body);
    advanceBranch(gh, repo, branchName, commit.sha);
    gh.repos.update(repo.id, { pushed_at: commit.committer_date, size: nextEntries.length });
    const savedEntry = nextEntries.find((entry) => entry.path === path)!;
    return c.json(
      {
        content: formatFile(gh, repo, savedEntry, branchName, baseUrl, false),
        commit: formatContentCommit(commit, repo, baseUrl),
      },
      existing ? 200 : 201,
    );
  });

  app.delete("/repos/:owner/:repo/contents/:path{.+}", async (c) => {
    const repo = lookupRepo(gh, c.req.param("owner")!, c.req.param("repo")!);
    if (!repo) throw notFoundResponse();
    const actor = assertRepoWrite(gh, c.get("authUser"), repo);
    const path = decodeURIComponent(c.req.param("path")!).replace(/^\/+|\/+$/g, "");
    const body = await parseJsonBody(c);
    if (typeof body.message !== "string" || !body.message.trim()) throw new ApiError(422, "message is required");
    if (typeof body.sha !== "string") throw new ApiError(422, "sha is required");
    const branchName =
      typeof body.branch === "string" ? body.branch.replace(/^refs\/heads\//, "") : repo.default_branch;
    const resolved = resolveCommit(gh, repo, branchName);
    if (!resolved?.branch) throw new ApiError(422, `Branch ${branchName} not found`);
    const currentTree = findTree(gh, repo.id, resolved.commit.tree_sha);
    if (!currentTree) throw new ApiError(422, "Current tree not found");
    const entries = flattenTree(gh, repo.id, currentTree);
    const existing = entries.find((entry) => entry.path === path && entry.type === "blob");
    if (!existing) throw notFoundResponse();
    if (existing.sha !== body.sha) throw new ApiError(409, "sha does not match");
    const nextEntries = entries.filter((entry) => entry.path !== path);
    const commit = createContentCommit(gh, repo, actor, resolved.commit, nextEntries, body);
    advanceBranch(gh, repo, branchName, commit.sha);
    gh.repos.update(repo.id, { pushed_at: commit.committer_date, size: nextEntries.length });
    return c.json({ content: null, commit: formatContentCommit(commit, repo, baseUrl) });
  });
}
