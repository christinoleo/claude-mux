/**
 * The switch that lets this machine's dashboard answer dialogs through
 * `PermissionRequest` (`hook-switch.ts`). Removable with no release, because it
 * holds a hook in every session.
 */

import { dialogHookPort, withDialogHook, withoutDialogHook } from "../setup/dialog-hook.js";
import { hookSwitch } from "./hook-switch.js";

const dialogAnswers = hookSwitch({
  name: "dialog-answers",
  port: dialogHookPort,
  add: withDialogHook,
  remove: withoutDialogHook,
});

export const readDialogAnswers = dialogAnswers.read;
export const setDialogAnswers = dialogAnswers.set;
export const followDialogAnswersPort = dialogAnswers.follow;
