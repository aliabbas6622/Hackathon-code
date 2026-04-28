import axios from 'axios';
import type { Session, User, Role, Task, EventRow } from './types';

const BASE = '/api';

export const api = {
  sessions: {
    list: () => axios.get<Session[]>(`${BASE}/sessions`).then((r) => r.data),
    create: (name: string) => axios.post<Session>(`${BASE}/sessions`, { name }).then((r) => r.data),
  },

  users: {
    list: () => axios.get<User[]>(`${BASE}/users`).then((r) => r.data),
    create: (name: string, role: Role, color: string) =>
      axios.post<User>(`${BASE}/users`, { name, role, color }).then((r) => r.data),
    updateRole: (id: string, role: Role) =>
      axios.patch<User>(`${BASE}/users/${id}`, { role }).then((r) => r.data),
  },

  tasks: {
    list: (sessionId: string) =>
      axios.get<Task[]>(`${BASE}/tasks/${sessionId}`).then((r) => r.data),
  },

  events: {
    list: (sessionId: string) =>
      axios.get<EventRow[]>(`${BASE}/events/${sessionId}`).then((r) => r.data),
  },

  replay: {
    get: (sessionId: string, seq: number) =>
      axios.get<{ events: EventRow[] }>(`${BASE}/replay/${sessionId}?seq=${seq}`).then((r) => r.data),
  },

  classify: {
    text: (text: string) =>
      axios.post(`${BASE}/classify`, { text }).then((r) => r.data),
  },
};
