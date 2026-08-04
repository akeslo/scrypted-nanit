
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

The Snapshot Photos are not working right now. You may see a "Failed Snapshot" screen until I can get that working. 

The Motion and Binary (sound/cry) sensors are declared but never fire. Each camera is
registered with the `MotionSensor` and `BinarySensor` interfaces, and the plugin has the
code to raise and auto-reset both states, but nothing subscribes to Nanit's event stream
yet — so the sensors sit at `false` forever. They show up in Scrypted and in anything
downstream (HomeKit, Home Assistant), which makes them look wired up: an automation built
on "motion detected" on a Nanit camera will simply never run. The interfaces are left in
place so the sensors do not disappear from existing setups when event subscription lands. 
 

## Importing into Home Assistant
### Method 1
- Under the camera, make sure the rebroadcast plugin is enabled. 
- In the Camera settings go to the Stream and there should be a "RTSP Rebroadcast URL" box. Copy that value
- In HomeAssistant add a camera entity -> https://www.home-assistant.io/integrations/generic/ 
  - The copied value is your "stream source"
  
### Method 2
- https://github.com/koush/scrypted/wiki/Installation:-Home-Assistant-OS
