import { env } from '$env/dynamic/private';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = () => {
	return {
		voiceEnabled: Boolean(env.GROQ_API_KEY)
	};
};
