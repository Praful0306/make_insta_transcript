// Owner-only: give a customer paid access by hand (before Razorpay is connected, or for refunds/gifts).
//   LIBRARY_DATABASE_URL=postgresql://... node scripts/grant-access.mjs someone@example.com 30
//   ...                                     node scripts/grant-access.mjs someone@example.com 0     (ends access now)
// FIREBASE_PROJECT_ID must be set too because the library module checks its configuration on load.
import { libraryDb, grantByEmail } from "../api/_library.js";
const [email, daysArg] = process.argv.slice(2);
const days = Number(daysArg);
if (!email || !email.includes("@") || !Number.isFinite(days) || days < 0 || days > 3660) {
  console.error("Usage: node scripts/grant-access.mjs <email> <days 0-3660>"); process.exit(1);
}
const q = await libraryDb();
const periodEnd = new Date(Date.now() + days * 86400000).toISOString();
await grantByEmail(q, email.toLowerCase(), { periodEnd, source: "manual" });
console.log(days === 0 ? `Access for ${email} ends now.` : `${email} has access until ${periodEnd.slice(0, 10)}.`);
