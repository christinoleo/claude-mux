import { readLiveText, setLiveText } from '$shared/server/live-text-switch.js';
import { hookSwitchRoute } from '$lib/server/hook-switch-route';

export const { GET, POST } = hookSwitchRoute({ read: readLiveText, set: setLiveText });
