// Excerpt: src/routes/discovery.ts (Cloudflare Workers API)
//
// The filterable "Nearby" feed — the core PostGIS query behind the discovery
// grid. Two things worth reading: the Null Island guard (a defensive fix for
// a whole class of client location bugs), and the WHERE clause, where every
// trust & safety gate lives in SQL so no ineligible profile can ever reach
// the response serializer.

import { Hono } from "hono";
import { getDb } from "../lib/db";
import type { Env } from "../types";

export const discoveryRoutes = new Hono<{ Bindings: Env }>();

/** Null-Island guard. A buggy client can send lat=0,lng=0 (e.g. iOS
 *  Geolocator's contested-permission sentinel, or a filter reload firing
 *  before GPS resolves). 0,0 sits in the Gulf of Guinea, so a distance query
 *  there surfaces West-African profiles first — which is how "why is my feed
 *  full of people 6,000 miles away?" bug reports happen. When we receive
 *  ~0,0, fall back to the user's last persisted location so the feed stays
 *  local regardless of client bugs. Server-side because old app builds stay
 *  in the wild for months. */
async function guardNullIsland(
  sql: ReturnType<typeof getDb>,
  userId: string,
  lat: number,
  lng: number,
): Promise<{ lat: number; lng: number }> {
  if (
    Number.isFinite(lat) && Number.isFinite(lng) &&
    Math.abs(lat) < 0.001 && Math.abs(lng) < 0.001
  ) {
    const [stored] = await sql`
      SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
      FROM user_profiles
      WHERE user_id = ${userId} AND location IS NOT NULL
    `;
    if (stored?.lat != null && stored?.lng != null) {
      return { lat: Number(stored.lat), lng: Number(stored.lng) };
    }
  }
  return { lat, lng };
}

// GET /api/v1/discovery/nearby?lat=X&lng=Y&limit=50&offset=0&radius_miles=250
// Optional filters: min_age, max_age, gender, orientation, looking_for,
// hide_passed, only_with_photos, last_active
discoveryRoutes.get("/nearby", async (c) => {
  const user = c.get("user");
  let lat = parseFloat(c.req.query("lat") ?? "");
  let lng = parseFloat(c.req.query("lng") ?? "");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50"), 100);
  const offset = Math.max(parseInt(c.req.query("offset") ?? "0"), 0);
  // 12,427 mi ≈ half Earth's circumference: "worldwide" as a radius value,
  // so one query shape serves both local and global browsing.
  const radiusMiles = Math.min(
    parseFloat(c.req.query("radius_miles") ?? "250"),
    12427,
  );
  const radiusMeters = radiusMiles * 1609.34;

  const minAge = c.req.query("min_age") ? parseInt(c.req.query("min_age")!) : null;
  const maxAge = c.req.query("max_age") ? parseInt(c.req.query("max_age")!) : null;
  const gender = c.req.query("gender") ?? null;
  const orientation = c.req.query("orientation") ?? null;
  const lookingFor = c.req.query("looking_for") ?? null;
  const hidePassed = c.req.query("hide_passed") === "true";
  const onlyWithPhotos = c.req.query("only_with_photos") === "true";
  const lastActiveFilter = c.req.query("last_active") ?? "all"; // all | 24h | week | month

  if (isNaN(lat) || isNaN(lng)) {
    return c.json({ error: "lat and lng are required query parameters" }, 400);
  }

  const sql = getDb(c.env.DATABASE_URL);
  ({ lat, lng } = await guardNullIsland(sql, user.uid, lat, lng));

  const lastActiveCutoff = lastActiveFilter === "24h"
    ? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    : lastActiveFilter === "week"
    ? new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    : lastActiveFilter === "month"
    ? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    : null;

  // Optional filters are compiled as (flag = 'no' OR predicate) guards — one
  // static, parameterized query shape for every filter combination. The
  // planner sees stable SQL, and there's no string-concatenated SQL anywhere.
  const requirePhoto = onlyWithPhotos ? "yes" : "no";
  const filterPassed = hidePassed ? "yes" : "no";
  const filterActive = lastActiveCutoff ? "yes" : "no";
  const activeCutoff = lastActiveCutoff ?? "1970-01-01T00:00:00Z";

  try {
    const rows = await sql`
      WITH blocked AS (
        -- Blocks hide BOTH directions: if either of us blocked the other,
        -- neither ever appears in the other's feed.
        SELECT blocked_id AS uid FROM user_blocks WHERE blocker_id = ${user.uid}
        UNION ALL
        SELECT blocker_id AS uid FROM user_blocks WHERE blocked_id = ${user.uid}
      ),
      passed AS (
        SELECT swiped_id AS uid FROM user_swipes
        WHERE swiper_id = ${user.uid} AND action = 'pass'
      )
      SELECT
        dp.user_id,
        dp.display_name,
        COALESCE(p.url, dp.main_photo_url) AS main_photo_url,
        dp.age,
        dp.gender_identity,
        dp.sexual_orientation,
        dp.looking_for,
        dp.is_verified,
        dp.is_premium,
        dp.last_active,
        dp.created_at,
        ROUND(
          (ST_Distance(
            dp.location::geography,
            ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography
          ) / 1609.34)::numeric,
          1
        )::float8 AS distance_miles
      FROM discovery_profiles dp
      -- Lateral join picks each profile's best PUBLIC, MODERATION-APPROVED
      -- photo. Private or unreviewed photos can never leak into discovery
      -- because the join itself can't see them.
      LEFT JOIN LATERAL (
        SELECT url FROM user_photos
        WHERE user_id = dp.user_id
          AND is_private = FALSE
          AND status IN ('approved', 'clean')
        ORDER BY is_primary DESC, display_order ASC
        LIMIT 1
      ) p ON TRUE
      WHERE dp.user_id             != ${user.uid}
        -- Safety gates, all server-side: banned/deleted/moderated-out
        -- profiles are structurally absent from every feed, not filtered
        -- by clients that might forget.
        AND dp.is_banned            = FALSE
        AND dp.is_verified          = TRUE
        AND dp.onboarding_completed = TRUE
        AND dp.account_status      NOT IN ('banned', 'deleted')
        AND dp.moderation_status   NOT IN ('banned', 'rejected')
        AND dp.profile_visibility   = 'public'
        AND dp.user_id NOT IN (SELECT uid FROM blocked)
        AND (${filterPassed} = 'no' OR dp.user_id NOT IN (SELECT uid FROM passed))
        AND (${requirePhoto} = 'no' OR p.url IS NOT NULL)
        AND (${filterActive} = 'no' OR dp.last_active >= ${activeCutoff}::timestamptz)
        -- The geospatial core: ST_DWithin on geography = true meters-on-the-
        -- globe radius search, backed by a GiST index — not a bounding-box
        -- or geohash approximation.
        AND ST_DWithin(
          dp.location::geography,
          ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
          ${radiusMeters}
        )
        AND (${minAge ?? 0} = 0 OR dp.age >= ${minAge ?? 0})
        AND (${maxAge ?? 0} = 0 OR dp.age <= ${maxAge ?? 99})
        -- Identity fields are arrays (people select multiple); filters use
        -- ANY() membership rather than equality.
        AND (${gender ?? ''} = '' OR ${gender ?? ''} = ANY(dp.gender_identity))
        AND (${orientation ?? ''} = '' OR ${orientation ?? ''} = ANY(dp.sexual_orientation))
        AND (${lookingFor ?? ''} = '' OR ${lookingFor ?? ''} = ANY(dp.looking_for))
      ORDER BY distance_miles ASC
      LIMIT ${limit}
      OFFSET ${offset}
    `;

    return c.json({
      users: rows,
      meta: {
        offset,
        limit,
        has_more: rows.length === limit,
        next_offset: offset + rows.length,
      },
    });
  } catch (err: unknown) {
    // Log the detail server-side; never return the raw SQL/exception string
    // to the client (it leaks column names, query shape, and input-validation
    // hints).
    console.error("[Discovery/nearby] SQL error:", err instanceof Error ? err.message : String(err));
    return c.json({ error: "Discovery query failed" }, 500);
  }
});
