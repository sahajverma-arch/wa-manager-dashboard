const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !/^https?:\/\//i.test(supabaseUrl.trim())) {
  throw new Error(
    "Invalid SUPABASE_URL. Set it to your project URL, for example https://<project-ref>.supabase.co",
  );
}

if (!supabaseServiceRoleKey) {
  throw new Error(
    "Missing SUPABASE_SERVICE_ROLE_KEY. Set it in .env before starting the backend.",
  );
}

function getJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

const jwtPayload = getJwtPayload(supabaseServiceRoleKey);
if (jwtPayload && jwtPayload.role !== "service_role") {
  throw new Error(
    `SUPABASE_SERVICE_ROLE_KEY is not a service role key. Detected role: ${jwtPayload.role}. Use the Supabase service_role key from Project Settings > API.`,
  );
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
    detectSessionInUrl: false,
  },
});

module.exports = { supabase };
