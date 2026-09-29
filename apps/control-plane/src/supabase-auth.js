import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";

/** Build a stateless server client; never persist a user's session in this shared instance. */
export function createSupabaseAuth({ url, anonKey, client } = {}) {
  if (!url && !anonKey) return null;
  if (typeof url !== "string" || typeof anonKey !== "string" || !anonKey) throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY must be configured together");
  let parsed;
  try { parsed = new URL(url); }
  catch { throw new Error("SUPABASE_URL must be a valid URL"); }
  if (parsed.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) throw new Error("SUPABASE_URL must use HTTPS outside local development");
  const baseUrl = parsed.origin;
  const authClient = client ?? createClient(baseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { fetch: withTimeout(fetch, 5000) },
    realtime: { transport: WebSocket },
  });

  return Object.freeze({
    provider: "supabase",
    clientConfig: Object.freeze({ url: baseUrl, anonKey }),
    async getUser(accessToken) {
      if (typeof accessToken !== "string" || accessToken.length < 20 || accessToken.length > 8192) return null;
      try {
        const { data, error } = await authClient.auth.getUser(accessToken);
        const user = data?.user;
        if (error || !user || typeof user.id !== "string" || !/^[0-9a-f-]{36}$/i.test(user.id) || typeof user.email !== "string" || !user.email_confirmed_at) return null;
        return { id: user.id, email: user.email };
      } catch { return null; }
    },
  });
}

function withTimeout(fetchImpl, timeoutMs) {
  return (input, init = {}) => fetchImpl(input, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
}
