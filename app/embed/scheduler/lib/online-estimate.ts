import { FlowState, SchedulerConfig } from './types';

// "Free Online Estimate" is offered only for install/replacement garage-door work
// that would otherwise be a FREE in-person estimate: a new door/panel, or a new /
// added opener. Anything needing diagnosis (repairs, opener "repair existing" or
// "not sure", maintenance, gates) stays on the book-a-visit path.
export function isOnlineEstimateEligible(state: FlowState, config: SchedulerConfig): boolean {
  if (!config.online_estimate_enabled) return false;
  if (state.primary_category !== 'garage_door') return false;
  if (state.service_type === 'door_panel_replacement') return true;
  if (state.service_type === 'opener_service') {
    return state.opener_need === 'replace' || state.opener_need === 'add_opener';
  }
  return false;
}

export interface GuidedShot {
  slot: string;
  label: string;
  hint: string;
  kind: 'photo' | 'video';
  optional?: boolean;
}

// The prescribed capture list, tailored to the job. Photos are encouraged, never
// required; a quality meter reflects how many are done.
export function getGuidedShots(state: FlowState): GuidedShot[] {
  if (state.service_type === 'opener_service') {
    return [
      { slot: 'opener_motor', label: 'Opener motor', hint: 'The motor unit hanging from the ceiling.', kind: 'photo' },
      { slot: 'opener_label', label: 'Model label', hint: 'Close-up of the brand/model label, if you can reach it.', kind: 'photo' },
      { slot: 'inside_door', label: 'Inside — whole door', hint: 'From inside the garage, door closed.', kind: 'photo' },
      { slot: 'operating_video', label: 'Short video (optional)', hint: '10-second clip of the door operating. Stay clear of moving parts.', kind: 'video', optional: true },
    ];
  }
  // door_panel_replacement (new door / panel)
  return [
    { slot: 'outside_door', label: 'Outside — whole door', hint: 'Stand back far enough to capture the entire door.', kind: 'photo' },
    { slot: 'inside_door', label: 'Inside — whole door', hint: 'From inside the garage, door closed.', kind: 'photo' },
    { slot: 'opening_framing', label: 'Opening & framing', hint: 'The opening and the surrounding framing/stucco.', kind: 'photo' },
    { slot: 'problem_area', label: 'Anything notable (optional)', hint: 'Close-up of anything damaged, worn, or unusual.', kind: 'photo', optional: true },
  ];
}

export const ONLINE_ESTIMATE_DISCLAIMER =
  'This is a preliminary estimate, subject to onsite verification — especially where measurements, hidden damage, structural conditions, or additional required parts can’t be confirmed from photos.';

export const ONLINE_ESTIMATE_TURNAROUND = 'within 1–2 business days';
