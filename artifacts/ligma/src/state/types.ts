export type Role = 'Lead' | 'Contributor' | 'Viewer';
export type IntentType = 'action_item' | 'decision' | 'open_question' | 'reference';
export type NodeKind = 'sticky' | 'rect' | 'text' | 'draw';

export interface CanvasNode {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  text: string;
  points?: Array<[number, number]>;
  ownerId?: string | null;
  lockedToRole?: string | null;
  intent?: IntentType | null;
  intentConfidence?: number;
  intentSource?: 'keyword' | 'ai' | null;
  createdAt?: number;
  updatedAt?: number;
}

export interface CursorState {
  userId: string;
  userName: string;
  color: string;
  x: number;
  y: number;
}

export interface OpPayload extends Partial<CanvasNode> {}

export interface Op {
  id: string;
  type: 'add_node' | 'update_node' | 'delete_node' | 'lock_node';
  nodeId: string;
  userId: string;
  baseRevision: number;
  payload: OpPayload;
  timestamp: number;
}

export interface CommittedOp extends Op {
  revision: number;
}

export interface User {
  id: string;
  name: string;
  role: Role;
  color: string;
}

export interface Session {
  id: string;
  name: string;
  created_at: string;
}

export interface EventRow {
  id: string;
  seq_num: string;
  event_type: string;
  node_id: string | null;
  user_id: string | null;
  payload: Record<string, unknown> | null;
  timestamp: string;
}

export interface Task {
  id: string;
  node_id: string;
  title: string;
  intent_type: IntentType;
  confirmed_by_ai: boolean;
  created_at: string;
  updated_at: string;
  author_name?: string;
  author_color?: string;
}
