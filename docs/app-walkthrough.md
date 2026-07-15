# App Walkthrough

A screen-by-screen tour of LezFindr as shipped. (Store-listing frames; profile photos shown are demo content.)

---

## 1 · Discovery — "The whole room is sapphic"

<img src="../assets/screenshots/01_sapphic.png" width="320" alt="Discovery grid">

The home surface: a distance-ranked grid of nearby profiles, served by PostGIS geospatial queries. Everyone here is inside the community by design — women, trans, nonbinary, two-spirit, and bigender sapphic people. New members are badged, and the filter entry point sits top-right.

## 2 · Verification — "No catfish"

<img src="../assets/screenshots/02_verified.png" width="320" alt="No-catfishing policy gate">

Identity policy is enforced from the very first photo upload: an explicit no-catfishing agreement, backed by a liveness-checked verification flow and ArcFace face matching server-side ([how it works](trust-and-safety.md)). The second button is not decoration — declining the policy really does route to account deletion.

## 3 · Filters — "Filter for exactly her"

<img src="../assets/screenshots/03_filters.png" width="320" alt="Discovery filters">

Discovery filtering: age range, distance (with a worldwide toggle), gender identity, orientation, what she's looking for, and an activity-recency filter. Every filter compiles into SQL predicates on the discovery query — no client-side filtering of oversized responses.

## 4 · New members — "Fresh faces daily"

<img src="../assets/screenshots/04_new.png" width="320" alt="Newest members feed">

The *Newest Members* feed surfaces recent signups, with verified badges inline. The tab bar shows the app's two core surfaces: **Discover** (browse) and **Sparks** (lightweight interest signals).

## 5 · Online now — "Say hi while she's still up"

<img src="../assets/screenshots/05_online.png" width="320" alt="Recently active feed">

*Recently Active* ranks people by presence so conversations start while both people are around. Free users see house ads here (AdMob) — one of the gentle monetization surfaces; premium removes them.

## 6 · Flares — "Send a Flare. Get noticed."

<img src="../assets/screenshots/06_flares.png" width="320" alt="Flares community board">

**Flares** is a regional community board: a post reaches everyone within ~100 miles, with reactions and inline replies. It turns the app from pure 1:1 matching into a local community space — "who wants to grab a drink at El Rio?" is a different kind of opener than a swipe.

## 7 · Video calls — "Face-to-face before the date"

<img src="../assets/screenshots/07_video.png" width="320" alt="Incoming video call">

In-app 1:1 video calling (P2P WebRTC, signaled over the existing chat WebSocket) lets users vibe-check a match before sharing any real-world details. Voice-only calls use the same stack in audio mode. Safety framing is deliberate: meet face-to-face *in the app* first.

## 8 · Premium — "Less than a latte a month"

<img src="../assets/screenshots/08_premium.png" width="320" alt="Premium paywall">

One premium tier: ad-free, expanded discovery radius, see-who-liked-you, priority placement, and read receipts. Entitlements are granted exclusively by RevenueCat/Stripe webhooks server-side. Day passes and rewarded ads give free users honest paths to the same features — supporting an indie app without a hard paywall.

---

**More:** [Architecture](architecture.md) · [Backend](backend.md) · [Mobile app](mobile-app.md) · [Trust & safety](trust-and-safety.md)
