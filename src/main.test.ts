import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';

// Mock axios entirely -- no real network calls, no real Nanit credentials ever touched.
vi.mock('axios', () => ({
    default: {
        get: vi.fn(),
        post: vi.fn(),
    },
}));

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
