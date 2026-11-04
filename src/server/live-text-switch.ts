/** The switch that turns live text on for this machine (`hook-switch.ts`). */

import { liveTextHookPort, withLiveTextHook, withoutLiveTextHook } from "../setup/live-text-hook.js";
import { hookSwitch } from "./hook-switch.js";

const liveText = hookSwitch({
  name: "live-text",
  port: liveTextHookPort,
  add: withLiveTextHook,
  remove: withoutLiveTextHook,
});

export const readLiveText = liveText.read;
export const setLiveText = liveText.set;
export const followLiveTextPort = liveText.follow;
