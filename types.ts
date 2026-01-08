
export interface Message {
  id: string;
  role: 'user' | 'model';
  text: string;
  timestamp: number;
}

export interface PersonaConfig {
  name: string;
  instruction: string;
  voiceName: 'Zephyr' | 'Puck' | 'Charon' | 'Kore' | 'Fenrir';
}

export type SessionState = 'disconnected' | 'connecting' | 'connected' | 'error';
