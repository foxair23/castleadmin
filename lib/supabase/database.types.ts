export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string
          full_name: string
          role: 'technician' | 'admin'
          is_active: boolean
          created_at: string
        }
        Insert: {
          id: string
          full_name: string
          role: 'technician' | 'admin'
          is_active?: boolean
          created_at?: string
        }
        Update: {
          id?: string
          full_name?: string
          role?: 'technician' | 'admin'
          is_active?: boolean
          created_at?: string
        }
      }
      job_types: {
        Row: {
          id: string
          name: string
          base_rate: number
          additional_rate: number | null
          requires_quantity: boolean
          is_active: boolean
          created_at: string
        }
        Insert: {
          id?: string
          name: string
          base_rate: number
          additional_rate?: number | null
          requires_quantity?: boolean
          is_active?: boolean
          created_at?: string
        }
        Update: {
          id?: string
          name?: string
          base_rate?: number
          additional_rate?: number | null
          requires_quantity?: boolean
          is_active?: boolean
          created_at?: string
        }
      }
      jobs: {
        Row: {
          id: string
          tech_id: string
          work_date: string
          job_name: string
          notes: string | null
          total_pay: number
          week_start_date: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          tech_id: string
          work_date: string
          job_name: string
          notes?: string | null
          total_pay: number
          week_start_date: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          tech_id?: string
          work_date?: string
          job_name?: string
          notes?: string | null
          total_pay?: number
          week_start_date?: string
          created_at?: string
          updated_at?: string
        }
      }
      job_work_items: {
        Row: {
          id: string
          job_id: string
          job_type_id: string
          quantity: number
          calculated_pay: number
        }
        Insert: {
          id?: string
          job_id: string
          job_type_id: string
          quantity?: number
          calculated_pay: number
        }
        Update: {
          id?: string
          job_id?: string
          job_type_id?: string
          quantity?: number
          calculated_pay?: number
        }
      }
      week_submissions: {
        Row: {
          id: string
          tech_id: string
          week_start_date: string
          submitted_at: string
        }
        Insert: {
          id?: string
          tech_id: string
          week_start_date: string
          submitted_at?: string
        }
        Update: {
          id?: string
          tech_id?: string
          week_start_date?: string
          submitted_at?: string
        }
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
  }
}
