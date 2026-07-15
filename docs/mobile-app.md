# Mobile App (Flutter)

A single Flutter codebase (~250k lines of Dart) shipping to iOS and Android, organized as **26 vertical feature modules** over a shared core.

## Architecture

```
lib/
├── core/           # DI (get_it), routing (go_router), theme, networking,
│                   #   push handling, remote config, analytics
├── shared/         # cross-feature models & services
└── features/       # vertical slices, each owning its UI + BLoCs + repos:
    auth · onboarding · discovery · matches · messaging · calls ·
    events · flares · sparks · profile · photo · verification ·
    subscription · settings · announcements · forms · referrals ·
    moderation · reporting · blocking · gamification · …
```

- **State management: BLoC.** Every feature exposes blocs/cubits; UI is a pure function of state. Async flows (uploads, calls, verification) are explicit state machines rather than ad-hoc futures.
- **Dependency injection: get_it.** Repositories and services are registered centrally, making features testable and swappable.
- **Navigation: go_router** with deep-link support — push notifications route to the exact conversation, announcement, or admin-action screen they reference.
- **API layer:** a thin typed client over the Cloudflare Workers API, attaching the Firebase ID token and handling refresh, retries, and error surfaces consistently.

## Feature highlights

### Video & voice calls (WebRTC)
1:1 calling implemented P2P with WebRTC: signaling rides the existing per-conversation WebSocket, media flows peer-to-peer with STUN/TURN fallback. Voice calls are the same stack in audio-only mode (`call_type: audio`) — one codebase, two products. Shipping this to real devices meant solving the long tail: native incoming-call UX on iOS and Android, banner-tap → call-screen bridging, hang-up teardown races, busy lockouts, and background-state audio sessions. Verified with cross-platform device testing (iPhone ↔ Pixel) in both directions.

### Verification with liveness
Onboarding photo verification uses on-device ML Kit face detection for a liveness gesture check, then a server-side face match against profile photos. The flow includes a graceful degradation path discovered the hard way: on some low-end Android devices ML Kit's detector can hang, so consecutive timeouts route the user to a manual-review path instead of a dead end — a fix that came from watching real-device behavior in an emerging-market device class.

### Messaging
Real-time chat with typing indicators, read receipts, photo messages, and **in-app voice memos** (record → waveform preview → send; stored as `.m4a` in R2). Conversations with banned or deleted accounts render a tombstone placeholder instead of breaking.

### Discovery & community
Distance-ranked discovery feeds (featured, new & nearby, recently active, online now) with rich filtering; **Flares**, a regional 100-mile community board with reactions and replies; **Sparks** for lightweight interest signals; events with RSVPs and business-venue check-ins.

### Monetization
RevenueCat-managed premium subscription, buyable day passes, and AdMob (interstitial + rewarded) for free users — with rewarded ads doubling as a feature-unlock currency. Paywall, win-back offers, and trial-expiry flows are all server-coordinated.

## Internationalization

Full app localization: **2,100+ ARB strings × 16 locales** (Arabic, German, English, Spanish, French, Hindi, Italian, Japanese, Korean, Dutch, Polish, Portuguese, Russian, Swedish, Turkish, Chinese), including RTL layout support. The migration from hard-coded strings to ARB was executed app-wide and verified per-locale.

## Release engineering

- **Scripted builds** for dev/prod, including an Android 16KB-page-size–compliant build required by Play Store policy.
- **Force-update gate:** minimum-required-build keys in Firebase Remote Config hard-block abandoned versions, keeping the server free to evolve.
- **Crash-driven releases:** Crashlytics triage feeds dedicated stabilization sprints (a top-8-crashes sprint is part of the release cadence); fleet version telemetry in the database shows adoption before server-side behavior flips.
- **Staged rollouts** on Google Play; phased release on the App Store — with the operating rule that nothing user-visible ships without a kill switch or a gate.
