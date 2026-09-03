/** The icon a tool call is drawn with, in the transcript and in the agent rail. */
export function toolIcon(name: string): string {
	const n = name.toLowerCase();
	if (n.includes('bash') || n.includes('command')) return 'mdi:console';
	if (n.includes('edit') || n.includes('write') || n.includes('notebook')) return 'mdi:file-edit-outline';
	if (n.includes('read')) return 'mdi:file-eye-outline';
	if (n.includes('grep') || n.includes('glob') || n.includes('search')) return 'mdi:magnify';
	if (n.includes('task') || n.includes('agent')) return 'mdi:robot-outline';
	if (n.includes('web')) return 'mdi:web';
	if (n.includes('todo')) return 'mdi:checkbox-marked-outline';
	return 'mdi:tools';
}
