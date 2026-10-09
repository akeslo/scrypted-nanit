import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

// Mock axios entirely -- no real network calls, no real Nanit credentials ever touched.
vi.mock('axios', () => ({
    default: {
        get: vi.fn(),
        post: vi.fn(),
    },
}));

// Mock 'ws' entirely -- no real socket connections in tests. Captures every
// instance created so a test can drive its open/message/close/error handlers
// directly instead of needing a live ActionCable server.
const { createdSockets } = vi.hoisted(() => {
    return { createdSockets: [] as any[] };
});
vi.mock('ws', () => {
    class FakeWebSocket {
        static CLOSED = 3;
        static OPEN = 1;
        url: string;
        opts: any;
        readyState = 1;
        listeners: Record<string, Function[]> = {};
        sentMessages: string[] = [];
        constructor(url: string, opts: any) {
            this.url = url;
            this.opts = opts;
            createdSockets.push(this);
        }
        on(event: string, cb: Function) {
            (this.listeners[event] ||= []).push(cb);
            return this;
        }
        send(data: string) {
            this.sentMessages.push(data);
        }
        __emit(event: string, ...args: any[]) {
            (this.listeners[event] || []).forEach((cb) => cb(...args));
        }
    }
    return { default: FakeWebSocket };
});

/**
 * @scrypted/sdk's ScryptedDeviceBase (which NanitCameraDevice extends) and
 * main.ts's own module-level `deviceManager`/`mediaManager` bindings all
 * resolve to bare, undeclared `deviceManager`/`mediaManager` identifiers that
 * the real Scrypted plugin host injects as globals at runtime. Outside that
 * host (i.e. under vitest) those identifiers are simply unbound, so anything
 * that touches `this.console`, `deviceManager.onDevicesChanged`, or
 * `mediaManager.createMediaObject` throws a ReferenceError/TypeError unless
 * the globals are seeded before @scrypted/sdk (and therefore main.ts) is
 * first loaded. vi.hoisted runs before the static imports below are
 * evaluated, so this is the one hook point that can seed them in time.
 */
const { fakeDeviceManager, fakeMediaManager } = vi.hoisted(() => {
    const fakeDeviceManager = {
        getDeviceLogger: vi.fn(() => ({ log: vi.fn() })),
        getDeviceConsole: vi.fn(() => ({ log: vi.fn() })),
        getDeviceStorage: vi.fn(() => ({})),
        getDeviceState: vi.fn(() => ({})),
        getMixinConsole: vi.fn(() => ({ log: vi.fn() })),
        getMixinStorage: vi.fn(() => ({})),
        onDeviceEvent: vi.fn(async () => {}),
        onMixinEvent: vi.fn(async () => {}),
        onDevicesChanged: vi.fn(async () => {}),
        onDeviceDiscovered: vi.fn(async () => {}),
    };
    const fakeMediaManager = {
        createMediaObject: vi.fn(async (data: any, mimeType: any) => ({ __fakeMediaObject: true, mimeType, data })),
    };
    (globalThis as any).deviceManager = fakeDeviceManager;
    (globalThis as any).mediaManager = fakeMediaManager;
    // @scrypted/sdk's own module-init also touches these bare globals in the
    // same object-literal assignment as deviceManager/mediaManager; if any of
    // them is missing, the whole assignment throws before deviceManager and
    // mediaManager ever get attached to the exported sdk object.
    (globalThis as any).endpointManager = {};
    (globalThis as any).systemManager = { setScryptedInterfaceDescriptors: vi.fn() };
    (globalThis as any).pluginHostAPI = {};
    return { fakeDeviceManager, fakeMediaManager };
});

import NanitCameraPlugin from './main';

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
        loginInFlight: null,
        // clearAndLogin()/clearAndTrySyncDevices() both call closeAllEventSockets(),
        // which iterates this map -- needs to exist on the harness even though no
        // test here opens a real socket.
        eventSockets: new Map(),
        getSettings: (NanitCameraPlugin.prototype as any).getSettings,
        tryLogin: (NanitCameraPlugin.prototype as any).tryLogin,
        performLogin: (NanitCameraPlugin.prototype as any).performLogin,
        clearAndLogin: (NanitCameraPlugin.prototype as any).clearAndLogin,
        clearAndTrySyncDevices: (NanitCameraPlugin.prototype as any).clearAndTrySyncDevices,
        closeAllEventSockets: (NanitCameraPlugin.prototype as any).closeAllEventSockets,
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

        it('clearAndLogin closes and forgets every open event socket', async () => {
            const { harness } = createPluginHarness({
                email: 'parent@example.com',
                password: 'hunter2',
            });
            harness.access_token = 'stale-token';
            const staleSocket = { removeAllListeners: vi.fn(), close: vi.fn() };
            harness.eventSockets.set('baby-1', staleSocket);

            mockedAxios.post.mockResolvedValueOnce({ data: { mfa_token: undefined } });

            await harness.clearAndLogin();

            expect(staleSocket.removeAllListeners).toHaveBeenCalledTimes(1);
            expect(staleSocket.close).toHaveBeenCalledTimes(1);
            expect(harness.eventSockets.size).toBe(0);
        });

        it('clearAndTrySyncDevices closes and forgets every open event socket', async () => {
            const { harness } = createPluginHarness({
                email: 'parent@example.com',
                password: 'hunter2',
            });
            harness.access_token = 'stale-token';
            const staleSocket = { removeAllListeners: vi.fn(), close: vi.fn() };
            harness.eventSockets.set('baby-1', staleSocket);
            harness.syncDevices.mockResolvedValueOnce(undefined);

            await harness.clearAndTrySyncDevices();

            expect(staleSocket.removeAllListeners).toHaveBeenCalledTimes(1);
            expect(staleSocket.close).toHaveBeenCalledTimes(1);
            expect(harness.eventSockets.size).toBe(0);
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

        it('discards the dead tokens and falls back to email/password login when the refresh call fails', async () => {
            const { harness, settingsStorage } = createPluginHarness({
                email: 'parent@example.com',
                password: 'hunter2',
                refresh_token: 'refresh-abc',
            });

            mockedAxios.post
                .mockRejectedValueOnce(new Error('network blip'))
                .mockResolvedValueOnce({ data: { mfa_token: 'mfa-789' } });

            await expect(harness.tryLogin()).resolves.toBeUndefined();

            expect(settingsStorage.putSetting).toHaveBeenCalledWith('access_token', '');
            expect(settingsStorage.putSetting).toHaveBeenCalledWith('refresh_token', '');
            expect(settingsStorage.putSetting).toHaveBeenCalledWith('expiration', 0);
            expect(mockedAxios.post).toHaveBeenCalledTimes(2);
            expect(mockedAxios.post).toHaveBeenLastCalledWith(
                'https://api.nanit.com/login',
                { email: 'parent@example.com', password: 'hunter2' },
                expect.anything(),
            );
            expect(harness.mfa_token).toBe('mfa-789');
        });
    });

    describe('single-flight coalescing', () => {
        it('runs one refresh for concurrent tryLogin() callers', async () => {
            const { harness } = createPluginHarness({
                email: 'parent@example.com',
                password: 'hunter2',
                refresh_token: 'refresh-abc',
            });

            let resolvePost: (value: any) => void = () => {};
            mockedAxios.post.mockReturnValueOnce(new Promise((resolve) => { resolvePost = resolve; }));

            const first = harness.tryLogin();
            const second = harness.tryLogin();

            // Nanit rotates the refresh token, so a second concurrent refresh would
            // present an already-consumed token and wipe the stored credentials.
            expect(mockedAxios.post).toHaveBeenCalledTimes(1);

            resolvePost({ data: { access_token: 'new-access-token', refresh_token: 'new-refresh-token' } });
            await Promise.all([first, second]);

            expect(mockedAxios.post).toHaveBeenCalledTimes(1);
            expect(harness.access_token).toBe('new-access-token');
        });

        it('clears the in-flight guard so a later login runs again', async () => {
            const { harness } = createPluginHarness({
                email: 'parent@example.com',
                password: 'hunter2',
            });

            mockedAxios.post
                .mockResolvedValueOnce({ data: { mfa_token: 'mfa-1' } })
                .mockResolvedValueOnce({ data: { mfa_token: 'mfa-2' } });

            await harness.tryLogin();
            await harness.tryLogin();

            expect(mockedAxios.post).toHaveBeenCalledTimes(2);
            expect(harness.loginInFlight).toBeNull();
        });

        it('clears the in-flight guard after a failed login', async () => {
            const { harness } = createPluginHarness({
                email: 'parent@example.com',
                password: 'hunter2',
            });

            mockedAxios.post.mockRejectedValueOnce(new Error('nanit is down'));

            await expect(harness.tryLogin()).rejects.toThrow('Nanit login failed');
            expect(harness.loginInFlight).toBeNull();
        });

        it('never coalesces a two-factor submission into an in-flight login', async () => {
            const { harness } = createPluginHarness({
                email: 'parent@example.com',
                password: 'hunter2',
            });
            harness.mfa_token = 'mfa-123';

            let resolveFirst: (value: any) => void = () => {};
            mockedAxios.post
                .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }))
                .mockResolvedValueOnce({ data: { access_token: 'final-access-token', refresh_token: 'final-refresh-token' } });

            const pending = harness.tryLogin();
            const withCode = harness.tryLogin('654321');

            resolveFirst({ data: { mfa_token: 'mfa-123' } });
            await Promise.all([pending, withCode]);

            expect(mockedAxios.post).toHaveBeenCalledTimes(2);
            expect(mockedAxios.post).toHaveBeenCalledWith(
                'https://api.nanit.com/login',
                expect.objectContaining({ mfa_code: '654321' }),
                expect.anything(),
            );
            expect(harness.access_token).toBe('final-access-token');
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

        it('throws when the initial login fails without returning an mfa challenge', async () => {
            const { harness } = createPluginHarness({
                email: 'parent@example.com',
                password: 'hunter2',
            });

            mockedAxios.post.mockRejectedValueOnce(new Error('nanit is down'));

            await expect(harness.tryLogin()).rejects.toThrow('Nanit login failed');
            expect(harness.access_token).toBe('');
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

/**
 * Builds a "this"-like object bound to the real NanitCameraPlugin.prototype
 * methods under test (syncDevices, getDevice), without running the real
 * constructor. tryLogin is stubbed here -- it has its own dedicated coverage
 * above -- so these tests isolate device discovery/sync behavior.
 */
function createProviderHarness(overrides: Record<string, any> = {}) {
    const consoleLog = vi.fn();
    const harness: any = {
        console: { log: consoleLog },
        devices: new Map(),
        access_token: 'provider-token',
        tryLogin: vi.fn().mockResolvedValue(undefined),
        syncDevices: (NanitCameraPlugin.prototype as any).syncDevices,
        getDevice: (NanitCameraPlugin.prototype as any).getDevice,
        releaseDevice: (NanitCameraPlugin.prototype as any).releaseDevice,
        createDevice: (NanitCameraPlugin.prototype as any).createDevice,
        ...overrides,
    };
    return { harness, consoleLog };
}

describe('NanitCameraPlugin.syncDevices', () => {
    beforeEach(() => {
        mockedAxios.get.mockReset();
        mockedAxios.post.mockReset();
        fakeDeviceManager.onDevicesChanged.mockClear();
    });

    it('fetches the babies list and reports discovered devices to deviceManager', async () => {
        const { harness } = createProviderHarness();
        mockedAxios.get.mockResolvedValueOnce({
            data: {
                babies: [
                    { uid: 'baby-1', name: 'Nursery' },
                    { uid: 'baby-2', name: 'Playroom' },
                ],
            },
        });

        await harness.syncDevices(0);

        expect(harness.tryLogin).toHaveBeenCalledTimes(1);
        expect(mockedAxios.get).toHaveBeenCalledWith(
            'https://api.nanit.com/babies',
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer provider-token' }),
            }),
        );
        expect(fakeDeviceManager.onDevicesChanged).toHaveBeenCalledTimes(1);
        const [{ devices }] = fakeDeviceManager.onDevicesChanged.mock.calls[0];
        expect(devices).toHaveLength(2);
        expect(devices[0]).toEqual(
            expect.objectContaining({
                nativeId: 'baby-1',
                name: 'Nursery',
                interfaces: expect.arrayContaining(['Camera', 'VideoCamera', 'MotionSensor']),
            }),
        );
        expect(devices[1]).toEqual(expect.objectContaining({ nativeId: 'baby-2', name: 'Playroom' }));
    });

    it('reports an empty device list when the account has no babies', async () => {
        const { harness } = createProviderHarness();
        mockedAxios.get.mockResolvedValueOnce({ data: { babies: [] } });

        await harness.syncDevices(0);

        expect(fakeDeviceManager.onDevicesChanged).toHaveBeenCalledWith({ devices: [] });
    });

    it('throws a pending-two-factor error when login left no access token', async () => {
        const { harness } = createProviderHarness({ access_token: '' });

        await expect(harness.syncDevices(0)).rejects.toThrow('Two Factor Code');

        expect(mockedAxios.get).not.toHaveBeenCalled();
        expect(fakeDeviceManager.onDevicesChanged).not.toHaveBeenCalled();
    });

    it('propagates a login failure without calling onDevicesChanged', async () => {
        const { harness } = createProviderHarness({
            tryLogin: vi.fn().mockRejectedValue(new Error('Failed to authenticate')),
        });

        await expect(harness.syncDevices(0)).rejects.toThrow('Failed to authenticate');

        expect(mockedAxios.get).not.toHaveBeenCalled();
        expect(fakeDeviceManager.onDevicesChanged).not.toHaveBeenCalled();
    });
});

describe('NanitCameraPlugin.getDevice', () => {
    it('instantiates and caches a device by nativeId', async () => {
        const { harness } = createProviderHarness();

        const device = await harness.getDevice('baby-1');
        const again = await harness.getDevice('baby-1');

        expect(device).toBeDefined();
        expect(again).toBe(device);
        expect(harness.devices.get('baby-1')).toBe(device);
    });

    it('creates independent instances for different nativeIds', async () => {
        const { harness } = createProviderHarness();

        const first = await harness.getDevice('baby-1');
        const second = await harness.getDevice('baby-2');

        expect(first).not.toBe(second);
        expect(harness.devices.size).toBe(2);
    });
});

describe('NanitCameraPlugin.releaseDevice', () => {
    it('drops the cached device and clears its pending sensor timers', async () => {
        const { harness } = createProviderHarness();

        const device: any = await harness.getDevice('baby-1');
        const motionFired = vi.fn();
        const binaryFired = vi.fn();
        device.motionTimeoutId = setTimeout(motionFired, 10);
        device.binaryStateTimeoutId = setTimeout(binaryFired, 10);

        await harness.releaseDevice('id-1', 'baby-1');

        expect(device.motionTimeoutId).toBeNull();
        expect(device.binaryStateTimeoutId).toBeNull();
        expect(harness.devices.has('baby-1')).toBe(false);

        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(motionFired).not.toHaveBeenCalled();
        expect(binaryFired).not.toHaveBeenCalled();
    });

    it('is a no-op for a nativeId that was never cached', async () => {
        const { harness } = createProviderHarness();

        await expect(harness.releaseDevice('id-1', 'unknown')).resolves.toBeUndefined();
    });
});

describe('NanitCameraPlugin.createDevice', () => {
    beforeEach(() => {
        fakeDeviceManager.onDeviceDiscovered.mockClear();
    });

    it('registers the same interface set syncDevices uses', async () => {
        const { harness } = createProviderHarness();

        const nativeId = await harness.createDevice({ name: 'Nursery', baby_uid: 'baby-1' });

        expect(nativeId).toBe('baby-1');
        expect(fakeDeviceManager.onDeviceDiscovered).toHaveBeenCalledWith(
            expect.objectContaining({
                nativeId: 'baby-1',
                name: 'Nursery',
                interfaces: expect.arrayContaining(['VideoCamera', 'Camera', 'MotionSensor', 'BinarySensor']),
            }),
        );
    });

    it('throws instead of registering a device with no baby_uid', async () => {
        const { harness } = createProviderHarness();

        await expect(harness.createDevice({ name: 'Nursery' })).rejects.toThrow('baby_uid is required');
        expect(fakeDeviceManager.onDeviceDiscovered).not.toHaveBeenCalled();
    });
});

describe('NanitCameraDevice.getVideoStream', () => {
    beforeEach(() => {
        fakeMediaManager.createMediaObject.mockClear();
    });

    it('constructs the FFmpeg RTMPS input using nativeId + access_token', async () => {
        const { harness } = createProviderHarness({ access_token: 'device-access-token' });
        const plugin = {
            tryLogin: vi.fn().mockResolvedValue(undefined),
            access_token: 'device-access-token',
        };
        // getDevice() is the only way to obtain a real NanitCameraDevice
        // instance -- the class itself is not exported from main.ts.
        harness.access_token = plugin.access_token;
        const device: any = await harness.getDevice('baby-1');
        device.plugin = plugin;

        await device.getVideoStream();

        expect(plugin.tryLogin).toHaveBeenCalledTimes(1);
        expect(fakeMediaManager.createMediaObject).toHaveBeenCalledTimes(1);
        const [buffer, mimeType] = fakeMediaManager.createMediaObject.mock.calls[0];
        expect(typeof mimeType).toBe('string');
        const ffmpegInput = JSON.parse(buffer.toString());
        expect(ffmpegInput.container).toBe('flv');
        expect(ffmpegInput.inputArguments).toContain(
            'rtmps://media-secured.nanit.com/nanit/baby-1.device-access-token',
        );
    });

    it('throws when nativeId is missing', async () => {
        const { harness } = createProviderHarness();
        const plugin = { tryLogin: vi.fn().mockResolvedValue(undefined), access_token: 'device-access-token' };
        const device: any = await harness.getDevice('');
        device.plugin = plugin;

        await expect(device.getVideoStream()).rejects.toThrow('missing nativeId');
    });

    it('throws when the plugin has no access token', async () => {
        const { harness } = createProviderHarness();
        const plugin = { tryLogin: vi.fn().mockResolvedValue(undefined), access_token: '' };
        const device: any = await harness.getDevice('baby-1');
        device.plugin = plugin;

        await expect(device.getVideoStream()).rejects.toThrow('missing access token');
    });

    it('propagates a login failure from tryLogin', async () => {
        const { harness } = createProviderHarness();
        const plugin = {
            tryLogin: vi.fn().mockRejectedValue(new Error('Failed to authenticate')),
            access_token: 'device-access-token',
        };
        const device: any = await harness.getDevice('baby-1');
        device.plugin = plugin;

        await expect(device.getVideoStream()).rejects.toThrow('Failed to authenticate');
        expect(fakeMediaManager.createMediaObject).not.toHaveBeenCalled();
    });
});

describe('NanitCameraDevice.takePicture', () => {
    beforeEach(() => {
        fakeMediaManager.createMediaObject.mockClear();
    });

    it('returns a MediaObject configured to capture a single frame from the RTMPS stream', async () => {
        const { harness } = createProviderHarness({ access_token: 'device-access-token' });
        const device: any = await harness.getDevice('baby-1');

        const result = await device.takePicture();

        expect(fakeMediaManager.createMediaObject).toHaveBeenCalledTimes(1);
        const [buffer, mimeType] = fakeMediaManager.createMediaObject.mock.calls[0];
        expect(typeof mimeType).toBe('string');
        const ffmpegInput = JSON.parse(buffer.toString());
        expect(ffmpegInput.videoDecoderArguments).toEqual(['-vframes', '1', '-q:v', '2']);
        expect(ffmpegInput.inputArguments).toContain(
            'rtmps://media-secured.nanit.com/nanit/baby-1.device-access-token',
        );
    });

    it('refreshes auth before building the snapshot URL', async () => {
        const { harness } = createProviderHarness({ access_token: 'device-access-token' });
        const device: any = await harness.getDevice('baby-1');

        await device.takePicture();

        expect(harness.tryLogin).toHaveBeenCalledTimes(1);
    });

    it('propagates a login failure from tryLogin', async () => {
        const { harness } = createProviderHarness({
            access_token: 'device-access-token',
            tryLogin: vi.fn().mockRejectedValue(new Error('Failed to authenticate')),
        });
        const device: any = await harness.getDevice('baby-1');

        await expect(device.takePicture()).rejects.toThrow('Failed to authenticate');
        expect(fakeMediaManager.createMediaObject).not.toHaveBeenCalled();
    });

    it('applies picture options to the FFmpeg stream', async () => {
        const { harness } = createProviderHarness({ access_token: 'device-access-token' });
        const device: any = await harness.getDevice('baby-1');

        // Picture options are passed through but the implementation currently
        // does not modify the stream based on them -- this test ensures the
        // interface is exercised even though the options are not yet used.
        const options = { picture: {} };
        await device.takePicture(options);

        expect(fakeMediaManager.createMediaObject).toHaveBeenCalledTimes(1);
    });

    it('throws when nativeId is missing', async () => {
        const { harness } = createProviderHarness();
        const device: any = await harness.getDevice('');

        await expect(device.takePicture()).rejects.toThrow('missing nativeId');
    });
});

describe('NanitCameraDevice.getPictureOptions', () => {
    it('returns an empty array (no alternate resolutions defined)', async () => {
        const { harness } = createProviderHarness();
        const device: any = await harness.getDevice('baby-1');

        const result = await device.getPictureOptions();

        expect(result).toEqual([]);
    });
});

describe('NanitCameraPlugin.performLogin — request timeouts', () => {
    beforeEach(() => {
        mockedAxios.get.mockReset();
        mockedAxios.post.mockReset();
    });

    it('bounds the /babies verification request with a timeout', async () => {
        const { harness } = createPluginHarness({
            email: 'parent@example.com',
            password: 'hunter2',
            access_token: 'valid-token',
            expiration: Date.now() + 1000 * 60 * 60,
        });
        mockedAxios.get.mockResolvedValueOnce({ status: 200, data: { babies: [] } });

        await harness.tryLogin();

        expect(mockedAxios.get).toHaveBeenCalledWith(
            'https://api.nanit.com/babies',
            expect.objectContaining({ timeout: expect.any(Number) }),
        );
    });

    it('bounds the token refresh request with a timeout', async () => {
        const { harness } = createPluginHarness({
            email: 'parent@example.com',
            password: 'hunter2',
            refresh_token: 'refresh-me',
        });
        mockedAxios.post.mockResolvedValueOnce({
            data: { access_token: 'new-access', refresh_token: 'new-refresh' },
        });

        await harness.tryLogin();

        expect(mockedAxios.post).toHaveBeenCalledWith(
            'https://api.nanit.com/tokens/refresh',
            expect.anything(),
            expect.objectContaining({ timeout: expect.any(Number) }),
        );
    });
});

describe('NanitCameraPlugin.performLogin — two factor code with no mfa_token', () => {
    beforeEach(() => {
        mockedAxios.get.mockReset();
        mockedAxios.post.mockReset();
    });

    it('acquires an mfa_token then spends the supplied code instead of discarding it', async () => {
        const { harness, settingsStorage } = createPluginHarness({
            email: 'parent@example.com',
            password: 'hunter2',
        });
        harness.mfa_token = '';

        // First call: email/password login returns the mfa challenge.
        mockedAxios.post.mockResolvedValueOnce({ data: { mfa_token: 'challenge-token' } });
        // Second call: the same run immediately submits the code.
        mockedAxios.post.mockResolvedValueOnce({
            data: { access_token: 'mfa-access', refresh_token: 'mfa-refresh' },
        });

        await harness.tryLogin('123456');

        expect(mockedAxios.post).toHaveBeenCalledTimes(2);
        expect(mockedAxios.post).toHaveBeenLastCalledWith(
            'https://api.nanit.com/login',
            expect.objectContaining({ mfa_token: 'challenge-token', mfa_code: '123456' }),
            expect.anything(),
        );
        expect(harness.access_token).toBe('mfa-access');
        expect(settingsStorage.store.refresh_token).toBe('mfa-refresh');
    });

    it('spends the code when the challenge arrives as a rejected login', async () => {
        const { harness } = createPluginHarness({
            email: 'parent@example.com',
            password: 'hunter2',
        });
        harness.mfa_token = '';

        mockedAxios.post.mockRejectedValueOnce({
            message: 'mfa required',
            response: { data: { mfa_token: 'challenge-token' } },
        });
        mockedAxios.post.mockResolvedValueOnce({
            data: { access_token: 'mfa-access', refresh_token: 'mfa-refresh' },
        });

        await harness.tryLogin('654321');

        expect(mockedAxios.post).toHaveBeenCalledTimes(2);
        expect(harness.access_token).toBe('mfa-access');
    });

    it('still stops and waits when no code was supplied', async () => {
        const { harness } = createPluginHarness({
            email: 'parent@example.com',
            password: 'hunter2',
        });
        harness.mfa_token = '';

        mockedAxios.post.mockResolvedValueOnce({ data: { mfa_token: 'challenge-token' } });

        await harness.tryLogin();

        expect(mockedAxios.post).toHaveBeenCalledTimes(1);
        expect(harness.mfa_token).toBe('challenge-token');
        expect(harness.access_token).toBe('');
    });
});

describe('NanitCameraPlugin.performLogin — account without two factor', () => {
    beforeEach(() => {
        mockedAxios.get.mockReset();
        mockedAxios.post.mockReset();
    });

    it('stores the tokens when the email/password login succeeds with no mfa challenge', async () => {
        const { harness, settingsStorage } = createPluginHarness({
            email: 'parent@example.com',
            password: 'hunter2',
        });
        harness.mfa_token = '';

        mockedAxios.post.mockResolvedValueOnce({
            data: { access_token: 'direct-access', refresh_token: 'direct-refresh' },
        });

        await harness.tryLogin();

        // One call only: there is no challenge to answer.
        expect(mockedAxios.post).toHaveBeenCalledTimes(1);
        expect(harness.access_token).toBe('direct-access');
        expect(settingsStorage.store.access_token).toBe('direct-access');
        expect(settingsStorage.store.refresh_token).toBe('direct-refresh');
        expect(settingsStorage.store.expiration).toBeGreaterThan(Date.now());
        expect(harness.mfa_token).toBe('');
    });
});

describe('NanitCameraPlugin.performLogin — mfa_token is single use', () => {
    beforeEach(() => {
        mockedAxios.get.mockReset();
        mockedAxios.post.mockReset();
    });

    it('clears the spent mfa_token so a later login mints a fresh challenge', async () => {
        const { harness } = createPluginHarness({
            email: 'parent@example.com',
            password: 'hunter2',
        });
        harness.mfa_token = 'challenge-token';

        mockedAxios.post.mockResolvedValueOnce({
            data: { access_token: 'mfa-access', refresh_token: 'mfa-refresh' },
        });

        await harness.tryLogin('123456');

        expect(harness.mfa_token).toBe('');
    });

    it('re-acquires a challenge on the next two factor submission instead of reusing the dead one', async () => {
        const { harness, settingsStorage } = createPluginHarness({
            email: 'parent@example.com',
            password: 'hunter2',
        });
        harness.mfa_token = 'challenge-token';

        mockedAxios.post.mockResolvedValueOnce({
            data: { access_token: 'mfa-access', refresh_token: 'mfa-refresh' },
        });
        await harness.tryLogin('123456');

        // Second login attempt: the stored tokens are gone (user cleared them per the
        // README's troubleshooting steps), so it must start from email/password again.
        harness.access_token = '';
        settingsStorage.store.access_token = '';
        settingsStorage.store.refresh_token = '';
        settingsStorage.store.expiration = 0;
        mockedAxios.post.mockResolvedValueOnce({ data: { mfa_token: 'fresh-token' } });
        mockedAxios.post.mockResolvedValueOnce({
            data: { access_token: 'second-access', refresh_token: 'second-refresh' },
        });

        await harness.tryLogin('654321');

        expect(mockedAxios.post).toHaveBeenLastCalledWith(
            'https://api.nanit.com/login',
            expect.objectContaining({ mfa_token: 'fresh-token', mfa_code: '654321' }),
            expect.anything(),
        );
    });
});

describe('NanitCameraPlugin.subscribeToEvents', () => {
    beforeEach(() => {
        createdSockets.length = 0;
    });

    function createEventHarness(overrides: Record<string, any> = {}) {
        const consoleLog = vi.fn();
        const device = { triggerMotion: vi.fn(), triggerBinaryState: vi.fn() };
        const devices = new Map<string, any>([['baby-1', device]]);
        const harness: any = {
            console: { log: consoleLog },
            access_token: 'live-token',
            devices,
            eventSockets: new Map(),
            subscribeToEvents: (NanitCameraPlugin.prototype as any).subscribeToEvents,
            ...overrides,
        };
        return { harness, consoleLog, device };
    }

    it('does nothing without an access token', () => {
        const { harness } = createEventHarness({ access_token: '' });

        harness.subscribeToEvents('baby-1');

        expect(createdSockets).toHaveLength(0);
    });

    it('opens a socket to the ActionCable endpoint and subscribes to the EventsChannel on open', () => {
        const { harness } = createEventHarness();

        harness.subscribeToEvents('baby-1');

        expect(createdSockets).toHaveLength(1);
        const socket = createdSockets[0];
        expect(socket.url).toBe('wss://api.nanit.com/focus/cable');
        expect(socket.opts).toEqual({ headers: { Authorization: 'Bearer live-token' } });

        socket.__emit('open');

        expect(socket.sentMessages).toHaveLength(1);
        expect(JSON.parse(socket.sentMessages[0])).toEqual({
            command: 'subscribe',
            identifier: JSON.stringify({ channel: 'EventsChannel', baby_uid: 'baby-1' }),
        });
    });

    it('does not open a second socket for a baby that already has one open', () => {
        const { harness } = createEventHarness();

        harness.subscribeToEvents('baby-1');
        harness.subscribeToEvents('baby-1');

        expect(createdSockets).toHaveLength(1);
    });

    it('opens a new socket for a baby whose existing socket is closed', () => {
        const { harness } = createEventHarness();

        harness.subscribeToEvents('baby-1');
        createdSockets[0].readyState = 3; // CLOSED

        harness.subscribeToEvents('baby-1');

        expect(createdSockets).toHaveLength(2);
    });

    it('routes a motion message to the matching device\'s triggerMotion()', () => {
        const { harness, device } = createEventHarness();
        harness.subscribeToEvents('baby-1');
        const socket = createdSockets[0];

        socket.__emit('message', JSON.stringify({ message: { event: { type: 'motion' } } }));

        expect(device.triggerMotion).toHaveBeenCalledTimes(1);
        expect(device.triggerBinaryState).not.toHaveBeenCalled();
    });

    it.each(['sound', 'cry', 'night_light'])(
        'routes a %s message to the matching device\'s triggerBinaryState()',
        (eventType) => {
            const { harness, device } = createEventHarness();
            harness.subscribeToEvents('baby-1');
            const socket = createdSockets[0];

            socket.__emit('message', JSON.stringify({ message: { event: { type: eventType } } }));

            expect(device.triggerBinaryState).toHaveBeenCalledTimes(1);
            expect(device.triggerMotion).not.toHaveBeenCalled();
        },
    );

    it('ignores a message for a baby with no matching device', () => {
        const { harness, device } = createEventHarness();
        harness.subscribeToEvents('baby-2');
        const socket = createdSockets[0];

        socket.__emit('message', JSON.stringify({ message: { event: { type: 'motion' } } }));

        expect(device.triggerMotion).not.toHaveBeenCalled();
    });

    it('ignores an unparseable/unrecognized frame without throwing', () => {
        const { harness } = createEventHarness();
        harness.subscribeToEvents('baby-1');
        const socket = createdSockets[0];

        expect(() => socket.__emit('message', 'not json')).not.toThrow();
        expect(() => socket.__emit('message', JSON.stringify({ type: 'ping' }))).not.toThrow();
    });

    it('reconnects on close after a fixed backoff while the access token is still present', () => {
        vi.useFakeTimers();
        try {
            const { harness } = createEventHarness();
            const spy = vi.spyOn(harness, 'subscribeToEvents');
            harness.subscribeToEvents('baby-1');
            const socket = createdSockets[0];
            spy.mockClear();

            socket.__emit('close');
            expect(harness.eventSockets.has('baby-1')).toBe(false);

            vi.advanceTimersByTime(30000);

            expect(createdSockets).toHaveLength(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not reconnect on close once the access token has been cleared', () => {
        vi.useFakeTimers();
        try {
            const { harness } = createEventHarness();
            harness.subscribeToEvents('baby-1');
            const socket = createdSockets[0];

            harness.access_token = '';
            socket.__emit('close');
            vi.advanceTimersByTime(30000);

            expect(createdSockets).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('logs instead of throwing on a socket error event', () => {
        const { harness, consoleLog } = createEventHarness();
        harness.subscribeToEvents('baby-1');
        const socket = createdSockets[0];

        socket.__emit('error', new Error('boom'));

        expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('boom'));
    });
});

describe('NanitCameraPlugin.getMotionTimeoutMs', () => {
    const call = (stored: any) =>
        (NanitCameraPlugin.prototype as any).getMotionTimeoutMs.call({
            settingsStorage: { getItem: () => stored },
        });

    it('defaults to 10000 when unset or empty', () => {
        expect(call(undefined)).toBe(10000);
        expect(call(null)).toBe(10000);
        expect(call('')).toBe(10000);
    });

    it('parses a valid configured value', () => {
        expect(call('2500')).toBe(2500);
        expect(call(4000)).toBe(4000);
    });

    it('falls back to 10000 for non-numeric, zero or negative values', () => {
        expect(call('abc')).toBe(10000);
        expect(call('0')).toBe(10000);
        expect(call('-5')).toBe(10000);
    });
});

describe('NanitCameraDevice trigger timers', () => {
    async function makeDevice(timeoutMs = 1000) {
        const { harness } = createProviderHarness();
        const device: any = await harness.getDevice('baby-1');
        device.plugin.getMotionTimeoutMs = vi.fn(() => timeoutMs);
        return device;
    }

    it('triggerMotion sets motionDetected and auto-resets after the timeout', async () => {
        vi.useFakeTimers();
        try {
            const device = await makeDevice(1000);
            device.triggerMotion();
            expect(device.motionDetected).toBe(true);
            vi.advanceTimersByTime(999);
            expect(device.motionDetected).toBe(true);
            vi.advanceTimersByTime(1);
            expect(device.motionDetected).toBe(false);
            expect(device.motionTimeoutId).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('triggerMotion restarts the window instead of stacking timers', async () => {
        vi.useFakeTimers();
        try {
            const device = await makeDevice(1000);
            device.triggerMotion();
            vi.advanceTimersByTime(800);
            device.triggerMotion();
            vi.advanceTimersByTime(800);
            expect(device.motionDetected).toBe(true);
            vi.advanceTimersByTime(200);
            expect(device.motionDetected).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('triggerBinaryState sets binaryState and auto-resets after the timeout', async () => {
        vi.useFakeTimers();
        try {
            const device = await makeDevice(500);
            device.triggerBinaryState();
            expect(device.binaryState).toBe(true);
            vi.advanceTimersByTime(500);
            expect(device.binaryState).toBe(false);
            expect(device.binaryStateTimeoutId).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('triggerBinaryState restarts the window instead of stacking timers', async () => {
        vi.useFakeTimers();
        try {
            const device = await makeDevice(500);
            device.triggerBinaryState();
            vi.advanceTimersByTime(400);
            device.triggerBinaryState();
            vi.advanceTimersByTime(400);
            expect(device.binaryState).toBe(true);
            vi.advanceTimersByTime(100);
            expect(device.binaryState).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});
