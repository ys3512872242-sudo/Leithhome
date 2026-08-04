export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      action_log: {
        Row: {
          action_type: string
          assistant_message_id: string
          created_at: string
          drive_delta: Json
          id: number
          intent_id: string | null
          result: Json
          satisfied: boolean
          source_event_id: string | null
        }
        Insert: {
          action_type: string
          assistant_message_id: string
          created_at?: string
          drive_delta?: Json
          id?: never
          intent_id?: string | null
          result?: Json
          satisfied?: boolean
          source_event_id?: string | null
        }
        Update: {
          action_type?: string
          assistant_message_id?: string
          created_at?: string
          drive_delta?: Json
          id?: never
          intent_id?: string | null
          result?: Json
          satisfied?: boolean
          source_event_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "action_log_intent_id_fkey"
            columns: ["intent_id"]
            isOneToOne: false
            referencedRelation: "intents"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_state: {
        Row: {
          agent_id: string
          created_at: string
          feature_flags: Json
          last_updated_at: string
          schema_version: number
          state: Json
          updated_at: string
          version: number
        }
        Insert: {
          agent_id: string
          created_at?: string
          feature_flags?: Json
          last_updated_at?: string
          schema_version?: number
          state: Json
          updated_at?: string
          version?: number
        }
        Update: {
          agent_id?: string
          created_at?: string
          feature_flags?: Json
          last_updated_at?: string
          schema_version?: number
          state?: Json
          updated_at?: string
          version?: number
        }
        Relationships: []
      }
      app_state: {
        Row: {
          state_key: string
          updated_at: string
          value: Json
        }
        Insert: {
          state_key: string
          updated_at?: string
          value?: Json
        }
        Update: {
          state_key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      diary_entries: {
        Row: {
          content: string
          covered_until: string | null
          created_at: string | null
          date_str: string
          id: number
          intimacy: Json
          keywords: string | null
          nicknames: string | null
          period: string | null
          period_end: string | null
          period_start: string | null
        }
        Insert: {
          content: string
          covered_until?: string | null
          created_at?: string | null
          date_str: string
          id?: never
          intimacy?: Json
          keywords?: string | null
          nicknames?: string | null
          period?: string | null
          period_end?: string | null
          period_start?: string | null
        }
        Update: {
          content?: string
          covered_until?: string | null
          created_at?: string | null
          date_str?: string
          id?: never
          intimacy?: Json
          keywords?: string | null
          nicknames?: string | null
          period?: string | null
          period_end?: string | null
          period_start?: string | null
        }
        Relationships: []
      }
      intents: {
        Row: {
          created_at: string
          drive_key: string
          id: string
          query_hint: string | null
          reason: string
          refractory_until: string | null
          score: number
          selected_at: string
          source_event_id: string | null
          status: string
          want_action: string
        }
        Insert: {
          created_at?: string
          drive_key: string
          id: string
          query_hint?: string | null
          reason: string
          refractory_until?: string | null
          score: number
          selected_at: string
          source_event_id?: string | null
          status?: string
          want_action: string
        }
        Update: {
          created_at?: string
          drive_key?: string
          id?: string
          query_hint?: string | null
          reason?: string
          refractory_until?: string | null
          score?: number
          selected_at?: string
          source_event_id?: string | null
          status?: string
          want_action?: string
        }
        Relationships: []
      }
      legacy_state_log: {
        Row: {
          captured_at: string
          id: number
          snapshot: Json
          source_state_key: string
        }
        Insert: {
          captured_at?: string
          id?: never
          snapshot: Json
          source_state_key: string
        }
        Update: {
          captured_at?: string
          id?: never
          snapshot?: Json
          source_state_key?: string
        }
        Relationships: []
      }
      memories: {
        Row: {
          content: string | null
          created_at: string
          id: number
          role: string | null
          thread_id: string | null
          type: string | null
        }
        Insert: {
          content?: string | null
          created_at?: string
          id?: number
          role?: string | null
          thread_id?: string | null
          type?: string | null
        }
        Update: {
          content?: string | null
          created_at?: string
          id?: number
          role?: string | null
          thread_id?: string | null
          type?: string | null
        }
        Relationships: []
      }
      shared_books: {
        Row: {
          content: string
          created_at: string | null
          id: string
          name: string
          owner_progress: number | null
          partner_progress: number | null
        }
        Insert: {
          content: string
          created_at?: string | null
          id: string
          name: string
          owner_progress?: number | null
          partner_progress?: number | null
        }
        Update: {
          content?: string
          created_at?: string | null
          id?: string
          name?: string
          owner_progress?: number | null
          partner_progress?: number | null
        }
        Relationships: []
      }
      shared_links: {
        Row: {
          created_at: string | null
          id: string
          note: string | null
          url: string
        }
        Insert: {
          created_at?: string | null
          id: string
          note?: string | null
          url: string
        }
        Update: {
          created_at?: string | null
          id?: string
          note?: string | null
          url?: string
        }
        Relationships: []
      }
      state_changes: {
        Row: {
          after_state: Json
          agent_id: string
          before_state: Json
          cause_event_id: string | null
          created_at: string
          delta: Json
          id: number
          mechanism: string
          reasons: Json
          state_version: number
        }
        Insert: {
          after_state: Json
          agent_id: string
          before_state: Json
          cause_event_id?: string | null
          created_at?: string
          delta: Json
          id?: never
          mechanism: string
          reasons?: Json
          state_version: number
        }
        Update: {
          after_state?: Json
          agent_id?: string
          before_state?: Json
          cause_event_id?: string | null
          created_at?: string
          delta?: Json
          id?: never
          mechanism?: string
          reasons?: Json
          state_version?: number
        }
        Relationships: [
          {
            foreignKeyName: "state_changes_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agent_state"
            referencedColumns: ["agent_id"]
          },
          {
            foreignKeyName: "state_changes_cause_event_id_fkey"
            columns: ["cause_event_id"]
            isOneToOne: false
            referencedRelation: "state_events"
            referencedColumns: ["id"]
          },
        ]
      }
      state_events: {
        Row: {
          appraisal: Json
          created_at: string
          event_type: string
          id: string
          occurred_at: string
          source_event_id: string
          source_kind: string
          summary: string
          topics: string[]
        }
        Insert: {
          appraisal: Json
          created_at?: string
          event_type: string
          id?: string
          occurred_at: string
          source_event_id: string
          source_kind?: string
          summary: string
          topics?: string[]
        }
        Update: {
          appraisal?: Json
          created_at?: string
          event_type?: string
          id?: string
          occurred_at?: string
          source_event_id?: string
          source_kind?: string
          summary?: string
          topics?: string[]
        }
        Relationships: []
      }
      state_token_usage: {
        Row: {
          completion_tokens: number | null
          created_at: string
          estimated: boolean
          event_tokens: number
          id: number
          model: string | null
          prompt_tokens: number | null
          provider: string | null
          source_message_id: string
          state_capsule_tokens: number
        }
        Insert: {
          completion_tokens?: number | null
          created_at?: string
          estimated?: boolean
          event_tokens?: number
          id?: never
          model?: string | null
          prompt_tokens?: number | null
          provider?: string | null
          source_message_id: string
          state_capsule_tokens?: number
        }
        Update: {
          completion_tokens?: number | null
          created_at?: string
          estimated?: boolean
          event_tokens?: number
          id?: never
          model?: string | null
          prompt_tokens?: number | null
          provider?: string | null
          source_message_id?: string
          state_capsule_tokens?: number
        }
        Relationships: []
      }
      thoughts: {
        Row: {
          born_at: string
          can_upgrade_to_fixation: boolean
          drive_key: string
          fed_count: number
          id: string
          kind: string
          source_event_id: string | null
          status: string
          strength: number
          text: string
          updated_at: string
        }
        Insert: {
          born_at: string
          can_upgrade_to_fixation?: boolean
          drive_key: string
          fed_count?: number
          id: string
          kind?: string
          source_event_id?: string | null
          status?: string
          strength: number
          text: string
          updated_at: string
        }
        Update: {
          born_at?: string
          can_upgrade_to_fixation?: boolean
          drive_key?: string
          fed_count?: number
          id?: string
          kind?: string
          source_event_id?: string | null
          status?: string
          strength?: number
          text?: string
          updated_at?: string
        }
        Relationships: []
      }
      wardrobe_items: {
        Row: {
          anchors: Json
          created_at: string
          description: string
          enabled: boolean
          id: string
          image_path: string
          name: string
          opacity: number
          price: number
          series_id: string | null
          series_name: string | null
          series_order: number | null
          slot: string
          transform: Json
          updated_at: string
          z_index: number
        }
        Insert: {
          anchors?: Json
          created_at?: string
          description?: string
          enabled?: boolean
          id: string
          image_path: string
          name: string
          opacity?: number
          price?: number
          series_id?: string | null
          series_name?: string | null
          series_order?: number | null
          slot: string
          transform?: Json
          updated_at?: string
          z_index?: number
        }
        Update: {
          anchors?: Json
          created_at?: string
          description?: string
          enabled?: boolean
          id?: string
          image_path?: string
          name?: string
          opacity?: number
          price?: number
          series_id?: string | null
          series_name?: string | null
          series_order?: number | null
          slot?: string
          transform?: Json
          updated_at?: string
          z_index?: number
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      commit_desire_event_v1: {
        Args: {
          p_after: Json
          p_before: Json
          p_delta: Json
          p_event: Json
          p_expected_version: number
          p_intent: Json
          p_occurred_at: string
          p_reasons: Json
          p_source_event_id: string
          p_source_kind: string
        }
        Returns: Json
      }
      complete_desire_action_v1: {
        Args: {
          p_after: Json
          p_assistant_message_id: string
          p_before: Json
          p_delta: Json
          p_expected_version: number
          p_intent: Json
          p_reasons: Json
          p_source_event_id: string
        }
        Returns: Json
      }
      leith_change_passcode: {
        Args: { p_current: string; p_new: string }
        Returns: string
      }
      leith_lock_status: { Args: never; Returns: boolean }
      leith_session_valid: { Args: never; Returns: boolean }
      leith_unlock: { Args: { p_passcode: string }; Returns: string }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

