import type { Env } from "../env";
import { AppError } from "../validation/errors";

const GITHUB_HEADERS = { accept: "application/vnd.github+json", "user-agent": "orsko" };
const FETCH_TIMEOUT_MS = 5000;

/**
 * A fetch to GitHub, bounded so a slow or hanging upstream cannot stall the
 * callback forever. A network failure or timeout is treated the same as a
 * non-2xx response: sign-in is unavailable, not a 500.
 */
async function githubFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch {
    throw new AppError("auth_unavailable", "github request failed");
  }
}

export function githubAuthorizeUrl(clientId: string, state: string, redirectUri: string): string {
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", "read:user user:email");
  u.searchParams.set("state", state);
  return u.toString();
}

export async function exchangeCode(env: Env, code: string, redirectUri: string): Promise<string> {
  const res = await githubFetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) throw new AppError("auth_unavailable", "github token exchange failed");
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new AppError("auth_unavailable", "github returned no token");
  return body.access_token;
}

export interface GithubUser {
  readonly id: string;
  readonly login: string;
  readonly name: string | null;
  readonly avatarUrl: string;
  readonly email: string | null;
}

interface GithubEmail {
  readonly email: string;
  readonly primary: boolean;
  readonly verified: boolean;
}

function primaryVerifiedEmail(emails: readonly GithubEmail[]): string | null {
  const usable = emails.filter((x) => x.verified && x.email);
  return (usable.find((x) => x.primary) ?? usable[0])?.email ?? null;
}

export async function fetchGithubUser(token: string): Promise<GithubUser> {
  const headers = { ...GITHUB_HEADERS, authorization: `Bearer ${token}` };
  const [userRes, emailRes] = await Promise.all([
    githubFetch("https://api.github.com/user", { headers }),
    githubFetch("https://api.github.com/user/emails", { headers }),
  ]);
  if (!userRes.ok) throw new AppError("auth_unavailable", "github user fetch failed");
  const user = (await userRes.json()) as {
    id: number;
    login: string;
    name: string | null;
    avatar_url: string;
  };
  const emails = emailRes.ok ? ((await emailRes.json()) as GithubEmail[]) : [];
  return {
    id: String(user.id),
    login: user.login,
    name: user.name,
    avatarUrl: user.avatar_url,
    email: primaryVerifiedEmail(emails),
  };
}
