// Verifies Firebase Authentication ID tokens (Google sign-in and email/password) on the server.
// No service account is needed: tokens are checked against Google's public keys.
// Env: FIREBASE_PROJECT_ID (required), FIREBASE_API_KEY and FIREBASE_AUTH_DOMAIN (public, for the page).
import { createRemoteJWKSet, jwtVerify } from "jose";

const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
let keys = null;
export const useKeysForTests = set => { keys = set; };       // tests only: a local key set instead of Google's
export const firebaseConfigured = () => !!process.env.FIREBASE_PROJECT_ID;

export async function verifyFirebaseToken(token) {
  const project = process.env.FIREBASE_PROJECT_ID;
  if (!project) throw new Error("Firebase is not configured.");
  keys ||= createRemoteJWKSet(new URL(JWKS_URL), { cooldownDuration: 60000 });
  const { payload } = await jwtVerify(token, keys, { issuer: `https://securetoken.google.com/${project}`, audience: project, algorithms: ["RS256"] });
  if (!payload.sub || String(payload.sub).length > 128) throw new Error("Bad subject.");
  return {
    uid: String(payload.sub),
    email: typeof payload.email === "string" ? payload.email.toLowerCase() : null,
    emailVerified: payload.email_verified === true,
    provider: (payload.firebase && payload.firebase.sign_in_provider) || null,
  };
}
