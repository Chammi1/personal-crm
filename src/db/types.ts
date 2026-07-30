export type Circle = 0 | 1 | 2 | 3 | 4;
export type PersonStatus = 'active' | 'paused' | 'archived';
export type Channel = 'message' | 'call' | 'meeting' | 'event';
export type EventKind = 'birthday' | 'anniversary' | 'custom';
export type TaskDirection = 'i_owe' | 'they_owe';

export interface Person {
  id: number;
  name: string;
  aliases: string | null;
  telegram: string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  circle: Circle;
  target_interval: number | null;
  met_on: string | null;
  met_context: string | null;
  met_via: number | null;
  is_connector: number;
  is_condenser: number;
  interest: number | null;
  difficulty: number | null;
  risk: number | null;
  status: PersonStatus;
  layout_angle: number | null;
  avatar: string | null;
  rapport: number | null;
  is_stub: number;
  created_at: string;
  updated_at: string;
}

export interface Dossier {
  person_id: number;
  family: string | null;
  occupation: string | null;
  recreation: string | null;
  dreams: string | null;
  hooks: string | null;
  avoid: string | null;
  gift_ideas: string | null;
  updated_at: string;
}

export interface Interaction {
  id: number;
  person_id: number;
  happened_on: string;
  channel: Channel;
  initiator: 'me' | 'them';
  summary: string | null;
  created_at: string;
}

export interface Note {
  id: number;
  person_id: number;
  written_on: string;
  body: string;
  source: 'manual' | 'voice' | 'import';
  created_at: string;
}

export interface PersonEvent {
  id: number;
  person_id: number;
  kind: EventKind;
  title: string | null;
  event_date: string;
  recurring: number;
  lead_days: number;
  pet_id: number | null;
  handled_for: string | null;
  created_at: string;
}

export interface Task {
  id: number;
  person_id: number;
  direction: TaskDirection;
  body: string;
  due_on: string | null;
  done_at: string | null;
  created_at: string;
}
