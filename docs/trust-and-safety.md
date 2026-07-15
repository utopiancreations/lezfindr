# Trust & Safety

Safety is the product. A dating app for a marginalized community lives or dies on whether users trust that the person on the other end is real, is who they say they are, and isn't there to exploit them. LezFindr's answer is a layered system: automated screening in the hot path, ML-assisted flagging, and human review for every consequential decision.

> Some operational specifics (thresholds, heuristics, escalation triggers) are deliberately omitted here — publishing them would help the people they're designed to stop.

## Identity verification

**"Verified or gone"** is the core policy: fake photos are a ban, not a warning.

The pipeline:

1. **Liveness check** — on-device face detection (ML Kit) drives a gesture-based liveness capture during onboarding, with a manual-review fallback for devices where the detector underperforms.
2. **Face match** — a server-side ArcFace embedding comparison between the liveness capture and profile photos produces a cosine similarity *score*, not a vibe. On labeled production data the matcher achieves **0.991 AUC**.
3. **Human review** — every verification lands in an admin queue with the evidence laid out; AI only flags, humans approve. Re-flagged accounts (e.g. photos changed after verification) re-enter the queue automatically and the user is notified in-app rather than silently losing status.

## The moderation engine

Content moderation runs on a **self-hosted, multi-model ML pipeline** on dedicated GPU hardware — no per-token API costs, no user content shipped to third-party LLM providers. It calls back into the platform API over service-token-authenticated endpoints.

The architecture bet, validated by measurement on production data: **small specialized models beat one big general VLM** for moderation tasks.

| Task | General VLM | Specialized model |
|---|---|---|
| Voice-transcript moderation | 57% of benign content auto-rejected | **7%** (small fine-tuned text classifier) |
| Photo NSFW | 20% false-positive rate | **6%** (ViT NSFW classifier) |
| Face match | prose ("moderate match") | **a calibrated score + threshold** (ArcFace) |

Modules: photo NSFW scoring, voice-message transcription (Whisper) + classification, face match / anti-spoofing for verification, and a log-anomaly watcher that surfaces new production error signatures. All of it is **fail-open by design** — moderation never blocks or slows the user-facing path.

## Anti-scam systems

Romance-scam pressure is real and geographically uneven. The response is friction and detection, not blanket geo-blocking (which was evaluated and rejected — it punishes legitimate users for their neighbors):

- **Tiered spam filtering** in the message hot path, plus per-sender fan-out limits that cap how many new conversations an account can spray.
- **Corridor friction** — graduated, tunable friction on statistically risky interaction patterns, with an escalation ladder that ends in silent restriction rather than a tip-off.
- **Server-tunable everything** — thresholds and levers live in app settings, adjustable in minutes without a client release.
- A data-driven insight along the way: verification and premium status turned out to be non-signals for scam likelihood, so they are deliberately *not* used to discriminate.

## Human-in-the-loop operations

A 25-page admin console (React + shadcn/ui) is the operational backbone:

- **Moderation center** — reports, photo queues, verification queue, spam review, voice-message review with an in-panel audio player.
- **Warnings & strikes** — user-facing: warned users get a blocking in-app acknowledgment with the reason, not a silent flag; appeals are a first-class flow.
- **Bans that degrade gracefully** — banned/deleted profiles tombstone in conversations instead of vanishing, and messaging pushes from restricted accounts are suppressed.
- **Evidence preservation** — flagged CSAM evidence is preserved in an isolated, restricted R2 sandbox bucket (no public access, TTL-purged, reachable only by admin moderation endpoints) to support lawful reporting while minimizing retention.
- **ML quality dashboards** — precision/recall tracking on the automated flags, so model drift is visible before it becomes a user-facing problem.

## Privacy posture

- Location is stored as coordinates for distance math but exposed to other users only as distance/region — never a pin.
- A "private" visibility mode allows stealth browsing (no online badge, no recently-active surfacing).
- Voice messages live for the life of the conversation with a hard retention backstop purging orphaned audio from storage.
- Media access is authenticated; user photos are not enumerable.
