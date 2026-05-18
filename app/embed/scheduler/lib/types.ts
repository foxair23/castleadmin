export type ServiceType = 'garage_door' | 'gate';

export interface TimeWindow {
  start: string;
  end: string;
  label: string;
}

export interface SchedulerConfig {
  office_phone: string;
  time_windows: TimeWindow[];
  scheduling_horizon_days: number;
  available_days: number[];
  garage_door_categories: string[];
  gate_categories: string[];
  garage_door_issues: string[];
  gate_issues: string[];
  incentive_banner_enabled: boolean;
  incentive_banner_text: string;
  tcpa_copy: string;
  marketing_sms_copy: string;
  scheduling_enabled: boolean;
  scheduling_disabled_message: string;
}

export interface FlowState {
  currentStep: number;
  service_type: ServiceType | null;
  service_category: string | null;
  issues: string[];
  opener: string | null;
  door_type: string | null;
  customer_first_name: string;
  customer_last_name: string;
  customer_phone: string;
  customer_email: string;
  customer_sms_appointment_consent: boolean;
  customer_sms_marketing_consent: boolean;
  address_line1: string;
  address_line2: string;
  address_city: string;
  address_state: string;
  address_zip: string;
  address_is_owner: boolean;
  appointment_date: string | null;
  appointment_window_start: string | null;
  appointment_window_end: string | null;
  description: string;
}

export interface BookingPayload {
  service_type: ServiceType;
  service_category: string;
  diagnostic_answers: {
    issues: string[];
    opener: string;
    door_type: string;
  };
  customer_first_name: string;
  customer_last_name: string;
  customer_phone: string;
  customer_email: string;
  customer_sms_appointment_consent: boolean;
  customer_sms_marketing_consent: boolean;
  address_line1: string;
  address_line2?: string;
  address_city: string;
  address_state: string;
  address_zip: string;
  address_is_owner: boolean;
  appointment_date: string;
  appointment_window_start: string;
  appointment_window_end: string;
  description?: string;
}

export interface BookingResponse {
  id: string;
  appointment_date: string;
  appointment_window_start: string;
  appointment_window_end: string;
  in_service_area: boolean;
}
