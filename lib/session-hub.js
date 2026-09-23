/**
 * In-memory hub of Streamable HTTP MCP sessions, keyed by session id.
 * Used to fan out OpenProject events (Ready / comment / assign) as
 * MCP logging notifications to matching seat sessions.
 *
 * Matching is Bearer-scoped identity only (userId / login / mentions).
 * Never stores tokens.
 */

const SECRET_KEYS = new Set([
  "bearer",
  "token",
  "authorization",
  "password",
  "secret",
  "apiKey",
  "api_key",
]);

/**
 * @param {{ userId?: number|string|null, login?: string|null }} session
 * @param {{ assigneeId?: number|string|null, assigneeLogin?: string|null, mentionIds?: Array<number|string>|null }} event
 */
export function eventMatchesSession(session, event = {}) {
  const userId = session?.userId != null ? Number(session.userId) : null;
  const login = typeof session?.login === "string" ? session.login.toLowerCase() : "";

  if (event.assigneeId != null && userId != null && Number(event.assigneeId) === userId) {
    return true;
  }
  if (
    typeof event.assigneeLogin === "string" &&
    login &&
    event.assigneeLogin.toLowerCase() === login
  ) {
    return true;
  }
  if (Array.isArray(event.mentionIds) && userId != null) {
    for (const id of event.mentionIds) {
      if (Number(id) === userId) return true;
    }
  }
  return false;
}

/**
 * Drop credential-shaped keys before putting an event on the wire.
 * @param {Record<string, unknown>} event
 */
export function sanitizeNotifyEvent(event = {}) {
  const out = {};
  for (const [key, value] of Object.entries(event)) {
    if (SECRET_KEYS.has(key)) continue;
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

/**
 * @typedef {{
 *   sessionId: string,
 *   userId?: number|null,
 *   login?: string|null,
 *   server: { sendLoggingMessage: Function },
 *   transport?: unknown,
 * }} SessionEntry
 */

export function createSessionHub() {
  /** @type {Map<string, SessionEntry>} */
  const bySession = new Map();

  return {
    /** @param {string} sessionId @param {SessionEntry} entry */
    register(sessionId, entry) {
      if (!sessionId || typeof sessionId !== "string") {
        throw new Error("sessionId required");
      }
      bySession.set(sessionId, { ...entry, sessionId });
    },

    /** @param {string} sessionId */
    unregister(sessionId) {
      bySession.delete(sessionId);
    },

    /** @param {string} sessionId */
    get(sessionId) {
      return bySession.get(sessionId) || null;
    },

    size() {
      return bySession.size;
    },

    list() {
      return [...bySession.values()];
    },

    /**
     * Fan out a sanitizeNotifyEvent'd logging notification to matching sessions.
     * @param {Record<string, unknown>} event
     * @returns {Promise<{ delivered: number, sessionIds: string[] }>}
     */
    async notify(event) {
      const data = sanitizeNotifyEvent(event);
      const matched = [];
      for (const entry of bySession.values()) {
        if (eventMatchesSession(entry, data)) matched.push(entry);
      }

      const sessionIds = [];
      for (const entry of matched) {
        await entry.server.sendLoggingMessage(
          {
            level: typeof data.level === "string" ? data.level : "info",
            logger: "openproject-mcp",
            data,
          },
          entry.sessionId
        );
        sessionIds.push(entry.sessionId);
      }
      return { delivered: sessionIds.length, sessionIds };
    },
  };
}

/** True when the TCP peer is loopback (IPv4 or IPv6). */
export function isLoopbackAddress(remoteAddress) {
  if (!remoteAddress || typeof remoteAddress !== "string") return false;
  const a = remoteAddress.replace(/^::ffff:/i, "");
  return a === "127.0.0.1" || a === "::1" || a === "localhost";
}
