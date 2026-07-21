import type { Context, RouteContext } from "@emulators/core";
import type { SlackChannel, SlackMessage, SlackUser } from "../entities.js";
import { formatSlackPermalink, parseSlackBody, requireSlackScopes, slackError, slackOk } from "../helpers.js";
import { getSlackStore } from "../store.js";

interface SearchInput {
  query: string;
  count: number;
  page: number;
  sortDirection: string;
}

export function searchRoutes({ app, store, baseUrl }: RouteContext): void {
  const handleSearch = async (c: Context) => {
    const authUser = c.get("authUser");
    if (!authUser) return slackError(c, "not_authed");
    const scopeError = requireSlackScopes(c, store, ["search:read"]);
    if (scopeError) return scopeError;

    const input = await parseSearchInput(c);
    if (!input.query.trim()) return slackError(c, "no_query");

    const ss = getSlackStore(store);
    const currentUser = findUser(ss.users.all(), authUser.login);
    const currentUserId = currentUser?.user_id ?? authUser.login;
    const parsedQuery = parseSearchQuery(input.query, ss.users.all(), ss.channels.all(), currentUserId);

    const matches = ss.messages
      .all()
      .flatMap((message) => {
        const channel = ss.channels.findOneBy("channel_id", message.channel_id);
        if (!channel || !canSearchChannel(channel, currentUserId)) return [];
        if (!matchesQuery(message, channel, parsedQuery)) return [];
        return [{ message, channel }];
      })
      .sort((left, right) => compareMatches(left.message, right.message, input.sortDirection));

    const total = matches.length;
    const start = (input.page - 1) * input.count;
    const pageMatches = matches.slice(start, start + input.count).map(({ message, channel }) => {
      const user = findUser(ss.users.all(), message.user);
      return {
        type: message.type,
        user: message.user,
        username: message.username ?? user?.name ?? "",
        text: message.text,
        ts: message.ts,
        channel: { id: channel.channel_id, name: channel.name },
        permalink: formatSlackPermalink(baseUrl, channel.channel_id, message),
        ...(message.thread_ts ? { thread_ts: message.thread_ts } : {}),
      };
    });

    return slackOk(c, {
      query: input.query,
      messages: {
        total,
        paging: {
          count: input.count,
          total,
          page: input.page,
          pages: total === 0 ? 0 : Math.ceil(total / input.count),
        },
        matches: pageMatches,
      },
    });
  };

  app.get("/api/search.messages", handleSearch);
  app.post("/api/search.messages", handleSearch);
}

async function parseSearchInput(c: Context): Promise<SearchInput> {
  const body = c.req.method === "GET" ? undefined : await parseSlackBody(c);
  const url = new URL(c.req.url);
  const value = (key: string) => {
    const fromBody = body?.[key];
    return typeof fromBody === "string" || typeof fromBody === "number"
      ? String(fromBody)
      : (url.searchParams.get(key) ?? "");
  };

  return {
    query: value("query"),
    count: clampInteger(value("count"), 20, 1, 100),
    page: clampInteger(value("page"), 1, 1, Number.MAX_SAFE_INTEGER),
    sortDirection: value("sort_dir") || "desc",
  };
}

function parseSearchQuery(
  query: string,
  users: SlackUser[],
  channels: SlackChannel[],
  currentUserId: string,
): { terms: string[]; userId?: string; channelId?: string } {
  const result: { terms: string[]; userId?: string; channelId?: string } = { terms: [] };
  for (const rawToken of query.match(/"[^"]*"|\S+/g) ?? []) {
    const token = rawToken.replace(/^"|"$/g, "");
    if (token.toLowerCase() === "from:me") {
      result.userId = currentUserId;
      continue;
    }
    if (token.toLowerCase().startsWith("from:")) {
      const reference = token.slice(5).replace(/^@/, "");
      result.userId = findUser(users, reference)?.user_id ?? reference;
      continue;
    }
    if (token.toLowerCase().startsWith("in:")) {
      const reference = token.slice(3).replace(/^#/, "");
      result.channelId =
        channels.find((channel) => channel.channel_id === reference || channel.name === reference)?.channel_id ??
        reference;
      continue;
    }
    if (token) result.terms.push(token.toLowerCase());
  }
  return result;
}

function matchesQuery(
  message: SlackMessage,
  channel: SlackChannel,
  query: { terms: string[]; userId?: string; channelId?: string },
): boolean {
  if (query.userId && message.user !== query.userId) return false;
  if (query.channelId && channel.channel_id !== query.channelId) return false;
  const text = message.text.toLowerCase();
  return query.terms.every((term) => text.includes(term));
}

function canSearchChannel(channel: SlackChannel, userId: string): boolean {
  if (!channel.is_private && !channel.is_im && !channel.is_mpim) return true;
  return channel.members.includes(userId);
}

function findUser(users: SlackUser[], reference: string): SlackUser | undefined {
  return users.find((user) => user.user_id === reference || user.name === reference);
}

function compareMatches(left: SlackMessage, right: SlackMessage, direction: string): number {
  const result = Number.parseFloat(left.ts) - Number.parseFloat(right.ts);
  return direction.toLowerCase() === "asc" ? result : -result;
}

function clampInteger(value: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}
