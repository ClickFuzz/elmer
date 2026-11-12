/// <reference types="jest" />
import Purchases, { PURCHASES_ERROR_CODE } from 'react-native-purchases';
import {
  initPurchases,
  switchPurchasesUser,
  logOutPurchases,
  purchaseSubscription,
  restorePurchases,
  _resetModule,
} from '../services/purchases';

jest.mock('react-native-purchases', () => ({
  __esModule: true,
  default: {
    configure: jest.fn(),
    getAppUserID: jest.fn(),
    logIn: jest.fn(),
    logOut: jest.fn(),
    setEmail: jest.fn(),
    setLogLevel: jest.fn(),
    getOfferings: jest.fn(),
    purchasePackage: jest.fn(),
    restorePurchases: jest.fn(),
  },
  LOG_LEVEL: { DEBUG: 'debug' },
  PURCHASES_ERROR_CODE: { PURCHASE_CANCELLED_ERROR: 'PURCHASE_CANCELLED_ERROR' },
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

const mp = Purchases as unknown as Record<string, jest.Mock>;
const mockPkg = { identifier: '$rc_monthly' };
const CANCELLED = PURCHASES_ERROR_CODE.PURCHASE_CANCELLED_ERROR;

beforeEach(() => {
  jest.clearAllMocks();
  _resetModule();

  mp.getAppUserID.mockResolvedValue('1');
  mp.logIn.mockResolvedValue({});
  mp.logOut.mockResolvedValue(undefined);
  mp.setEmail.mockResolvedValue(undefined);
  mp.getOfferings.mockResolvedValue({ current: { availablePackages: [mockPkg] } });
  mp.purchasePackage.mockResolvedValue({});
  mp.restorePurchases.mockResolvedValue({ entitlements: { active: {} } });
});

// ── purchaseSubscription identity guard ────────────────────────────────────

describe('purchaseSubscription', () => {
  test('blocks when RC SDK is not configured', async () => {
    // _resetModule() left _configured = false; don't call initPurchases
    const result = await purchaseSubscription();
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('not available') });
    expect(mp.purchasePackage).not.toHaveBeenCalled();
  });

  test('blocks when no user is signed in', async () => {
    initPurchases(null);
    const result = await purchaseSubscription();
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('sign in') });
    expect(mp.purchasePackage).not.toHaveBeenCalled();
  });

  test('succeeds without calling logIn when RC identity already matches', async () => {
    initPurchases('1');
    mp.getAppUserID.mockResolvedValue('1');
    const result = await purchaseSubscription();
    expect(mp.logIn).not.toHaveBeenCalled();
    expect(result).toEqual({ success: true });
  });

  test('calls logIn to sync identity when RC App User ID does not match, then purchases', async () => {
    initPurchases('1');
    mp.getAppUserID.mockResolvedValue('$RCAnonymousID:xyz');
    const result = await purchaseSubscription();
    expect(mp.logIn).toHaveBeenCalledWith('1');
    expect(mp.purchasePackage).toHaveBeenCalled();
    expect(result).toEqual({ success: true });
  });

  test('blocks purchase when RC logIn fails (network or auth error)', async () => {
    initPurchases('1');
    mp.getAppUserID.mockResolvedValue('$RCAnonymousID:xyz');
    mp.logIn.mockRejectedValue(new Error('Network error'));
    const result = await purchaseSubscription();
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('sync') });
    expect(mp.purchasePackage).not.toHaveBeenCalled();
  });

  test('blocks purchase when account changes during RC logIn (generation guard)', async () => {
    initPurchases('1');
    mp.getAppUserID.mockResolvedValue('$RCAnonymousID:xyz');
    mp.logIn.mockImplementation(async () => {
      // Simulate user signing out on another screen while logIn is in flight
      await logOutPurchases();
    });
    const result = await purchaseSubscription();
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('account changed') });
    expect(mp.purchasePackage).not.toHaveBeenCalled();
  });

  test('returns cancelled when user dismisses StoreKit sheet', async () => {
    initPurchases('1');
    mp.getAppUserID.mockResolvedValue('1');
    mp.purchasePackage.mockRejectedValue({ code: CANCELLED, message: 'User cancelled' });
    const result = await purchaseSubscription();
    expect(result).toEqual({ success: false, cancelled: true });
  });

  test('returns error message on non-cancellation purchase failure', async () => {
    initPurchases('1');
    mp.getAppUserID.mockResolvedValue('1');
    mp.purchasePackage.mockRejectedValue({ code: 'STORE_PROBLEM', message: 'Payment method declined' });
    const result = await purchaseSubscription();
    expect(result).toEqual({ success: false, error: 'Payment method declined' });
  });

  test('returns fallback error message when purchase error has no message', async () => {
    initPurchases('1');
    mp.getAppUserID.mockResolvedValue('1');
    mp.purchasePackage.mockRejectedValue({});
    const result = await purchaseSubscription();
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('Purchase failed') });
  });

  test('returns error when no packages are available', async () => {
    initPurchases('1');
    mp.getAppUserID.mockResolvedValue('1');
    mp.getOfferings.mockResolvedValue({ current: { availablePackages: [] } });
    const result = await purchaseSubscription();
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('No subscription packages') });
  });

  test('calls setEmail after successful identity sync', async () => {
    initPurchases('1', 'user@example.com');
    mp.getAppUserID.mockResolvedValue('$RCAnonymousID:xyz'); // force logIn path
    await purchaseSubscription();
    expect(mp.setEmail).toHaveBeenCalledWith('user@example.com');
  });

  test('does not call setEmail when no email was provided', async () => {
    initPurchases('1');
    mp.getAppUserID.mockResolvedValue('$RCAnonymousID:xyz');
    await purchaseSubscription();
    expect(mp.setEmail).not.toHaveBeenCalled();
  });
});

// ── restorePurchases identity guard ───────────────────────────────────────

describe('restorePurchases', () => {
  test('blocks restore when no user is signed in', async () => {
    initPurchases(null);
    const result = await restorePurchases();
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('sign in') });
    expect(mp.restorePurchases).not.toHaveBeenCalled();
  });

  test('applies identity guard: calls logIn when RC identity mismatches before restore', async () => {
    initPurchases('1');
    mp.getAppUserID.mockResolvedValue('$RCAnonymousID:stale');
    await restorePurchases();
    expect(mp.logIn).toHaveBeenCalledWith('1');
    expect(mp.restorePurchases).toHaveBeenCalled();
  });

  test('returns hasEntitlement true when entitlement is active', async () => {
    initPurchases('1');
    mp.getAppUserID.mockResolvedValue('1');
    mp.restorePurchases.mockResolvedValue({
      entitlements: { active: { 'elmer-post-everywhere': { isActive: true } } },
    });
    const result = await restorePurchases();
    expect(result).toEqual({ success: true, hasEntitlement: true });
  });

  test('returns hasEntitlement false when no active entitlement found', async () => {
    initPurchases('1');
    mp.getAppUserID.mockResolvedValue('1');
    // default mock has empty active entitlements
    const result = await restorePurchases();
    expect(result).toEqual({ success: true, hasEntitlement: false });
  });

  test('returns error on RC SDK failure', async () => {
    initPurchases('1');
    mp.getAppUserID.mockResolvedValue('1');
    mp.restorePurchases.mockRejectedValue({ message: 'Restore failed' });
    const result = await restorePurchases();
    expect(result).toEqual({ success: false, error: 'Restore failed' });
  });
});

// ── identity state management ─────────────────────────────────────────────

describe('identity state management', () => {
  test('switchPurchasesUser calls RC logIn with new userId', async () => {
    initPurchases('1');
    await switchPurchasesUser('2', 'user2@example.com');
    expect(mp.logIn).toHaveBeenCalledWith('2');
  });

  test('switchPurchasesUser calls setEmail after logIn', async () => {
    initPurchases('1');
    await switchPurchasesUser('2', 'user2@example.com');
    expect(mp.setEmail).toHaveBeenCalledWith('user2@example.com');
  });

  test('after logOutPurchases, purchaseSubscription is blocked (no signed-in user)', async () => {
    initPurchases('1');
    await logOutPurchases();
    mp.getAppUserID.mockResolvedValue('$RCAnonymousID:new');
    const result = await purchaseSubscription();
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('sign in') });
    expect(mp.purchasePackage).not.toHaveBeenCalled();
  });

  test('after logOutPurchases, restorePurchases is blocked', async () => {
    initPurchases('1');
    await logOutPurchases();
    const result = await restorePurchases();
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('sign in') });
  });

  test('switching to a new user and purchasing uses the new userId for RC identity', async () => {
    initPurchases('1');
    await switchPurchasesUser('2');
    mp.getAppUserID.mockResolvedValue('$RCAnonymousID:xyz');
    mp.logIn.mockClear();
    await purchaseSubscription();
    expect(mp.logIn).toHaveBeenCalledWith('2'); // guard uses userId '2', not '1'
  });

  test('RC SDK is not re-initialized on subsequent initPurchases calls (SDK already configured)', async () => {
    initPurchases('1');
    const configureCallCount = mp.configure.mock.calls.length;
    initPurchases('1'); // second call — SDK already running
    expect(mp.configure).toHaveBeenCalledTimes(configureCallCount); // no extra configure
  });
});
