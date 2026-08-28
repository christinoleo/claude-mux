<script lang="ts">
	import { cn, type WithElementRef, type WithoutChildren } from "$lib/utils.js";
	import type { HTMLInputAttributes } from "svelte/elements";

	let {
		ref = $bindable(null),
		value = $bindable(),
		class: className,
		"data-slot": dataSlot = "input",
		...restProps
	}: WithoutChildren<WithElementRef<HTMLInputAttributes>> = $props();
</script>

<input
	bind:this={ref}
	data-slot={dataSlot}
	class={cn(
		"border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 flex h-10 w-full min-w-0 rounded-md border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50 focus-visible:ring-[3px]",
		className
	)}
	bind:value
	{...restProps}
/>
