import { createClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "node:crypto";

export interface DemoIdentity {
  userId: string;
  method: "supabase" | "shared-token" | "development";
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function bearerToken(request: Request): string {
  return request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";
}

export async function authenticateDemoRequest(request: Request): Promise<DemoIdentity | null> {
  const token = bearerToken(request);
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const supabaseKey = (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)?.trim();
  if (supabaseUrl && supabaseKey) {
    if (!token) return null;
    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await supabase.auth.getUser(token);
    return !error && data.user ? { userId: data.user.id, method: "supabase" } : null;
  }

  const required = process.env.LLMOVOICE_DEMO_ACCESS_TOKEN?.trim();
  if (required) return token && safeEqual(token, required)
    ? { userId: "shared-demo-user", method: "shared-token" }
    : null;
  if (process.env.NODE_ENV !== "production") return { userId: "local-demo-user", method: "development" };
  return null;
}
