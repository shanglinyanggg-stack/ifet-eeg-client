import { describe, expect, test } from 'vitest';
import { normalizeSleepEndpoint, toServiceObservation } from './sleep-staging-client';

describe('sleep staging client', () => {
  test('normalizes the local endpoint', () => {
    expect(normalizeSleepEndpoint(' http://127.0.0.1:8765/ ')).toBe('http://127.0.0.1:8765');
    expect(() => normalizeSleepEndpoint('https://example.com')).toThrow(/local/i);
  });

  test('maps the formal intervention action for the session state machine', () => {
    const observation = toServiceObservation({
      decision_valid: true,
      selected_prediction3: 1,
      selected_stage: 'NREM',
      selected_sleep_probability: 0.86,
      sleep_detected: true,
      intervention_action_candidate: 'stop_music',
      intervention_action: 'hold_previous_state',
      autonomous_music_allowed: false,
      coverage: 0.94,
      maximum_contiguous_gap_seconds: 0.12
    });

    expect(observation.interventionActionCandidate).toBe('stop_music');
    expect(observation.interventionAction).toBe('hold_previous_state');
    expect(observation.autonomousMusicAllowed).toBe(false);
  });
});
