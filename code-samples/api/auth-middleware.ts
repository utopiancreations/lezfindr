// Excerpt: src/middleware/auth.ts (Cloudflare Workers API)
//
// Firebase stayed as the identity provider after the Firebase→Postgres
// migration, but token verification moved to the edge: the Worker validates
// Firebase ID tokens itself with `jose` instead of calling Firebase per
// request. Warm-path cost of auth: zero network I/O.

import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";

// Correct JWKS endpoint (JSON Web Key Set format — NOT the X.509 cert
// endpoint that most Firebase docs point at, which `jose` can't consume).
const FIREBASE_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

// Module-scope singleton: survives across requests within a Worker isolate.
let _remoteJWKS: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJWKS() {
  // createRemoteJWKSet fetches lazily, caches in memory, and refetches on
  // key rotation (unknown `kid`) automatically. An earlier iteration cached
  // the JWKS in Cloudflare KV; jose's built-in caching made that layer
  // redundant, so it was deleted — less code, same I/O profile.
  if (!_remoteJWKS) {
    _remoteJWKS = createRemoteJWKSet(new URL(FIREBASE_JWKS_URL));
  }
  return _remoteJWKS;
}

export const authMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (
  c,
  next,
) => {
  // WebSocket upgrades can't carry an Authorization header; their token
  // travels as a query param and is verified by the Durable Object itself
  // (see chat-room.ts). Don't double-verify here.
  if (c.req.header("Upgrade") === "websocket") {
    return await next();
  }

  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or malformed Authorization header" }, 401);
  }

  const token = authHeader.slice(7);
  const projectId = c.env.FIREBASE_PROJECT_ID;

  try {
    const { payload } = await jwtVerify(token, getJWKS(), {
      // Issuer + audience pinning: a validly-signed token from a DIFFERENT
      // Firebase project fails here. Signature alone is not identity.
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
    });

    c.set("user", {
      uid: payload.sub as string,
      email: payload.email as string | undefined,
      emailVerified: (payload as Record<string, unknown>).email_verified === true,
      // Accept either claim spelling: the admin panel's Cloud Functions treat
      // `isAdmin === true || admin === true` as admin, and Firebase's
      // setCustomUserClaims REPLACES all claims — so an account can end up
      // with only one of the two. The Worker previously checked `admin`
      // alone, which silently 403'd accounts the panel itself considered
      // admins. Lesson learned: custom claims are a distributed-consistency
      // surface, not a config file.
      admin:
        (payload as Record<string, unknown>).admin === true ||
        (payload as Record<string, unknown>).isAdmin === true,
      business: (payload as Record<string, unknown>).userRole === "business",
      firebase:
        (payload as JWTPayload & { firebase: { sign_in_provider: string } })
          .firebase,
    });

    return await next();
  } catch (err) {
    // Log the detail server-side; the client gets a generic 401 (verification
    // failure reasons are useful to attackers, useless to users).
    console.error("[Auth] JWT verification failed:", err);
    return c.json({ error: "Unauthorized — invalid or expired token" }, 401);
  }
};
