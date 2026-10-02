// The in-memory Store: ephemeral by construction, one instance per tenant.
// Every value is structuredClone'd on the way in and on the way out, so a caller that mutates
// what it holds never changes stored state. No work happens at module scope.
import {
  type AuthCode,
  ClockRangeError,
  MAX_DATE_MS,
  type Session,
  type SigningKey,
  type Snapshot,
  type Store,
  type StoredClient,
  type StoredUser,
  type TokenRecord,
} from "./types";

const EMPTY_BASELINE: Snapshot = {
  users: [],
  clients: [],
  next_put_code: 1000,
  next_mint_seq: 1,
};

export class MemoryStore implements Store {
  #users = new Map<string, StoredUser>();
  #clients = new Map<string, StoredClient>();
  #codes = new Map<string, AuthCode>();
  /** Keyed by access token; the refresh token has its own index into this map. */
  #tokens = new Map<string, TokenRecord>();
  #refreshIndex = new Map<string, string>();
  #sessions = new Map<string, Session>();
  #putCode = EMPTY_BASELINE.next_put_code;
  #mintSeq = EMPTY_BASELINE.next_mint_seq;
  #clockOffsetMs = 0;
  #signingKey: SigningKey | null = null;
  #baseline: Snapshot = structuredClone(EMPTY_BASELINE);

  async getUser(orcid: string): Promise<StoredUser | null> {
    const user = this.#users.get(orcid);
    return user ? structuredClone(user) : null;
  }

  async listUsers(): Promise<StoredUser[]> {
    return structuredClone([...this.#users.values()]);
  }

  async insertUser(user: StoredUser): Promise<"created" | "conflict"> {
    if (this.#users.has(user.orcid)) return "conflict";
    this.#users.set(user.orcid, structuredClone(user));
    return "created";
  }

  async upsertUser(user: StoredUser): Promise<"created" | "replaced"> {
    const existed = this.#users.has(user.orcid);
    this.#users.set(user.orcid, structuredClone(user));
    return existed ? "replaced" : "created";
  }

  async deleteUser(orcid: string): Promise<boolean> {
    // No await between the deletes, so the user and everything issued to them go in one step.
    const removed = this.#users.delete(orcid);
    for (const [code, record] of this.#codes) {
      if (record.orcid === orcid) this.#codes.delete(code);
    }
    for (const [access, token] of this.#tokens) {
      if (token.orcid !== orcid) continue;
      this.#tokens.delete(access);
      this.#refreshIndex.delete(token.refresh_token);
    }
    for (const [id, session] of this.#sessions) {
      if (session.orcid === orcid) this.#sessions.delete(id);
    }
    return removed;
  }

  async getClient(clientId: string): Promise<StoredClient | null> {
    const client = this.#clients.get(clientId);
    return client ? structuredClone(client) : null;
  }

  async listClients(): Promise<StoredClient[]> {
    return structuredClone([...this.#clients.values()]);
  }

  async upsertClient(client: StoredClient): Promise<"created" | "replaced"> {
    const existed = this.#clients.has(client.client_id);
    this.#clients.set(client.client_id, structuredClone(client));
    return existed ? "replaced" : "created";
  }

  async putCode(code: AuthCode): Promise<void> {
    this.#codes.set(code.code, structuredClone(code));
  }

  async consumeCode(code: string): Promise<AuthCode | null> {
    const found = this.#codes.get(code);
    if (!found) return null;
    this.#codes.delete(code);
    return structuredClone(found);
  }

  async putTokens(token: TokenRecord): Promise<void> {
    this.#insertToken(structuredClone(token));
  }

  async getAccessToken(accessToken: string): Promise<TokenRecord | null> {
    const token = this.#tokens.get(accessToken);
    return token ? structuredClone(token) : null;
  }

  async getRefreshToken(refreshToken: string): Promise<TokenRecord | null> {
    const token = this.#byRefresh(refreshToken);
    return token ? structuredClone(token) : null;
  }

  async rotateRefresh(
    oldRefreshToken: string,
    next: TokenRecord,
    revokeOld: boolean,
  ): Promise<TokenRecord | null> {
    // No await between the check and the writes, so the rotation is atomic.
    const old = this.#byRefresh(oldRefreshToken);
    if (!old || old.revoked) return null;
    if (revokeOld) old.revoked = true;
    this.#insertToken(structuredClone(next));
    return structuredClone(next);
  }

  async revoke(token: string): Promise<boolean> {
    const found = this.#tokens.get(token) ?? this.#byRefresh(token);
    if (!found) return false;
    found.revoked = true;
    return true;
  }

  async putSession(session: Session): Promise<void> {
    this.#sessions.set(session.id, structuredClone(session));
  }

  async getSession(id: string): Promise<Session | null> {
    const session = this.#sessions.get(id);
    return session ? structuredClone(session) : null;
  }

  async deleteSession(id: string): Promise<void> {
    this.#sessions.delete(id);
  }

  async nextPutCode(): Promise<number> {
    return this.#putCode++;
  }

  async nextMintSeq(): Promise<number> {
    return this.#mintSeq++;
  }

  async clockOffsetMs(): Promise<number> {
    return this.#clockOffsetMs;
  }

  async advanceClock(seconds: number): Promise<number> {
    if (!Number.isFinite(seconds) || seconds < 0) {
      throw new ClockRangeError("advanceClock expects a finite, non-negative number of seconds");
    }
    const next = this.#clockOffsetMs + seconds * 1000;
    // Date.now() + offset must stay a valid Date, or every expiry computation turns into NaN.
    if (!Number.isFinite(next) || Date.now() + next > MAX_DATE_MS) {
      throw new ClockRangeError("advanceClock would move the clock past the end of the Date range");
    }
    this.#clockOffsetMs = next;
    return this.#clockOffsetMs;
  }

  async getSigningKey(): Promise<SigningKey | null> {
    return this.#signingKey ? structuredClone(this.#signingKey) : null;
  }

  async putSigningKeyIfAbsent(key: SigningKey): Promise<SigningKey> {
    // No await between the check and the write, so the first caller wins atomically.
    this.#signingKey ??= structuredClone(key);
    return structuredClone(this.#signingKey);
  }

  async setBaseline(snapshot: Snapshot): Promise<void> {
    this.#baseline = structuredClone(snapshot);
    await this.reset();
  }

  async reset(): Promise<void> {
    const baseline = structuredClone(this.#baseline);
    this.#users = new Map(baseline.users.map((user) => [user.orcid, user]));
    this.#clients = new Map(baseline.clients.map((client) => [client.client_id, client]));
    this.#putCode = baseline.next_put_code;
    this.#mintSeq = baseline.next_mint_seq;
    this.#codes.clear();
    this.#tokens.clear();
    this.#refreshIndex.clear();
    this.#sessions.clear();
    this.#clockOffsetMs = 0;
    // The signing key is kept: a client that cached the JWKS stays valid across resets.
  }

  #insertToken(token: TokenRecord): void {
    const replaced = this.#tokens.get(token.access_token);
    if (replaced) this.#refreshIndex.delete(replaced.refresh_token);
    this.#tokens.set(token.access_token, token);
    this.#refreshIndex.set(token.refresh_token, token.access_token);
  }

  #byRefresh(refreshToken: string): TokenRecord | undefined {
    const access = this.#refreshIndex.get(refreshToken);
    return access === undefined ? undefined : this.#tokens.get(access);
  }
}
