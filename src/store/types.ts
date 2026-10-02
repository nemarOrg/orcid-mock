// The Store interface and every record type. FROZEN after phase 1: phases 2 to 4 consume it and
// cannot change a signature without the lead.
// One Store instance is one tenant, so no method takes a tenant id; all mutable state lives
// behind this interface, never in module or process variables.
// Everything is async so a Durable Object store can implement it; records are plain
// JSON-serializable objects, and every time is in epoch milliseconds.
import type {
  FixtureAddress,
  FixtureBiography,
  FixtureEducation,
  FixtureEmail,
  FixtureEmployment,
  FixtureExternalIdentifier,
  FixtureFunding,
  FixtureKeyword,
  FixtureName,
  FixtureOtherName,
  FixturePeerReview,
  FixtureQualification,
  FixtureResearcherUrl,
  FixtureUser,
  FixtureWork,
  PutCodeSection,
} from "../fixtures/schema";

export type Visibility = "public" | "limited" | "private";
export type ScopeName = "/authenticate" | "openid" | "/read-limited" | "/read-public";

/** The `created-date` and `last-modified-date` that ORCID stamps on an item. */
interface Stamps {
  created_ms: number;
  modified_ms: number;
}

/** An item that carries a put-code in ORCID: the put-code is always filled once stored. */
type StoredItem<T> = Omit<T, "put_code"> & { put_code: number } & Stamps;

/**
 * The normalized fixture user: a FixtureUser with the iD and every put-code filled, plus
 * `created_ms` and `modified_ms` on every piece that has dates in ORCID (the name, the
 * biography, each email, and each item of every section).
 * Absent sections stay absent, and `claimed` stays absent for claimed.
 */
export interface StoredUser
  extends Omit<FixtureUser, "orcid" | "name" | "biography" | "emails" | PutCodeSection> {
  orcid: string;
  name: FixtureName & Stamps;
  biography?: (FixtureBiography & Stamps) | null;
  emails?: Array<FixtureEmail & Stamps>;
  other_names?: Array<StoredItem<FixtureOtherName>>;
  addresses?: Array<StoredItem<FixtureAddress>>;
  keywords?: Array<StoredItem<FixtureKeyword>>;
  external_identifiers?: Array<StoredItem<FixtureExternalIdentifier>>;
  researcher_urls?: Array<StoredItem<FixtureResearcherUrl>>;
  employments?: Array<StoredItem<FixtureEmployment>>;
  educations?: Array<StoredItem<FixtureEducation>>;
  qualifications?: Array<StoredItem<FixtureQualification>>;
  works?: Array<StoredItem<FixtureWork>>;
  fundings?: Array<StoredItem<FixtureFunding>>;
  peer_reviews?: Array<StoredItem<FixturePeerReview>>;
}

export interface StoredClient {
  client_id: string;
  client_secret: string;
  name: string;
  redirect_uris: string[];
  member: boolean;
}

export interface AuthCode {
  code: string;
  client_id: string;
  orcid: string;
  scopes: ScopeName[];
  redirect_uri: string;
  state_present: boolean;
  nonce: string | null;
  auth_time_ms: number;
  amr: string | null;
  expires_at_ms: number;
}

export interface TokenRecord {
  access_token: string;
  refresh_token: string;
  client_id: string;
  /** Null for a client-credentials token. */
  orcid: string | null;
  scopes: ScopeName[];
  member: boolean;
  issued_at_ms: number;
  expires_at_ms: number;
  revoked: boolean;
  auth_time_ms: number | null;
  nonce: string | null;
}

export interface Session {
  id: string;
  orcid: string;
  auth_time_ms: number;
  expires_at_ms: number;
}

export interface SigningKey {
  kid: string;
  private_jwk: JsonWebKey;
  public_jwk: JsonWebKey;
  created_ms: number;
}

/** What `reset()` restores: the loaded users and clients and the counters' starting values. */
export interface Snapshot {
  users: StoredUser[];
  clients: StoredClient[];
  next_put_code: number;
  next_mint_seq: number;
  loaded_ms: number;
}

export interface Store {
  getUser(orcid: string): Promise<StoredUser | null>;
  /** In insertion order; replacing a user keeps its place. */
  listUsers(): Promise<StoredUser[]>;
  insertUser(user: StoredUser): Promise<"created" | "conflict">;
  upsertUser(user: StoredUser): Promise<"created" | "replaced">;
  deleteUser(orcid: string): Promise<boolean>;

  getClient(clientId: string): Promise<StoredClient | null>;
  listClients(): Promise<StoredClient[]>;
  upsertClient(client: StoredClient): Promise<"created" | "replaced">;

  putCode(code: AuthCode): Promise<void>;
  /** Atomic take-and-delete: a second call for the same code gets null. */
  consumeCode(code: string): Promise<AuthCode | null>;

  putTokens(token: TokenRecord): Promise<void>;
  /** Revoked and expired tokens are returned as stored; the caller checks both. */
  getAccessToken(accessToken: string): Promise<TokenRecord | null>;
  getRefreshToken(refreshToken: string): Promise<TokenRecord | null>;
  /** Atomic; null if the old refresh token is unknown or revoked. */
  rotateRefresh(
    oldRefreshToken: string,
    next: TokenRecord,
    revokeOld: boolean,
  ): Promise<TokenRecord | null>;
  /** Takes an access or a refresh token and revokes the pair; false if it is unknown. */
  revoke(token: string): Promise<boolean>;

  putSession(session: Session): Promise<void>;
  getSession(id: string): Promise<Session | null>;
  deleteSession(id: string): Promise<void>;

  nextPutCode(): Promise<number>;
  nextMintSeq(): Promise<number>;

  clockOffsetMs(): Promise<number>;
  /** Rejects a negative or non-finite number of seconds; returns the new offset. */
  advanceClock(seconds: number): Promise<number>;

  getSigningKey(): Promise<SigningKey | null>;
  putSigningKey(key: SigningKey): Promise<void>;

  /** Records the snapshot as the baseline and applies it, as `reset()` would. */
  setBaseline(snapshot: Snapshot): Promise<void>;
  /**
   * Users, clients, and counters go back to the baseline; codes, tokens, and sessions are
   * cleared; the clock offset returns to zero; the signing key is kept.
   */
  reset(): Promise<void>;
}
