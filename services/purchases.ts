import Purchases, { LOG_LEVEL, PURCHASES_ERROR_CODE } from 'react-native-purchases';
import { Platform } from 'react-native';

const RC_KEY_IOS = process.env.EXPO_PUBLIC_RC_API_KEY_IOS ?? '';
const RC_KEY_ANDROID = process.env.EXPO_PUBLIC_RC_API_KEY_ANDROID ?? '';

// RC dashboard: Offering = "default", Package = "$rc_monthly", Entitlement = "elmer-post-everywhere"
// Product: com.clickfuzz.elmer.monthly (Apple) / com.clickfuzz.elmer.monthly (Google Play TBD)
const MONTHLY_PACKAGE_ID = '$rc_monthly';
const ENTITLEMENT_ID = 'elmer-post-everywhere';

let _configured = false;

export function initPurchases(userId: string | null): void {
  const apiKey = Platform.OS === 'ios' ? RC_KEY_IOS : RC_KEY_ANDROID;
  if (!apiKey) {
    // No key — RC not initialized. Expected in Expo Go and CI builds.
    console.log(`[Purchases] No RC API key for platform=${Platform.OS} — skipping (Expo Go / CI build)`);
    return;
  }
  if (_configured) {
    // SDK already running — switch user identity without reinitializing.
    if (userId) Purchases.logIn(userId).catch(() => {});
    return;
  }
  if (__DEV__) Purchases.setLogLevel(LOG_LEVEL.DEBUG);
  Purchases.configure({ apiKey, appUserID: userId ?? undefined });
  _configured = true;
  console.log(`[Purchases] SDK configured; platform=${Platform.OS} userId=${userId ? 'set' : 'anonymous'}`);
}

// Call after sign-in to associate purchases with the authenticated user.
export async function switchPurchasesUser(userId: string): Promise<void> {
  if (!_configured) return;
  try {
    await Purchases.logIn(userId);
  } catch {
    // Non-fatal — entitlement verification is authoritative on the server via webhook.
  }
}

// Call on sign-out to revert RC to anonymous identity.
export async function logOutPurchases(): Promise<void> {
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
  if (!_configured) {
    console.warn(`[Purchases] purchaseSubscription called but SDK not configured; iOS key present=${!!RC_KEY_IOS} Android key present=${!!RC_KEY_ANDROID}`);
    return { success: false, error: 'In-app purchases are not available. Please restart the app and try again.' };
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

export function getPurchaseDiagnostics(): { configured: boolean; iosKeyPresent: boolean; iosKeyPrefix: string; androidKeyPresent: boolean; platform: string } {
  return {
    configured: _configured,
    iosKeyPresent: !!RC_KEY_IOS,
    iosKeyPrefix: RC_KEY_IOS ? RC_KEY_IOS.slice(0, 12) + '…' : '(empty)',
    androidKeyPresent: !!RC_KEY_ANDROID,
    platform: Platform.OS,
  };
}

export type RestoreResult =
  | { success: true; hasEntitlement: boolean }
  | { success: false; error: string };

export async function restorePurchases(): Promise<RestoreResult> {
  if (!_configured) {
    console.warn('[Purchases] restorePurchases called but SDK not configured');
    return { success: false, error: 'In-app purchases are not available. Please restart the app and try again.' };
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
