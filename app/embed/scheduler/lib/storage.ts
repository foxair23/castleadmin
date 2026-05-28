import { FlowState } from './types';

const STORAGE_KEY = 'castle_scheduler_flow_v1';

export const INITIAL_FLOW_STATE: FlowState = {
  currentStep: 1,

  // Step 1
  zip: '',
  service_area_valid: null,

  // Step 2
  first_name: '',
  mobile_phone: '',
  partial_lead_id: null,

  // Step 3 — service
  primary_category: null,
  service_type: null,

  // Step 3 — branch answers
  can_open_close: null,
  estimated_age: null,
  replacement_type: null,
  multiple_doors: null,
  opener_need: null,
  gate_type: null,

  // Step 4 — optional details
  optional_note: '',
  uploaded_photo_urls: [],

  // Step 5 — schedule
  appointment_date: null,
  appointment_window_start: null,
  appointment_window_end: null,

  // Step 6 — property details
  address_line1: '',
  address_city: '',
  address_state: 'CA',
  address_zip: '',
  address_is_owner: true,
  customer_email: '',
  customer_last_name: '',
  additional_notes: '',
};

export function loadFlowState(): FlowState {
  if (typeof window === 'undefined') return INITIAL_FLOW_STATE;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return INITIAL_FLOW_STATE;
    return { ...INITIAL_FLOW_STATE, ...JSON.parse(raw) };
  } catch {
    return INITIAL_FLOW_STATE;
  }
}

export function saveFlowState(state: FlowState): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

export function clearFlowState(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
