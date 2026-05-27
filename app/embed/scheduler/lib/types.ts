export type PrimaryCategory = 'garage_door' | 'gate'

export type GDServiceType = 'repairs_service' | 'door_panel_replacement' | 'opener_service'
export type GateServiceType = 'repairs_service' | 'gate_opener_service' | 'new_gate_replacement'

export interface TimeWindow {
  start: string
  end: string
  label: string
}

export interface WindowAvailability extends TimeWindow {
  available: boolean
  reason?: 'full' | 'too_soon'
}

export interface DateAvailability {
  available: boolean
  windows: WindowAvailability[]
}

export interface SchedulerConfig {
  office_phone: string
  time_windows: TimeWindow[]
  scheduling_horizon_days: number
  available_days: number[]
  incentive_banner_enabled: boolean
  incentive_banner_text: string
  tcpa_copy: string
  marketing_sms_copy: string
  scheduling_enabled: boolean
  scheduling_disabled_message: string
}

export interface FlowState {
  currentStep: number

  // Step 1
  zip: string
  service_area_valid: boolean | null

  // Step 2
  first_name: string
  mobile_phone: string
  partial_lead_id: string | null

  // Step 3 — service
  primary_category: PrimaryCategory | null
  service_type: string | null

  // Step 3 — branch answers
  can_open_close: 'yes' | 'no' | null
  estimated_age: 'less_than_8_years' | '8_years_or_older' | 'not_sure' | null
  replacement_type: 'basic_functional' | 'nicer_more_features' | 'not_sure' | null
  multiple_doors: 'yes' | 'no' | null
  opener_need: 'repair_existing' | 'replace' | 'add_opener' | 'not_sure' | null
  gate_type: 'swing' | 'sliding' | 'pedestrian' | 'not_sure' | null

  // Step 4 — optional details
  optional_note: string
  uploaded_photo_urls: string[]

  // Step 5 — schedule
  appointment_date: string | null
  appointment_window_start: string | null
  appointment_window_end: string | null

  // Step 6 — property details
  address_line1: string
  address_city: string
  address_state: string
  address_zip: string
  address_is_owner: boolean
  customer_email: string
  additional_notes: string
}

export interface BookingPayload {
  // lead identity
  partial_lead_id?: string
  session_id?: string
  // contact
  first_name: string
  mobile_phone: string
  // service
  primary_category: PrimaryCategory
  service_type: string
  answers: {
    can_open_close?: string
    estimated_age?: string
    replacement_type?: string
    multiple_doors?: string
    opener_need?: string
    gate_type?: string
  }
  // optional details
  optional_note?: string
  uploaded_photo_urls?: string[]
  // schedule
  appointment_date: string
  appointment_window_start: string
  appointment_window_end: string
  // address
  address_line1: string
  address_city: string
  address_state: string
  address_zip: string
  address_is_owner: boolean
  customer_email?: string
  additional_notes?: string
  // widget
  widget_key: string
}

export interface PartialLeadPayload {
  zip: string
  first_name: string
  mobile_phone: string
  session_id: string
  widget_key: string
}

export interface BookingResponse {
  id: string
  appointment_date: string
  appointment_window_start: string
  appointment_window_end: string
  in_service_area: boolean
}

export type SubmitResult =
  | { ok: true; data: BookingResponse }
  | { ok: false; status: number; error: string }
