<script lang="ts">
	import AskQuestionPanel from '$lib/components/AskQuestionPanel.svelte';
	import type { PendingQuestion } from '$lib/stores/sessions.svelte';

	const singleSelect: PendingQuestion = {
		started_at: 1,
		questions: [{
			question: 'Which color do you prefer?',
			header: 'Single choice',
			multiSelect: false,
			options: [
				{ label: 'Red', description: 'Warm and energetic' },
				{ label: 'Blue', description: 'Cool and calm' },
				{ label: 'Green', description: 'Natural and fresh' },
			]
		}]
	};

	const multiSelect: PendingQuestion = {
		started_at: 2,
		questions: [{
			question: 'Which features matter most to you?',
			header: 'Multi choice',
			multiSelect: true,
			options: [
				{ label: 'Mobile UX', description: 'Works great on phone' },
				{ label: 'Speed', description: 'Fast response times' },
				{ label: 'Dark mode', description: 'Easy on the eyes' },
			]
		}]
	};

	const noOptions: PendingQuestion = {
		started_at: 3,
		questions: [{
			question: 'What is the capital of France?',
			header: 'Free text',
			multiSelect: false,
			options: []
		}]
	};

	// Fake tmux target — send calls will fail but that's fine for visual testing
	const fakeTarget = 'test:0.0';
</script>

<div style="background: #0a0a0a; min-height: 100vh; padding: 24px; display: flex; flex-direction: column; gap: 32px;">
	<h2 style="color: #888; font-size: 12px; text-transform: uppercase; letter-spacing: 0.1em; margin: 0;">AskQuestionPanel — visual test</h2>

	<div>
		<div style="color: #555; font-size: 11px; margin-bottom: 8px;">SINGLE SELECT</div>
		<div style="max-width: 480px; border: 1px solid #222; border-radius: 8px; overflow: hidden;">
			<AskQuestionPanel question={singleSelect} target={fakeTarget} />
		</div>
	</div>

	<div>
		<div style="color: #555; font-size: 11px; margin-bottom: 8px;">MULTI SELECT</div>
		<div style="max-width: 480px; border: 1px solid #222; border-radius: 8px; overflow: hidden;">
			<AskQuestionPanel question={multiSelect} target={fakeTarget} />
		</div>
	</div>

	<div>
		<div style="color: #555; font-size: 11px; margin-bottom: 8px;">FREE TEXT ONLY</div>
		<div style="max-width: 480px; border: 1px solid #222; border-radius: 8px; overflow: hidden;">
			<AskQuestionPanel question={noOptions} target={fakeTarget} />
		</div>
	</div>
</div>
