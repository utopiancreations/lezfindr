# Backend

The entire backend is **one Cloudflare Worker**: a Hono (TypeScript) application with 28 route modules, a Durable Object class for real-time messaging, cron-triggered background jobs, and bindings to Neon Postgres, R2, and KV. One artifact, deployed globally in seconds with `wrangler deploy`, tested with vitest.

## API design

```
src/
├── routes/            # 28 modules: profiles, discovery, swipes, matches,
│                      #   messages, calls, events, businesses, verifications,
│                      #   media, payments, referrals, flares, forms, admin, …
├── middleware/        # auth (Firebase JWT), rate limiting
├── durable-objects/   # ChatRoom — WebSocket rooms + call signaling
├── lib/               # shared utilities (+ unit tests)
└── index.ts           # router assembly, CORS, cron dispatch
```

**Authentication.** Every `/api/v1/*` request carries a Firebase ID token. The Worker verifies it at the edge — JWKS fetched from Google, cached in KV, signature/issuer/audience validated with `jose` — with zero calls to Firebase per request in the warm path. Custom claims (`admin`, `business`) gate role-restricted routes. Service-to-service callers (webhooks, the ML moderation runner) authenticate on separate mounts with their own shared-secret/service-token schemes, deliberately isolated from user auth.

**Authorization hygiene.** Entitlements (premium, day passes) are written only by payment webhooks and admin actions, and read from Postgres on every gated request — the client is never trusted about its own tier. Admin endpoints double-check the role claim server-side, and moderation-sensitive routes were hardened in a dedicated security pass.

## Geospatial discovery (PostGIS)

Profiles and businesses store `geography(Point, 4326)` columns. Every discovery surface is a variation of one indexed pattern:

```sql
SELECT p.*, ST_Distance(p.geo, $me) AS distance_m
FROM   user_profiles p
WHERE  ST_DWithin(p.geo, $me, $radius_m)
  AND  p.onboarding_completed
  AND  NOT EXISTS (SELECT 1 FROM blocks b WHERE …)
ORDER  BY distance_m;
```

That single capability powers: *New & Nearby*, *Recently Active*, *Featured*, event radius search, business geofences (check-in perks), and the regional community board (a 100-mile "Flares" feed). Filters (age range, gender identity, orientation, online-within window, photo-only) compose as SQL predicates — no application-side filtering of oversized result sets.

## Real-time: Durable Objects

Each conversation maps to a **ChatRoom Durable Object** — a single-threaded, stateful instance that owns the live WebSocket connections for that room. Design points:

- **Auth before state.** The Worker verifies the WebSocket token in the HTTP handler and only then forwards the upgrade to the DO — the object never processes an unauthenticated socket.
- **Messaging features:** delivery/read receipts, typing indicators, media messages (photos, voice memos recorded in-app → `.m4a` in R2), tombstone handling so conversations with banned/deleted users degrade gracefully instead of vanishing.
- **Call signaling on the same channel.** WebRTC offer/answer/ICE for 1:1 video and voice calls rides the existing per-conversation socket — no separate signaling infrastructure. The call model (`call_type: video | audio`) adds ring/answer/decline/timeout states and a 409-based busy lockout so a user can't be double-called.
- **Moderation hooks in the hot path** — messages pass spam heuristics and per-sender fan-out limits before fan-out (see [trust & safety](trust-and-safety.md)), designed fail-open so moderation never takes chat down.

## Scheduled work

Cron triggers dispatch inside the same Worker to background jobs:

- **Engagement notifications** — push for matches, likes, admin actions (photo approval, gift passes, unbans…).
- **Lifecycle jobs** — trial expiry, subscription reconciliation, win-back offers.
- **Data retention** — voice-message R2 backstop purge (12-month), moderation-evidence TTL purge, orphaned-media cleanup.
- **Daily maintenance** — stats rollups, stale-data cleanup.

## Payments

Two rails, unified server-side:

- **RevenueCat** for app-store subscriptions (iOS/Android IAP) — webhooks grant/revoke the premium entitlement in Postgres.
- **Stripe** for web checkout and business billing — signature-verified webhooks with the same entitlement writeback.

Buyable **day passes** and **rewarded-ad unlocks** complement the subscription so free users always have a path to feature access; all grants converge on the same server-side entitlement record.

## Media pipeline

Uploads flow through the Worker into **R2** (photos, voice messages), served from a custom CDN domain with zero egress fees. Profile photos pass moderation before becoming publicly visible. A **separate, restricted R2 sandbox bucket** preserves flagged-content evidence for lawful reporting — no public access, no custom domain, TTL-purged by cron, readable only by admin moderation endpoints.

## Reliability

- **Backups (3-2-1):** Neon PITR (7 days) + protected snapshot branch + nightly `pg_dump` → R2 (30-day lifecycle) + offsite copies; written, tested restore runbook.
- **Migrations:** 54 versioned SQL files, applied deliberately (no auto-runner) — small blast radius per change, reviewed against the live schema.
- **Observability:** structured logs streamed via `wrangler tail`, plus a self-hosted log-anomaly loop that watches production logs and surfaces new error signatures in the admin panel.
- **Feature flags:** server-driven app settings let risky behavior (call availability, spam thresholds, discovery rules) change without a deploy — and get turned off fast if something goes wrong.
