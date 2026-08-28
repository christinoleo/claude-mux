/**
 * Offline Anthropic rates, extracted from LiteLLM's
 * `model_prices_and_context_window.json`.
 *
 * Only the Anthropic entries are embedded: this table exists so a host with
 * no outbound network still prices Claude Code sessions, and claude-mux never
 * prices anything else. Regenerate by re-reading the LiteLLM document and
 * keeping the unprefixed `claude-*` keys.
 */

export interface FallbackRate {
  input_cost_per_token: number;
  output_cost_per_token: number;
  cache_read_input_token_cost: number | null;
  cache_creation_input_token_cost: number | null;
  cache_creation_input_token_cost_above_1hr: number | null;
}

export const FALLBACK_RATES: Record<string, FallbackRate> = {
  "claude-3-7-sonnet-20250219": {
    input_cost_per_token: 3e-6,
    output_cost_per_token: 1.5e-5,
    cache_read_input_token_cost: 3e-7,
    cache_creation_input_token_cost: 3.75e-6,
    cache_creation_input_token_cost_above_1hr: 6e-6,
  },
  "claude-3-haiku-20240307": {
    input_cost_per_token: 2.5e-7,
    output_cost_per_token: 1.25e-6,
    cache_read_input_token_cost: 3e-8,
    cache_creation_input_token_cost: 3e-7,
    cache_creation_input_token_cost_above_1hr: 5e-7,
  },
  "claude-3-opus-20240229": {
    input_cost_per_token: 1.5e-5,
    output_cost_per_token: 7.5e-5,
    cache_read_input_token_cost: 1.5e-6,
    cache_creation_input_token_cost: 1.875e-5,
    cache_creation_input_token_cost_above_1hr: 3e-5,
  },
  "claude-4-opus-20250514": {
    input_cost_per_token: 1.5e-5,
    output_cost_per_token: 7.5e-5,
    cache_read_input_token_cost: 1.5e-6,
    cache_creation_input_token_cost: 1.875e-5,
    cache_creation_input_token_cost_above_1hr: null,
  },
  "claude-4-sonnet-20250514": {
    input_cost_per_token: 3e-6,
    output_cost_per_token: 1.5e-5,
    cache_read_input_token_cost: 3e-7,
    cache_creation_input_token_cost: 3.75e-6,
    cache_creation_input_token_cost_above_1hr: null,
  },
  "claude-fable-5": {
    input_cost_per_token: 1e-5,
    output_cost_per_token: 5e-5,
    cache_read_input_token_cost: 1e-6,
    cache_creation_input_token_cost: 1.25e-5,
    cache_creation_input_token_cost_above_1hr: 2e-5,
  },
  "claude-haiku-4-5": {
    input_cost_per_token: 1e-6,
    output_cost_per_token: 5e-6,
    cache_read_input_token_cost: 1e-7,
    cache_creation_input_token_cost: 1.25e-6,
    cache_creation_input_token_cost_above_1hr: 2e-6,
  },
  "claude-haiku-4-5-20251001": {
    input_cost_per_token: 1e-6,
    output_cost_per_token: 5e-6,
    cache_read_input_token_cost: 1e-7,
    cache_creation_input_token_cost: 1.25e-6,
    cache_creation_input_token_cost_above_1hr: 2e-6,
  },
  "claude-mythos-5": {
    input_cost_per_token: 1e-5,
    output_cost_per_token: 5e-5,
    cache_read_input_token_cost: 1e-6,
    cache_creation_input_token_cost: 1.25e-5,
    cache_creation_input_token_cost_above_1hr: 2e-5,
  },
  "claude-mythos-preview": {
    input_cost_per_token: 1e-5,
    output_cost_per_token: 5e-5,
    cache_read_input_token_cost: 1e-6,
    cache_creation_input_token_cost: 1.25e-5,
    cache_creation_input_token_cost_above_1hr: 2e-5,
  },
  "claude-opus-4-1": {
    input_cost_per_token: 1.5e-5,
    output_cost_per_token: 7.5e-5,
    cache_read_input_token_cost: 1.5e-6,
    cache_creation_input_token_cost: 1.875e-5,
    cache_creation_input_token_cost_above_1hr: 3e-5,
  },
  "claude-opus-4-1-20250805": {
    input_cost_per_token: 1.5e-5,
    output_cost_per_token: 7.5e-5,
    cache_read_input_token_cost: 1.5e-6,
    cache_creation_input_token_cost: 1.875e-5,
    cache_creation_input_token_cost_above_1hr: 3e-5,
  },
  "claude-opus-4-20250514": {
    input_cost_per_token: 1.5e-5,
    output_cost_per_token: 7.5e-5,
    cache_read_input_token_cost: 1.5e-6,
    cache_creation_input_token_cost: 1.875e-5,
    cache_creation_input_token_cost_above_1hr: 3e-5,
  },
  "claude-opus-4-5": {
    input_cost_per_token: 5e-6,
    output_cost_per_token: 2.5e-5,
    cache_read_input_token_cost: 5e-7,
    cache_creation_input_token_cost: 6.25e-6,
    cache_creation_input_token_cost_above_1hr: 1e-5,
  },
  "claude-opus-4-5-20251101": {
    input_cost_per_token: 5e-6,
    output_cost_per_token: 2.5e-5,
    cache_read_input_token_cost: 5e-7,
    cache_creation_input_token_cost: 6.25e-6,
    cache_creation_input_token_cost_above_1hr: 1e-5,
  },
  "claude-opus-4-6": {
    input_cost_per_token: 5e-6,
    output_cost_per_token: 2.5e-5,
    cache_read_input_token_cost: 5e-7,
    cache_creation_input_token_cost: 6.25e-6,
    cache_creation_input_token_cost_above_1hr: 1e-5,
  },
  "claude-opus-4-6-20260205": {
    input_cost_per_token: 5e-6,
    output_cost_per_token: 2.5e-5,
    cache_read_input_token_cost: 5e-7,
    cache_creation_input_token_cost: 6.25e-6,
    cache_creation_input_token_cost_above_1hr: 1e-5,
  },
  "claude-opus-4-7": {
    input_cost_per_token: 5e-6,
    output_cost_per_token: 2.5e-5,
    cache_read_input_token_cost: 5e-7,
    cache_creation_input_token_cost: 6.25e-6,
    cache_creation_input_token_cost_above_1hr: 1e-5,
  },
  "claude-opus-4-7-20260416": {
    input_cost_per_token: 5e-6,
    output_cost_per_token: 2.5e-5,
    cache_read_input_token_cost: 5e-7,
    cache_creation_input_token_cost: 6.25e-6,
    cache_creation_input_token_cost_above_1hr: 1e-5,
  },
  "claude-opus-4-8": {
    input_cost_per_token: 5e-6,
    output_cost_per_token: 2.5e-5,
    cache_read_input_token_cost: 5e-7,
    cache_creation_input_token_cost: 6.25e-6,
    cache_creation_input_token_cost_above_1hr: 1e-5,
  },
  "claude-opus-5": {
    input_cost_per_token: 5e-6,
    output_cost_per_token: 2.5e-5,
    cache_read_input_token_cost: 5e-7,
    cache_creation_input_token_cost: 6.25e-6,
    cache_creation_input_token_cost_above_1hr: 1e-5,
  },
  "claude-sonnet-4-20250514": {
    input_cost_per_token: 3e-6,
    output_cost_per_token: 1.5e-5,
    cache_read_input_token_cost: 3e-7,
    cache_creation_input_token_cost: 3.75e-6,
    cache_creation_input_token_cost_above_1hr: 6e-6,
  },
  "claude-sonnet-4-5": {
    input_cost_per_token: 3e-6,
    output_cost_per_token: 1.5e-5,
    cache_read_input_token_cost: 3e-7,
    cache_creation_input_token_cost: 3.75e-6,
    cache_creation_input_token_cost_above_1hr: 6e-6,
  },
  "claude-sonnet-4-5-20250929": {
    input_cost_per_token: 3e-6,
    output_cost_per_token: 1.5e-5,
    cache_read_input_token_cost: 3e-7,
    cache_creation_input_token_cost: 3.75e-6,
    cache_creation_input_token_cost_above_1hr: 6e-6,
  },
  "claude-sonnet-4-5-20250929-v1:0": {
    input_cost_per_token: 3e-6,
    output_cost_per_token: 1.5e-5,
    cache_read_input_token_cost: 3e-7,
    cache_creation_input_token_cost: 3.75e-6,
    cache_creation_input_token_cost_above_1hr: 6e-6,
  },
  "claude-sonnet-4-6": {
    input_cost_per_token: 3e-6,
    output_cost_per_token: 1.5e-5,
    cache_read_input_token_cost: 3e-7,
    cache_creation_input_token_cost: 3.75e-6,
    cache_creation_input_token_cost_above_1hr: 6e-6,
  },
  "claude-sonnet-5": {
    input_cost_per_token: 2e-6,
    output_cost_per_token: 1e-5,
    cache_read_input_token_cost: 2e-7,
    cache_creation_input_token_cost: 2.5e-6,
    cache_creation_input_token_cost_above_1hr: 4e-6,
  },
};
