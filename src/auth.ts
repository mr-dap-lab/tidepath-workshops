import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { db } from './db.ts'

const scrypt = promisify(scryptCallback)
const sessionCookie = 'tidepath_session'
const sessionSeconds = 8 * 60 * 60

type Account = {
  id: string
  name: string
  password_hash: string
  role: 'platform_admin' | 'tenant_admin' | 'coordinator' | 'reviewer'
}

export type Identity = Pick<Account, 'id' | 'name' | 'role'>

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex')
  const hash = await scrypt(password, salt, 64) as Buffer
  return `${salt}:${hash.toString('hex')}`
}

export async function authenticate(tenantId: string | null, email: string, password: string, allowDemo = true) {
  const { rows: [account] } = await db.query<Account>(`
    SELECT a.id, a.name, a.password_hash,
      CASE WHEN $1::uuid IS NULL THEN 'platform_admin' ELSE m.role END AS role
    FROM accounts a
    LEFT JOIN memberships m ON m.account_id = a.id AND m.tenant_id = $1
    WHERE a.email = $2 AND ($3 OR NOT a.demo_account) AND
      (($1::uuid IS NULL AND a.platform_admin) OR m.account_id IS NOT NULL)
  `, [tenantId, email, allowDemo])
  const [salt, expected] = account?.password_hash.split(':') ?? ['0'.repeat(32), '0'.repeat(128)]
  const actual = await scrypt(password, salt, 64) as Buffer
  return timingSafeEqual(actual, Buffer.from(expected, 'hex')) ? account : undefined
}

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

function readToken(cookieHeader?: string) {
  return cookieHeader?.match(/(?:^|;\s*)tidepath_session=([a-f0-9]{64})(?:;|$)/)?.[1]
}

function cookie(token: string, maxAge: number, secure: boolean) {
  return `${sessionCookie}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
}

export async function startSession(accountId: string, tenantId: string | null, secure: boolean) {
  const token = randomBytes(32).toString('hex')
  await db.query(`
    INSERT INTO sessions (token_hash, account_id, tenant_id, expires_at)
    VALUES ($1, $2, $3, now() + $4 * interval '1 second')
  `, [tokenHash(token), accountId, tenantId, sessionSeconds])
  return cookie(token, sessionSeconds, secure)
}

export async function getIdentity(tenantId: string | null, cookieHeader?: string, allowDemo = true) {
  const token = readToken(cookieHeader)
  if (!token) return undefined
  const { rows: [identity] } = await db.query<Identity>(`
    SELECT a.id, a.name,
      CASE WHEN $2::uuid IS NULL THEN 'platform_admin' ELSE m.role END AS role
    FROM sessions s
    JOIN accounts a ON a.id = s.account_id
    LEFT JOIN memberships m ON m.account_id = a.id AND m.tenant_id = $2
    WHERE s.token_hash = $1 AND s.tenant_id IS NOT DISTINCT FROM $2::uuid
      AND s.expires_at > now() AND ($3 OR NOT a.demo_account)
      AND (($2::uuid IS NULL AND a.platform_admin) OR m.account_id IS NOT NULL)
  `, [tokenHash(token), tenantId, allowDemo])
  return identity
}

export async function endSession(tenantId: string | null, secure: boolean, cookieHeader?: string) {
  const token = readToken(cookieHeader)
  if (token) {
    await db.query('DELETE FROM sessions WHERE token_hash = $1 AND tenant_id IS NOT DISTINCT FROM $2::uuid', [
      tokenHash(token), tenantId,
    ])
  }
  return cookie('', 0, secure)
}
