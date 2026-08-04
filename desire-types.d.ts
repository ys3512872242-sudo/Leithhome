export type DriveKey = "attachment" | "curiosity" | "reflection" | "duty" | "social" | "fatigue" | "libido" | "stress";
export type AffectKey = "happiness" | "anger" | "grievance";

export interface EvaluatedEvent {
  event_type: string;
  summary: string;
  relevance: number;
  novelty: number;
  goal_congruence: number;
  intimacy: number;
  threat: number;
  certainty: number;
  topics: string[];
}

export interface Thought {
  id: string;
  text: string;
  drive_key: DriveKey;
  kind: "flit" | "fixation";
  strength: number;
  source_event_id: string | null;
  born_at: string;
  updated_at: string;
  fed_count: number;
  status: "active" | "satisfied" | "dismissed";
  can_upgrade_to_fixation: boolean;
}

export interface Intent {
  id: string;
  want_action: string;
  drive_key: DriveKey;
  reason: string;
  score: number;
  query_hint: string;
  selected_at: string;
  status: "active" | "satisfied";
}

export interface DesireState {
  schemaVersion: 1;
  version: number;
  drives: Record<DriveKey, number>;
  affect: Record<AffectKey, number>;
  baselines: { drives: Record<DriveKey, number>; affect: Record<AffectKey, number> };
  refractory: Partial<Record<DriveKey, string>>;
  thoughts: Thought[];
  recentEvents: Array<{ type: string; at: string; sourceEventId: string }>;
  intent: Intent | null;
  lastUpdatedAt: string;
}
