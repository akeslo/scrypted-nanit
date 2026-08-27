import { BinarySensor, Camera, Device, DeviceCreator, DeviceCreatorSettings, DeviceProvider, FFmpegInput, Intercom, MediaObject, MediaStreamOptions, MotionSensor, PictureOptions, ResponseMediaStreamOptions, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, ScryptedMimeTypes, Setting, Settings, SettingValue, VideoCamera } from '@scrypted/sdk';
import sdk from '@scrypted/sdk';
import { StorageSettings } from "@scrypted/sdk/storage-settings"

import axios, { AxiosRequestConfig } from 'axios'

const { log, deviceManager, mediaManager } = sdk;

// Every Nanit API call goes through axios with no default timeout, which means a
// connection that opens and then stalls never settles. tryLogin() is single-flighted,
// so one stalled request wedges *every* later getVideoStream()/takePicture()/
// syncDevices() on the same never-resolving promise -- the plugin looks dead until the
// Scrypted host is restarted. Bound every request instead.
const NANIT_REQUEST_TIMEOUT_MS = 15000;


class NanitCameraDevice extends ScryptedDeviceBase implements Intercom, Camera, VideoCamera, MotionSensor, BinarySensor {
    private motionTimeoutId: NodeJS.Timeout | null = null;
    private binaryStateTimeoutId: NodeJS.Timeout | null = null;

    constructor(public plugin: NanitCameraPlugin, nativeId: string) {
        super(nativeId);
    }

    async takePicture(options?: PictureOptions): Promise<MediaObject> {
        // KNOWN ISSUE: Snapshot capture is not working reliably. The implementation
        // attempts to extract a single frame from the RTMPS stream using FFmpeg options,
        // but the Nanit API does not appear to support still-frame extraction via the
        // video stream. Users will see a "Failed Snapshot" screen when attempting to
        // capture a picture. A proper fix would require implementing snapshot capture
        // via a separate Nanit API endpoint, if one exists.
        this.console.log("trying to take a photo")
        if (!this.nativeId) {
            throw new Error("missing nativeId");
        }
        // The access token is baked into the RTMPS URL, so a snapshot taken with a
        // stale token produces a stream that never opens. getVideoStream() already
        // refreshes auth first; this path did not, which meant snapshots failed on
        // their own schedule (tokens expire after 4h) even when live view worked.
        await this.plugin.tryLogin();
        if (!this.plugin.access_token) {
            throw new Error("missing access token");
        }
        let ffmpegInputVal: FFmpegInput;
        ffmpegInputVal = this.ffmpegInput(options);
        ffmpegInputVal.videoDecoderArguments = ['-vframes', '1', '-q:v', '2']

        // Validate FFmpeg input structure before returning
        if (!ffmpegInputVal.container) {
            throw new Error("Invalid snapshot configuration: missing container");
        }
        if (!Array.isArray(ffmpegInputVal.inputArguments) || ffmpegInputVal.inputArguments.length === 0) {
            throw new Error("Invalid snapshot configuration: missing inputArguments");
        }
        if (!Array.isArray(ffmpegInputVal.videoDecoderArguments) || ffmpegInputVal.videoDecoderArguments.length === 0) {
            throw new Error("Invalid snapshot configuration: missing videoDecoderArguments");
        }

        return mediaManager.createMediaObject(Buffer.from(JSON.stringify(ffmpegInputVal)), ScryptedMimeTypes.FFmpegInput);
    }

    async getPictureOptions(): Promise<PictureOptions[]> {
        // can optionally provide the different resolutions of images that are available.
        // used by homekit, if available.
        return [];
    }

    async getVideoStream(options?: MediaStreamOptions): Promise<MediaObject> {
        this.console.log("Attempting to confirm access token to retrieve video stream")
        await this.plugin.tryLogin();
        this.console.log("Login Succeeded. Returning video stream")
        let ffmpegInputVal: FFmpegInput;

        if (!this.nativeId) {
            throw new Error("missing nativeId");
        }
        if (!this.plugin.access_token) {
            throw new Error("missing access token");
        }
        ffmpegInputVal = this.ffmpegInput(options);

        // Validate FFmpeg input structure before returning
        if (!ffmpegInputVal.container) {
            throw new Error("Invalid stream configuration: missing container");
        }
        if (!Array.isArray(ffmpegInputVal.inputArguments) || ffmpegInputVal.inputArguments.length === 0) {
            throw new Error("Invalid stream configuration: missing inputArguments");
        }

        return mediaManager.createMediaObject(Buffer.from(JSON.stringify(ffmpegInputVal)), ScryptedMimeTypes.FFmpegInput);
    }

    ffmpegInput(options?: MediaStreamOptions): FFmpegInput {
        this.console.log("Creating stream with camera:" + this.nativeId)
        const file = "rtmps://media-secured.nanit.com/nanit/" + this.nativeId! + "." + this.plugin.access_token;

        return {
            url: undefined,
            container: 'flv',
            inputArguments: [
                '-analyzeduration', '1000000',
                '-probesize', '5000000',
                '-fflags', '+genpts+discardcorrupt',
                '-use_wallclock_as_timestamps', '1',
                '-max_delay', '500000',
                '-loglevel', 'error',
                '-err_detect', 'ignore_err',
                '-i', file,
            ]
        };
    }

    async getVideoStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
        return [{
            id: this.nativeId + "-stream",
            allowBatteryPrebuffer: false,
            video: {
                codec: 'h264',
            }
        }];
    }


    async startIntercom(media: MediaObject): Promise<void> {
        // Intercom not supported by Nanit API; silently no-op rather than throwing.
        this.console.log('Intercom requested but not supported by this camera');
    }

    async stopIntercom(): Promise<void> {
    }

    // Called when the plugin drops this device. Pending motion/binary timers hold a
    // reference to the device and would still fire (mutating state on a device the
    // host has already released), so clear them explicitly.
    release() {
        if (this.motionTimeoutId) {
            clearTimeout(this.motionTimeoutId);
            this.motionTimeoutId = null;
        }
        if (this.binaryStateTimeoutId) {
            clearTimeout(this.binaryStateTimeoutId);
            this.binaryStateTimeoutId = null;
        }
    }

    // NOTE: nothing calls triggerBinaryState()/triggerMotion() — the plugin never
    // subscribes to Nanit's event stream, so both sensors stay false forever even
    // though every device advertises MotionSensor/BinarySensor. Documented as a known
    // limitation in the README; wiring up the event source is what makes them real.
    // most cameras have have motion and doorbell press events, but dont notify when the event ends.
    // so set a timeout ourselves to reset the state.
    triggerBinaryState() {
        this.binaryState = true;
        // Clear existing timeout before setting a new one to prevent stacking
        if (this.binaryStateTimeoutId) {
            clearTimeout(this.binaryStateTimeoutId);
        }
        const timeoutMs = this.plugin.getMotionTimeoutMs();
        this.binaryStateTimeoutId = setTimeout(() => {
            this.binaryState = false;
            this.binaryStateTimeoutId = null;
        }, timeoutMs);
    }

    // most cameras have have motion and doorbell press events, but dont notify when the event ends.
    // so set a timeout ourselves to reset the state.
    triggerMotion() {
        this.motionDetected = true;
        // Clear existing timeout before setting a new one to prevent stacking
        if (this.motionTimeoutId) {
            clearTimeout(this.motionTimeoutId);
        }
        const timeoutMs = this.plugin.getMotionTimeoutMs();
        this.motionTimeoutId = setTimeout(() => {
            this.motionDetected = false;
            this.motionTimeoutId = null;
        }, timeoutMs);
    }
}

class NanitCameraPlugin extends ScryptedDeviceBase implements DeviceProvider, Settings, DeviceCreator {
    devices = new Map<string, NanitCameraDevice>();
    access_token = '';
    mfa_token = '';
    failedCount = 0;
    // Single-flight guard for tryLogin(). Nanit rotates the refresh token on every
    // /tokens/refresh call, so two overlapping logins (e.g. syncDevices() at startup
    // racing a getVideoStream()/takePicture()) both present the same refresh token
    // and the loser gets rejected -- which discards the stored credentials and drops
    // the user back to a full email/password + MFA login for no reason.
    private loginInFlight: Promise<void> | null = null;


    settingsStorage = new StorageSettings(this, {
        email: {
            title: 'Email',
            onPut: async () => this.clearAndTrySyncDevices(),
        },
        password: {
            title: 'Password',
            type: 'password',
            onPut: async () => this.clearAndTrySyncDevices(),
        },
        twoFactorCode: {
            title: 'Two Factor Code',
            description: 'Optional: If 2 factor is enabled on your account, enter the code sent to your email or phone number.',
            type: "string",
            onPut: async (oldValue, newValue) => {
                await this.tryLogin(newValue);
                await this.syncDevices(0);
            },
            noStore: true,
        },
        refresh_token: {
            title: 'refresh_token'
        },
        access_token: {
            title: 'access_token'
        },
        expiration: {
            title: 'expiration',
            onPut: async () => this.syncDevices(0),
        },
        motionTimeoutMs: {
            title: 'Motion Sensor Timeout (ms)',
            description: 'How long (in milliseconds) to keep motion/binary sensor states active after an event before resetting them. Default: 10000 (10 seconds).',
            type: 'number',
            defaultValue: 10000,
        },
    });

    constructor() {
        super();
        this.console.log("calling syncDevices from constructor")
        this.syncDevices(0).catch((err) => {
            this.console.log("syncDevices failed during startup: " + (err?.message || err));
        });
    }

    getMotionTimeoutMs(): number {
        const stored = this.settingsStorage.getItem("motionTimeoutMs");
        if (stored !== undefined && stored !== null && stored !== '') {
            const parsed = parseInt(String(stored), 10);
            return !isNaN(parsed) && parsed > 0 ? parsed : 10000;
        }
        return 10000;
    }

    async getCreateDeviceSettings(): Promise<Setting[]> {
        return [
            {
                key: 'name',
                title: 'Name',
            },
            {
                key: 'baby_uid',
                title: 'baby_uid',
            }
        ];
    }

    async createDevice(settings: DeviceCreatorSettings): Promise<string> {
        const nativeId = settings.baby_uid?.toString();
        // Without a baby_uid there is no stream URL to build, and returning
        // undefined from a Promise<string> left the host holding a device it
        // could never resolve.
        if (!nativeId)
            throw new Error("baby_uid is required to create a Nanit camera");

        await deviceManager.onDeviceDiscovered({
            nativeId,
            type: ScryptedDeviceType.Camera,
            // Keep this in step with syncDevices() -- a manually created camera
            // that omits the sensor interfaces silently loses motion/binary events.
            interfaces: [
                ScryptedInterface.VideoCamera,
                ScryptedInterface.Camera,
                ScryptedInterface.MotionSensor,
                ScryptedInterface.BinarySensor,
            ],
            name: settings.name?.toString(),
        });
        return nativeId;
    }

    onDeviceEvent(eventInterface: string, eventData: any): Promise<void> {
        this.console.log("Device Event occured " + eventInterface)
        return Promise.resolve();
    }

    async clearAndTrySyncDevices() {
        // Clear stored tokens and re-sync devices when user credentials change.
        this.console.log("clearAndTrySyncDevices called");
        this.access_token = '';
        await this.settingsStorage.putSetting("access_token", '');
        return this.syncDevices(0).catch((err) => {
            this.console.log("syncDevices failed after credential change: " + (err?.message || err));
        });
    }

    async clearAndLogin() {
        this.console.log("clearAndLogin called");
        this.access_token = '';
        await this.settingsStorage.putSetting("access_token", '');
        // Call performLogin() directly, not tryLogin(): clearAndLogin() is itself
        // invoked from inside an in-flight performLogin(), and routing back through
        // the single-flight guard would return that same pending promise and deadlock.
        return this.performLogin('');
    }

    async tryLogin(twoFactorCode?: string): Promise<void> {
        // A two-factor submission is a distinct, user-initiated login -- never coalesce
        // it into an in-flight tokenless attempt, which would silently discard the code.
        if (twoFactorCode)
            return this.performLogin(twoFactorCode);

        if (this.loginInFlight)
            return this.loginInFlight;

        const inFlight = this.performLogin().finally(() => {
            if (this.loginInFlight === inFlight)
                this.loginInFlight = null;
        });
        this.loginInFlight = inFlight;
        return inFlight;
    }

    async performLogin(twoFactorCode?: string): Promise<void> {
        this.console.log("trying login...");

        const email: String = this.settingsStorage.getItem("email");
        const password: String = this.settingsStorage.getItem("password");
        let saved_access_token = this.settingsStorage.getItem("access_token")
        const expirationRaw = this.settingsStorage.getItem("expiration")
        const expiration = typeof expirationRaw === 'number' ? expirationRaw : Number(expirationRaw) || 0;
        const refresh_token = this.settingsStorage.getItem("refresh_token")

        if (saved_access_token) {
            this.access_token = saved_access_token;
        }

        if (!email || !password) {
            this.console.log("Email and password required");
            throw new Error("Email and password required");
        }
        if (this.access_token && expiration > Date.now()) {
            //we already have a good access token that isn't expired
            this.console.log("Access Token Already Exists and is not expired. Going to call babies api to ensure we are logged in")
            //verify we are actually logged in
            const authenticatedConfig: AxiosRequestConfig = {
                timeout: NANIT_REQUEST_TIMEOUT_MS,
                headers: {
                    "nanit-api-version": 1,
                    "Authorization": "Bearer " + this.access_token
                },
                validateStatus: function (status) {
                    return (status >= 200 && status < 300) || status == 401; // default
                }
            };



            return axios.get("https://api.nanit.com/babies", authenticatedConfig).then((response) => {
                //we are authenticated nothing to do

                if (response.status == 401 && this.failedCount < 2) {
                    this.console.log('failed to auth but received 401 so will clear tokens and try again')
                    this.failedCount++;
                    return this.clearAndLogin()
                } else if (response.status == 401) {
                    return Promise.reject("Exceeded fail count");
                } else {
                    this.failedCount = 0;
                    this.console.log("Confirmed we are authenticated. Stream should Work")
                }
            }).catch((error) => {
                throw new Error("Failed to authenticate: " + (error.message || error.toString()))
            })
        }

        const config = {
            timeout: NANIT_REQUEST_TIMEOUT_MS,
            headers: {
                "nanit-api-version": 1
            }
        };
        if (refresh_token) {
            this.console.log("we have a refresh token...calling the token refresh api");
            try {
                const response = await axios.post("https://api.nanit.com/tokens/refresh", { "refresh_token": refresh_token }, config);
                this.console.log("Received new access token");
                this.failedCount = 0;
                this.access_token = response.data.access_token;
                // putSetting() is async. Dropping the promise meant a rejected storage
                // write surfaced as an unhandled rejection, and the next getItem() could
                // still read the previous value.
                await this.settingsStorage.putSetting("access_token", response.data.access_token)
                await this.settingsStorage.putSetting("refresh_token", response.data.refresh_token)
                await this.settingsStorage.putSetting("expiration", Date.now() + (1000 * 60 * 60 * 4))
                return;
            } catch (error: any) {
                // A failed refresh used to resolve successfully, which left callers
                // (getVideoStream/syncDevices) running with a stale or empty access
                // token and produced an opaque downstream failure. Discard the dead
                // credentials and fall through to the email/password login below --
                // the same recovery the README's Troubleshooting section describes
                // doing by hand.
                this.console.log("Failed to refresh token, discarding stored tokens and falling back to login: " + (error?.message || error));
                this.access_token = '';
                await this.settingsStorage.putSetting("access_token", '')
                await this.settingsStorage.putSetting("refresh_token", '')
                await this.settingsStorage.putSetting("expiration", 0)
            }
        }

        if (!twoFactorCode || !this.mfa_token) {
            this.console.log("calling the login api without mfa. will need to call again to get access/refresh token");
            try {
                const response = await axios.post("https://api.nanit.com/login", { "email": email, "password": password }, config);
                // An account with two-factor disabled gets its tokens back from this
                // very call and never receives an mfa_token. The old code stored only
                // response.data.mfa_token (undefined), then returned -- silently
                // throwing away a completed login and leaving every caller with an
                // empty access token, so the plugin was unusable without 2FA.
                if (response.data?.access_token) {
                    this.console.log("Login successful without an mfa challenge. Storing tokens.")
                    this.failedCount = 0;
                    this.mfa_token = '';
                    this.access_token = response.data.access_token;
                    await this.settingsStorage.putSetting("access_token", response.data.access_token)
                    await this.settingsStorage.putSetting("refresh_token", response.data.refresh_token)
                    await this.settingsStorage.putSetting("expiration", Date.now() + (1000 * 60 * 60 * 4))
                    return;
                }
                this.console.log("Login successful. setting mfa token and will recall login")
                this.mfa_token = response.data.mfa_token;
                // If the user supplied a code, we only came here to (re)acquire the
                // mfa_token -- fall through and spend the code now. Returning here
                // discarded it, and the caller then reported "enter the Two Factor
                // Code" to a user who had just entered it. mfa_token is empty on any
                // fresh plugin start, so this hit every restart mid-login.
                if (!twoFactorCode || !this.mfa_token)
                    return;
            } catch (error: any) {
                if (error.response?.data?.mfa_token) {
                    this.mfa_token = error.response.data.mfa_token;
                    this.console.log("received an mfa challenge from the email/pass login; awaiting two factor code")
                    if (!twoFactorCode)
                        return;
                    this.console.log("two factor code was supplied alongside the challenge; continuing to the mfa login")
                } else {
                    // Neither an access token nor an MFA challenge came back, so there is
                    // nothing for the caller to proceed with -- surface it instead of
                    // resolving and letting the next API call fail with a bare 401.
                    this.console.log("Failed to talk to nanit: " + (error?.message || error));
                    throw new Error("Nanit login failed: " + (error?.message || error));
                }
            }
        }

        this.console.log("calling the login api with mfa to get access and refresh token");

        return axios.post("https://api.nanit.com/login", { "email": email, "password": password, "mfa_token": this.mfa_token, "mfa_code": twoFactorCode }, config).then(async (response) => {
            this.failedCount = 0;
            this.console.log("response from email/pass/mfa login. Received new access token and refresh token")
            // An mfa_token is single-use. Keeping the spent one meant the guard above
            // ("!twoFactorCode || !this.mfa_token") saw a truthy mfa_token on the next
            // login, skipped the email/password step that mints a fresh challenge, and
            // posted the dead token -- so every re-login after the first failed until
            // the Scrypted host was restarted.
            this.mfa_token = '';
            this.access_token = response.data.access_token;
            await this.settingsStorage.putSetting("access_token", response.data.access_token)
            await this.settingsStorage.putSetting("refresh_token", response.data.refresh_token)
            await this.settingsStorage.putSetting("expiration", Date.now() + (1000 * 60 * 60 * 4))
        }).catch((error) => {
            this.console.log("Failed to login with MFA: " + (error.message || error.toString()));
            throw new Error("MFA login failed: " + (error.message || error.toString()))
        });

    }

    getSettings(): Promise<Setting[]> {
        return this.settingsStorage.getSettings();
    }

    putSetting(key: string, value: SettingValue): Promise<void> {
        return this.settingsStorage.putSetting(key, value);
    }

    async syncDevices(duration: number) {
        this.console.log("Sync Devices")
        await this.tryLogin();
        // tryLogin() resolves without an access token whenever it only got as far as
        // an MFA challenge (the two-factor code has not been entered yet). Continuing
        // from there sends "Bearer " with no token and surfaces as an opaque 401 from
        // /babies, which reads like a broken plugin rather than a pending login step.
        if (!this.access_token) {
            this.console.log("No access token after login; two factor code is likely still required");
            throw new Error("Not authenticated with Nanit yet - enter the Two Factor Code to finish logging in");
        }
        const config = {
            timeout: NANIT_REQUEST_TIMEOUT_MS,
            headers: {
                "nanit-api-version": 1,
                "Authorization": "Bearer " + this.access_token
            }
        };

        const response = await axios.get("https://api.nanit.com/babies", config);
        if (!response.data || !Array.isArray(response.data.babies)) {
            this.console.log("Invalid response structure from Nanit API: expected {babies: array}");
            throw new Error("Invalid babies response from Nanit API");
        }
        const babies: any[] = response.data.babies;
        const devices: Device[] = [];
        for (const camera of babies) {
            const nativeId = camera.uid;
            const interfaces = [
                ScryptedInterface.Camera,
                ScryptedInterface.VideoCamera,
                ScryptedInterface.MotionSensor,
                ScryptedInterface.BinarySensor,
            ];

            const device: Device = {
                info: {
                    model: 'Nanit Cam',
                    manufacturer: 'Nanit',
                },
                nativeId,
                name: camera.name,

                type: ScryptedDeviceType.Camera,
                interfaces,
            };
            devices.push(device);
        }

        await deviceManager.onDevicesChanged({
            devices,
        });
        this.console.log('discovered devices');
    }

    async getDevice(nativeId: string) {
        this.console.log("get device with id " + nativeId)
        if (!this.devices.has(nativeId)) {
            const camera = new NanitCameraDevice(this, nativeId);

            this.devices.set(nativeId, camera);
        }
        return this.devices.get(nativeId);
    }

    async releaseDevice(id: string, nativeId: string): Promise<void> {
        const device = this.devices.get(nativeId);
        if (!device)
            return;
        device.release();
        this.devices.delete(nativeId);
        this.console.log("released device with id " + nativeId);
    }
}

export default NanitCameraPlugin;
