/**
 * Google Maps Platform list prices this code accounts with (card #266), per
 * 1,000 billable requests, in USD. Checked on 2026-10-30 for spike #264:
 *
 * - Routes API computeRoutes, Pro SKU (TRAFFIC_AWARE with a departure time): $10
 * - Geocoding API: $5
 * - Places API Text Search, Pro SKU (name, address and location fields): $32
 *
 * Transit and walking routes do not ask for traffic and may bill at the
 * cheaper Essentials rate; they are counted at the Pro rate anyway, so the
 * recorded cost never comes in under the bill. Free monthly allowances are
 * shared across the whole billing account and are ignored here for the same
 * reason. Shared by the Worker (deploy/maps-proxy) and the box, so it uses
 * nothing but plain values.
 */
export type MapsCall = 'geocode' | 'route' | 'places'

export const USD_PER_1000: Readonly<Record<MapsCall, number>> = {
  route: 10,
  geocode: 5,
  places: 32,
}

/** One billable request's cost in micro-dollars (whole numbers, so totals never drift). */
export function microUsdFor(call: MapsCall): number {
  return Math.round((USD_PER_1000[call] * 1_000_000) / 1000)
}

export const microToUsd = (micro: number): number => Math.round(micro) / 1_000_000
