import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import NanitCameraPlugin from './main';

// Mock axios entirely -- no real network calls, no real Nanit credentials ever touched.
vi.mock('axios', () => ({
    default: {
        get: vi.fn(),
        post: vi.fn(),
    },
}));

const mockedAxios = axios as unknown as { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };

/**
 * Builds a minimal in-memory settings storage that mimics
 * @scrypted/sdk's StorageSettings getItem/putSetting surface,
 * which is all tryLogin() touches.
 */
function createFakeStorage(initial: Record<string, any> = {}) {
    const store: Record<string, any> = { ...initial };
    return {
        store,
        getItem: vi.fn((key: string) => store[key]),
        putSetting: vi.fn((key: string, value: any) => {
            store[key] = value;
        }),
        getSettings: vi.fn(async () => []),
    };
}

/**
 * Builds a "this"-like object bound to the real NanitCameraPlugin.prototype
 * methods (tryLogin, clearAndLogin, getSettings), without running the real
 * constructor (which would eagerly call syncDevices()/tryLogin() against
 * @scrypted/sdk's live deviceManager -- unavailable outside a real Scrypted
 * host). This exercises the exact production tryLogin() code path.
 */
function createPluginHarness(storageInitial: Record<string, any> = {}) {
    const settingsStorage = createFakeStorage(storageInitial);
    const consoleLog = vi.fn();

    const harness: any = {
        console: { log: consoleLog },
        settingsStorage,
        access_token: '',
        mfa_token: '',
        failedCount: 0,
        getSettings: (NanitCameraPlugin.prototype as any).getSettings,
        tryLogin: (NanitCameraPlugin.prototype as any).tryLogin,
        clearAndLogin: (NanitCameraPlugin.prototype as any).clearAndLogin,
        clearAndTrySyncDevices: (NanitCameraPlugin.prototype as any).clearAndTrySyncDevices,
        syncDevices: vi.fn(), // not under test here
    };

    return { harness, settingsStorage, consoleLog };
}

describe('NanitCameraPlugin.tryLogin', () => {
    beforeEach(() => {
        mockedAxios.get.mockReset();
        mockedAxios.post.mockReset();
    });

    it('throws when email/password are not configured', async () => {
        const { harness } = createPluginHarness({});

        await expect(harness.tryLogin()).rejects.toThrow('Email and password required');
        expect(mockedAxios.get).not.toHaveBeenCalled();
        expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    describe('branch: stored token valid and verified', () => {
        it('confirms the stored access token via /babies and resets failedCount', async () => {
            const future = Date.now() + 1000 * 60 * 60;
            const { harness, settingsStorage } = createPluginHarness({
                email: 'parent@example.com',
                password: 'hunter2',
                access_token: 'valid-token',
                expiration: future,
            });
            harness.failedCount = 1;

            mockedAxios.get.mockResolvedValueOnce({ status: 200, data: { babies: [] } });

            await harness.tryLogin();

            expect(mockedAxios.get).toHaveBeenCalledWith(
                'https://api.nanit.com/babies',
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer valid-token',
                    }),
                }),
            );
            expect(harness.failedCount).toBe(0);
            expect(mockedAxios.post).not.toHaveBeenCalled();
            // no token mutation should occur on a simple successful verification
            expect(settingsStorage.putSetting).not.toHaveBeenCalled();
        });
    });

    describe('branch: stored token 401 -> retry via clearAndLogin', () => {
        it('clears tokens and retries login when the verification call returns 401 and failedCount < 2', async () => {
            const future = Date.now() + 1000 * 60 * 60;
            const { harness, settingsStorage } = createPluginHarness({
                email: 'parent@example.com',
                password: 'hunter2',
                access_token: 'stale-token',
                expiration: future,
            });
            harness.failedCount = 0;

            mockedAxios.get.mockResolvedValueOnce({ status: 401, data: {} });
            // isolate the retry branch: stub clearAndLogin so we assert it was
            // invoked correctly without recursing into a fresh login flow.
            const clearAndLoginSpy = vi.fn().mockResolvedValue(undefined);
            harness.clearAndLogin = clearAndLoginSpy;

            await harness.tryLogin();

            expect(harness.failedCount).toBe(1);
            expect(clearAndLoginSpy).toHaveBeenCalledTimes(1);
        });

        it('rejects when 401 persists and failedCount is already >= 2', async () => {
            // The "Exceeded fail count" Promise.reject() thrown inside the .then()
            // handler is itself caught by the chained .catch() below it: since the
            // rejection value is a bare string (no `.response` property), the
            // catch's `error.response?.status == 401` check is false, so it falls
            // through to `throw new Error("Failed to authenticate")`. This is the
            // actual (if surprising) production behavior of the promise chain.
            const future = Date.now() + 1000 * 60 * 60;
            const { harness } = createPluginHarness({
                email: 'parent@example.com',
                password: 'hunter2',
                access_token: 'stale-token',
                expiration: future,
            });
            harness.failedCount = 2;

            mockedAxios.get.mockResolvedValueOnce({ status: 401, data: {} });

            await expect(harness.tryLogin()).rejects.toThrow('Failed to authenticate');
        });

        it('clearAndLogin resets access_token, persists it, and re-invokes tryLogin', async () => {
            const { harness, settingsStorage } = createPluginHarness({
                email: 'parent@example.com',
                password: 'hunter2',
            });
            harness.access_token = 'stale-token';

            // clearAndLogin -> tryLogin('') with no email/password path already covered;
            // here email/password ARE set, so it will fall through to the login flow.
            mockedAxios.post.mockResolvedValueOnce({ data: { mfa_token: undefined } });

            await harness.clearAndLogin();

            expect(harness.access_token).toBe('');
            expect(settingsStorage.putSetting).toHaveBeenCalledWith('access_token', '');
            expect(mockedAxios.post).toHaveBeenCalledWith(
                'https://api.nanit.com/login',
                { email: 'parent@example.com', password: 'hunter2' },
                expect.anything(),
            );
        });
    });

    describe('branch: refresh-token flow', () => {
        it('exchanges a stored refresh_token for a fresh access token', async () => {
            const { harness, settingsStorage } = createPluginHarness({
                email: 'parent@example.com',
                password: 'hunter2',
                refresh_token: 'refresh-abc',
                // no access_token/expiration -> falls through to refresh-token branch
            });
            harness.failedCount = 1;

            mockedAxios.post.mockResolvedValueOnce({
                data: { access_token: 'new-access-token', refresh_token: 'new-refresh-token' },
            });

            await harness.tryLogin();

            expect(mockedAxios.post).toHaveBeenCalledWith(
                'https://api.nanit.com/tokens/refresh',
                { refresh_token: 'refresh-abc' },
                expect.anything(),
            );
            expect(harness.access_token).toBe('new-access-token');
            expect(harness.failedCount).toBe(0);
            expect(settingsStorage.putSetting).toHaveBeenCalledWith('access_token', 'new-access-token');
            expect(settingsStorage.putSetting).toHaveBeenCalledWith('refresh_token', 'new-refresh-token');
            expect(settingsStorage.putSetting).toHaveBeenCalledWith('expiration', expect.any(Number));
        });

        it('logs but does not throw when the refresh call fails', async () => {
            const { harness } = createPluginHarness({
                email: 'parent@example.com',
                password: 'hunter2',
                refresh_token: 'refresh-abc',
            });

            mockedAxios.post.mockRejectedValueOnce(new Error('network blip'));

            await expect(harness.tryLogin()).resolves.toBeUndefined();
        });
    });

    describe('branch: email/password + MFA login flow', () => {
        it('performs the initial email/password login and captures the mfa_token (no code yet)', async () => {
            const { harness } = createPluginHarness({
                email: 'parent@example.com',
                password: 'hunter2',
            });

            mockedAxios.post.mockResolvedValueOnce({ data: { mfa_token: 'mfa-123' } });

            await harness.tryLogin();

            expect(mockedAxios.post).toHaveBeenCalledWith(
                'https://api.nanit.com/login',
                { email: 'parent@example.com', password: 'hunter2' },
                expect.anything(),
            );
            expect(harness.mfa_token).toBe('mfa-123');
        });

        it('captures mfa_token from a rejected initial login response (MFA required error)', async () => {
            const { harness } = createPluginHarness({
                email: 'parent@example.com',
                password: 'hunter2',
            });

            mockedAxios.post.mockRejectedValueOnce({
                response: { data: { mfa_token: 'mfa-456' } },
            });

            await harness.tryLogin();

            expect(harness.mfa_token).toBe('mfa-456');
        });

        it('completes login with email/password + mfa_token + code and stores the new tokens', async () => {
            const { harness, settingsStorage } = createPluginHarness({
                email: 'parent@example.com',
                password: 'hunter2',
            });
            harness.mfa_token = 'mfa-123';
            harness.failedCount = 1;

            mockedAxios.post.mockResolvedValueOnce({
                data: { access_token: 'final-access-token', refresh_token: 'final-refresh-token' },
            });

            await harness.tryLogin('654321');

            expect(mockedAxios.post).toHaveBeenCalledWith(
                'https://api.nanit.com/login',
                {
                    email: 'parent@example.com',
                    password: 'hunter2',
                    mfa_token: 'mfa-123',
                    mfa_code: '654321',
                },
                expect.anything(),
            );
            expect(harness.access_token).toBe('final-access-token');
            expect(harness.failedCount).toBe(0);
            expect(settingsStorage.putSetting).toHaveBeenCalledWith('access_token', 'final-access-token');
            expect(settingsStorage.putSetting).toHaveBeenCalledWith('refresh_token', 'final-refresh-token');
        });

        it('throws when the final mfa login call fails', async () => {
            const { harness } = createPluginHarness({
                email: 'parent@example.com',
                password: 'hunter2',
            });
            harness.mfa_token = 'mfa-123';

            mockedAxios.post.mockRejectedValueOnce(new Error('bad mfa code'));

            await expect(harness.tryLogin('000000')).rejects.toThrow('bad mfa code');
        });
    });
});
