import Purchases, { LOG_LEVEL, PURCHASES_ERROR_CODE } from 'react-native-purchases';
import { Platform } from 'react-native';

const RC_KEY_IOS = process.env.EXPO_PUBLIC_RC_API_KEY_IOS ?? '';
const RC_KEY_ANDROID = process.env.EXPO_PUBLIC_RC_API_KEY_ANDROID ?? '';

// RC dashboard: Offering = "default", Package = "$rc_monthly", Entitlement = "elmer-post-everywhere"
// Product: com.clickfuzz.elmer.monthly (Apple) / com.clickfuzz.elmer.monthly (Google Play TBD)
const MONTHLY_PACKAGE_ID = '$rc_monthly';
const ENTITLEMENT_ID = 'elmer-post-everywhere';

// ── Module-level identity state ────────────────────────────────────────────
// Tracks the current authenticated Elmer user. Updated on every login/logout.
// _identityGeneration is incremented on every identity change so that an async
// logIn() call can detect if the user switched accounts while it was in flight.

let _configured = false;
let _currentUserId: string | null = null;
let _currentEmail: string | null = null;
let _identityGeneration = 0;

// ── Identity guard ─────────────────────────────────────────────────────────
// Called before any purchase or restore. Verifies that the RC SDK is running
// under the authenticated Elmer user. If the RC App User ID has drifted
// (anonymous session, stale identity from a previous account), one logIn()
// attempt is made. If that also fails the purchase is not initiated.
//
// Why this matters: rc-verify-purchase queries RC for the authenticated Elmer
// user ID extracted from the Bearer token. If the purchase was processed under
// a different RC identity (anonymous or prior user), that query returns no
// entitlement even though Apple/Google charged the customer successfully.
async function _ensureIdentity(): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!_configured) {
    return { ok: false, error: 'In-app purchases are not available. Please restart the app and try again.' };
  }
  if (!_currentUserId) {
    return { ok: false, error: 'Please sign in to your Elmer account before purchasing.' };
  }

  const gen = _identityGeneration; // Capture before any await — detects mid-flight account switches.

  const currentRcId = await Purchases.getAppUserID();
  if (currentRcId === _currentUserId) {
    return { ok: true };
  }

  // RC identity doesn't match the authenticated Elmer user — attempt to sync.
  console.warn(`[Purchases] RC identity mismatch (current=${currentRcId}, expected=userId:${_currentUserId}) — attempting logIn`);

  try {
    await Purchases.logIn(_currentUserId);

    // Abort if the Elmer account changed while logIn() was awaited.
    if (_identityGeneration !== gen) {
      return { ok: false, error: 'Your account changed during purchase setup. Please try again.' };
    }

    if (_currentEmail) {
      Purchases.setEmail(_currentEmail).catch((err: unknown) => {
        console.warn('[Purchases] setEmail failed:', err instanceof Error ? err.message : String(err));
      });
    }

    console.log(`[Purchases] RC identity synchronized for userId:${_currentUserId}`);
    return { ok: true };
  } catch (err: unknown) {
    // Scrub any email-like strings from the log to avoid accidental PII exposure.
    const raw = err instanceof Error ? err.message : String(err);
    const sanitized = raw.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email]');
    console.warn(`[Purchases] RC logIn failed for userId:${_currentUserId}: ${sanitized}`);
    return {
      ok: false,
      error: 'Could not sync your account with the payment system. Please check your connection and try again.',
    };
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export function initPurchases(userId: string | null, email?: string): void {
  const apiKey = Platform.OS === 'ios' ? RC_KEY_IOS : RC_KEY_ANDROID;
  if (!apiKey) {
    // No key — RC not initialized. Expected in Expo Go and CI builds.
    console.log(`[Purchases] No RC API key for platform=${Platform.OS} — skipping (Expo Go / CI build)`);
    return;
  }

  _currentUserId = userId;
  _currentEmail = email ?? null;

  if (_configured) {
    // SDK already running — switch user identity without reinitializing.
    if (userId) {
      Purchases.logIn(userId).then(() => {
        if (email) {
          Purchases.setEmail(email).catch((err: unknown) => {
            console.warn('[Purchases] setEmail failed:', err instanceof Error ? err.message : String(err));
          });
        }
      }).catch((err: unknown) => {
        const raw = err instanceof Error ? err.message : String(err);
        console.warn(`[Purchases] initPurchases logIn failed for userId:${userId}: ${raw.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email]')}`);
      });
    }
    return;
  }

  if (__DEV__) Purchases.setLogLevel(LOG_LEVEL.DEBUG);
  Purchases.configure({ apiKey, appUserID: userId ?? undefined });
  _configured = true;
  console.log(`[Purchases] SDK configured; platform=${Platform.OS} userId=${userId ? 'set' : 'anonymous'}`);
}

// Call after sign-in to associate purchases with the authenticated user.
// Errors are logged — not thrown — because sign-in must succeed regardless of
// RC availability. The identity guard in purchaseSubscription/restorePurchases
// will catch any drift at purchase time and prompt the user to retry.
export async function switchPurchasesUser(userId: string, email?: string): Promise<void> {
  _currentUserId = userId;
  _currentEmail = email ?? null;
  _identityGeneration++;

  if (!_configured) return;
  try {
    await Purchases.logIn(userId);
    if (email) {
      Purchases.setEmail(email).catch((err: unknown) => {
        console.warn('[Purchases] setEmail failed:', err instanceof Error ? err.message : String(err));
      });
    }
  } catch (err: unknown) {
    const raw = err instanceof Error ? err.message : String(err);
    console.warn(`[Purchases] switchPurchasesUser logIn failed for userId:${userId}: ${raw.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email]')}`);
    // Non-fatal here: the identity guard will re-attempt logIn at purchase time.
  }
}

// Call on sign-out to revert RC to anonymous identity.
export async function logOutPurchases(): Promise<void> {
  _currentUserId = null;
  _currentEmail = null;
  _identityGeneration++;

  if (!_configured) return;
  try {
    await Purchases.logOut();
  } catch {
    // Non-fatal
  }
}

export type PurchaseResult =
  | { success: true }
  | { success: false; cancelled: true }
  | { success: false; cancelled?: false; error: string };

export async function purchaseSubscription(): Promise<PurchaseResult> {
  const identity = await _ensureIdentity();
  if (!identity.ok) {
    return { success: false, error: identity.error };
  }

  try {
    const offerings = await Purchases.getOfferings();
    const pkgs = offerings.current?.availablePackages ?? [];
    // Prefer the explicit $rc_monthly package; fall back to first available.
    const pkg = pkgs.find(p => p.identifier === MONTHLY_PACKAGE_ID) ?? pkgs[0];
    if (!pkg) {
      return { success: false, error: 'No subscription packages are available. Please try again later.' };
    }
    await Purchases.purchasePackage(pkg);
    return { success: true };
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string };
    if (e?.code === PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR) {
      return { success: false, cancelled: true };
    }
    return { success: false, error: e?.message ?? 'Purchase failed. Please try again.' };
  }
}

export type RestoreResult =
  | { success: true; hasEntitlement: boolean }
  | { success: false; error: string };

export async function restorePurchases(): Promise<RestoreResult> {
  const identity = await _ensureIdentity();
  if (!identity.ok) {
    return { success: false, error: identity.error };
  }

  try {
    const customerInfo = await Purchases.restorePurchases();
    const hasEntitlement = !!(customerInfo?.entitlements?.active?.[ENTITLEMENT_ID]);
    return { success: true, hasEntitlement };
  } catch (err: unknown) {
    const e = err as { message?: string };
    return { success: false, error: e?.message ?? 'Restore failed. Please try again.' };
  }
}

// ── Test utilities ─────────────────────────────────────────────────────────
// Resets all module-level state. Only for use in automated tests.
export function _resetModule(): void {
  _configured = false;
  _currentUserId = null;
  _currentEmail = null;
  _identityGeneration = 0;
}
