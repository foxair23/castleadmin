import { FlowState } from './types';

const STORAGE_KEY = 'castle_scheduler_flow_v1';

export const INITIAL_FLOW_STATE: FlowState = {
  currentStep: 1,
  service_type: null,
  service_category: null,
  issues: [],
  opener: null,
  door_type: null,
  customer_first_name: '',
  customer_last_name: '',
  customer_phone: '',
  customer_email: '',
  customer_sms_appointment_consent: false,
  customer_sms_marketing_consent: false,
  address_line1: '',
  address_line2: '',
  address_city: '',
  address_state: 'CA',
  address_zip: '',
  address_is_owner: true,
  appointment_date: null,
  appointment_window_start: null,
  appointment_window_end: null,
  description: '',
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
