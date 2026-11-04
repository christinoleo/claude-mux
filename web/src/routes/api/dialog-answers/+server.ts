import { readDialogAnswers, setDialogAnswers } from '$shared/server/dialog-switch.js';
import { hookSwitchRoute } from '$lib/server/hook-switch-route';

export const { GET, POST } = hookSwitchRoute({ read: readDialogAnswers, set: setDialogAnswers });
