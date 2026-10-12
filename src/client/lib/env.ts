/**
 * Frontend-public endpoints. By default the API and signaling server share
 * the page's origin; set VITE_API_BASE_URL / VITE_SIGNALING_URL at build time
 * only when the frontend is hosted separately from the backend.
 */
import { SIGNALING_PATH } from '../../shared/constants';

export function apiBaseUrl(): string {
  const configured = import.meta.env.VITE_API_BASE_URL as string | undefined;
  return (configured ?? '').replace(/\/+$/, '');
}

export function signalingUrl(): string {
  const configured = import.meta.env.VITE_SIGNALING_URL as string | undefined;
  if (configured) return configured;
  const base = apiBaseUrl();
  if (base) return base.replace(/^http/, 'ws') + SIGNALING_PATH;
  const { protocol, host } = window.location;
  return `${protocol === 'https:' ? 'wss' : 'ws'}://${host}${SIGNALING_PATH}`;
}

/** Absolute URL of a path on this app (used for QR codes and share links). */
export function appUrl(path: string): string {
  return new URL(path, window.location.origin).toString();
}

/** Web Crypto and the async Clipboard API require a secure context (HTTPS or localhost). */
export function isSecureContextAvailable(): boolean {
  return (
    typeof window !== 'undefined' && window.isSecureContext === true && !!globalThis.crypto?.subtle
  );
}

export function isWebRtcAvailable(): boolean {
  return typeof RTCPeerConnection !== 'undefined';
}
