// Display names for the fixed review themes (lib/reputation/tagging.ts THEMES).
// Kept dependency-free so client components can import it without pulling in
// the server-only modules that compute the insights.
export const THEME_LABEL: Record<string, string> = {
  punctuality: 'Punctuality', price_value: 'Price and value', communication: 'Communication', quality_of_work: 'Quality of work', cleanliness: 'Cleanliness',
  professionalism: 'Professionalism', scheduling: 'Scheduling', warranty_follow_up: 'Warranty and follow-up', emergency_response: 'Emergency response',
}
