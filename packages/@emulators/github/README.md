# @emulators/github

Fully stateful GitHub API emulation. Creates, updates, and deletes persist in memory and affect related entities.

Part of [emulate](https://github.com/vercel-labs/emulate) — local drop-in replacement services for CI and no-network sandboxes.

## Install

```bash
npm install @emulators/github
```

## Endpoints

### Users
- `GET /user` — authenticated user
- `PATCH /user` — update profile
- `GET /users/:username` — get user
- `GET /users` — list users
- `GET /users/:username/repos` — list user repos
- `GET /users/:username/orgs` — list user orgs
- `GET /users/:username/followers` — list followers
- `GET /users/:username/following` — list following

### Repositories
- `GET /repos/:owner/:repo` — get repo
- `POST /user/repos` — create user repo
- `POST /orgs/:org/repos` — create org repo
- `PATCH /repos/:owner/:repo` — update repo
- `DELETE /repos/:owner/:repo` — delete repo (cascades)
- `GET/PUT /repos/:owner/:repo/topics` — get/replace topics
- `GET /repos/:owner/:repo/languages` — languages
- `GET /repos/:owner/:repo/contributors` — contributors
- `GET /repos/:owner/:repo/forks` — list forks
- `POST /repos/:owner/:repo/forks` — create fork
- `GET/PUT/DELETE /repos/:owner/:repo/collaborators/:username` — collaborators
- `GET /repos/:owner/:repo/collaborators/:username/permission`
- `POST /repos/:owner/:repo/transfer` — transfer repo
- `GET /repos/:owner/:repo/tags` — list tags

### Contents
- `GET /repos/:owner/:repo/contents/:path` — get a file or directory
- `PUT /repos/:owner/:repo/contents/:path` — create or update file contents
- `DELETE /repos/:owner/:repo/contents/:path` — delete a file

### Issues
- `GET /repos/:owner/:repo/issues` — list (filter by state, labels, assignee, milestone, creator, since)
- `POST /repos/:owner/:repo/issues` — create
- `GET /repos/:owner/:repo/issues/:number` — get
- `PATCH /repos/:owner/:repo/issues/:number` — update (state transitions, events)
- `PUT/DELETE /repos/:owner/:repo/issues/:number/lock` — lock/unlock
- `GET /repos/:owner/:repo/issues/:number/timeline` — timeline events
- `GET /repos/:owner/:repo/issues/:number/events` — events
- `POST/DELETE /repos/:owner/:repo/issues/:number/assignees` — manage assignees

### Pull Requests
- `GET /repos/:owner/:repo/pulls` — list (filter by state, head, base)
- `POST /repos/:owner/:repo/pulls` — create
- `GET /repos/:owner/:repo/pulls/:number` — get
- `PATCH /repos/:owner/:repo/pulls/:number` — update
- `PUT /repos/:owner/:repo/pulls/:number/merge` — merge (with branch protection enforcement)
- `GET /repos/:owner/:repo/pulls/:number/commits` — list commits
- `GET /repos/:owner/:repo/pulls/:number/files` — list files
- `POST/DELETE /repos/:owner/:repo/pulls/:number/requested_reviewers` — manage reviewers
- `PUT /repos/:owner/:repo/pulls/:number/update-branch` — update branch

### Comments
- Issue comments: full CRUD on `/repos/:owner/:repo/issues/:number/comments`
- Review comments: full CRUD on `/repos/:owner/:repo/pulls/:number/comments`
- `POST /repos/:owner/:repo/pulls/:number/comments/:comment_id/replies` — reply to a review comment
- Commit comments: full CRUD on `/repos/:owner/:repo/commits/:sha/comments`
- Repo-wide listings for each type

### Reviews
- `GET /repos/:owner/:repo/pulls/:number/reviews` — list
- `POST /repos/:owner/:repo/pulls/:number/reviews` — create (with inline comments)
- `GET/PUT /repos/:owner/:repo/pulls/:number/reviews/:id` — get/update
- `POST /repos/:owner/:repo/pulls/:number/reviews/:id/events` — submit
- `PUT /repos/:owner/:repo/pulls/:number/reviews/:id/dismissals` — dismiss
- `POST /graphql` — query, resolve, or unresolve review threads

### Labels & Milestones
- Labels: full CRUD, add/remove from issues, replace all
- Milestones: full CRUD, state transitions, issue counts

### Branches & Git Data
- Branches: list, get, protection CRUD (status checks, PR reviews, enforce admins)
- Refs: get, match, create, update, delete
- Commits: get, create
- Trees: get (with recursive), create (with inline content)
- Blobs: get, create
- Tags: get, create
- `POST /repos/:owner/:repo/statuses/:sha` — create a commit status
- `GET /repos/:owner/:repo/commits/:ref/status` — get combined commit status

### Organizations & Teams
- Orgs: get, update, list
- Org members: list, check, remove, get/set membership
- Teams: full CRUD, members, repos

### Releases
- Releases: full CRUD, latest, by tag
- Release assets: full CRUD, upload
- Generate release notes

### Webhooks
- Repo webhooks: full CRUD, ping, test, deliveries
- Org webhooks: full CRUD, ping
- Real HTTP delivery to registered URLs on all state changes

### Search
- `GET /search/repositories` — full query syntax (user, org, language, topic, stars, forks, etc.)
- `GET /search/issues` — issues + PRs (repo, is, author, label, milestone, state, etc.)
- `GET /search/users` — users + orgs
- `GET /search/code` — blob content search
- `GET /search/commits` — commit message search
- `GET /search/topics` — topic search
- `GET /search/labels` — label search

### Actions
- Workflows: list, get, enable/disable, dispatch
- Workflow runs: list, get, cancel, rerun all jobs, rerun failed jobs, delete, logs
- Jobs: list, get, rerun, logs
- Artifacts: list, get, delete
- Seed workflows with runs, jobs, logs, and artifacts for deterministic CI tests
- `POST /repos/:owner/:repo/actions/runs/:run_id/rerun` — rerun all jobs
- `POST /repos/:owner/:repo/actions/runs/:run_id/rerun-failed-jobs` — rerun failed jobs
- `POST /repos/:owner/:repo/actions/jobs/:job_id/rerun` — rerun one job
- Secrets: repo + org CRUD

### Checks
- Check runs: create, update, get, annotations, rerequest, list by ref/suite
- Check suites: create, get, preferences, rerequest, list by ref
- Automatic suite status rollup from check run results

### Misc
- `GET /rate_limit` — rate limit status
- `GET /meta` — server metadata
- `GET /octocat` — ASCII art
- `GET /emojis` — emoji URLs
- `GET /zen` — random zen phrase
- `GET /versions` — API versions

## Auth

Public repo endpoints work without auth. Private repos and write operations require a valid token. Pagination uses `page`/`per_page` with `Link` headers.

## Seed Configuration

```yaml
github:
  users:
    - login: octocat
      name: The Octocat
      email: octocat@github.com
  orgs:
    - login: my-org
      name: My Organization
  repos:
    - owner: octocat
      name: hello-world
      language: JavaScript
      auto_init: true
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
    - client_id: "Iv1.abc123"
      client_secret: "secret_abc123"
      name: "My Web App"
      redirect_uris:
        - "http://localhost:3000/api/auth/callback/github"
  apps:
    - app_id: 12345
      slug: "my-github-app"
      name: "My GitHub App"
      private_key: |
        -----BEGIN RSA PRIVATE KEY-----
        ...your PEM key...
        -----END RSA PRIVATE KEY-----
      permissions:
        contents: read
        issues: write
      events: [push, pull_request]
      installations:
        - installation_id: 100
          account: my-org
          repository_selection: all
```

## Links

- [Full documentation](https://emulate.dev/github)
- [GitHub](https://github.com/vercel-labs/emulate)
