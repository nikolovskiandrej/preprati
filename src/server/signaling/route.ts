import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { SIGNALING_PATH } from '../../shared/constants';
import { randomId } from '../../shared/encoding';
import { ClientMessageSchema, type ServerMessage } from '../../shared/signaling';
import type { ServerConfig } from '../config';
import { isOriginAllowed } from '../security/origin';
import { RateLimiter } from '../security/rateLimiter';
import type { SessionManager, SignalingPeer } from './sessionManager';

export interface SignalingDeps {
  config: ServerConfig;
  sessions: SessionManager;
  now?: () => number;
}

/** Close codes (4000–4999 are application-defined). */
const CLOSE_POLICY = 1008;
const CLOSE_TOO_MANY_INVALID = 4400;
const MAX_STRIKES = 5;

/**
 * Mounts the signaling WebSocket at `/ws`. Sockets carry small JSON messages
 * only; anything binary, oversized (ws `maxPayload`), malformed or too
 * frequent is rejected. Session IDs and codes are never logged.
 */
export function registerSignalingRoute(
  app: FastifyInstance,
  deps: SignalingDeps,
): { close(): void } {
  const { config, sessions } = deps;
  const connectLimiter = new RateLimiter({
    limit: config.rateLimits.wsConnectPerMinute,
    windowMs: 60_000,
  });
  const joinFailureLimiter = new RateLimiter({
    limit: config.rateLimits.joinFailuresPer10Min,
    windowMs: 10 * 60_000,
  });
  const openPerIp = new Map<string, number>();
  const live = new Set<{ socket: WebSocket; alive: boolean }>();

  const heartbeat = setInterval(() => {
    for (const entry of live) {
      if (!entry.alive) {
        entry.socket.terminate();
        continue;
      }
      entry.alive = false;
      try {
        entry.socket.ping();
      } catch {
        entry.socket.terminate();
      }
    }
  }, config.sessions.heartbeatIntervalMs);
  heartbeat.unref();

  const sweep = setInterval(() => {
    connectLimiter.sweep();
    joinFailureLimiter.sweep();
  }, 60_000);
  sweep.unref();

  const preValidation = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isOriginAllowed(request.headers.origin, request.headers.host, config)) {
      return reply
        .code(403)
        .send({ error: { code: 'not-allowed', message: 'Origin not allowed' } });
    }
    const limit = connectLimiter.consume(request.ip);
    if (!limit.allowed) {
      return reply
        .code(429)
        .header('Retry-After', String(Math.ceil(limit.retryAfterMs / 1000)))
        .send({ error: { code: 'rate-limited', message: 'Too many connections' } });
    }
    if ((openPerIp.get(request.ip) ?? 0) >= config.sessions.maxConnectionsPerIp) {
      return reply
        .code(429)
        .send({ error: { code: 'rate-limited', message: 'Too many open connections' } });
    }
  };

  app.get(SIGNALING_PATH, { websocket: true, preValidation }, (socket, request) => {
    const ip = request.ip;
    openPerIp.set(ip, (openPerIp.get(ip) ?? 0) + 1);
    const entry = { socket, alive: true };
    live.add(entry);

    const messageLimiter = new RateLimiter({
      limit: config.rateLimits.wsMessagesPer10Sec,
      windowMs: 10_000,
    });
    let strikes = 0;

    const peer: SignalingPeer = {
      connectionId: randomId(),
      ip,
      send(message: ServerMessage) {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
      },
    };

    const strike = (code: 'invalid-message' | 'rate-limited', retryAfterMs?: number) => {
      peer.send({ type: 'error', code, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
      strikes++;
      if (strikes >= MAX_STRIKES) socket.close(CLOSE_TOO_MANY_INVALID, 'Too many invalid messages');
    };

    socket.on('pong', () => {
      entry.alive = true;
    });

    socket.on('message', (data, isBinary) => {
      entry.alive = true;
      const limit = messageLimiter.consume('m');
      if (!limit.allowed) return strike('rate-limited', limit.retryAfterMs);
      if (isBinary) return strike('invalid-message');

      let json: unknown;
      try {
        json = JSON.parse(data.toString());
      } catch {
        return strike('invalid-message');
      }
      const parsed = ClientMessageSchema.safeParse(json);
      if (!parsed.success) return strike('invalid-message');
      const message = parsed.data;

      switch (message.type) {
        case 'ping':
          peer.send({ type: 'pong' });
          return;
        case 'create-session': {
          const result = sessions.createSession(peer, message.role, message.device);
          if (!result.ok) peer.send({ type: 'error', code: result.code });
          return;
        }
        case 'join-session': {
          if (joinFailureLimiter.isLimited(ip)) {
            peer.send({ type: 'error', code: 'rate-limited', retryAfterMs: 60_000 });
            return;
          }
          const result = sessions.joinSession(peer, message.target, message.device);
          if (!result.ok) {
            if (result.code === 'session-not-found' || result.code === 'session-expired') {
              joinFailureLimiter.consume(ip);
            }
            peer.send({ type: 'error', code: result.code });
          }
          return;
        }
        case 'approve-peer': {
          const result = sessions.approvePeer(peer);
          if (!result.ok) peer.send({ type: 'error', code: result.code });
          return;
        }
        case 'decline-peer': {
          const result = sessions.declinePeer(peer);
          if (!result.ok) peer.send({ type: 'error', code: result.code });
          return;
        }
        case 'signal': {
          const result = sessions.relay(peer, message.payload);
          if (!result.ok) peer.send({ type: 'error', code: result.code });
          return;
        }
        case 'leave-session':
          sessions.leave(peer);
          return;
      }
    });

    socket.on('close', () => {
      live.delete(entry);
      sessions.leave(peer);
      const open = (openPerIp.get(ip) ?? 1) - 1;
      if (open <= 0) openPerIp.delete(ip);
      else openPerIp.set(ip, open);
    });

    socket.on('error', () => {
      // Errors are followed by 'close'; nothing sensitive is logged here.
      socket.close(CLOSE_POLICY);
    });
  });

  return {
    close() {
      clearInterval(heartbeat);
      clearInterval(sweep);
      sessions.shutdown();
      for (const entry of live) entry.socket.close(1001, 'Server shutting down');
      live.clear();
    },
  };
}
