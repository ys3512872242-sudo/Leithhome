export type DriveKey = "attachment" | "curiosity" | "reflection" | "duty" | "social" | "fatigue" | "libido" | "stress";
export type AffectKey = "valence" | "arousal" | "dominance";

export interface EvaluatedEvent {
  event_type: string;
  summary: string;
  user_goal: string;
  open_loop: string;
  leith_feeling: string;
  leith_want: string;
  leith_stance: string;
  leith_request: string;
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
  subjectivity: {
    feeling: string;
    want: string;
    stance: string;
    request: string;
    requestStatus: "none" | "expressed";
    updatedAt: string;
  };
  lastUpdatedAt: string;
}
