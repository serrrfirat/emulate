---
name: github
description: Emulated GitHub REST and review-thread GraphQL APIs for local development and testing. Use when the user needs to interact with GitHub API endpoints locally, test GitHub integrations, emulate repository contents, commit statuses, issues, pull requests, review threads, configure seeded Actions runs, set up GitHub OAuth flows, configure GitHub Apps, test webhooks, or work with checks without hitting the real GitHub API.
allowed-tools: Bash(npx emulate:*), Bash(emulate:*), Bash(curl:*)
---

# GitHub API Emulator

Fully stateful GitHub REST API emulation. Creates, updates, and deletes persist in memory and affect related entities.

## Start

```bash
# GitHub only
npx emulate --service github

# Default port
# http://localhost:4001
```

Or programmatically:

```typescript
import { createEmulator } from 'emulate'

const github = await createEmulator({ service: 'github', port: 4001 })
// github.url === 'http://localhost:4001'
```

## Auth

Pass tokens as `Authorization: Bearer <token>` or `Authorization: token <token>`.

```bash
curl http://localhost:4001/user \
  -H "Authorization: Bearer test_token_admin"
```

Public repo endpoints work without auth. Private repos and write operations require a valid token. When no token is provided, requests fall back to the first seeded user.

### GitHub App JWT

Configure apps in the seed config with a private key. Sign a JWT with `{ iss: "<app_id>" }` using RS256. The emulator verifies the signature and resolves the app.

```yaml
github:
  apps:
    - app_id: 12345
      slug: my-github-app
      name: My GitHub App
      private_key: |
        -----BEGIN RSA PRIVATE KEY-----
        ...
        -----END RSA PRIVATE KEY-----
      permissions:
        contents: read
        issues: write
      events: [push, pull_request]
      webhook_url: http://localhost:8080/github/webhook
      webhook_secret: my-webhook-secret
      description: My CI/CD bot
      installations:
        - installation_id: 100
          account: my-org
          repository_selection: all
          permissions:
            contents: read
          events: [push]
          repositories: [my-org/org-repo]
```

## Pointing Your App at the Emulator

### Environment Variable

```bash
GITHUB_EMULATOR_URL=http://localhost:4001
```

### Octokit

```typescript
import { Octokit } from '@octokit/rest'

const octokit = new Octokit({
  baseUrl: process.env.GITHUB_EMULATOR_URL ?? 'https://api.github.com',
  auth: 'test_token_admin',
})
```

### OAuth URL Mapping

| Real GitHub URL | Emulator URL |
|-----------------|-------------|
| `https://github.com/login/oauth/authorize` | `$GITHUB_EMULATOR_URL/login/oauth/authorize` |
| `https://github.com/login/oauth/access_token` | `$GITHUB_EMULATOR_URL/login/oauth/access_token` |
| `https://api.github.com/user` | `$GITHUB_EMULATOR_URL/user` |

### Auth.js / NextAuth.js

```typescript
import GitHub from '@auth/core/providers/github'

GitHub({
  clientId: process.env.GITHUB_CLIENT_ID,
  clientSecret: process.env.GITHUB_CLIENT_SECRET,
  authorization: {
    url: `${process.env.GITHUB_EMULATOR_URL}/login/oauth/authorize`,
  },
  token: {
    url: `${process.env.GITHUB_EMULATOR_URL}/login/oauth/access_token`,
  },
  userinfo: {
    url: `${process.env.GITHUB_EMULATOR_URL}/user`,
  },
})
```

## Seed Config

```yaml
tokens:
  test_token_admin:
    login: admin
    scopes: [repo, user, admin:org, admin:repo_hook]

github:
  users:
    - login: octocat
      name: The Octocat
      email: octocat@github.com
      bio: I am the Octocat
      company: GitHub
      location: San Francisco
      blog: https://github.blog
      twitter_username: github
      site_admin: false
  orgs:
    - login: my-org
      name: My Organization
      description: A test organization
      email: org@example.com
  repos:
    - owner: octocat
      name: hello-world
      description: My first repository
      language: JavaScript
      topics: [hello, world]
      default_branch: main
      private: false
    - owner: my-org
      name: org-repo
      description: An organization repository
      language: TypeScript
  workflows:
    - owner: octocat
      repo: hello-world
      id: 101
      name: CI
      path: .github/workflows/ci.yml
  workflow_runs:
    - owner: octocat
      repo: hello-world
      workflow_id: 101
      id: 1001
      status: completed
      conclusion: success
      logs: Build completed successfully.
  jobs:
    - owner: octocat
      repo: hello-world
      run_id: 1001
      id: 2001
      name: test
      status: completed
      conclusion: success
      logs: All tests passed.
  artifacts:
    - owner: octocat
      repo: hello-world
      run_id: 1001
      id: 3001
      name: test-results
  oauth_apps:
    - client_id: Iv1.abc123
      client_secret: secret_abc123
      name: My Web App
      redirect_uris:
        - http://localhost:3000/api/auth/callback/github
```

Repos are auto-initialized with a commit, branch, and README unless `auto_init: false` is set.

## Pagination

All list endpoints support `page` and `per_page` query params with `Link` headers:

```bash
curl "http://localhost:4001/repos/octocat/hello-world/issues?page=1&per_page=10" \
  -H "Authorization: Bearer $TOKEN"
```

## API Endpoints

### Users

```bash
# Authenticated user
curl http://localhost:4001/user -H "Authorization: Bearer $TOKEN"

# Update profile
curl -X PATCH http://localhost:4001/user \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"bio": "Hello!"}'

# Get user by username
curl http://localhost:4001/users/octocat

# List users
curl http://localhost:4001/users

# User repos / orgs / followers / following
curl http://localhost:4001/users/octocat/repos
curl http://localhost:4001/users/octocat/orgs
curl http://localhost:4001/users/octocat/followers
curl http://localhost:4001/users/octocat/following

# User hovercard
curl http://localhost:4001/users/octocat/hovercard

# User emails
curl http://localhost:4001/user/emails -H "Authorization: Bearer $TOKEN"
```

### Repositories

```bash
# Get repo
curl http://localhost:4001/repos/octocat/hello-world

# Create user repo
curl -X POST http://localhost:4001/user/repos \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "new-repo", "private": false}'

# Create org repo
curl -X POST http://localhost:4001/orgs/my-org/repos \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "org-project"}'

# Update repo
curl -X PATCH http://localhost:4001/repos/octocat/hello-world \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"description": "Updated description"}'

# Delete repo (cascades issues, PRs, etc.)
curl -X DELETE http://localhost:4001/repos/octocat/hello-world \
  -H "Authorization: Bearer $TOKEN"

# Topics, languages, contributors, forks, collaborators, tags, transfer
```

### Contents

```bash
# Read a file
curl http://localhost:4001/repos/octocat/hello-world/contents/README.md

# Create or update a file
curl -X PUT http://localhost:4001/repos/octocat/hello-world/contents/docs/guide.md \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "Update guide", "content": "IyBHdWlkZQo=", "branch": "main"}'

# Delete a file
curl -X DELETE http://localhost:4001/repos/octocat/hello-world/contents/docs/guide.md \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "Remove guide", "sha": "<blob-sha>", "branch": "main"}'
```

### Issues

```bash
# List issues (filter by state, labels, assignee, milestone, creator, since)
curl "http://localhost:4001/repos/octocat/hello-world/issues?state=open&labels=bug"

# Create issue
curl -X POST http://localhost:4001/repos/octocat/hello-world/issues \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "Bug report", "body": "Details here", "labels": ["bug"]}'

# Get / update / lock / unlock / timeline / events / assignees
```

### Pull Requests

```bash
# List PRs
curl "http://localhost:4001/repos/octocat/hello-world/pulls?state=open"

# Create PR
curl -X POST http://localhost:4001/repos/octocat/hello-world/pulls \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "Feature", "head": "feature-branch", "base": "main"}'

# Merge PR (enforces branch protection)
curl -X PUT http://localhost:4001/repos/octocat/hello-world/pulls/1/merge \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"merge_method": "squash"}'

# Commits, files, requested reviewers, update branch
```

### Comments

```bash
# Issue comments: full CRUD
curl http://localhost:4001/repos/octocat/hello-world/issues/1/comments
curl -X POST http://localhost:4001/repos/octocat/hello-world/issues/1/comments \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"body": "Looks good!"}'

# Comment by ID (cross-resource)
curl http://localhost:4001/repos/octocat/hello-world/issues/comments/1

# PR review comments
curl http://localhost:4001/repos/octocat/hello-world/pulls/1/comments
curl -X POST http://localhost:4001/repos/octocat/hello-world/pulls/1/comments/10/replies \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"body": "Addressed in the latest revision."}'

# Commit comments
curl http://localhost:4001/repos/octocat/hello-world/commits/abc123/comments

# Repo-wide comment listings
curl http://localhost:4001/repos/octocat/hello-world/issues/comments
curl http://localhost:4001/repos/octocat/hello-world/pulls/comments
curl http://localhost:4001/repos/octocat/hello-world/comments
```

### Reviews

```bash
# List / create / get / update / submit / dismiss reviews
curl http://localhost:4001/repos/octocat/hello-world/pulls/1/reviews
curl -X POST http://localhost:4001/repos/octocat/hello-world/pulls/1/reviews \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"event": "APPROVE", "body": "LGTM"}'

# Minimal review-thread GraphQL supports queries, resolve, and unresolve
curl -X POST http://localhost:4001/graphql \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"query ReviewThreads($owner: String!, $repo: String!, $number: Int!, $first: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviewThreads(first: $first) { nodes { id isResolved } } } } }","variables":{"owner":"octocat","repo":"hello-world","number":1,"first":20}}'
```

### Labels & Milestones

Full CRUD for labels and milestones. Add/remove labels from issues, replace all labels. List labels for a milestone.

### Branches & Git Data

```bash
# List branches
curl http://localhost:4001/repos/octocat/hello-world/branches

# Branch protection CRUD (status checks, PR reviews, enforce admins)
curl -X PUT http://localhost:4001/repos/octocat/hello-world/branches/main/protection \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"required_status_checks": {"strict": true, "contexts": ["ci"]}}'

# Refs, commits, trees (recursive), blobs, tags, matching-refs

# Create and read commit statuses
curl -X POST http://localhost:4001/repos/octocat/hello-world/statuses/abc123 \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"state": "success", "context": "ci/test", "description": "Tests passed"}'

curl http://localhost:4001/repos/octocat/hello-world/commits/abc123/status
```

### Organizations & Teams

```bash
# List all orgs / user's orgs / get org / update org
curl http://localhost:4001/organizations
curl http://localhost:4001/user/orgs -H "Authorization: Bearer $TOKEN"
curl http://localhost:4001/orgs/my-org
curl -X PATCH http://localhost:4001/orgs/my-org \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"description": "Updated org"}'

# Org members: list, get, remove
curl http://localhost:4001/orgs/my-org/members
curl http://localhost:4001/orgs/my-org/members/octocat
curl -X DELETE http://localhost:4001/orgs/my-org/members/octocat \
  -H "Authorization: Bearer $TOKEN"

# Org memberships: get, set (invite/update role)
curl http://localhost:4001/orgs/my-org/memberships/octocat -H "Authorization: Bearer $TOKEN"
curl -X PUT http://localhost:4001/orgs/my-org/memberships/octocat \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"role": "admin"}'

# Teams: CRUD
curl http://localhost:4001/orgs/my-org/teams
curl -X POST http://localhost:4001/orgs/my-org/teams \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "engineering", "privacy": "closed"}'

# Team members and memberships
curl http://localhost:4001/orgs/my-org/teams/engineering/members
curl -X PUT http://localhost:4001/orgs/my-org/teams/engineering/memberships/octocat \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"role": "maintainer"}'

# Team repos: list, add, remove
curl http://localhost:4001/orgs/my-org/teams/engineering/repos
curl -X PUT http://localhost:4001/orgs/my-org/teams/engineering/repos/my-org/org-repo \
  -H "Authorization: Bearer $TOKEN"

# Legacy team endpoints by ID
curl http://localhost:4001/teams/1
curl http://localhost:4001/teams/1/members
```

### GitHub Apps

```bash
# Get authenticated app (requires JWT auth)
curl http://localhost:4001/app \
  -H "Authorization: Bearer <jwt>"

# List app installations
curl http://localhost:4001/app/installations \
  -H "Authorization: Bearer <jwt>"

# Get installation
curl http://localhost:4001/app/installations/100 \
  -H "Authorization: Bearer <jwt>"

# Create installation access token (mints ghs_... token)
curl -X POST http://localhost:4001/app/installations/100/access_tokens \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"permissions": {"contents": "read"}}'

# Find installation for repo / org / user
curl http://localhost:4001/repos/my-org/org-repo/installation
curl http://localhost:4001/orgs/my-org/installation
curl http://localhost:4001/users/octocat/installation
```

App webhook delivery: when events occur, the emulator POSTs `event_callback` payloads to configured `webhook_url` with `X-GitHub-Event` and `X-Hub-Signature-256` headers.

### Releases

```bash
# Create release
curl -X POST http://localhost:4001/repos/octocat/hello-world/releases \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"tag_name": "v1.0.0", "name": "v1.0.0"}'

# List, get, latest, by tag, generate notes

# Release assets: list, upload
curl http://localhost:4001/repos/octocat/hello-world/releases/1/assets
curl -X POST http://localhost:4001/repos/octocat/hello-world/releases/1/assets \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/octet-stream" \
  -H "name: binary.zip" \
  --data-binary @binary.zip
```

### Webhooks

```bash
# Create webhook (real HTTP delivery on state changes)
curl -X POST http://localhost:4001/repos/octocat/hello-world/hooks \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"config": {"url": "http://localhost:8080/webhook"}, "events": ["push", "pull_request"]}'

# Full CRUD, ping, test, deliveries
# Org webhooks also supported
```

### Search

```bash
# Search repositories
curl "http://localhost:4001/search/repositories?q=language:JavaScript+user:octocat"

# Search issues and PRs
curl "http://localhost:4001/search/issues?q=repo:octocat/hello-world+is:open"

# Search users, code, commits, topics, labels
```

### Actions

```bash
# Workflows: list, get, enable/disable, dispatch
# Workflow runs: list, get, cancel, rerun all jobs, rerun failed jobs, delete, logs
# Jobs: list, get, rerun, logs
# Artifacts: list, get, delete
# Seed workflows with runs, jobs, logs, and artifacts for deterministic CI tests
# Secrets: repo + org CRUD

curl -X POST http://localhost:4001/repos/octocat/hello-world/actions/runs/1001/rerun \
  -H "Authorization: Bearer $TOKEN"

curl -X POST http://localhost:4001/repos/octocat/hello-world/actions/runs/1001/rerun-failed-jobs \
  -H "Authorization: Bearer $TOKEN"

curl -X POST http://localhost:4001/repos/octocat/hello-world/actions/jobs/2001/rerun \
  -H "Authorization: Bearer $TOKEN"
```

### Checks

```bash
# Create check run
curl -X POST http://localhost:4001/repos/octocat/hello-world/check-runs \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "CI", "head_sha": "abc123", "status": "completed", "conclusion": "success"}'

# Check suites: create, get, rerequest, preferences, list by ref
# Check runs: list for suite, annotations
# Automatic suite status rollup from check run results
```

### OAuth

```bash
# Authorize (browser flow, shows user picker)
# GET /login/oauth/authorize?client_id=...&redirect_uri=...&scope=...&state=...

# Token exchange
curl -X POST http://localhost:4001/login/oauth/access_token \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{"client_id": "Iv1.abc123", "client_secret": "secret_abc123", "code": "<code>"}'

# User emails
curl http://localhost:4001/user/emails -H "Authorization: Bearer $TOKEN"

# OAuth app management (settings)
curl http://localhost:4001/settings/applications -H "Authorization: Bearer $TOKEN"
curl http://localhost:4001/settings/connections/applications/Iv1.abc123 -H "Authorization: Bearer $TOKEN"

# Revoke OAuth app
curl -X POST http://localhost:4001/settings/connections/applications/Iv1.abc123/revoke \
  -H "Authorization: Bearer $TOKEN"
```

### Misc

```bash
curl http://localhost:4001/rate_limit
curl http://localhost:4001/meta
curl http://localhost:4001/emojis
curl http://localhost:4001/versions
curl http://localhost:4001/octocat
curl http://localhost:4001/zen
```

## Common Patterns

### Create Repo, Issue, and PR

```bash
TOKEN="test_token_admin"
BASE="http://localhost:4001"

# Create repo
curl -X POST $BASE/user/repos \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-project"}'

# Create issue
curl -X POST $BASE/repos/admin/my-project/issues \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "First issue"}'

# Create PR
curl -X POST $BASE/repos/admin/my-project/pulls \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "First PR", "head": "feature", "base": "main"}'
```

### GitHub App Installation Token Flow

```bash
# 1. Sign a JWT with { iss: "12345" } using the app's private key (RS256)
# 2. Create an installation access token
curl -X POST $BASE/app/installations/100/access_tokens \
  -H "Authorization: Bearer <jwt>" \
  -H "Content-Type: application/json" \
  -d '{"permissions": {"contents": "read", "issues": "write"}}'
# Returns { "token": "ghs_...", ... }

# 3. Use the installation token to call API endpoints
curl $BASE/repos/my-org/org-repo \
  -H "Authorization: Bearer ghs_..."
```

### OAuth Flow

1. Redirect user to `$GITHUB_EMULATOR_URL/login/oauth/authorize?client_id=...&redirect_uri=...&scope=user+repo&state=...`
2. User picks a seeded user on the emulator's UI
3. Emulator redirects back with `?code=...&state=...`
4. Exchange code for token via `POST /login/oauth/access_token`
5. Use token to call API endpoints
