/// <reference types="jest" />
import Purchases, { PURCHASES_ERROR_CODE } from 'react-native-purchases';
import {
  initPurchases,
  switchPurchasesUser,
  logOutPurchases,
  purchaseSubscription,
  restorePurchases,
  getMonthlyPackage,
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
    // RC reports anonymous before logIn; reports correct userId afterward (RC behavior post-logIn)
    mp.getAppUserID
      .mockResolvedValueOnce('$RCAnonymousID:xyz') // _ensureIdentity: mismatch → triggers logIn
      .mockResolvedValue('1');                      // final check after logIn
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

// ── purchaseSubscription — final identity check (getOfferings window) ────────

describe('purchaseSubscription — final identity check', () => {
  test('aborts purchase when account switches during getOfferings()', async () => {
    initPurchases('1');
    mp.getAppUserID.mockResolvedValue('1');
    mp.getOfferings.mockImplementation(async () => {
      await logOutPurchases(); // increments generation, clears userId
      return { current: { availablePackages: [mockPkg] } };
    });
    const result = await purchaseSubscription();
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('account changed') });
    expect(mp.purchasePackage).not.toHaveBeenCalled();
  });

  test('aborts purchase when RC identity drifts during getOfferings()', async () => {
    initPurchases('1');
    mp.getAppUserID
      .mockResolvedValueOnce('1')                       // _ensureIdentity fast path
      .mockResolvedValueOnce('$RCAnonymousID:drifted'); // final RC check
    const result = await purchaseSubscription();
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('account changed') });
    expect(mp.purchasePackage).not.toHaveBeenCalled();
  });

  test('aborts restore when RC identity drifts between guard and restore call', async () => {
    initPurchases('1');
    mp.getAppUserID
      .mockResolvedValueOnce('1')                       // _ensureIdentity fast path
      .mockResolvedValueOnce('$RCAnonymousID:drifted'); // final RC check in restorePurchases
    const result = await restorePurchases();
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('account changed') });
    expect(mp.restorePurchases).not.toHaveBeenCalled();
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
    mp.getAppUserID
      .mockResolvedValueOnce('$RCAnonymousID:stale') // _ensureIdentity: mismatch → triggers logIn
      .mockResolvedValue('1');                        // final check after logIn
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

// ── getMonthlyPackage ──────────────────────────────────────────────────────

describe('getMonthlyPackage', () => {
  // iOS StoreKit: free trial via introPrice.price === 0
  const freeTrialPkg = {
    identifier: '$rc_monthly',
    product: {
      priceString: '$19.99',
      introPrice: { price: 0, periodNumberOfUnits: 14, periodUnit: 'DAY', priceString: '$0.00', cycles: 1, period: 'P14D' },
      defaultOption: null,
    },
  };
  // No trial, no intro on either platform
  const noTrialPkg = {
    identifier: '$rc_monthly',
    product: { priceString: '€9.99', introPrice: null, defaultOption: null },
  };
  // Paid introductory offer (not a free trial) — introPrice.price > 0
  const paidIntroPkg = {
    identifier: '$rc_monthly',
    product: {
      priceString: '$19.99',
      introPrice: { price: 9.99, periodNumberOfUnits: 1, periodUnit: 'MONTH', priceString: '$9.99', cycles: 1, period: 'P1M' },
      defaultOption: null,
    },
  };
  // Android Google Play: free trial only in defaultOption.freePhase (introPrice may be null)
  const androidFreeTrialPkg = {
    identifier: '$rc_monthly',
    product: {
      priceString: '$19.99',
      introPrice: null,
      defaultOption: {
        freePhase: { billingPeriod: { unit: 'DAY', value: 14, iso8601: 'P14D' }, price: { amountMicros: 0, formatted: '$0.00', currencyCode: 'USD' } },
        introPhase: null,
        fullPricePhase: { billingPeriod: { unit: 'MONTH', value: 1, iso8601: 'P1M' }, price: { amountMicros: 19990000, formatted: '$19.99', currencyCode: 'USD' } },
      },
    },
  };
  // Android: no free trial (base plan only, no offers)
  const androidNoTrialPkg = {
    identifier: '$rc_monthly',
    product: {
      priceString: '$19.99',
      introPrice: null,
      defaultOption: { freePhase: null, introPhase: null, fullPricePhase: null },
    },
  };

  test('returns null when RC SDK is not configured', async () => {
    const result = await getMonthlyPackage();
    expect(result).toBeNull();
  });

  test('returns null when no packages are available', async () => {
    initPurchases('1');
    mp.getOfferings.mockResolvedValue({ current: { availablePackages: [] } });
    const result = await getMonthlyPackage();
    expect(result).toBeNull();
  });

  test('returns null when getOfferings throws', async () => {
    initPurchases('1');
    mp.getOfferings.mockRejectedValue(new Error('Network error'));
    const result = await getMonthlyPackage();
    expect(result).toBeNull();
  });

  test('returns localized price string from store product', async () => {
    initPurchases('1');
    mp.getOfferings.mockResolvedValue({ current: { availablePackages: [freeTrialPkg] } });
    const result = await getMonthlyPackage();
    expect(result?.priceString).toBe('$19.99');
  });

  test('detects free trial when introPrice.price is 0', async () => {
    initPurchases('1');
    mp.getOfferings.mockResolvedValue({ current: { availablePackages: [freeTrialPkg] } });
    const result = await getMonthlyPackage();
    expect(result?.hasFreeTrial).toBe(true);
    expect(result?.trialPeriodUnits).toBe(14);
    expect(result?.trialPeriodUnit).toBe('day');
  });

  test('reports no free trial when introPrice is null', async () => {
    initPurchases('1');
    mp.getOfferings.mockResolvedValue({ current: { availablePackages: [noTrialPkg] } });
    const result = await getMonthlyPackage();
    expect(result?.hasFreeTrial).toBe(false);
  });

  test('reports no free trial when introPrice.price is non-zero', async () => {
    initPurchases('1');
    mp.getOfferings.mockResolvedValue({ current: { availablePackages: [paidIntroPkg] } });
    const result = await getMonthlyPackage();
    expect(result?.hasFreeTrial).toBe(false);
  });

  test('returns non-USD localized price without alteration', async () => {
    initPurchases('1');
    mp.getOfferings.mockResolvedValue({ current: { availablePackages: [noTrialPkg] } });
    const result = await getMonthlyPackage();
    expect(result?.priceString).toBe('€9.99');
  });

  test('falls back to first available package when $rc_monthly is not found', async () => {
    initPurchases('1');
    const fallbackPkg = { identifier: 'custom_monthly', product: { priceString: '$9.99', introPrice: null, defaultOption: null } };
    mp.getOfferings.mockResolvedValue({ current: { availablePackages: [fallbackPkg] } });
    const result = await getMonthlyPackage();
    expect(result?.priceString).toBe('$9.99');
  });

  test('detects free trial via defaultOption.freePhase when introPrice is null (Android path)', async () => {
    initPurchases('1');
    mp.getOfferings.mockResolvedValue({ current: { availablePackages: [androidFreeTrialPkg] } });
    const result = await getMonthlyPackage();
    expect(result?.hasFreeTrial).toBe(true);
    expect(result?.trialPeriodUnits).toBe(14);
    expect(result?.trialPeriodUnit).toBe('day');
  });

  test('reports no free trial when defaultOption.freePhase is null and introPrice is null (Android base plan)', async () => {
    initPurchases('1');
    mp.getOfferings.mockResolvedValue({ current: { availablePackages: [androidNoTrialPkg] } });
    const result = await getMonthlyPackage();
    expect(result?.hasFreeTrial).toBe(false);
  });

  test('prefers introPrice free trial data over defaultOption.freePhase when both are present', async () => {
    initPurchases('1');
    const bothPkg = {
      identifier: '$rc_monthly',
      product: {
        priceString: '$19.99',
        introPrice: { price: 0, periodNumberOfUnits: 14, periodUnit: 'DAY', priceString: '$0.00', cycles: 1, period: 'P14D' },
        defaultOption: {
          freePhase: { billingPeriod: { unit: 'WEEK', value: 2, iso8601: 'P2W' }, price: { amountMicros: 0 } },
          introPhase: null,
        },
      },
    };
    mp.getOfferings.mockResolvedValue({ current: { availablePackages: [bothPkg] } });
    const result = await getMonthlyPackage();
    expect(result?.hasFreeTrial).toBe(true);
    // introPrice wins (iOS path checked first): 14 days, not 2 weeks
    expect(result?.trialPeriodUnits).toBe(14);
    expect(result?.trialPeriodUnit).toBe('day');
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
    mp.getAppUserID
      .mockResolvedValueOnce('$RCAnonymousID:xyz') // _ensureIdentity: mismatch → triggers logIn as '2'
      .mockResolvedValue('2');                      // final check after logIn
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
