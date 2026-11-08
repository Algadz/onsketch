// Supabase project the editor talks to. Both values are public by design:
// the publishable (anon) key only grants what the row-level security
// policies in supabase/migrations/ allow. Leave them empty and the editor
// works exactly as before (browser storage only, no account UI).
export const SUPABASE_URL = '';
export const SUPABASE_KEY = '';
