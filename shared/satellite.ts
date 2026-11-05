import type { FrameSettings, Media } from './model.js';
import type { PowerPhase } from './power.js';

export type PlaybackAction = 'previous' | 'pause' | 'resume' | 'next';
export interface PlaybackCommand {
  id: string;
  action: PlaybackAction;
  expiresAt: number;
}
export interface PlaybackSnapshot {
  asset: Media | null;
  phase: 'loading' | 'photo' | 'motion' | 'video' | 'still';
  paused: boolean;
  position: number;
  duration: number | null;
  viewport: { width: number; height: number };
  fit: FrameSettings['fit'];
  videoSource: FrameSettings['videoSource'];
  foregroundTransform: string;
  foregroundOrigin: string;
  reportedAt: string;
}
export interface UpdateState {
  managedBy: string | null;
  requested: { id: string; requestedAt: string } | null;
  result: { id: string; state: 'running' | 'succeeded' | 'failed'; message: string; reportedAt: string } | null;
  agentSeenAt: string | null;
}
export interface SatelliteInfo {
  id: string;
  apiVersion: 1;
  version: string;
  name: string;
  settings: FrameSettings;
  playback: PlaybackSnapshot | null;
  playerOnline: boolean;
  update: UpdateState;
  display?: DisplayState;
}
export interface DisplayState {
  connected: boolean;
  sleeping: boolean | null;
  timeZone: string | null;
  error: string | null;
  phase?: PowerPhase;
  kioskRunning?: boolean | null;
}
export interface SatelliteRecord {
  id: string;
  address: string;
  snapshot: SatelliteInfo;
  lastSeenAt: string;
  pendingSettings: Partial<FrameSettings> | null;
  error: string | null;
}
export interface HubState {
  id: string;
  updatePolicy: 'manual' | 'automatic';
  lastUpdateCheck: string | null;
  satellites: SatelliteRecord[];
}
