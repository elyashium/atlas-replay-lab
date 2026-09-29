import { createClient } from "@supabase/supabase-js";

export function createSupabaseBrowserClient(config) {
  if (config?.provider !== "supabase" || typeof config.url !== "string" || typeof config.anonKey !== "string" || !config.anonKey) return null;
  return createClient(config.url, config.anonKey, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
      flowType: "pkce",
    },
  });
}
