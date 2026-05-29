import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

let client: SupabaseClient | null = null;

export function getSupabaseUrl(): string | null {
  return url?.trim() ? url.trim() : null;
}

export function getSupabaseAnonKey(): string | null {
  return anonKey?.trim() ? anonKey.trim() : null;
}

export function isSupabaseConfigured(): boolean {
  return Boolean(getSupabaseUrl() && getSupabaseAnonKey());
}

export function getSupabase(): SupabaseClient {
  if (!isSupabaseConfigured()) {
    throw new Error(
      "Missing Supabase config. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in dashboard/.env.",
    );
  }
  if (!client) {
    client = createClient(getSupabaseUrl()!, getSupabaseAnonKey()!, {
      auth: {
        detectSessionInUrl: true,
        flowType: "pkce",
        persistSession: true,
      },
    });
  }
  return client;
}

export function getAllowedEmailDomain(): string | null {
  const domain = import.meta.env.VITE_ALLOWED_EMAIL_DOMAIN as string | undefined;
  return domain?.trim() ? domain.trim().toLowerCase() : null;
}

export function isAllowedEmail(email: string | undefined | null): boolean {
  const domain = getAllowedEmailDomain();
  if (!domain) return true;
  const normalized = (email ?? "").trim().toLowerCase();
  return normalized.endsWith(`@${domain}`);
}
