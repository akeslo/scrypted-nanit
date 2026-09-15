
# Nanit Camera
## How to install:
- Install Node and npm -> https://docs.npmjs.com/downloading-and-installing-node-js-and-npm  
- Install https://www.scrypted.app/ and follow instructions on the website.  
- Once you have Scrypted running and can access it...continue  

- Open this plugin directory in VS Code  
- In a terminal cd into this project directory  
- run `npm install` 
- run `npm run build` 
- run `npm run scrypted-deploy 127.0.0.1` NOTE: you can replace `127.0.0.1` with the ip address of the server you installed scrypted on  

The  `Terminal` area may show an authentication failure and prompt you to log in to the Scrypted Management Console with `npx scrypted login`. You will only need to do this once. You can then relaunch afterwards.  The command if your scrypted instance is remote is `npx scrypted login ip:port`
  
- Launch Scrypted, go to "Devices"  
- You should see a device named `Nanit Camera Plugin`, click it  
- Enter your email and password on the right, then click save.   
- You'll receive the mfa token enter that in the "Two Factor Code" and click save again  
- Wait a few seconds then reload the page: Refresh Token, Access Token and Expiration should all have values  
- Now go back to devices and you should see a new device that is named the same as your Nanit Device. Click it and then click the video and it should be streaming!  


## Troubleshooting

If you aren't seeing the video load, first try clearing the Expiration value in the `Nanit Camera Plugin` and click save. This will force the plugin to get a new token.  

If you are still having issues then clear the `access_token` and `refresh_token` values and click save. 

Finally, Login again with your username and password + two factor auth by following instructions in above section

## Other Notes
Pre-buffering is prevented via `allowBatteryPrebuffer: false` in `getVideoStreamOptions` (main.ts), so Scrypted only connects to the Nanit stream on demand instead of staying connected 24/7. Earlier versions of this plugin achieved the same effect by declaring the camera as a Battery device (which Scrypted never pre-buffers); that has been removed since `allowBatteryPrebuffer: false` covers it directly without misrepresenting the device's capabilities.

Snapshot Photos may show a "Failed Snapshot" screen. This note dates from 2023-05-09 and
has NOT been re-verified since the snapshot path was reworked: `takePicture` now refreshes
auth before capturing and fails with an explicit message on a pending 2FA (`12185bc`),
validates its FFmpeg configuration (`344d20a`), and carries test coverage (`c38b625`). So
treat a failed snapshot as worth reporting rather than as a known-broken feature — the
error text should now say which of those it is. 

The Motion and Binary (sound/cry) sensors subscribe to Nanit's ActionCable event socket
(`subscribeToEvents` in `main.ts`) and raise/auto-reset their state from it. This is
NOT yet verified against a live camera — if a sensor never flips, suspect the
channel/message shape before assuming the plugin is broken. A failed subscribe only logs
and leaves the sensor at `false`, so a silently-stuck sensor is still possible if the
socket never connects.
 

## Importing into Home Assistant
### Method 1
- Under the camera, make sure the rebroadcast plugin is enabled. 
- In the Camera settings go to the Stream and there should be a "RTSP Rebroadcast URL" box. Copy that value
- In HomeAssistant add a camera entity -> https://www.home-assistant.io/integrations/generic/ 
  - The copied value is your "stream source"
  
### Method 2
- https://github.com/koush/scrypted/wiki/Installation:-Home-Assistant-OS
